import { type Operation, Operation as OperationSchema } from "@anvil/air";
import { describe, expect, it } from "vitest";
import {
  type CredentialResolver,
  EnvCredentialResolver,
  execute,
  type HttpResponse,
  type IdempotencyLedger,
  InMemoryLedger,
  InMemoryObserver,
  MockTransport,
  normalizeEnv,
  registerLedgerBackend,
  requestFingerprint,
  resolveIdempotencyKey,
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
    // The executor refuses anything else before any other step; mechanics
    // tests exercise an approved operation. The approval gate has its own suite.
    state: "approved",
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
  serviceId: "payments",
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
    expect(res.envelope.error.required_flags).toEqual(["--confirm"]);
    expect(transport.requests).toHaveLength(0); // never touched upstream
  });

  it("lists an absent caller key only when the required-key contract cannot derive one", async () => {
    const transport = new MockTransport(() => ok({}));
    const operation = op({
      idempotency: {
        mode: "required",
        mechanism: "header",
        key: "Idempotency-Key",
        keyDerivation: "client_supplied",
      },
    });

    const missing = await execute(
      operation,
      { input: { payment_id: "pay_1", amount: 2500 } },
      { ...baseCtx, transport },
    );
    expect(missing.outcome).toBe("error");
    if (missing.outcome === "error") {
      expect(missing.envelope.error.required_flags).toEqual(["--confirm", "--idempotency-key"]);
    }

    const supplied = await execute(
      operation,
      { input: { payment_id: "pay_1", amount: 2500 }, idempotencyKey: "refund-pay_1" },
      { ...baseCtx, transport },
    );
    expect(supplied.outcome).toBe("error");
    if (supplied.outcome === "error") {
      expect(supplied.envelope.error.required_flags).toEqual(["--confirm"]);
    }
    expect(transport.requests).toHaveLength(0);
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

  it("injects one header when source and policy casing differ", async () => {
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    const operation = op({
      input: {
        params: [
          { name: "payment_id", in: "path", required: true, schema: { type: "string" } },
          {
            name: "idempotency-key",
            in: "header",
            required: true,
            schema: { type: "string" },
          },
        ],
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
    });

    const res = await execute(
      operation,
      {
        input: { payment_id: "pay_1", amount: 2500 },
        confirm: true,
        idempotencyKey: "refund-key-1",
      },
      { ...baseCtx, transport },
    );

    expect(res.outcome).toBe("success");
    const headers = transport.requests[0]?.headers ?? {};
    expect(Object.keys(headers).filter((name) => name.toLowerCase() === "idempotency-key")).toEqual([
      "Idempotency-Key",
    ]);
    expect(new Headers(headers).get("idempotency-key")).toBe("refund-key-1");
  });

  it("refuses a resolved credential that would overwrite the idempotency carrier", async () => {
    let reservations = 0;
    const ledger: IdempotencyLedger = {
      durable: true,
      reserve: async () => {
        reservations += 1;
        return { outcome: "reserved" };
      },
      complete: async () => {},
      release: async () => {},
    };
    const transport = new MockTransport(() => ok({ id: "must-not-run" }));
    const operation = op({
      auth: {
        type: "api_key",
        scopes: [],
        carrier: { in: "header", name: "X-Auth-Key" },
      },
    });

    const res = await execute(
      operation,
      {
        input: { payment_id: "pay_1", amount: 2500 },
        confirm: true,
        idempotencyKey: "refund-key-1",
      },
      {
        ...baseCtx,
        transport,
        ledger,
        credentials: {
          // A runtime override/custom resolver can drift from AIR. The
          // executor must still fail before reserving or invoking upstream.
          resolve: async () => ({ headers: { "idempotency-key": "secret-api-key" } }),
        },
      },
    );

    expect(res.outcome).toBe("error");
    if (res.outcome === "error") {
      expect(res.envelope.error.code).toBe("unsupported_operation");
      expect(JSON.stringify(res.envelope)).not.toContain("secret-api-key");
    }
    expect(reservations).toBe(0);
    expect(transport.requests).toHaveLength(0);
  });

  it("injects an exact modeled query carrier without requiring a duplicate input", async () => {
    const queryOp = op({
      idempotency: {
        mode: "required",
        mechanism: "query",
        key: "request_key",
        keyDerivation: "client_supplied",
      },
      input: {
        params: [
          { name: "payment_id", in: "path", required: true, schema: { type: "string" } },
          { name: "request_key", in: "query", required: true, schema: { type: "string" } },
        ],
      },
    });
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    const res = await execute(
      queryOp,
      { input: { payment_id: "pay_1" }, confirm: true, idempotencyKey: "query-key" },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("success");
    expect(transport.requests[0]?.url).toContain("request_key=query-key");
  });

  it("injects an exact modeled path carrier and URL-encodes the safety key", async () => {
    const pathOp = op({
      sourceRef: { kind: "openapi", path: "/requests/{request_key}", method: "post" },
      idempotency: {
        mode: "required",
        mechanism: "path",
        key: "request_key",
        keyDerivation: "client_supplied",
      },
      input: {
        params: [{ name: "request_key", in: "path", required: true, schema: { type: "string" } }],
      },
    });
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    const res = await execute(
      pathOp,
      { input: {}, confirm: true, idempotencyKey: "path/key" },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("success");
    expect(transport.requests[0]?.url).toContain("/requests/path%2Fkey");
  });

  it("injects a nested JSON Pointer body carrier without mutating caller input", async () => {
    const bodyOp = op({
      sourceRef: { kind: "graphql", path: "/graphql/Mutation/checkout", method: "post" },
      idempotency: {
        mode: "required",
        mechanism: "body",
        key: "/input/idempotencyKey",
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
              input: {
                type: "object",
                properties: {
                  cartId: { type: "string" },
                  idempotencyKey: { type: "string" },
                },
              },
            },
          },
        },
      },
    });
    const body = { input: { cartId: "cart_1" } };
    const transport = new MockTransport(() => ok({ id: "order_1" }));
    const res = await execute(
      bodyOp,
      { input: { body }, confirm: true, idempotencyKey: "body-key" },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("success");
    expect(JSON.parse(transport.requests[0]?.body ?? "{}")).toEqual({
      input: { cartId: "cart_1", idempotencyKey: "body-key" },
    });
    expect(body).toEqual({ input: { cartId: "cart_1" } });
  });

  it("refuses an unmodeled carrier before a dry-run or retry can claim safety", async () => {
    const transport = new MockTransport(() => ({ status: 503, headers: {}, body: "" }));
    const res = await execute(
      op({
        idempotency: {
          mode: "required",
          mechanism: "query",
          key: "invented_key",
          keyDerivation: "client_supplied",
        },
      }),
      {
        input: { payment_id: "pay_1", amount: 2500 },
        confirm: true,
        idempotencyKey: "k1",
        dryRun: true,
      },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("unsupported_operation");
    expect(transport.requests).toHaveLength(0);
  });

  it("refuses conflicting safety and modeled carrier values", async () => {
    const bodyOp = op({
      idempotency: {
        mode: "required",
        mechanism: "body",
        key: "idempotency_key",
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
            properties: { idempotency_key: { type: "string" } },
          },
        },
      },
    });
    const transport = new MockTransport(() => ok({}));
    const res = await execute(
      bodyOp,
      {
        input: { body: { idempotency_key: "body-key" } },
        confirm: true,
        idempotencyKey: "flag-key",
      },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("validation_error");
    expect(transport.requests).toHaveLength(0);
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

describe("approval gate", () => {
  const args = {
    input: { payment_id: "pay_1", amount: 2500 },
    confirm: true,
    idempotencyKey: "k1",
  };

  it.each([
    "generated",
    "review_required",
    "deprecated",
    "blocked",
  ] as const)("refuses a %s operation before any other step — zero wire requests", async (state) => {
    const transport = new MockTransport(() => ok({}));
    const res = await execute(op({ state }), args, { ...baseCtx, transport });
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("unsupported_operation");
    expect(res.envelope.error.retryable).toBe(false);
    // The refusal names the state and the next action, not a dead end.
    expect(res.envelope.error.message).toContain(`state: ${state}`);
    expect(res.envelope.error.message).toContain("anvil approve");
    expect(transport.requests).toHaveLength(0);
  });

  it("refuses a dry-run of an unapproved operation — no plan for the unplannable", async () => {
    const transport = new MockTransport(() => ok({}));
    const res = await execute(
      op({ state: "review_required" }),
      { ...args, dryRun: true },
      { ...baseCtx, transport },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("unsupported_operation");
    expect(transport.requests).toHaveLength(0);
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

  it("names the exact env vars the default resolver would read — names only, never values", async () => {
    const transport = new MockTransport(() => ok({}));
    const res = await execute(
      op({ auth: { type: "oauth2_client_credentials", scopes: ["payments.write"] } }),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport, authProfile: "prod", credentials: new EnvCredentialResolver({}) },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("auth_required");
    expect(res.envelope.error.message).toContain("ANVIL_PROD_TOKEN");
    expect(res.envelope.error.details).toEqual({ expected_env: ["ANVIL_PROD_TOKEN"] });
  });

  it("names both env vars for basic auth profiles", async () => {
    const transport = new MockTransport(() => ok({}));
    const res = await execute(
      op({ auth: { type: "basic", scopes: [] } }),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport, credentials: new EnvCredentialResolver({}) },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.details).toEqual({
      expected_env: ["ANVIL_DEFAULT_USERNAME", "ANVIL_DEFAULT_PASSWORD"],
    });
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

  it("routes each source security scheme through its own credential profile", async () => {
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    const seen: string[] = [];
    const resolver: CredentialResolver = {
      async resolve(profile) {
        seen.push(profile);
        return { headers: { Authorization: "Bearer secret" } };
      },
    };
    const res = await execute(
      op({
        auth: {
          type: "oauth2_client_credentials",
          scopes: ["payments.write"],
          credentialProfile: "partner_oauth_11111111111111111111111111111111",
        },
      }),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport, authProfile: "prod", credentials: resolver },
    );
    expect(res.outcome).toBe("success");
    expect(seen).toEqual(["prod_partner_oauth_11111111111111111111111111111111"]);
  });

  it("threads the inbound caller identity to the resolver as call context (OBO subject)", async () => {
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    const seen: unknown[] = [];
    const resolver: CredentialResolver = {
      async resolve(_profile, _auth, callCtx) {
        seen.push(callCtx);
        return { headers: { Authorization: "Bearer exchanged" } };
      },
    };
    const inbound = {
      subjectToken: "USER.JWT.TOKEN",
      subjectTokenType: "jwt" as const,
      sub: "user-1",
      claims: { iss: "https://identity.example.com", sub: "user-1" },
    };
    const res = await execute(
      op({ auth: { type: "oauth2_on_behalf_of", principal: "delegated", scopes: [] } }),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      { ...baseCtx, transport, authProfile: "prod", credentials: resolver, inbound },
    );
    expect(res.outcome).toBe("success");
    expect(seen[0]).toEqual({ inbound });
    expect(transport.requests[0]?.headers.Authorization).toBe("Bearer exchanged");
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

  it.each([
    [201, '{"id":"created"}'],
    [204, ""],
  ])("preserves upstream status %i when replaying a completed write", async (status, body) => {
    const ledger = new InMemoryLedger();
    let calls = 0;
    const transport = new MockTransport(() => {
      calls += 1;
      return { status, headers: {}, body };
    });
    const args = {
      input: { payment_id: "pay_1", amount: 2500 },
      confirm: true,
      idempotencyKey: `status-${status}`,
    };

    const first = await execute(op(), args, { ...baseCtx, transport, ledger });
    const replay = await execute(op(), args, { ...baseCtx, transport, ledger });

    expect(first.outcome).toBe("success");
    expect(replay.outcome).toBe("success");
    if (replay.outcome !== "success") return;
    expect(replay.status).toBe(status);
    expect(calls).toBe(1);
  });

  it("allows exactly one concurrent invocation to reach the upstream", async () => {
    const ledger = new InMemoryLedger();
    let releaseUpstream!: (value: HttpResponse) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const upstream = new Promise<HttpResponse>((resolve) => {
      releaseUpstream = resolve;
    });
    let calls = 0;
    const transport = {
      send: async () => {
        calls += 1;
        markStarted();
        return upstream;
      },
    };
    const args = {
      input: { payment_id: "pay_1", amount: 2500 },
      confirm: true,
      idempotencyKey: "concurrent-key",
    };

    const firstPromise = execute(op(), args, { ...baseCtx, transport, ledger });
    await started;
    const concurrent = await execute(op(), args, { ...baseCtx, transport, ledger });
    expect(concurrent.outcome).toBe("error");
    if (concurrent.outcome === "error") {
      expect(concurrent.envelope.error.code).toBe("conflict");
      expect(concurrent.record.ledger).toBe("in_progress");
    }
    expect(calls).toBe(1);

    releaseUpstream(ok({ id: "re_1" }));
    await expect(firstPromise).resolves.toMatchObject({ outcome: "success" });
  });

  it("never releases a reservation when completion persistence fails after a write", async () => {
    let releases = 0;
    const reference =
      "firestore/anvil_idempotency_0123456789abcdef/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ledger: IdempotencyLedger = {
      durable: true,
      reserve: async () => ({ outcome: "reserved", reference }),
      complete: async () => {
        throw new Error("secret backend detail");
      },
      release: async () => {
        releases += 1;
      },
    };
    const transport = new MockTransport(() => ({
      status: 201,
      headers: {},
      body: '{"id":"created"}',
    }));
    const res = await execute(
      op(),
      {
        input: { payment_id: "pay_1", amount: 2500 },
        confirm: true,
        idempotencyKey: "complete-failure",
      },
      { ...baseCtx, env: "prod", transport, ledger },
    );

    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("idempotency_ledger_unavailable");
    expect(res.envelope.error.safe_to_retry).toBe(false);
    expect(res.envelope.error.details).toMatchObject({
      ledger_phase: "complete",
      upstream_touched: true,
      operator_action_required: true,
      ledger_reference: reference,
    });
    expect(JSON.stringify(res)).not.toContain("secret backend detail");
    expect(releases).toBe(0);
  });

  it("releases a failed reservation when the upstream repeat contract is proven safe", async () => {
    let releases = 0;
    const backing = new InMemoryLedger();
    const ledger: IdempotencyLedger = {
      durable: false,
      reserve: (key, fingerprint) => backing.reserve(key, fingerprint),
      complete: (key, result, status) => backing.complete(key, result, status),
      release: async (key) => {
        releases += 1;
        await backing.release(key);
      },
    };
    const transport = new MockTransport(() => ({ status: 400, headers: {}, body: "" }));
    const res = await execute(
      op({ retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] } }),
      {
        input: { payment_id: "pay_1", amount: 2500 },
        confirm: true,
        idempotencyKey: "safe-release",
      },
      { ...baseCtx, transport, ledger },
    );

    expect(res.outcome).toBe("error");
    expect(releases).toBe(1);
  });

  it("fails closed and redacts backend details when reservation release cannot be confirmed", async () => {
    const reference =
      "firestore/anvil_idempotency_0123456789abcdef/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const ledger: IdempotencyLedger = {
      durable: true,
      reserve: async () => ({ outcome: "reserved", reference }),
      complete: async () => {},
      release: async () => {
        throw new Error("alloydb://user:password@private-host/database");
      },
    };
    const transport = new MockTransport(() => ({ status: 400, headers: {}, body: "" }));
    const res = await execute(
      op({ retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] } }),
      {
        input: { payment_id: "pay_1", amount: 2500 },
        confirm: true,
        idempotencyKey: "release-failure",
      },
      { ...baseCtx, env: "prod", transport, ledger },
    );

    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("idempotency_ledger_unavailable");
    expect(res.envelope.error.safe_to_retry).toBe(false);
    expect(res.envelope.error.details).toMatchObject({
      ledger_phase: "release",
      upstream_touched: true,
      operator_action_required: true,
      ledger_reference: reference,
    });
    expect(JSON.stringify(res)).not.toContain("private-host");
  });

  it("sanitizes a pre-write ledger reservation failure and marks retry as safe", async () => {
    const ledger: IdempotencyLedger = {
      durable: true,
      reserve: async () => {
        throw new Error("postgres://user:password@private-host/database");
      },
      complete: async () => {},
      release: async () => {},
    };
    const transport = new MockTransport(() => ok({ id: "must-not-run" }));
    const res = await execute(
      op(),
      {
        input: { payment_id: "pay_1", amount: 2500 },
        confirm: true,
        idempotencyKey: "reserve-failure",
      },
      { ...baseCtx, env: "prod", transport, ledger },
    );

    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("idempotency_ledger_unavailable");
    expect(res.envelope.error.safe_to_retry).toBe(true);
    expect(res.envelope.error.details).toMatchObject({
      ledger_phase: "reserve",
      upstream_touched: false,
    });
    expect(JSON.stringify(res)).not.toContain("private-host");
    expect(transport.requests).toHaveLength(0);
  });

  it("retains the reservation when a response begins but its body cannot be consumed", async () => {
    let releases = 0;
    const reference =
      "firestore/anvil_idempotency_0123456789abcdef/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const ledger: IdempotencyLedger = {
      durable: true,
      reserve: async () => ({ outcome: "reserved", reference }),
      complete: async () => {},
      release: async () => {
        releases += 1;
      },
    };
    const transport = new MockTransport((_request, attempt) =>
      attempt === 1
        ? new TransportError("timeout", "response body timed out", "after_response")
        : new TransportError("timeout", "connect timed out"),
    );
    const res = await execute(
      op(),
      {
        input: { payment_id: "pay_1", amount: 2500 },
        confirm: true,
        idempotencyKey: "ambiguous-response",
      },
      { ...baseCtx, env: "prod", transport, ledger, timeoutMs: 1_234 },
    );

    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(transport.requests).toHaveLength(3);
    expect(transport.requests.every((request) => request.timeoutMs === 1_234)).toBe(true);
    expect(res.envelope.error.code).toBe("upstream_timeout");
    expect(res.envelope.error.safe_to_retry).toBe(false);
    expect(res.envelope.error.details).toMatchObject({
      upstream_outcome: "possibly_committed",
      operator_action_required: true,
      ledger_reference: reference,
    });
    expect(res.record.ledger).toBe("in_progress");
    expect(releases).toBe(0);
  });

  it("retries bounded pre-response timeouts and releases the reservation once", async () => {
    let releases = 0;
    const ledger: IdempotencyLedger = {
      durable: true,
      reserve: async () => ({ outcome: "reserved" }),
      complete: async () => {},
      release: async () => {
        releases += 1;
      },
    };
    const transport = new MockTransport(() => new TransportError("timeout", "connect timed out"));
    const res = await execute(
      op(),
      {
        input: { payment_id: "pay_1", amount: 2500 },
        confirm: true,
        idempotencyKey: "bounded-timeout",
      },
      { ...baseCtx, env: "prod", transport, ledger, timeoutMs: 1_234 },
    );

    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(transport.requests).toHaveLength(3);
    expect(transport.requests.every((request) => request.timeoutMs === 1_234)).toBe(true);
    expect(res.envelope.error.safe_to_retry).toBe(true);
    expect(releases).toBe(1);
  });

  it.each([
    [
      "safe",
      "firestore/anvil_idempotency_0123456789abcdef/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      true,
    ],
    ["unsafe", "merchant-secret-key", false],
  ])("returns only a %s in-progress ledger reference", async (_label, reference, exposed) => {
    const ledger: IdempotencyLedger = {
      durable: true,
      reserve: async () => ({ outcome: "in_progress", reference }),
      complete: async () => {},
      release: async () => {},
    };
    const transport = new MockTransport(() => ok({ id: "must-not-run" }));
    const res = await execute(
      op(),
      {
        input: { payment_id: "pay_1", amount: 2500 },
        confirm: true,
        idempotencyKey: "already-running",
      },
      { ...baseCtx, env: "prod", transport, ledger },
    );

    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("conflict");
    const returnedReference = (
      res.envelope.error.details as { ledger_reference?: string } | undefined
    )?.ledger_reference;
    if (exposed) expect(returnedReference).toBe(reference);
    else expect(returnedReference).toBeUndefined();
    expect(transport.requests).toHaveLength(0);
  });
});

describe("bounded execution policy", () => {
  it.each([
    0,
    99,
    30_001,
    Number.NaN,
  ])("rejects invalid upstream timeout %s before transport", async (timeoutMs) => {
    const transport = new MockTransport(() => ok({ id: "must-not-run" }));
    const res = await execute(
      op(),
      {
        input: { payment_id: "pay_1", amount: 2500 },
        confirm: true,
        idempotencyKey: "invalid-timeout",
      },
      { ...baseCtx, transport, timeoutMs },
    );

    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("validation_error");
    expect(res.envelope.error.details).toMatchObject({
      field: "timeout_ms",
      min: 100,
      max: 30_000,
    });
    expect(transport.requests).toHaveLength(0);
  });

  it("refuses malformed AIR retry bounds before any runtime hook or transport", async () => {
    const transport = new MockTransport(() => ok({ id: "must-not-run" }));
    const malformed = {
      ...op(),
      retries: { ...op().retries, maxAttempts: 6 },
    } as Operation;
    const res = await execute(
      malformed,
      {
        input: { payment_id: "pay_1", amount: 2500 },
        confirm: true,
        idempotencyKey: "invalid-retries",
      },
      { ...baseCtx, transport },
    );

    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("unsupported_operation");
    expect(res.envelope.error.details).toEqual({
      max_attempts: 5,
      max_delay_ms: 20_000,
    });
    expect(transport.requests).toHaveLength(0);
  });
});

describe("idempotency key validation", () => {
  it("enforces the portable-key contract in direct resolution callers too", () => {
    expect(() =>
      resolveIdempotencyKey({
        provided: "line\nbreak",
        keyDerivation: "client_supplied",
        operationId: "payments.refund.create",
        input: {},
      }),
    ).toThrow(/visible ASCII/i);
  });

  it.each([
    " ",
    "contains space",
    "line\nbreak",
    "non-ascii-ü",
    "a".repeat(256),
  ])("rejects a non-portable caller key before transport: %j", async (idempotencyKey) => {
    const transport = new MockTransport(() => ok({ id: "must-not-run" }));
    const res = await execute(
      op(),
      {
        input: { payment_id: "pay_1", amount: 2500 },
        confirm: true,
        idempotencyKey,
      },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );

    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("validation_error");
    expect(res.envelope.error.message).toMatch(/visible ASCII/i);
    expect(res.envelope.error.details).toEqual({
      field: "idempotency_key",
      encoding: "visible_ascii",
      max_bytes: 255,
    });
    expect(transport.requests).toHaveLength(0);
  });

  it("accepts a 255-byte visible-ASCII key", async () => {
    const transport = new MockTransport(() => ok({ id: "not-called-in-dry-run" }));
    const res = await execute(
      op(),
      {
        input: { payment_id: "pay_1", amount: 2500 },
        confirm: true,
        idempotencyKey: "a".repeat(255),
        dryRun: true,
      },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );

    expect(res.outcome).toBe("dry_run");
    expect(transport.requests).toHaveLength(0);
  });

  it("accepts key_supported without an explicit key and derives one for the exact carrier", async () => {
    const ledger = new InMemoryLedger();
    const transport = new MockTransport(() => ok({ id: "created" }));
    const optionalKey = op({
      idempotency: {
        mode: "key_supported",
        mechanism: "header",
        key: "Idempotency-Key",
        keyDerivation: "request_fingerprint",
      },
    });
    const args = {
      input: { payment_id: "pay_1", amount: 2500 },
      confirm: true,
    };

    const first = await execute(optionalKey, args, { ...baseCtx, transport, ledger });
    const replay = await execute(optionalKey, args, { ...baseCtx, transport, ledger });

    expect(first.outcome).toBe("success");
    expect(replay.outcome).toBe("success");
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.headers["Idempotency-Key"]).toMatch(/^anvil-[a-f0-9]{32}$/);
    if (replay.outcome === "success") expect(replay.record.ledger).toBe("replay");
  });

  it("accepts the optional MCP input key for key_supported and injects it upstream", async () => {
    const transport = new MockTransport(() => ok({ id: "created" }));
    const optionalKey = op({
      idempotency: {
        mode: "key_supported",
        mechanism: "header",
        key: "Idempotency-Key",
        keyDerivation: "request_fingerprint",
      },
    });

    const res = await execute(
      optionalKey,
      {
        input: {
          payment_id: "pay_1",
          amount: 2500,
          idempotency_key: "mcp-business-key",
        },
        confirm: true,
      },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );

    expect(res.outcome).toBe("success");
    expect(transport.requests[0]?.headers["Idempotency-Key"]).toBe("mcp-business-key");
  });

  it.each([
    "none",
    "natural",
    "client_id",
  ] as const)("rejects a caller safety key for non-keyed mode %s before ledger or upstream", async (mode) => {
    let reservations = 0;
    const ledger: IdempotencyLedger = {
      durable: true,
      reserve: async () => {
        reservations += 1;
        return { outcome: "reserved" };
      },
      complete: async () => {},
      release: async () => {},
    };
    const transport = new MockTransport(() => ok({ id: "must-not-run" }));
    const nonKeyed = op({
      confirmation: { required: false },
      idempotency: { mode, mechanism: "none", keyDerivation: "none" },
      retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    });

    const res = await execute(
      nonKeyed,
      {
        input: { payment_id: "pay_1", amount: 2500 },
        idempotencyKey: "caller-key",
      },
      { ...baseCtx, transport, ledger },
    );

    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("validation_error");
    expect(res.envelope.error.details).toMatchObject({
      field: "idempotency_key",
      declared_mode: mode,
    });
    expect(res.envelope.error.message).not.toContain("caller-key");
    expect(reservations).toBe(0);
    expect(transport.requests).toHaveLength(0);
  });

  it("keeps a non-keyed source field named idempotency_key on the wire as business input", async () => {
    let reservations = 0;
    const ledger: IdempotencyLedger = {
      durable: true,
      reserve: async () => {
        reservations += 1;
        return { outcome: "reserved" };
      },
      complete: async () => {},
      release: async () => {},
    };
    const transport = new MockTransport(() => ok({ id: "created" }));
    const businessField = op({
      confirmation: { required: false },
      input: {
        params: [{ name: "payment_id", in: "path", required: true, schema: { type: "string" } }],
        body: {
          contentType: "application/json",
          required: true,
          schema: {
            type: "object",
            required: ["amount", "idempotency_key"],
            properties: {
              amount: { type: "integer" },
              idempotency_key: { type: "string" },
            },
          },
          projection: "fields",
          fields: [
            { name: "amount", required: true, schema: { type: "integer" } },
            { name: "idempotency_key", required: true, schema: { type: "string" } },
          ],
        },
      },
      idempotency: { mode: "none", mechanism: "none", keyDerivation: "none" },
      retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    });

    const res = await execute(
      businessField,
      {
        input: {
          payment_id: "pay_1",
          amount: 2500,
          idempotency_key: "business value ü",
        },
      },
      { ...baseCtx, transport, ledger },
    );

    expect(res.outcome).toBe("success");
    expect(reservations).toBe(0);
    expect(JSON.parse(transport.requests[0]?.body ?? "{}")).toMatchObject({
      idempotency_key: "business value ü",
    });
  });

  it("keeps colliding business fields distinct from header-key and confirmation controls", async () => {
    const transport = new MockTransport(() => ok({ id: "created" }));
    const collision = op({
      input: {
        params: [
          { name: "payment_id", in: "path", required: true, schema: { type: "string" } },
          {
            name: "idempotency_key",
            in: "query",
            required: true,
            schema: { type: "string" },
          },
          { name: "confirm", in: "query", required: true, schema: { type: "string" } },
        ],
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
        keyDerivation: "client_supplied",
      },
    });

    const res = await execute(
      collision,
      {
        input: {
          payment_id: "pay_1",
          amount: 2500,
          idempotency_key: "business-query-value",
          confirm: "business-confirm-value",
          anvil_idempotency_key: "write-key-1",
          anvil_confirm: true,
        },
      },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );

    expect(res.outcome).toBe("success");
    expect(transport.requests).toHaveLength(1);
    const request = transport.requests[0];
    expect(request?.headers["Idempotency-Key"]).toBe("write-key-1");
    const url = new URL(request?.url ?? "");
    expect(url.searchParams.get("idempotency_key")).toBe("business-query-value");
    expect(url.searchParams.get("confirm")).toBe("business-confirm-value");
  });

  it("enforces a modeled carrier format even for direct runtime embedders", async () => {
    const transport = new MockTransport(() => ok({ id: "created" }));
    const constrained = op({
      confirmation: { required: false },
      input: {
        params: [
          { name: "payment_id", in: "path", required: true, schema: { type: "string" } },
          {
            name: "request_key",
            in: "query",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
      },
      idempotency: {
        mode: "required",
        mechanism: "query",
        key: "request_key",
        keyDerivation: "client_supplied",
      },
    });

    const invalid = await execute(
      constrained,
      { input: { payment_id: "pay_1" }, idempotencyKey: "not-a-uuid" },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(invalid.outcome).toBe("error");
    if (invalid.outcome === "error") {
      expect(invalid.envelope.error.code).toBe("validation_error");
      expect(invalid.envelope.error.message).toMatch(/carrier constraints/i);
    }
    expect(transport.requests).toHaveLength(0);

    const key = "550e8400-e29b-41d4-a716-446655440000";
    const valid = await execute(
      constrained,
      { input: { payment_id: "pay_1" }, idempotencyKey: key },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(valid.outcome).toBe("success");
    expect(new URL(transport.requests[0]?.url ?? "").searchParams.get("request_key")).toBe(key);
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

describe("production defaults fail closed (no dev fallback)", () => {
  const args = {
    input: { payment_id: "pay_1", amount: 2500 },
    confirm: true,
    idempotencyKey: "k1",
  };

  it("treats an unset env as prod for host pinning (empty allowlist denies)", async () => {
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    // No `env`, no `allowedHosts`: a misconfigured context must NOT silently get
    // dev semantics (which would permit any upstream host).
    const res = await execute(op(), args, {
      serviceId: "payments",
      baseUrl: "https://payments.internal.example.com",
      transport,
      sleep: async () => {},
      rng: () => 0.5,
      ledger: new DurableTestLedger(),
    });
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("policy_denied");
    expect(transport.requests).toHaveLength(0);
  });

  it("treats an unset env as prod for the durable-ledger gate", async () => {
    const transport = new MockTransport(() => ok({ id: "re_1" }));
    // Allowlist satisfied, but no env and only a process-local ledger: must fail
    // closed on the required-idempotency mutation, not fall through as dev.
    const res = await execute(op(), args, {
      serviceId: "payments",
      baseUrl: "https://payments.internal.example.com",
      allowedHosts: ["payments.internal.example.com"],
      transport,
      sleep: async () => {},
      rng: () => 0.5,
      ledger: new InMemoryLedger(),
    });
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.code).toBe("idempotency_ledger_unavailable");
    expect(transport.requests).toHaveLength(0);
  });

  it("normalizeEnv maps unset/unknown to prod and only exact 'dev' to dev", () => {
    expect(normalizeEnv(undefined)).toBe("prod");
    expect(normalizeEnv("")).toBe("prod");
    expect(normalizeEnv("Dev")).toBe("prod");
    expect(normalizeEnv("production")).toBe("prod");
    expect(normalizeEnv("dev")).toBe("dev");
    expect(normalizeEnv("staging")).toBe("staging");
  });
});

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

  it("does not replay an idempotency key for a different request fingerprint", async () => {
    const ledger = new InMemoryLedger();
    expect(await ledger.reserve("shared-key", "fingerprint-a")).toEqual({
      outcome: "reserved",
    });
    await ledger.complete("shared-key", { id: "first" });
    expect(await ledger.reserve("shared-key", "fingerprint-b")).toEqual({
      outcome: "conflict",
    });
  });
});
