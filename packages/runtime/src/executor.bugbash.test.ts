import { MAX_RETRY_DELAY_MS, type Operation, Operation as OperationSchema } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { denyPolicy, execute, type HttpResponse, MockTransport, TransportError } from "./index.js";

/**
 * Bug-bash coverage for the runtime safety hot path (executor.ts). Mirrors the
 * operation factory, `ok()` helper, and `baseCtx` shape from `runtime.test.ts`
 * exactly so both files exercise the same fixtures the same way. This file
 * targets branches `runtime.test.ts` and `idempotency-scope.test.ts` do not:
 * policy hooks, header/cookie construction, body-carrier container validation,
 * idempotency key type checks, auth-vs-carrier conflicts for non-header
 * mechanisms, and the finer edges of retry gating.
 */

/** Minimal operation factory for tests — identical to runtime.test.ts's `op()`. */
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
    state: "approved",
    ...overrides,
  });
}

const ok = (body: unknown): HttpResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(body),
});

// dev, matching runtime.test.ts's baseCtx: the in-memory/no ledger is a
// legitimate backend here, so these tests can focus on the branches they target.
const baseCtx = {
  serviceId: "payments",
  baseUrl: "https://payments.internal.example.com",
  allowedHosts: ["payments.internal.example.com"],
  env: "dev",
  sleep: async () => {},
  rng: () => 0.5,
};

describe("policy hooks", () => {
  it("runs the success sequence preValidate -> preAuth -> preExecute -> postResponse -> postExecute", async () => {
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    const res = await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      {
        ...baseCtx,
        transport,
        policy: {
          preValidate: (ctx) => ctx.decide("preValidate"),
          preAuth: (ctx) => ctx.decide("preAuth"),
          preExecute: (ctx) => ctx.decide("preExecute"),
          postResponse: (ctx) => ctx.decide("postResponse"),
          postExecute: (ctx) => ctx.decide("postExecute"),
          postError: (ctx) => ctx.decide("postError"),
        },
      },
    );
    expect(res.outcome).toBe("success");
    expect(res.record.policyDecisions).toEqual([
      "preValidate",
      "preAuth",
      "preExecute",
      "postResponse",
      "postExecute",
    ]);
  });

  it("runs the failure sequence preValidate -> preAuth -> preExecute -> postError -> postExecute (never postResponse)", async () => {
    const transport = new MockTransport(() => ({ status: 500, headers: {}, body: "" }));
    const res = await execute(
      op({ retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] } }),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      {
        ...baseCtx,
        transport,
        policy: {
          preValidate: (ctx) => ctx.decide("preValidate"),
          preAuth: (ctx) => ctx.decide("preAuth"),
          preExecute: (ctx) => ctx.decide("preExecute"),
          postResponse: (ctx) => ctx.decide("postResponse"),
          postExecute: (ctx) => ctx.decide("postExecute"),
          postError: (ctx) => ctx.decide("postError"),
        },
      },
    );
    expect(res.outcome).toBe("error");
    expect(res.record.policyDecisions).toEqual([
      "preValidate",
      "preAuth",
      "preExecute",
      "postError",
      "postExecute",
    ]);
  });

  it("denies at preValidate before any input validation or wire request", async () => {
    const transport = new MockTransport(() => ok({}));
    const res = await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      {
        ...baseCtx,
        transport,
        policy: {
          preValidate: (ctx) => {
            ctx.decide("preValidate:deny");
            denyPolicy(ctx, "blocked by policy for testing");
          },
        },
      },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("policy_denied");
    expect(res.envelope.error.message).toBe("blocked by policy for testing");
    expect(res.record.policyDecisions).toEqual(["preValidate:deny"]);
    expect(transport.requests).toHaveLength(0);
  });

  it("lets preAuth mutate the outbound request before auth material and upstream send", async () => {
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    const res = await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      {
        ...baseCtx,
        transport,
        policy: {
          preAuth: (ctx) => {
            if (ctx.request) ctx.request.headers["x-policy-injected"] = "yes";
          },
        },
      },
    );
    expect(res.outcome).toBe("success");
    expect(transport.requests[0]?.headers["x-policy-injected"]).toBe("yes");
  });

  it("wraps a plain Error thrown from a policy hook as unknown_upstream_error", async () => {
    const transport = new MockTransport(() => ok({}));
    const res = await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      {
        ...baseCtx,
        transport,
        policy: {
          preValidate: () => {
            throw new Error("boom from policy");
          },
        },
      },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("unknown_upstream_error");
    expect(res.envelope.error.message).toBe("boom from policy");
    expect(transport.requests).toHaveLength(0);
  });

  // BUG: `runHook` (executor.ts) only ever forwards `request` at every one of
  // its 6 call sites (preValidate/preAuth/preExecute/postResponse/postExecute/
  // postError) — `PolicyContext.response` is declared in policy.ts specifically
  // for a postResponse hook to inspect the upstream result, but the executor
  // never assigns it. A postResponse hook can therefore never see the response
  // status/body it is named for; it degrades to a same-timing alias of
  // postExecute. Fix: thread `res` into `runHook(ctx.policy?.postResponse, request, res)`.
  it.fails("BUG: postResponse hook never receives the actual HttpResponse via ctx.response", async () => {
    let capturedResponse: unknown = "unset";
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      {
        ...baseCtx,
        transport,
        policy: {
          postResponse: (ctx) => {
            capturedResponse = ctx.response;
          },
        },
      },
    );
    expect(capturedResponse).toBeDefined();
  });
});

