import { IdentityProfile, Operation } from "@anvil/air";
import { describe, expect, it, vi } from "vitest";
import { bootRuntimeFromEnv } from "./boot.js";
import { execute } from "./executor.js";
import { InMemoryLedger } from "./idempotency.js";
import { createIdentityRuntime, loadIdentityProfile, mapIdentity } from "./identity.js";
import { type InboundIdentity, withInboundIdentity } from "./inbound-identity.js";
import { MockTransport } from "./transport.js";

const raw = {
  version: 1,
  id: "enterprise",
  authentication: {
    provider: "oidc",
    issuer: "https://id.example",
    audience: "https://mcp.example",
    jwksUri: "https://id.example/keys",
  },
  mapping: {
    tenant: { source: "claim", claim: "tenant", allowed: ["a", "b"] },
    groupsClaim: "groups",
  },
  authorization: {
    rules: [
      {
        id: "read",
        service: "orders",
        operations: ["orders.get"],
        effect: "allow",
        groups: ["reader"],
        constraints: [{ kind: "tenant_equals", input: "tenant" }],
      },
    ],
  },
};
const profile = () => IdentityProfile.parse(structuredClone(raw));
const inbound = (claims: Record<string, unknown> = {}): InboundIdentity => ({
  subjectToken: "secret-bearer",
  subjectTokenType: "jwt",
  sub: "alice",
  claims: {
    iss: "https://id.example",
    aud: "https://mcp.example",
    sub: "alice",
    exp: Date.now() / 1000 + 300,
    tenant: "a",
    groups: ["reader"],
    ...claims,
  },
});
const operation = () =>
  Operation.parse({
    id: "orders.get",
    canonicalName: "get_orders",
    displayName: "Get orders",
    sourceRef: { kind: "openapi", path: "/orders", method: "get" },
    effect: { kind: "read", resource: "orders", risk: "low", reversible: true },
    input: {
      params: [{ name: "tenant", in: "query", required: true, schema: { type: "string" } }],
    },
    idempotency: { mode: "natural" },
    retries: { mode: "none", maxAttempts: 1 },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "orders get" },
    mcp: { toolName: "orders_get" },
    skill: { intentExamples: [] },
    state: "approved",
  });
function context(p = profile()) {
  const transport = new MockTransport(() => ({ status: 200, headers: {}, body: "{}" }));
  return {
    serviceId: "orders",
    baseUrl: "https://api.example",
    allowedHosts: ["api.example"],
    env: "dev",
    transport,
    identity: createIdentityRuntime(p),
    inbound: inbound(),
  };
}

