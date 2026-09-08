import { type AirDocument, idempotencyModeUsesCarrier, operationSafetyInputKeys } from "@anvil/air";
import { type Check, fc, type JsonValue, type Property, type Scenario, Step } from "@anvil/fuzz";
import { exampleInput } from "@anvil/generators";
import { diff, expectedWire, type WireLoss } from "../bundle-driver.js";

/** Bounded schema-example mutations; stateful business campaigns supply their own arbitrary. */
export function contractScenarios(air: AirDocument) {
  const operations = air.operations.filter((op) => op.state === "approved");
  if (!operations.length) throw new Error("Fuzzing requires at least one approved operation");
  return fc
    .tuple(
      fc.constantFrom(...operations),
      fc.constantFrom("valid", "unconfirmed", "keyless"),
      fc.string({ minLength: 1, maxLength: 24 }),
    )
    .map(([op, variant, key]): Scenario => {
      const keys = operationSafetyInputKeys(op);
      const input = JSON.parse(JSON.stringify(exampleInput(op))) as Record<string, JsonValue>;
      if (op.confirmation.required) input[keys.confirm] = true;
      // Carrier values cannot contain newlines when sent as HTTP headers. Keep
      // key generation printable; transport boundary fuzzing is a separate lane.
      if (idempotencyModeUsesCarrier(op.idempotency.mode))
        input[keys.idempotencyKey] = `fuzz-${key}`.replace(/[^a-zA-Z0-9_-]/g, "x");
      if (variant === "unconfirmed") delete input[keys.confirm];
      if (variant === "keyless") delete input[keys.idempotencyKey];
      return {
        id: `contract-${op.id}`,
        steps: [Step.parse({ id: "call", operation: op.id, input, tags: [variant] })],
      };
    });
}

/** Checks contract/wire agreement only; it does not infer business guarantees. */
export function contractProperties(air: AirDocument): Property {
  const operations = new Map(air.operations.map((op) => [op.id, op]));
  return (scenario, traces) => {
    const checks: Check[] = [];
    for (const trace of traces) {
      let captured = 0;
      for (const event of trace.events) {
        const op = operations.get(event.step.operation);
        if (
          !op ||
          event.outcome.status === "unsupported" ||
          event.outcome.status === "inconclusive"
        )
          continue;
        const all = Array.isArray(event.outcome.wire) ? event.outcome.wire : [];
        const requests = all.slice(captured);
        captured = all.length;
        const keys = operationSafetyInputKeys(op);
        if (op.confirmation.required && event.input[keys.confirm] !== true) {
          checks.push({
            id: "contract.confirmation",
            driver: trace.driver,
            operation: op.id,
            stepId: event.step.id,
            status:
              event.outcome.status === "error" &&
              ["confirmation_required", "invalid_arguments"].includes(
                event.outcome.errorCode ?? "",
              ) &&
              requests.length === 0
                ? "passed"
                : "failed",
            detail: "Missing confirmation must refuse before the wire",
          });
        } else if (
          op.idempotency.mode === "required" &&
          op.idempotency.keyDerivation !== "request_fingerprint" &&
          !event.input[keys.idempotencyKey]
        ) {
          checks.push({
            id: "contract.idempotency-gate",
            driver: trace.driver,
            operation: op.id,
            stepId: event.step.id,
            status:
              event.outcome.status === "error" &&
              ["idempotency_required", "invalid_arguments"].includes(
                event.outcome.errorCode ?? "",
              ) &&
              requests.length === 0
                ? "passed"
                : "failed",
            detail: "Missing required key must refuse before the wire",
          });
        } else if (event.outcome.status === "ok") {
          const want = expectedWire(op, event.input);
          const losses: WireLoss[] = [];
          for (const raw of requests) {
            const actual = raw as {
              method?: unknown;
              path?: unknown;
              query?: unknown;
              body?: unknown;
              headers?: Record<string, string>;
            };
            diff(op.sourceRef.method?.toUpperCase(), actual.method, "method", losses);
            for (const [key, value] of Object.entries(want.headers))
              diff(value, actual.headers?.[key], `headers.${key}`, losses);
            diff(want.path, actual.path, "path", losses);
            diff(want.query, actual.query ?? {}, "query", losses);
            diff(want.body ?? null, actual.body ?? null, "body", losses);
          }
          checks.push({
            id: "contract.wire",
            driver: trace.driver,
            operation: op.id,
            stepId: event.step.id,
            status: requests.length && !losses.length ? "passed" : "failed",
            detail: requests.length
              ? losses.length
                ? `Wire differs at ${losses.map((loss) => loss.path).join(", ")}`
                : "Request matches AIR"
              : "A successful operation produced no observable request",
          });
        } else {
          checks.push({
            id: "contract.input-coverage",
            driver: trace.driver,
            operation: op.id,
            stepId: event.step.id,
            status: "inconclusive",
            detail: "The schema example was rejected; wire behavior remains unverified",
          });
        }
      }
    }
    for (const step of scenario.steps) {
      const outcomes = traces
        .map((trace) => ({
          driver: trace.driver,
          event: trace.events.find((event) => event.step.id === step.id),
        }))
        .filter((item) => item.event && ["ok", "error"].includes(item.event.outcome.status));
      const baseline = outcomes[0];
      if (!baseline) continue;
      for (const item of outcomes.slice(1)) {
        const a = baseline.event?.outcome;
        const b = item.event?.outcome;
        const values: WireLoss[] = [];
        if (a?.status === "ok" && b?.status === "ok") diff(a.value, b.value, "value", values);
        checks.push({
          id: "contract.outcome-agreement",
          driver: item.driver,
          operation: step.operation,
          stepId: step.id,
          status:
            !values.length &&
            a?.status === b?.status &&
            (step.tags.some((tag) => ["unconfirmed", "keyless"].includes(tag)) ||
              a?.errorCode === b?.errorCode)
              ? "passed"
              : "failed",
          detail: `${baseline.driver}: ${a?.status}/${a?.errorCode ?? ""}; ${item.driver}: ${b?.status}/${b?.errorCode ?? ""}`,
        });
      }
    }
    return checks;
  };
}