describe("header redaction (dry run)", () => {
  it.each([
    ["Authorization", "authorization", "Bearer super-secret"],
    ["X-Api-Key", "x_api_key", "sk-live-secret"],
    ["Proxy-Authorization", "proxy_authorization", "Basic secret-creds"],
  ])("redacts the %s header in the dry-run plan", async (headerName, propName, secretValue) => {
    const sensitiveOp = op({
      input: {
        params: [
          { name: "payment_id", in: "path", required: true, schema: { type: "string" } },
          { name: headerName, in: "header", required: true, schema: { type: "string" } },
        ],
        body: op().input.body,
      },
    });
    const transport = new MockTransport(() => ok({}));
    const res = await execute(
      sensitiveOp,
      {
        input: { payment_id: "pay_1", amount: 2500, [propName]: secretValue },
        confirm: true,
        dryRun: true,
      },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("dry_run");
    if (res.outcome !== "dry_run") return;
    expect(res.plan.headers[headerName]).toBe("***");
    expect(JSON.stringify(res.plan)).not.toContain(secretValue);
    expect(transport.requests).toHaveLength(0);
  });

  it("does not redact an ordinary (non-reserved) header param", async () => {
    const plainOp = op({
      input: {
        params: [
          { name: "payment_id", in: "path", required: true, schema: { type: "string" } },
          { name: "X-Request-Context", in: "header", required: true, schema: { type: "string" } },
        ],
        body: op().input.body,
      },
    });
    const transport = new MockTransport(() => ok({}));
    const res = await execute(
      plainOp,
      {
        input: { payment_id: "pay_1", amount: 2500, x_request_context: "trace-abc" },
        confirm: true,
        dryRun: true,
      },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("dry_run");
    if (res.outcome !== "dry_run") return;
    expect(res.plan.headers["X-Request-Context"]).toBe("trace-abc");
  });
});

describe("cookie-location parameters", () => {
  const cookieOp = op({
    input: {
      params: [
        { name: "payment_id", in: "path", required: true, schema: { type: "string" } },
        { name: "session_id", in: "cookie", required: true, schema: { type: "string" } },
        { name: "csrf_token", in: "cookie", required: true, schema: { type: "string" } },
      ],
      body: op().input.body,
    },
  });

  it("assembles and joins multiple cookie params into one Cookie header", async () => {
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    const res = await execute(
      cookieOp,
      {
        input: {
          payment_id: "pay_1",
          amount: 2500,
          session_id: "sess-abc",
          csrf_token: "csrf-xyz",
        },
        confirm: true,
        idempotencyKey: "k1",
      },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("success");
    expect(transport.requests[0]?.headers.cookie).toBe("session_id=sess-abc; csrf_token=csrf-xyz");
  });

  it("redacts the assembled Cookie header in a dry-run plan", async () => {
    const transport = new MockTransport(() => ok({}));
    const res = await execute(
      cookieOp,
      {
        input: {
          payment_id: "pay_1",
          amount: 2500,
          session_id: "sess-abc",
          csrf_token: "csrf-xyz",
        },
        confirm: true,
        idempotencyKey: "k1",
        dryRun: true,
      },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("dry_run");
    if (res.outcome !== "dry_run") return;
    expect(res.plan.headers.cookie).toBe("***");
    expect(transport.requests).toHaveLength(0);
  });
});

describe("idempotency body-carrier container validation", () => {
  it("refuses a non-object whole body when a carrier must nest a key into it", async () => {
    const transport = new MockTransport(() => ok({}));
    const wholeBodyOp = op({
      confirmation: { required: false },
      idempotency: {
        mode: "required",
        mechanism: "body",
        key: "idempotencyKey",
        keyDerivation: "client_supplied",
      },
      input: {
        params: [],
        body: {
          contentType: "application/json",
          required: true,
          projection: "whole",
          fields: [],
          schema: { type: "object", properties: { idempotencyKey: { type: "string" } } },
        },
      },
    });
    const res = await execute(
      wholeBodyOp,
      { input: { body: "not-an-object" }, idempotencyKey: "k1" },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("validation_error");
    expect(res.envelope.error.message).toBe(
      "The request body must be an object to carry the idempotency key.",
    );
    expect(transport.requests).toHaveLength(0);
  });

  it("refuses a non-object intermediate body field on the carrier path", async () => {
    const transport = new MockTransport(() => ok({}));
    const nestedOp = op({
      confirmation: { required: false },
      idempotency: {
        mode: "required",
        mechanism: "body",
        key: "/meta/key",
        keyDerivation: "client_supplied",
      },
      input: {
        params: [],
        body: {
          contentType: "application/json",
          required: true,
          projection: "whole",
          fields: [],
          schema: {
            type: "object",
            properties: {
              meta: { type: "object", properties: { key: { type: "string" } } },
            },
          },
        },
      },
    });
    const res = await execute(
      nestedOp,
      { input: { body: { meta: "not-an-object" } }, idempotencyKey: "k1" },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("validation_error");
    expect(res.envelope.error.message).toBe(
      "Body field 'meta' must be an object to carry the idempotency key.",
    );
    expect(transport.requests).toHaveLength(0);
  });

  it("auto-creates missing intermediate containers for a multi-segment body carrier path", async () => {
    const transport = new MockTransport(() => ok({ id: "order_1" }));
    const deepOp = op({
      sourceRef: { kind: "graphql", path: "/graphql/Mutation/checkout", method: "post" },
      confirmation: { required: false },
      idempotency: {
        mode: "required",
        mechanism: "body",
        key: "/meta/tracking/idempotencyKey",
        keyDerivation: "client_supplied",
      },
      input: {
        params: [],
        body: {
          contentType: "application/json",
          required: true,
          projection: "whole",
          fields: [],
          schema: {
            type: "object",
            properties: {
              cartId: { type: "string" },
              meta: {
                type: "object",
                properties: {
                  tracking: {
                    type: "object",
                    properties: { idempotencyKey: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    });
    const caller = { cartId: "cart_1" };
    const res = await execute(
      deepOp,
      { input: { body: caller }, idempotencyKey: "deep-key" },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("success");
    expect(JSON.parse(transport.requests[0]?.body ?? "{}")).toEqual({
      cartId: "cart_1",
      meta: { tracking: { idempotencyKey: "deep-key" } },
    });
    // The caller's object must never be mutated in place.
    expect(caller).toEqual({ cartId: "cart_1" });
  });
});

describe("idempotency key type validation", () => {
  it("refuses a non-string modeled body-carrier value even when the schema declares string", async () => {
    const transport = new MockTransport(() => ok({ id: "must-not-run" }));
    const businessCarrierOp = op({
      confirmation: { required: false },
      idempotency: {
        mode: "required",
        mechanism: "body",
        key: "idempotency_key",
        keyDerivation: "client_supplied",
      },
      input: {
        params: [{ name: "payment_id", in: "path", required: true, schema: { type: "string" } }],
        body: {
          contentType: "application/json",
          required: true,
          projection: "fields",
          fields: [
            { name: "amount", required: true, schema: { type: "integer" } },
            { name: "idempotency_key", required: false, schema: { type: "string" } },
          ],
          schema: {
            type: "object",
            required: ["amount"],
            properties: {
              amount: { type: "integer" },
              idempotency_key: { type: "string" },
            },
          },
        },
      },
    });
    const res = await execute(
      businessCarrierOp,
      { input: { payment_id: "pay_1", amount: 2500, idempotency_key: 12345 } },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("validation_error");
    expect(res.envelope.error.message).toBe(
      "The modeled idempotency carrier must contain a string key.",
    );
    expect(transport.requests).toHaveLength(0);
  });

  it("refuses a non-string caller idempotency key supplied through MCP business input", async () => {
    const transport = new MockTransport(() => ok({ id: "must-not-run" }));
    const res = await execute(
      op(),
      {
        input: { payment_id: "pay_1", amount: 2500, idempotency_key: 42 },
        confirm: true,
      },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("validation_error");
    expect(res.envelope.error.message).toMatch(/visible ASCII/i);
    expect(transport.requests).toHaveLength(0);
  });
});

describe("auth material vs idempotency carrier conflicts", () => {
  it("refuses a resolved query credential that would overwrite a query idempotency carrier", async () => {
    const transport = new MockTransport(() => ok({ id: "must-not-run" }));
    const queryOp = op({
      idempotency: {
        mode: "required",
        mechanism: "query",
        key: "request_key",
        keyDerivation: "client_supplied",
      },
      auth: {
        type: "api_key",
        scopes: [],
        carrier: { in: "header", name: "X-Auth-Key" },
      },
      input: {
        params: [
          { name: "payment_id", in: "path", required: true, schema: { type: "string" } },
          { name: "request_key", in: "query", required: true, schema: { type: "string" } },
        ],
        body: op().input.body,
      },
    });
    const res = await execute(
      queryOp,
      {
        input: { payment_id: "pay_1", amount: 2500 },
        confirm: true,
        idempotencyKey: "query-key",
      },
      {
        ...baseCtx,
        transport,
        credentials: {
          // Runtime-resolved material can drift from the static AIR carrier
          // declaration; the executor must re-check the *resolved* material.
          resolve: async () => ({ query: { request_key: "leaked-secret" } }),
        },
      },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("unsupported_operation");
    expect(JSON.stringify(res.envelope)).not.toContain("leaked-secret");
    expect(transport.requests).toHaveLength(0);
  });

  it("does not false-positive a conflict for a path-mechanism idempotency carrier", async () => {
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    const pathOp = op({
      sourceRef: { kind: "openapi", path: "/requests/{request_key}", method: "post" },
      idempotency: {
        mode: "required",
        mechanism: "path",
        key: "request_key",
        keyDerivation: "client_supplied",
      },
      auth: {
        type: "api_key",
        scopes: [],
        carrier: { in: "header", name: "X-Auth-Key" },
      },
      input: {
        params: [{ name: "request_key", in: "path", required: true, schema: { type: "string" } }],
      },
    });
    const res = await execute(
      pathOp,
      { input: {}, confirm: true, idempotencyKey: "path/key" },
      {
        ...baseCtx,
        transport,
        credentials: {
          resolve: async () => ({ headers: { "X-Auth-Key": "secret" } }),
        },
      },
    );
    expect(res.outcome).toBe("success");
    expect(transport.requests[0]?.headers["X-Auth-Key"]).toBe("secret");
  });
});

describe("retry gating (safety contract)", () => {
  it("exhausts all bounded attempts on repeated transient failures and returns the final upstream error", async () => {
    let calls = 0;
    const transport = new MockTransport(() => {
      calls += 1;
      return { status: 503, headers: {}, body: "" };
    });
    const res = await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(calls).toBe(3); // op().retries.maxAttempts
    expect(transport.requests).toHaveLength(3);
    expect(res.record.retryCount).toBe(2);
    expect(res.envelope.error.code).toBe("upstream_unavailable");
  });

  it("does not retry a transient status code absent from the operation's retryOn allowlist", async () => {
    const transport = new MockTransport(() => ({ status: 500, headers: {}, body: "" }));
    const res = await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(transport.requests).toHaveLength(1); // 500 is not in op().retries.retryOn
    expect(res.envelope.error.code).toBe("unknown_upstream_error");
    expect(res.envelope.error.safe_to_retry).toBe(false);
  });

  it("does not retry a status code with no retry condition at all, even under a safe policy", async () => {
    const transport = new MockTransport(() => ({ status: 400, headers: {}, body: "" }));
    const res = await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(transport.requests).toHaveLength(1);
    expect(res.envelope.error.code).toBe("validation_error");
  });

  it("does not retry a transient transport failure whose condition is outside the retryOn allowlist", async () => {
    const transport = new MockTransport(
      () => new TransportError("dns_failure", "name did not resolve"),
    );
    const res = await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(transport.requests).toHaveLength(1);
    expect(res.envelope.error.code).toBe("upstream_unavailable");
    // Not retried this run, but honestly labeled retryable under this op's contract.
    expect(res.envelope.error.safe_to_retry).toBe(true);
  });

  it("classifies a non-timeout transport failure distinctly from a timeout", async () => {
    const transport = new MockTransport(
      () => new TransportError("connection_reset", "peer reset the connection"),
    );
    const res = await execute(
      op({ retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] } }),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("upstream_unavailable");
    expect(transport.requests).toHaveLength(1);
  });

  it("ctx.retries=false forces a single attempt even for a proven-idempotent, policy-safe mutation", async () => {
    let calls = 0;
    const transport = new MockTransport(() => {
      calls += 1;
      return { status: 503, headers: {}, body: "" };
    });
    const res = await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport, retries: false },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(calls).toBe(1);
    // Safe in principle (proven idempotent), just not auto-retried on this call.
    expect(res.envelope.error.safe_to_retry).toBe(true);
  });

  it("propagates (and never retries) an unexpected non-transport error thrown by the transport", async () => {
    const transport = new MockTransport(() => {
      throw new Error("totally unexpected transport bug");
    });
    const res = await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("unknown_upstream_error");
    expect(res.envelope.error.message).toBe("totally unexpected transport bug");
    expect(transport.requests).toHaveLength(1); // never retried
  });
});

describe("dry-run retry plan", () => {
  // BUG: executor.ts's dry-run branch computes `retryPlan.maxAttempts` from
  // `retrySafe` alone (`retrySafe ? op.retries.maxAttempts : 1`, executor.ts
  // line 879), while `retryPlan.enabled` correctly factors in the
  // `ctx.retries === false` override (line 878) — the same combined condition
  // the real execution path uses to cap attempts at 1 (`retriesEnabled` /
  // `maxAttempts`, executor.ts lines 1032-1033). So forcing `ctx.retries:
  // false` on an otherwise-safe idempotent mutation yields a self-contradictory
  // plan: `{ enabled: false, maxAttempts: 3 }`, which misrepresents what
  // execution will actually do (cap at 1 attempt). Fix: mirror the enabled
  // condition, e.g. `maxAttempts: retrySafe && ctx.retries !== false ?
  // op.retries.maxAttempts : 1`.
  it.fails("BUG: disables the retry plan when ctx.retries is forced false, even for a safe idempotent mutation", async () => {
    const transport = new MockTransport(() => ok({}));
    const res = await execute(
      op(),
      {
        input: { payment_id: "pay_1", amount: 2500 },
        confirm: true,
        idempotencyKey: "k1",
        dryRun: true,
      },
      { ...baseCtx, transport, retries: false },
    );
    expect(res.outcome).toBe("dry_run");
    if (res.outcome !== "dry_run") return;
    expect(res.plan.retryPlan).toEqual({ enabled: false, maxAttempts: 1 });
  });

  it("disables the retry plan for a non-idempotent mutation regardless of policy", async () => {
    const transport = new MockTransport(() => ok({}));
    const nonIdempotentOp = op({
      confirmation: { required: false },
      idempotency: { mode: "none", mechanism: "none", keyDerivation: "none" },
    });
    const res = await execute(
      nonIdempotentOp,
      { input: { payment_id: "pay_1", amount: 2500 }, dryRun: true },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("dry_run");
    if (res.outcome !== "dry_run") return;
    expect(res.plan.retryPlan).toEqual({ enabled: false, maxAttempts: 1 });
    expect(res.plan.idempotencyKeyPresent).toBe(false);
  });
});

describe("retry contract bounds (bypassing AIR schema validation)", () => {
  // AIR's own zod schema already rejects these at parse time; these tests
  // simulate a runtime embedder / drifted bundle that hands the executor an
  // already-parsed Operation object with an out-of-bounds retry contract, to
  // prove the executor's own defense-in-depth bound check (not just AIR's).
  it.each([
    ["maxAttempts is zero", { maxAttempts: 0 }],
    ["maxAttempts is not an integer", { maxAttempts: 1.5 }],
    ["baseDelayMs is negative", { baseDelayMs: -1 }],
    ["baseDelayMs exceeds the runtime bound", { baseDelayMs: MAX_RETRY_DELAY_MS + 1 }],
    ["maxDelayMs exceeds the runtime bound", { maxDelayMs: MAX_RETRY_DELAY_MS + 1 }],
  ])("refuses a retry contract that is %s", async (_label, override) => {
    const transport = new MockTransport(() => ok({ id: "must-not-run" }));
    const malformed = { ...op(), retries: { ...op().retries, ...override } } as Operation;
    const res = await execute(
      malformed,
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("unsupported_operation");
    expect(transport.requests).toHaveLength(0);
  });
});

describe("canonical upstream fingerprinting", () => {
  it("fails closed with policy_denied when the base URL cannot be parsed as a URL", async () => {
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    const res = await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport, baseUrl: "not a valid base url" },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("policy_denied");
    expect(transport.requests).toHaveLength(0);
  });
});
