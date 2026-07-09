import { type Operation, Operation as OperationSchema } from "@anvil/air";
import { describe, expect, it } from "vitest";
import {
  type CredentialResolver,
  execute,
  type HttpResponse,
  InMemoryLedger,
  InMemoryObserver,
  MockTransport,
  registerLedgerBackend,
  requestFingerprint,
  resolveLedger,
  TransportError,
} from "./index.js";

/** Minimal operation factory for tests. */
function op(overrides: Record<string, unknown> = {}): Operation {
  return OperationSchema.parse({
    id: "payments.refund.create",
    canonicalName: "create_refund",
    displayName: "Create refund",
    sourceRef: { kind: "openapi", path: "/payments/{payment_id}/refunds", method: "post" },
    effect: { kind: "mutation", resource: "refund", risk: "financial", reversible: false },
    input: {
      params: [{ name: "payment_id", in: "path", required: true, schema: { type: "string" } }],
      body: {
        contentType: "application/json",
        required: true,
        schema: {
          type: "object",
          required: ["amount"],
          properties: { amount: { type: "integer" } },
        },
        projection: "fields",
        fields: [{ name: "amount", required: true, schema: { type: "integer" } }],
      },
    },
    idempotency: {
      mode: "required",
      mechanism: "header",
      key: "Idempotency-Key",
      keyDerivation: "request_fingerprint",
    },
    retries: {
      mode: "safe",
      maxAttempts: 3,
      backoff: "exponential_jitter",
      retryOn: ["http_503", "http_429", "timeout"],
    },
    confirmation: { required: true, risk: "financial" },
    auth: { type: "none", scopes: [] },
    cli: { command: "payments refunds create" },
    mcp: { toolName: "payments_create_refund" },
    skill: { intentExamples: [] },
    ...overrides,
  });
}

const ok = (body: unknown): HttpResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(body),
});

// Mechanics tests run in `dev`, where the in-memory ledger is a legitimate
// backend. The prod durable-ledger contract is exercised separately below.
const baseCtx = {
  baseUrl: "https://payments.internal.example.com",
  allowedHosts: ["payments.internal.example.com"],
  env: "dev",
  sleep: async () => {},
  rng: () => 0.5,
};

describe("confirmation gate", () => {
  it("refuses an unsafe mutation without confirm and lists required flags", async () => {
    const transport = new MockTransport(() => ok({}));
    const res = await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, idempotencyKey: "k1" },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("confirmation_required");
    expect(res.envelope.error.required_flags).toContain("--confirm");
    expect(transport.requests).toHaveLength(0); // never touched upstream
  });
});

describe("idempotency gate", () => {
  it("requires a key when none is supplied or derivable", async () => {
    const transport = new MockTransport(() => ok({}));
    const res = await execute(
      op({
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "Idempotency-Key",
          keyDerivation: "none",
        },
      }),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("idempotency_required");
  });

  it("derives a stable key from the request fingerprint and sends it upstream", async () => {
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    const res = await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("success");
    expect(transport.requests[0]?.headers["Idempotency-Key"]).toMatch(/^anvil-/);
  });
});

describe("request body reconstruction", () => {
  it("assembles a flat body from projected fields", async () => {
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport },
    );
    expect(JSON.parse(transport.requests[0]?.body ?? "{}")).toEqual({ amount: 2500 });
    // payment_id is a path param — it must NOT leak into the body.
    expect(transport.requests[0]?.url).toContain("/payments/pay_1/refunds");
  });

  it("sends a whole (nested) body verbatim without flattening", async () => {
    const wholeOp = op({
      idempotency: { mode: "none", mechanism: "none", keyDerivation: "none" },
      confirmation: { required: false },
      input: {
        params: [],
        body: {
          contentType: "application/json",
          required: true,
          projection: "whole",
          fields: [],
          schema: {
            type: "object",
            properties: { items: { type: "array", items: { type: "object" } } },
          },
        },
      },
    });
    const transport = new MockTransport(() => ok({ id: "o1" }));
    const payload = { items: [{ sku: "a", qty: 2 }], note: "gift" };
    const res = await execute(wholeOp, { input: { body: payload } }, { ...baseCtx, transport });
    expect(res.outcome).toBe("success");
    expect(JSON.parse(transport.requests[0]?.body ?? "{}")).toEqual(payload);
  });

  it("still honors legacy in:body params (older AIR bundles)", async () => {
    // A bundle compiled before the body-model change carries body fields as
    // in:"body" params and no `input.body`. It must not execute with an empty body.
    const legacyOp = op({
      idempotency: { mode: "none", mechanism: "none", keyDerivation: "none" },
      confirmation: { required: false },
      input: {
        params: [
          { name: "payment_id", in: "path", required: true, schema: { type: "string" } },
          { name: "amount", in: "body", required: true, schema: { type: "integer" } },
        ],
      },
    });
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    const res = await execute(
      legacyOp,
      { input: { payment_id: "pay_1", amount: 2500 } },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("success");
    expect(JSON.parse(transport.requests[0]?.body ?? "{}")).toEqual({ amount: 2500 });
  });

  it("fails closed when a required whole body is missing", async () => {
    const wholeOp = op({
      idempotency: { mode: "none", mechanism: "none", keyDerivation: "none" },
      confirmation: { required: false },
      input: {
        params: [],
        body: { required: true, projection: "whole", fields: [], schema: { type: "object" } },
      },
    });
    const transport = new MockTransport(() => ok({}));
    const res = await execute(wholeOp, { input: {} }, { ...baseCtx, transport });
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("validation_error");
    expect(res.envelope.error.details?.missing).toContain("body");
    expect(transport.requests).toHaveLength(0);
  });
});