describe("reusable identity profiles", () => {
  it("rejects unknown configuration, conflicting sources and unregistered adapters", () => {
    expect(() => IdentityProfile.parse({ ...raw, typo: true })).toThrow();
    expect(() =>
      loadIdentityProfile({ ANVIL_IDENTITY_PROFILE: "x", ANVIL_IDENTITY_PROFILE_JSON: "{}" }),
    ).toThrow();
    const p = profile();
    p.authorization.adapter = "missing";
    p.authorization.rules = [];
    expect(() => createIdentityRuntime(p)).toThrow(/not registered/);
  });
  it("separates issuer/tenant/subject and never maps by email", () => {
    const a = mapIdentity(profile(), inbound());
    const b = mapIdentity(profile(), inbound({ tenant: "b" }));
    expect(a?.id).not.toBe(b?.id);
    expect(JSON.stringify(a)).not.toContain("secret-bearer");
    for (const claims of [
      { iss: "https://evil.example" },
      { aud: "other" },
      { sub: "" },
      { tenant: "unknown" },
      { exp: 0 },
      { groups: { reader: true } },
    ])
      expect(mapIdentity(profile(), inbound(claims))).toBeUndefined();
  });
  it("boots the same profile into every context and refuses local anonymous fallback", async () => {
    const boot = await bootRuntimeFromEnv({
      serviceId: "orders",
      env: { ANVIL_IDENTITY_PROFILE_JSON: JSON.stringify(raw), ANVIL_ENV: "dev" },
    });
    expect(boot.contextDeps.identity?.digest).toHaveLength(64);
    expect(boot.principalDirectoryConfigured).toBe(true);
    expect(boot.principalFor()).toBeUndefined();
    expect(boot.principalFor(inbound())?.id).toMatch(/^identity:/);
  });
  it("executes an allowed request and audits the profile without bearer material", async () => {
    const ctx = context();
    const result = await execute(operation(), { input: { tenant: "a" } }, ctx);
    expect(result.outcome).toBe("success");
    expect(result.record.principalId).toMatch(/^identity:/);
    expect(result.record.policyDecisions.some((value) => value.startsWith("identity:"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-bearer");
    expect(ctx.transport.requests).toHaveLength(1);
  });
  it("denies missing identity, cross-tenant access and unbound operations before credentials or wire", async () => {
    for (const variant of ["missing", "tenant", "group", "operation", "service"]) {
      const ctx = context();
      const credentials = { resolve: vi.fn() };
      const op = operation();
      const result = await execute(
        op,
        { input: { tenant: variant === "tenant" ? "b" : "a" } },
        {
          ...ctx,
          credentials,
          inbound:
            variant === "missing" ? undefined : inbound(variant === "group" ? { groups: [] } : {}),
          serviceId: variant === "service" ? "another-service" : "orders",
          identity:
            variant === "operation"
              ? createIdentityRuntime({
                  ...profile(),
                  authorization: { ...profile().authorization, rules: [] },
                })
              : ctx.identity,
          principal: { id: "forged", scopes: ["*"] },
        },
      );
      expect(result.outcome, variant).toBe("error");
      expect(ctx.transport.requests, variant).toHaveLength(0);
      expect(credentials.resolve).not.toHaveBeenCalled();
    }
  });
  it("retains approval and confirmation gates; deny rules override allows", async () => {
    const p = profile();
    p.authorization.rules[0]!.requireConfirmation = true;
    const ctx = context(p);
    expect((await execute(operation(), { input: { tenant: "a" } }, ctx)).outcome).toBe("error");
    expect(
      (await execute(operation(), { input: { tenant: "a" }, confirm: true }, ctx)).outcome,
    ).toBe("success");
    const blocked = operation();
    blocked.state = "blocked";
    expect((await execute(blocked, { input: { tenant: "a" }, confirm: true }, ctx)).outcome).toBe(
      "error",
    );
    const deny = profile();
    deny.authorization.rules.push({ ...deny.authorization.rules[0]!, id: "deny", effect: "deny" });
    expect((await execute(operation(), { input: { tenant: "a" } }, context(deny))).outcome).toBe(
      "error",
    );
  });
  it("prevents hooks rewriting a resource after authorization", async () => {
    const ctx = context();
    const result = await execute(
      operation(),
      { input: { tenant: "a" } },
      {
        ...ctx,
        policy: {
          preExecute: (hook) => {
            hook.request!.url = "https://api.example/orders?tenant=b";
          },
        },
      },
    );
    expect(result.outcome).toBe("error");
    expect(ctx.transport.requests).toHaveLength(0);
  });
  it("uses each request identity rather than a fleet session principal", async () => {
    const ctx = context();
    const results = await Promise.all(
      ["a", "b"].map((tenant) =>
        withInboundIdentity(inbound({ tenant }), async () => {
          await Promise.resolve();
          return execute(operation(), { input: { tenant } }, { ...ctx, inbound: undefined });
        }),
      ),
    );
    expect(results.map((value) => value.outcome)).toEqual(["success", "success"]);
    expect(results[0]!.record.principalId).not.toBe(results[1]!.record.principalId);
  });
  it("fails closed on timeout, exception, malformed decisions and unknown obligations", async () => {
    const variants = [
      async () => {
        throw new Error("secret diagnostic");
      },
      async () => ({
        allowed: true,
        reason: "ok",
        policyVersion: "1",
        obligations: [{ kind: "unknown" }],
      }),
      async () => new Promise<never>(() => {}),
    ];
    for (const [index, adapter] of variants.entries()) {
      const name = `failure-${index}`;

      const p = profile();
      p.authorization = { adapter: name, rules: [], timeoutMs: 5 };
      const ctx = {
        ...context(),
        identity: createIdentityRuntime(p, { [name]: adapter as never }),
      };
      const result = await execute(operation(), { input: { tenant: "a" } }, ctx);
      expect(result.outcome).toBe("error");
      expect(ctx.transport.requests).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain("secret diagnostic");
    }
  });
});

it.each([false, true])("isolates custom-tenant replay with explicit key=%s", async (explicit) => {
  const p = profile();
  p.mapping.tenant = { source: "claim", claim: "customer_org", allowed: ["a", "b"] };
  p.authorization.rules[0]!.constraints = [];
  const ctx = context(p);
  const ledger = new InMemoryLedger();
  const op = operation();
  op.sourceRef.method = "post";
  op.effect.kind = "mutation";
  op.idempotency = {
    mode: "required",
    mechanism: "header",
    key: "Idempotency-Key",
    keyDerivation: "request_fingerprint",
  };
  const results = [];
  for (const tenant of ["a", "b", "a"]) {
    results.push(
      await execute(
        op,
        { input: { tenant: "same-input" }, idempotencyKey: explicit ? "same-key" : undefined },
        {
          ...ctx,
          ledger,
          inbound: inbound({ tenant: undefined, customer_org: tenant }),
        },
      ),
    );
  }
  expect(results.map((result) => result.outcome)).toEqual([
    "success",
    explicit ? "error" : "success",
    "success",
  ]);
  expect(ctx.transport.requests).toHaveLength(explicit ? 1 : 2);
  expect(results[2]!.record.ledger).toBe("replay");
});

it("validates operation inputs before consulting an authorization adapter", async () => {
  const decide = vi.fn(async () => ({ allowed: true, reason: "ok", policyVersion: "1" }));
  const p = profile();
  p.authorization = { adapter: "external", rules: [], timeoutMs: 100 };
  const ctx = { ...context(), identity: createIdentityRuntime(p, { external: decide }) };
  const result = await execute(operation(), { input: { tenant: 42 } }, ctx);
  expect(result.outcome).toBe("error");
  expect(decide).not.toHaveBeenCalled();
  expect(ctx.transport.requests).toHaveLength(0);
});

it("does not let an adapter rewrite authorized arguments", async () => {
  const p = profile();
  p.authorization = { adapter: "external", rules: [], timeoutMs: 100 };
  const ctx = {
    ...context(),
    identity: createIdentityRuntime(p, {
      external: async (request) => {
        (request.input as Record<string, unknown>).tenant = "b";
        return { allowed: true, reason: "ok", policyVersion: "1" };
      },
    }),
  };
  expect((await execute(operation(), { input: { tenant: "a" } }, ctx)).outcome).toBe("success");
  expect(ctx.transport.requests[0]!.url).toContain("tenant=a");
});

it("refuses a competing legacy principal directory at boot", async () => {
  await expect(
    bootRuntimeFromEnv({
      serviceId: "orders",
      env: { ANVIL_IDENTITY_PROFILE_JSON: JSON.stringify(raw), ANVIL_PRINCIPALS: "token:legacy:*" },
    }),
  ).rejects.toThrow(/one mapping authority/);
});
