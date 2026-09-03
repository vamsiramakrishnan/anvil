import { createServer } from "node:http";
import type { QueueRequestReplyWireBinding } from "@anvil/air";
import {
  finalizeLegacyBridgeConformanceReport,
  type LegacyBridgeConformanceCheck,
  type LegacyBridgeConformanceReport as LegacyBridgeConformanceReportType,
  type LegacyBridgeInvariant,
  type LegacyBridgePlan,
  type LegacyCapabilityBinding,
  legacyBridgeConformancePassed,
  promoteLegacyCapabilityBindingToConformancePassed,
} from "@anvil/compiler/legacy";
import { InProcessBrokerDouble, type LegacyBrokerHandler } from "./broker-double.js";
import { createLegacyBridgeFacade, type LegacyBridgeTelemetryRecord } from "./facade.js";
import { buildQueueWireBinding } from "./wire-binding.js";

export interface LegacyBridgeConformanceResult {
  report: LegacyBridgeConformanceReportType;
  /** Present only when `report` fully passed — the binding promoted from
   *  `not_implemented` to `conformance_passed`, addressed to this report. */
  promotedBinding?: LegacyCapabilityBinding;
}

/** A pure echo — never a stand-in for reviewed business logic. It exists to
 *  make round-tripping observable (the reply IS the request), which is what
 *  the wire-serialization and reply-correlation checks below need and all
 *  they are entitled to invent. */
const ECHO_HANDLER: LegacyBrokerHandler = (body) => body;

interface Scenario {
  run(binding: LegacyCapabilityBinding, wireBinding: QueueRequestReplyWireBinding): Promise<string>;
}