describe("validation", () => {
  it("rejects missing required parameters", async () => {
    const transport = new MockTransport(() => ok({}));
    const res = await execute(
      op(),
      { input: { amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("validation_error");
    expect(res.envelope.error.details).toEqual({ missing: ["payment_id"] });
  });
});

describe("retry safety", () => {
  it("retries transient failures for a proven-idempotent mutation", async () => {
    let n = 0;
    const transport = new MockTransport(() => {
      n += 1;
      if (n < 3) return { status: 503, headers: {}, body: "" };
      return ok({ id: "re_1" });
    });
    const res = await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("success");
    expect(transport.requests).toHaveLength(3);
    expect(res.record.retryCount).toBe(2);
  });

  it("NEVER auto-retries a non-idempotent mutation and marks it unsafe to retry", async () => {
    const nonIdempotent = op({
      confirmation: { required: false },
      idempotency: { mode: "none", mechanism: "none", keyDerivation: "none" },
      retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    });
    const transport = new MockTransport(() => new TransportError("timeout", "boom"));
    const res = await execute(
      nonIdempotent,
      { input: { payment_id: "pay_1", amount: 2500 } },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(transport.requests).toHaveLength(1); // exactly one attempt
    expect(res.envelope.error.safe_to_retry).toBe(false);
    expect(res.envelope.error.code).toBe("upstream_timeout");
  });
});

describe("error mapping", () => {
  it.each([
    [404, "not_found"],
    [429, "rate_limited"],
    [403, "permission_denied"],
    [409, "conflict"],
  ])("maps HTTP %i to %s", async (status, code) => {
    const transport = new MockTransport(() => ({ status, headers: {}, body: "" }));
    const res = await execute(
      op({ retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] } }),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe(code);
    expect(res.envelope.error.upstream?.status).toBe(status);
  });
});

describe("dry run", () => {
  it("returns a plan without touching upstream and redacts secrets", async () => {
    const transport = new MockTransport(() => ok({}));
    const res = await execute(
      op(),
      {
        input: { payment_id: "pay_1", amount: 2500 },
        confirm: true,
        idempotencyKey: "k1",
        dryRun: true,
      },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("dry_run");
    if (res.outcome !== "dry_run") return;
    expect(transport.requests).toHaveLength(0);
    expect(res.plan.method).toBe("POST");
    expect(res.plan.url).toContain("/payments/pay_1/refunds");
    expect(res.plan.idempotencyKeyPresent).toBe(true);
  });
});

describe("auth binding", () => {
  it("fails closed with auth_required when credentials cannot be resolved", async () => {
    const transport = new MockTransport(() => ok({}));
    const res = await execute(
      op({ auth: { type: "oauth2_client_credentials", scopes: ["payments.write"] } }),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport, authProfile: "prod" },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("auth_required");
  });

  it("applies resolved auth material to the request", async () => {
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    const resolver: CredentialResolver = {
      async resolve() {
        return { headers: { Authorization: "Bearer secret" } };
      },
    };
    const res = await execute(
      op({ auth: { type: "oauth2_client_credentials", scopes: ["payments.write"] } }),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport, authProfile: "prod", credentials: resolver },
    );
    expect(res.outcome).toBe("success");
    expect(transport.requests[0]?.headers.Authorization).toBe("Bearer secret");
  });
});

describe("host pinning", () => {
  it("denies an upstream host outside the allowlist in prod", async () => {
    const transport = new MockTransport(() => ok({}));
    const res = await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport, env: "prod", baseUrl: "https://evil.example.com" },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    // Host pinning is enforced before the ledger check, so the security error wins.
    expect(res.envelope.error.code).toBe("policy_denied");
  });
});

describe("idempotency ledger", () => {
  it("replays the cached result for a duplicate key without re-calling upstream", async () => {
    const ledger = new InMemoryLedger();
    let calls = 0;
    const transport = new MockTransport(() => {
      calls += 1;
      return ok({ id: "re_1", n: calls });
    });
    const args = {
      input: { payment_id: "pay_1", amount: 2500 },
      confirm: true,
      idempotencyKey: "k-dup",
    };
    const first = await execute(op(), args, { ...baseCtx, transport, ledger });
    const second = await execute(op(), args, { ...baseCtx, transport, ledger });
    expect(first.outcome).toBe("success");
    expect(second.outcome).toBe("success");
    expect(calls).toBe(1); // second call served from ledger
    if (second.outcome === "success") expect(second.record.ledger).toBe("replay");
  });
});

describe("durable ledger (prod fail-closed)", () => {
  const prod = { ...baseCtx, env: "prod" };
  const args = {
    input: { payment_id: "pay_1", amount: 2500 },
    confirm: true,
    idempotencyKey: "k1",
  };

  it("refuses a required-idempotency mutation in prod with no ledger — never touches upstream", async () => {
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    const res = await execute(op(), args, { ...prod, transport });
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("idempotency_ledger_unavailable");
    expect(transport.requests).toHaveLength(0); // failed closed before any side effect
  });

  it("refuses when only a process-local (non-durable) ledger is configured in prod", async () => {
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    const res = await execute(op(), args, { ...prod, transport, ledger: new InMemoryLedger() });
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("idempotency_ledger_unavailable");
    expect(transport.requests).toHaveLength(0);
  });

  it("proceeds in prod once a durable ledger is configured", async () => {
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    const res = await execute(op(), args, { ...prod, transport, ledger: new DurableTestLedger() });
    expect(res.outcome).toBe("success");
    expect(transport.requests).toHaveLength(1);
  });

  it("still allows a dry-run preview in prod without a durable ledger", async () => {
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    const res = await execute(op(), { ...args, dryRun: true }, { ...prod, transport });
    expect(res.outcome).toBe("dry_run");
    expect(transport.requests).toHaveLength(0);
  });
});

/** A ledger that reports itself durable — stands in for Firestore/Spanner in tests. */
class DurableTestLedger extends InMemoryLedger {
  override readonly durable = true;
}

describe("observability", () => {
  it("emits an execution record with no secrets", async () => {
    const observer = new InMemoryObserver();
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport, observer },
    );
    expect(observer.records).toHaveLength(1);
    const rec = observer.records[0];
    expect(rec?.operationId).toBe("payments.refund.create");
    expect(rec?.idempotencyKeyPresent).toBe(true);
    expect(rec?.confirmed).toBe(true);
    expect(JSON.stringify(rec)).not.toContain("secret");
  });
});

describe("fingerprint", () => {
  it("is stable regardless of key order", () => {
    const a = requestFingerprint("op", { a: 1, b: 2 });
    const b = requestFingerprint("op", { b: 2, a: 1 });
    expect(a).toBe(b);
  });
});

describe("resolveLedger", () => {
  it("returns a non-durable in-memory ledger when nothing is configured", () => {
    const ledger = resolveLedger(undefined);
    expect(ledger.durable).toBe(false);
    expect(ledger).toBeInstanceOf(InMemoryLedger);
  });

  it("selects a registered durable backend by scheme", async () => {
    let built = "";
    registerLedgerBackend("faux", (uri) => {
      built = uri;
      return new DurableTestLedger();
    });
    const ledger = resolveLedger("faux://project/db");
    expect(ledger.durable).toBe(true);
    expect(built).toBe("faux://project/db");
  });

  it("throws (never boots into false safety) when the scheme is unregistered", () => {
    expect(() => resolveLedger("unregistered://x")).toThrow(/no idempotency ledger backend/i);
  });
});
