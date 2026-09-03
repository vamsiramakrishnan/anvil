import { type Operation, Operation as OperationSchema } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { execute } from "./executor.js";
import { buildLimitsGate } from "./limits.js";
import { ANONYMOUS_PRINCIPAL } from "./policy.js";
import { MockTransport } from "./transport.js";

/**
 * Fleet-runtime safety coverage: principal scope denial and rate/spend
 * limits, both gated BEFORE any upstream call and never retried. Mirrors the
 * `op()`/`baseCtx` fixture shape from `executor.bugbash.test.ts` so this file
 * reads as an extension of the same hot-path suite, not a parallel one.
 */

function op(overrides: Record<string, unknown> = {}): Operation {
  return OperationSchema.parse({
    id: "orders.list",
    canonicalName: "list_orders",
    displayName: "List orders",
    sourceRef: { kind: "openapi", path: "/orders", method: "get" },
    effect: { kind: "read", resource: "order", risk: "low" },
    input: { params: [] },
    idempotency: { mode: "natural", mechanism: "none" },
    retries: { mode: "safe", maxAttempts: 3, backoff: "exponential_jitter", retryOn: ["http_503"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: ["orders.read"] },
    cli: { command: "orders list" },
    mcp: { toolName: "orders_list_orders" },
    skill: { intentExamples: [] },
    state: "approved",
    ...overrides,
  });
}

const ok = () => ({ status: 200, headers: {}, body: "[]" });

const baseCtx = {
  serviceId: "orders",
  baseUrl: "https://orders.internal.example.com",
  allowedHosts: ["orders.internal.example.com"],
  env: "dev" as const,
  sleep: async () => {},
  rng: () => 0.5,
};

describe("principal scope gate", () => {
  it("defaults to the anonymous, every-scope principal and never denies when unconfigured", async () => {
    const transport = new MockTransport(ok);
    const res = await execute(op(), { input: {} }, { ...baseCtx, transport });
    expect(res.outcome).toBe("success");
    expect(res.record.principalId).toBe("anonymous");
    expect(transport.requests).toHaveLength(1);
  });

  it("denies a named principal missing a required scope BEFORE any upstream call", async () => {
    const transport = new MockTransport(ok);
    const res = await execute(
      op(),
      { input: {} },
      { ...baseCtx, transport, principal: { id: "alice", scopes: ["orders.write"] } },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") throw new Error("unreachable");
    expect(res.envelope.error.code).toBe("policy_denied");
    expect(res.envelope.error.details).toMatchObject({
      code: "policy/scope_denied",
      principalId: "alice",
      missing: ["orders.read"],
    });
    expect(res.envelope.error.retryable).toBe(false);
    // The load-bearing assertion: denial happened before any request reached
    // the transport at all.
    expect(transport.requests).toHaveLength(0);
    expect(res.record.principalId).toBe("alice");
  });

  it("never leaks the credential that resolved a principal into the record", async () => {
    const transport = new MockTransport(ok);
    const res = await execute(
      op(),
      { input: {} },
      { ...baseCtx, transport, principal: { id: "alice", scopes: ["orders.read"] } },
    );
    expect(res.outcome).toBe("success");
    expect(res.record.principalId).toBe("alice");
    expect(JSON.stringify(res.record)).not.toContain("bearer");
  });

  it("a wildcard-scoped principal (e.g. anonymous) is authorized for any declared scope", async () => {
    const transport = new MockTransport(ok);
    const res = await execute(
      op(),
      { input: {} },
      { ...baseCtx, transport, principal: ANONYMOUS_PRINCIPAL },
    );
    expect(res.outcome).toBe("success");
  });
});

describe("rate/spend limits", () => {
  it("is unlimited by default (no limits configured)", async () => {
    const transport = new MockTransport(ok);
    for (let i = 0; i < 5; i++) {
      const res = await execute(op(), { input: {} }, { ...baseCtx, transport });
      expect(res.outcome).toBe("success");
    }
    expect(transport.requests).toHaveLength(5);
  });

  it("refuses over the per-principal rate limit BEFORE any upstream call, never retried", async () => {
    const transport = new MockTransport(ok);
    const limits = buildLimitsGate({ rate: { capacity: 1, refillPerSecond: 0 } });
    const ctx = {
      ...baseCtx,
      transport,
      limits,
      principal: { id: "alice", scopes: ["orders.read"] },
      now: () => 1_000,
    };
    const first = await execute(op(), { input: {} }, ctx);
    expect(first.outcome).toBe("success");
    const second = await execute(op(), { input: {} }, ctx);
    expect(second.outcome).toBe("error");
    if (second.outcome !== "error") throw new Error("unreachable");
    expect(second.envelope.error.code).toBe("rate_limited");
    expect(second.envelope.error.retryable).toBe(false);
    expect(second.envelope.error.details).toMatchObject({ code: "policy/rate_limited" });
    // Exactly one request reached the transport — the refused call never did.
    expect(transport.requests).toHaveLength(1);
  });

  it("refuses over the per-principal spend budget BEFORE any upstream call, never retried", async () => {
    const transport = new MockTransport(ok);
    const limits = buildLimitsGate({ spend: { budget: 1, windowMs: 60_000 } });
    const ctx = {
      ...baseCtx,
      transport,
      limits,
      principal: { id: "alice", scopes: ["orders.read"] },
      now: () => 1_000,
    };
    // A read at risk "low" costs 1 unit (costTierFor) — the first call spends
    // the whole budget; the second has nothing left.
    const first = await execute(op(), { input: {} }, ctx);
    expect(first.outcome).toBe("success");
    const second = await execute(op(), { input: {} }, ctx);
    expect(second.outcome).toBe("error");
    if (second.outcome !== "error") throw new Error("unreachable");
    expect(second.envelope.error.code).toBe("policy_denied");
    expect(second.envelope.error.retryable).toBe(false);
    expect(second.envelope.error.details).toMatchObject({ code: "policy/budget_exhausted" });
    expect(transport.requests).toHaveLength(1);
  });

  it("rate limiting and spend budgets are independent per principal", async () => {
    const transport = new MockTransport(ok);
    const limits = buildLimitsGate({ rate: { capacity: 1, refillPerSecond: 0 } });
    const now = () => 1_000;
    const alice = await execute(
      op(),
      { input: {} },
      { ...baseCtx, transport, limits, principal: { id: "alice", scopes: ["orders.read"] }, now },
    );
    const bob = await execute(
      op(),
      { input: {} },
      { ...baseCtx, transport, limits, principal: { id: "bob", scopes: ["orders.read"] }, now },
    );
    expect(alice.outcome).toBe("success");
    expect(bob.outcome).toBe("success");
  });
});