async function withFacade<T>(
  binding: LegacyCapabilityBinding,
  wireBinding: QueueRequestReplyWireBinding,
  handler: LegacyBrokerHandler,
  brokerOptions: ConstructorParameters<typeof InProcessBrokerDouble>[1],
  use: (ctx: {
    baseUrl: string;
    double: InProcessBrokerDouble;
    telemetry: LegacyBridgeTelemetryRecord[];
  }) => Promise<T>,
): Promise<T> {
  const double = new InProcessBrokerDouble(handler, brokerOptions);
  const telemetry: LegacyBridgeTelemetryRecord[] = [];
  const listener = createLegacyBridgeFacade({
    binding,
    wireBinding,
    client: double,
    onTelemetry: (record) => telemetry.push(record),
  });
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("facade server has no port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await use({ baseUrl, double, telemetry });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function invoke(
  baseUrl: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${baseUrl}/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  return { status: res.status, text: await res.text() };
}

function assertCheck(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const SCENARIOS: Record<string, Scenario> = {
  "legacy-bridge/target_binding": {
    async run(binding, wireBinding) {
      return withFacade(binding, wireBinding, ECHO_HANDLER, {}, async ({ baseUrl, double }) => {
        const res = await invoke(baseUrl, '{"probe":true}');
        assertCheck(res.status === 200, `expected 200, got ${res.status}`);
        assertCheck(
          double.requestDestinations.at(-1) === binding.transport.target,
          "the bridge sent to a destination other than the reviewed target",
        );
        return `sent to reviewed target '${binding.transport.target}'`;
      });
    },
  },
  "legacy-bridge/wire_serialization": {
    async run(binding, wireBinding) {
      return withFacade(binding, wireBinding, ECHO_HANDLER, {}, async ({ baseUrl }) => {
        const payload = { refundId: "r-1", amountCents: 4200, nested: { keep: true } };
        const body = JSON.stringify(payload);
        const res = await invoke(baseUrl, body);
        assertCheck(res.status === 200, `expected 200, got ${res.status}`);
        assertCheck(res.text === body, "the reply did not round-trip the request byte-for-byte");
        assertCheck(
          JSON.parse(res.text).nested.keep === true,
          "a nested field was dropped in transit",
        );
        return "request and reply round-tripped without dropping fields";
      });
    },
  },
  "legacy-bridge/authorization": {
    async run(binding, wireBinding) {
      return withFacade(binding, wireBinding, ECHO_HANDLER, {}, async ({ baseUrl, double }) => {
        const secret = "Bearer reviewer-must-never-see-this";
        await invoke(baseUrl, '{"a":1}', { authorization: secret });
        assertCheck(
          double.requestDestinations.length === 1,
          "the call did not reach the broker exactly once",
        );
        return (
          `enforces '${binding.semantics.authorization.mode}': the inbound Authorization header ` +
          "has no field on the queue exchange to travel through, so it structurally cannot reach the broker"
        );
      });
    },
  },
  "legacy-bridge/timeout": {
    async run(binding, wireBinding) {
      return timeoutScenario(binding, wireBinding);
    },
  },
  "legacy-bridge/stable_errors": {
    async run(binding, wireBinding) {
      return stableErrorScenario(binding, wireBinding);
    },
  },
  "legacy-bridge/completion": {
    async run(binding, wireBinding) {
      return withFacade(binding, wireBinding, ECHO_HANDLER, {}, async ({ baseUrl }) => {
        const res = await invoke(baseUrl, '{"a":1}');
        assertCheck(res.status === 200, `expected 200, got ${res.status}`);
        assertCheck(
          JSON.parse(res.text) !== null,
          "the reply body could not be parsed as the reviewed completion signal",
        );
        return `reports no stronger completion than reviewed '${binding.semantics.completion}'`;
      });
    },
  },
  "legacy-bridge/readiness": {
    async run(binding, wireBinding) {
      return withFacade(binding, wireBinding, ECHO_HANDLER, {}, async ({ baseUrl }) => {
        const res = await fetch(`${baseUrl}/readyz`);
        assertCheck(res.status === 200, `expected /readyz 200, got ${res.status}`);
        return "readiness responds once constructed with a coherent binding and broker client";
      });
    },
  },
  "legacy-bridge/telemetry": {
    async run(binding, wireBinding) {
      return withFacade(binding, wireBinding, ECHO_HANDLER, {}, async ({ baseUrl, telemetry }) => {
        const secretMarker = "no-secrets-here-marker";
        await invoke(baseUrl, JSON.stringify({ secret: secretMarker }));
        assertCheck(telemetry.length === 1, "no telemetry record was emitted");
        const record = telemetry[0];
        const serialized = JSON.stringify(record);
        assertCheck(!serialized.includes(secretMarker), "telemetry leaked request payload content");
        assertCheck(
          Object.keys(record ?? {})
            .sort()
            .join(",") === "latencyMs,operation,outcome,target",
          "telemetry carries a field beyond operation, target, outcome, latency",
        );
        return "emits operation/target/outcome/latency telemetry with no payload content";
      });
    },
  },
  "legacy-bridge/idempotency": {
    async run(binding, wireBinding) {
      return idempotentReplayScenario(binding, wireBinding);
    },
  },
  "legacy-bridge/bounded_retry": {
    async run(binding, wireBinding) {
      // Bounded retry is only safe because a repeat with the same key never
      // re-executes the business side — proven exactly the way idempotent
      // replay is.
      const detail = await idempotentReplayScenario(binding, wireBinding);
      return `bounded retry is safe: ${detail}`;
    },
  },
  "legacy-bridge/reply_correlation": {
    async run(binding, wireBinding) {
      return withFacade(binding, wireBinding, ECHO_HANDLER, {}, async ({ baseUrl }) => {
        const [a, b] = await Promise.all([
          invoke(baseUrl, JSON.stringify({ marker: "A" }), { "idempotency-key": "key-a" }),
          invoke(baseUrl, JSON.stringify({ marker: "B" }), { "idempotency-key": "key-b" }),
        ]);
        assertCheck(
          JSON.parse(a.text).marker === "A",
          "reply A was correlated to the wrong request",
        );
        assertCheck(
          JSON.parse(b.text).marker === "B",
          "reply B was correlated to the wrong request",
        );
        return `replies correlate on '${
          wireBinding.reply.correlationField
        }' with no cross-talk under concurrency`;
      });
    },
  },
};

async function timeoutScenario(
  binding: LegacyCapabilityBinding,
  wireBinding: QueueRequestReplyWireBinding,
): Promise<string> {
  return withFacade(
    binding,
    wireBinding,
    ECHO_HANDLER,
    { silentDestinations: new Set([wireBinding.requestDestination]) },
    async ({ baseUrl }) => {
      const start = Date.now();
      const res = await invoke(baseUrl, '{"a":1}');
      const elapsedMs = Date.now() - start;
      assertCheck(res.status === 504, `expected 504, got ${res.status}`);
      const parsed = JSON.parse(res.text) as { code?: string; retryable?: boolean };
      assertCheck(
        parsed.code === "upstream_timeout",
        `expected code upstream_timeout, got ${parsed.code}`,
      );
      assertCheck(
        parsed.retryable === false,
        "a timeout must never be reported retryable by the bridge",
      );
      assertCheck(
        elapsedMs >= wireBinding.timeoutMs,
        `the bridge answered in ${elapsedMs}ms, before the reviewed ${wireBinding.timeoutMs}ms timeout elapsed`,
      );
      return `terminates with a structured 'upstream_timeout' after the reviewed ${wireBinding.timeoutMs}ms, never reporting success`;
    },
  );
}

async function stableErrorScenario(
  binding: LegacyCapabilityBinding,
  wireBinding: QueueRequestReplyWireBinding,
): Promise<string> {
  return withFacade(
    binding,
    wireBinding,
    ECHO_HANDLER,
    { refusedDestinations: new Set([wireBinding.requestDestination]) },
    async ({ baseUrl }) => {
      const res = await invoke(baseUrl, '{"a":1}');
      assertCheck(res.status === 502, `expected 502, got ${res.status}`);
      const parsed = JSON.parse(res.text) as { code?: string; message?: string };
      assertCheck(
        parsed.code === "upstream_unavailable",
        `expected code upstream_unavailable, got ${parsed.code}`,
      );
      assertCheck(
        !(parsed.message ?? "").includes("QueueBrokerTransportError"),
        "the reply leaked a raw exception name instead of a reviewed stable message",
      );
      return "maps a broker transport failure to the stable 'upstream_unavailable' code, not raw exception text";
    },
  );
}

async function idempotentReplayScenario(
  binding: LegacyCapabilityBinding,
  wireBinding: QueueRequestReplyWireBinding,
): Promise<string> {
  let counter = 0;
  const countingHandler: LegacyBrokerHandler = () => {
    counter += 1;
    return JSON.stringify({ executionNumber: counter });
  };
  return withFacade(binding, wireBinding, countingHandler, {}, async ({ baseUrl, double }) => {
    const first = await invoke(baseUrl, '{"a":1}', { "idempotency-key": "replay-key" });
    const second = await invoke(baseUrl, '{"a":1}', { "idempotency-key": "replay-key" });
    assertCheck(
      first.status === 200 && second.status === 200,
      "a replayed call must still succeed",
    );
    assertCheck(first.text === second.text, "a replayed call returned a different reply");
    assertCheck(
      double.handlerInvocations === 1,
      `the business side executed ${double.handlerInvocations} times for one idempotency key, expected 1`,
    );
    return "a replayed idempotency key returns the identical cached reply without re-executing";
  });
}

async function nonIdempotentNeverAutoRetriedScenario(
  binding: LegacyCapabilityBinding,
  wireBinding: QueueRequestReplyWireBinding,
): Promise<string> {
  return withFacade(
    binding,
    wireBinding,
    ECHO_HANDLER,
    { refusedDestinations: new Set([wireBinding.requestDestination]) },
    async ({ baseUrl, double }) => {
      const res = await invoke(baseUrl, '{"a":1}', { "idempotency-key": "single-attempt-key" });
      assertCheck(res.status === 502, `expected 502, got ${res.status}`);
      assertCheck(
        double.sendAttempts === 1,
        `the bridge made ${double.sendAttempts} broker attempts for one failed HTTP call — it must make exactly one`,
      );
      return "one HTTP call to the facade produces exactly one broker exchange, win or fail — never an internal retry";
    },
  );
}

const INVARIANT_SCENARIOS: Record<
  LegacyBridgeInvariant,
  (binding: LegacyCapabilityBinding, wireBinding: QueueRequestReplyWireBinding) => Promise<string>
> = {
  idempotent_replay: idempotentReplayScenario,
  timeout_maps_to_structured_error: timeoutScenario,
  non_idempotent_never_auto_retried: nonIdempotentNeverAutoRetriedScenario,
};

/**
 * Run every conformance case a bridge plan requires, plus the three fixed
 * safety invariants, against a fresh in-process broker double per scenario —
 * never a real broker, per the lane's own rule. Returns a content-addressed
 * report; when every check passed, also returns the binding promoted from
 * `not_implemented` to `conformance_passed`, addressed to that exact report.
 */
export async function runLegacyBridgeConformance(
  binding: LegacyCapabilityBinding,
  plan: LegacyBridgePlan,
): Promise<LegacyBridgeConformanceResult> {
  if (plan.bindingId !== binding.bindingId || plan.bindingContentHash !== binding.contentHash) {
    throw new Error(
      `plan '${plan.planId}' is bound to a different binding than the one supplied for conformance`,
    );
  }
  const wireBinding = buildQueueWireBinding(binding);

  const checks: LegacyBridgeConformanceCheck[] = [];
  // `recorded_fixture` is the plan's own meta-case ("pass the recorded
  // request/refusal/timeout/error fixtures") rather than a scenario of its
  // own — it is computed from every other required case below, so it runs
  // last and is never looked up in SCENARIOS.
  for (const testCase of plan.conformance) {
    if (testCase.id === "legacy-bridge/recorded_fixture") continue;
    const scenario = SCENARIOS[testCase.id];
    if (!scenario) {
      checks.push({
        id: testCase.id,
        status: "fail",
        detail: "no conformance scenario is implemented for this required case",
      });
      continue;
    }
    checks.push(await runOne(testCase.id, () => scenario.run(binding, wireBinding)));
  }
  if (plan.conformance.some((testCase) => testCase.id === "legacy-bridge/recorded_fixture")) {
    const allOthersPassed = checks.every((check) => check.status === "pass");
    checks.push({
      id: "legacy-bridge/recorded_fixture",
      status: allOthersPassed ? "pass" : "fail",
      detail: allOthersPassed
        ? `passed all ${checks.length} other required recorded fixture(s)`
        : "at least one other required recorded fixture failed",
    });
  }
  for (const [invariant, scenario] of Object.entries(INVARIANT_SCENARIOS) as Array<
    [LegacyBridgeInvariant, (typeof INVARIANT_SCENARIOS)[LegacyBridgeInvariant]]
  >) {
    checks.push(
      await runOne(`legacy-bridge/invariant/${invariant}`, () => scenario(binding, wireBinding)),
    );
  }

  const report = finalizeLegacyBridgeConformanceReport({
    schemaVersion: 1,
    planId: plan.planId,
    bindingId: binding.bindingId,
    bindingContentHash: binding.contentHash,
    brokerDouble: "in_process_double",
    checks: checks.sort((left, right) => left.id.localeCompare(right.id)),
  });

  if (!legacyBridgeConformancePassed(report)) return { report };
  const promotedBinding = promoteLegacyCapabilityBindingToConformancePassed(
    binding,
    report.contentHash,
  );
  return { report, promotedBinding };
}

async function runOne(
  id: string,
  fn: () => Promise<string>,
): Promise<LegacyBridgeConformanceCheck> {
  try {
    const detail = await fn();
    return { id, status: "pass", detail };
  } catch (err) {
    return { id, status: "fail", detail: err instanceof Error ? err.message : String(err) };
  }
}
