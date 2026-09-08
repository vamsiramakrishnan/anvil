import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type AirDocument, operationSafetyInputKeys } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { type Check, fc, type JsonValue, type Property, type Scenario, Step } from "@anvil/fuzz";
import type { FuzzFixtureFactory } from "./fixture.js";

/** Owned test contract. Assertions below are hand-authored business invariants. */
const paymentId = { name: "payment_id", in: "path", required: true, schema: { type: "string" } };
const jsonResponse = (properties: Record<string, unknown>) => ({
  description: "Success",
  content: { "application/json": { schema: { type: "object", properties } } },
});
export const PAYMENT_FUZZ_SPEC = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Fuzz Payments", version: "1.0.0" },
  servers: [{ url: "http://127.0.0.1:1" }],
  paths: {
    "/payments/{payment_id}": {
      get: {
        operationId: "getPayment",
        summary: "Read a payment",
        parameters: [paymentId],
        responses: {
          "200": jsonResponse({ id: { type: "string" }, refunded: { type: "integer" } }),
        },
      },
    },
    "/payments/{payment_id}/refunds": {
      post: {
        operationId: "createRefund",
        summary: "Refund a payment",
        parameters: [paymentId],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["amount"],
                properties: { amount: { type: "integer", minimum: 1, maximum: 10000 } },
              },
            },
          },
        },
        responses: {
          "201": jsonResponse({ id: { type: "string" }, amount: { type: "integer" } }),
          "409": { description: "Key reused with different input" },
        },
      },
    },
  },
});
export const PAYMENT_FUZZ_MANIFEST = `operations:
  getPayment:
    state: approved
  createRefund:
    state: approved
    side_effect: mutation
    risk: financial
    reversible: false
    idempotency:
      strategy: required_request_key
      key_location: header
      header: Idempotency-Key
    confirmation:
      required: true
      reason: Confirm the refund amount.
    retries:
      enabled: true
      only_on: [timeout, "503"]
      max_attempts: 2
`;

export function compilePaymentFuzzFixture(): Promise<AirDocument> {
  return compile({
    spec: PAYMENT_FUZZ_SPEC,
    manifest: PAYMENT_FUZZ_MANIFEST,
    serviceId: "fuzz-payments",
  });
}

/** Independent HTTP ledger: it does not import or execute AIR safety rules. */
export const paymentFuzzFixture: FuzzFixtureFactory = async (_bundle, _seed, signal) => {
  let refunded = 0;
  let commits = 0;
  let dropped = 0;
  let dropNext = false;
  const ledger = new Map<string, { amount: number; value: { id: string; amount: number } }>();
  const wire: JsonValue[] = [];
  const server = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "GET" && path === "/payments/p1") {
      wire.push({ method: "GET", path, body: null });
      send(200, { id: "p1", refunded });
      return;
    }
    if (request.method !== "POST" || path !== "/payments/p1/refunds") {
      send(404, { error: "not_found" });
      return;
    }
    let text = "";
    try {
      for await (const chunk of request) {
        text += String(chunk);
        if (text.length > 10000) {
          send(413, {});
          return;
        }
      }
      const body = JSON.parse(text) as { amount?: number };
      const key = request.headers["idempotency-key"];
      wire.push({
        method: "POST",
        path,
        body: body as JsonValue,
        key: typeof key === "string" ? key : null,
      });
      if (typeof key !== "string" || !key) {
        send(400, { error: "key_required" });
        return;
      }
      if (!Number.isInteger(body.amount) || (body.amount ?? 0) < 1 || (body.amount ?? 0) > 10000) {
        send(400, { error: "invalid_amount" });
        return;
      }
      const amount = body.amount as number;
      const previous = ledger.get(key);
      if (previous) {
        send(
          previous.amount === amount ? 201 : 409,
          previous.amount === amount ? previous.value : { error: "key_conflict" },
        );
        return;
      }
      if (refunded + amount > 10000) {
        send(409, { error: "insufficient_balance" });
        return;
      }
      refunded += amount;
      commits++;
      const value = { id: `r${commits}`, amount };
      ledger.set(key, { amount, value });
      if (dropNext) {
        dropNext = false;
        dropped++;
        response.destroy();
        return;
      }
      send(201, value);
    } catch {
      if (!response.destroyed) send(400, { error: "invalid_request" });
    }
  });
  const close = async () => {
    signal.removeEventListener("abort", abort);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const abort = () => {
    void close();
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    await close();
    throw new Error("Fixture aborted");
  }
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async before(step) {
      if (step.fault) {
        if (step.fault.kind !== "lost-response-after-commit")
          throw new Error("Unsupported payment fault");
        dropNext = true;
      }
    },
    async observe() {
      return { wire: structuredClone(wire), effects: { commits, refunded, dropped } };
    },
    close,
  };
};

function paymentOperations(air: AirDocument) {
  const read = air.operations.find(
    (op) => op.sourceRef.operationId === "getPayment" || op.id === "getPayment",
  );
  const refund = air.operations.find(
    (op) => op.sourceRef.operationId === "createRefund" || op.id === "createRefund",
  );
  if (!read || !refund) throw new Error("Payment campaign requires its fixture contract");
  return { read, refund, keys: operationSafetyInputKeys(refund) };
}

export function paymentScenarios(air: AirDocument) {
  const { read, refund, keys } = paymentOperations(air);
  return fc
    .record({
      amount: fc.integer({ min: 1, max: 250 }),
      noise: fc.integer({ min: 0, max: 3 }),
      gate: fc.boolean(),
      drop: fc.boolean(),
      conflict: fc.boolean(),
    })
    .map(({ amount, noise, gate, drop, conflict }): Scenario => {
      const steps = Array.from({ length: noise }, (_, i) =>
        Step.parse({ id: `noise-${i}`, operation: read.id, input: { payment_id: "p1" } }),
      );
      steps.push(Step.parse({ id: "payment", operation: read.id, input: { payment_id: "p1" } }));
      const input = { amount, [keys.confirm]: true, [keys.idempotencyKey]: "refund-k1" };
      const bindings = { payment_id: { step: "payment", pointer: "/id" } };
      if (gate)
        steps.push(
          Step.parse({
            id: "unconfirmed",
            operation: refund.id,
            input: { amount, [keys.idempotencyKey]: "refund-k1" },
            bindings,
          }),
        );
      steps.push(
        Step.parse({
          id: "refund",
          operation: refund.id,
          input,
          bindings,
          ...(drop ? { fault: { kind: "lost-response-after-commit" } } : {}),
        }),
      );
      steps.push(
        Step.parse({ id: "replay", operation: refund.id, input, bindings, requires: ["refund"] }),
      );
      if (conflict)
        steps.push(
          Step.parse({
            id: "conflict",
            operation: refund.id,
            input: { ...input, amount: amount + 1 },
            bindings,
            requires: ["refund"],
          }),
        );
      return { id: "payment-refund", steps };
    });
}

/** Independent oracle over fixture commits, not over generated response text. */
export function paymentProperties(air: AirDocument): Property {
  const { refund, keys } = paymentOperations(air);
  return (_scenario, traces) => {
    const checks: Check[] = [];
    for (const trace of traces) {
      const expected = new Map<string, number>();
      for (const event of trace.events) {
        if (event.outcome.status === "unsupported" || event.outcome.status === "inconclusive")
          continue;
        const isRefund = event.step.operation === refund.id;
        const amount = Number(event.input.amount);
        const key = event.input[keys.idempotencyKey];
        const confirmed = event.input[keys.confirm] === true;
        const valid =
          isRefund &&
          event.input.payment_id === "p1" &&
          Number.isInteger(amount) &&
          amount >= 1 &&
          amount <= 10000 &&
          typeof key === "string" &&
          key.length > 0;
        if (
          valid &&
          confirmed &&
          !expected.has(key) &&
          [...expected.values()].reduce((sum, n) => sum + n, 0) + amount <= 10000
        )
          expected.set(key, amount);
        const state = event.outcome.effects as { commits?: number; refunded?: number } | undefined;
        const expectedAmount = [...expected.values()].reduce((sum, n) => sum + n, 0);
        checks.push({
          id: "payment.at-most-once",
          status: !state
            ? "inconclusive"
            : state.commits === expected.size && state.refunded === expectedAmount
              ? "passed"
              : "failed",
          driver: trace.driver,
          stepId: event.step.id,
          operation: event.step.operation,
          detail: `Expected ${expected.size} commits totalling ${expectedAmount}; observed ${state?.commits ?? "unknown"} commits totalling ${state?.refunded ?? "unknown"}`,
        });
        if (isRefund && !confirmed)
          checks.push({
            id: "payment.confirmation",
            status:
              event.outcome.status === "error" &&
              ["confirmation_required", "invalid_arguments"].includes(event.outcome.errorCode ?? "")
                ? "passed"
                : "failed",
            driver: trace.driver,
            operation: refund.id,
            stepId: event.step.id,
            detail: "An unconfirmed refund must refuse before committing",
          });
        if (
          valid &&
          confirmed &&
          expected.get(String(key)) === amount &&
          event.step.fault?.kind !== "lost-response-after-commit"
        )
          checks.push({
            id: "payment.completion",
            status: event.outcome.status === "ok" ? "passed" : "failed",
            driver: trace.driver,
            operation: refund.id,
            stepId: event.step.id,
            detail: "An authorized refund or identical replay must return its result",
          });
        if (isRefund && confirmed && (!valid || expected.get(String(key)) !== amount))
          checks.push({
            id: "payment.key-conflict",
            status: event.outcome.status === "error" ? "passed" : "failed",
            driver: trace.driver,
            operation: refund.id,
            stepId: event.step.id,
            detail: "A key reused for a different amount must refuse",
          });
      }
    }
    return checks;
  };
}

/** A trajectory must achieve the requested goal as well as obey safety laws. */
export function paymentTaskGoal(amount: number): Property {
  return (_scenario, traces) =>
    traces.map((trace) => {
      const state = trace.events.at(-1)?.outcome.effects as
        | { commits?: number; refunded?: number }
        | undefined;
      return {
        id: "payment.task-goal",
        driver: trace.driver,
        status: !state
          ? "inconclusive"
          : state.commits === 1 && state.refunded === amount
            ? "passed"
            : "failed",
        detail: `The task must commit exactly one refund of ${amount}`,
      };
    });
}
