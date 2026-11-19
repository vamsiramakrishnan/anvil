import { readFileSync } from "node:fs";
import {
  AirDocument,
  EnterpriseOAuthBinding,
  IdentityProfile,
  validateEnterpriseOAuthBinding,
} from "@anvil/air";
import { describe, expect, it, vi } from "vitest";
import {
  createEnterpriseTokenVerifier,
  enterpriseCredentialResolver,
  enterpriseOAuthNamespace,
  loadEnterpriseOAuthBinding,
} from "./enterprise-oauth-binding.js";
import { EnterpriseOAuthError } from "./enterprise-oauth-flow.js";
import { execute } from "./executor.js";
import { createIdentityRuntime, mapIdentity } from "./identity.js";
import { otelSpanId, otelTraceId } from "./observability.js";
import { MockTransport } from "./transport.js";

const binding = EnterpriseOAuthBinding.parse({
  service: "owned-orders",
  operations: ["raw_order_lookup"],
  upstreamBaseUrl: "https://broker.example/api",
  issuer: "https://id.example",
  resource: "https://orders.example",
  authorizationEndpoint: "https://id.example/authorize",
  tokenEndpoint: "https://id.example/token",
  introspectionEndpoint: "https://id.example/introspect",
  redirectUri: "https://anvil.example/connect/callback",
  scopes: ["orders.read"],
  clientIdEnv: "OAUTH_ID",
  clientSecretEnv: "OAUTH_SECRET",
});
const env = { OAUTH_ID: "orders-connector", OAUTH_SECRET: "secret" };
const profile = IdentityProfile.parse({
  version: 1,
  id: "user-mcp",
  authentication: {
    provider: "oidc",
    issuer: binding.issuer,
    audience: "https://anvil.example/mcp",
    jwksUri: "https://id.example/jwks",
  },
  mapping: {
    tenant: { source: "claim", allowed: ["a", "b"], claim: "tenant" },
    upstreamScopes: binding.scopes,
  },
  authorization: { rules: [] },
});
const exp = Math.floor(Date.now() / 1000) + 3600;
const principal = mapIdentity(profile, {
  subjectToken: "inbound-oauth",
  subjectTokenType: "access_token",
  claims: {
    iss: binding.issuer,
    sub: "alice",
    aud: profile.authentication.audience,
    exp,
    tenant: "a",
  },
})!;
function bundle() {
  const air = AirDocument.parse(
    JSON.parse(
      readFileSync(
        new URL("../../../examples/business/sources/orders.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const op = air.operations[0]!;
  op.auth = {
    type: "oauth2_authorization_code",
    principal: "end_user",
    secretSource: "vault",
    scopes: binding.scopes,
  };
  air.operations = [op];
  return air;
}
const active = {
  active: true,
  token_type: "access_token",
  iss: binding.issuer,
  sub: "alice",
  tenant: "a",
  client_id: env.OAUTH_ID,
  aud: binding.resource,
  exp,
  scope: binding.scopes[0],
};

describe("standalone enterprise OAuth binding", () => {
  it("requires the bundle, vault carrier, service URL, issuer and separate credential audiences", () => {
    const air = bundle();
    expect(
      loadEnterpriseOAuthBinding(
        { ...env, ANVIL_ENTERPRISE_OAUTH_JSON: JSON.stringify(binding) },
        air,
        profile,
        binding.upstreamBaseUrl,
      ),
    ).toEqual(binding);
    for (const invalid of [
      { service: "other" },
      { operations: ["other"] },
      { upstreamBaseUrl: "https://other.example" },
      { issuer: "https://other.example" },
      { scopes: ["admin"] },
      { resource: profile.authentication.audience },
      { resource: "https://anvil.example/connect" },
      { redirectUri: "https://anvil.example/wrong" },
    ])
      expect(() =>
        validateEnterpriseOAuthBinding(
          { ...binding, ...invalid },
          air,
          profile,
          binding.upstreamBaseUrl,
        ),
      ).toThrow();
    air.operations[0]!.auth.secretSource = "env";
    expect(() =>
      validateEnterpriseOAuthBinding(binding, air, profile, binding.upstreamBaseUrl),
    ).toThrow();
  });

  it("uses the checked user and pinned resource, including at refresh", async () => {
    const send = vi.fn<typeof fetch>();
    const verify = createEnterpriseTokenVerifier(binding, profile, env, send);
    send.mockResolvedValueOnce(
      Response.json({ ...active, aud: [binding.resource], exp: String(exp) }),
    );
    expect(await verify("outbound-access-token", principal)).toEqual({ expiresAt: exp * 1000 });
    expect(send).toHaveBeenCalledWith(
      new URL(binding.introspectionEndpoint),
      expect.objectContaining({
        redirect: "error",
        body: "token=outbound-access-token&token_type_hint=access_token",
      }),
    );
    for (const invalid of [
      { sub: "bob" },
      { tenant: "b" },
      { iss: "foreign" },
      { aud: "wrong" },
      { aud: [binding.resource, profile.authentication.audience] },
      { client_id: "other" },
      { active: false },
      { token_type: "refresh_token" },
      { scope: "orders.read write" },
      { scope: "" },
      { exp: 1 },
      { nbf: exp + 1 },
    ]) {
      send.mockResolvedValueOnce(Response.json({ ...active, ...invalid }));
      await expect(verify("outbound-access-token", principal)).rejects.toMatchObject({
        code: "invalid_user_grant",
      });
    }
    send.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(verify("outbound-access-token", principal)).rejects.toMatchObject({
      code: "dependency_unavailable",
    });
  });

  it("resolves only after verifying the concrete method, route, authority and employee", async () => {
    const air = bundle();
    const accessToken = vi.fn(async () => "alice-api");
    const resolver = enterpriseCredentialResolver(binding, { accessToken }, air);
    const call = {
      principal,
      service: binding.service,
      operation: "raw_order_lookup",
      method: "GET",
      headerNames: [] as string[],
      url: `${binding.upstreamBaseUrl}/internal/orders/123`,
    };
    const resolve = (enterprise: typeof call) =>
      resolver.resolve("production", air.operations[0]!.auth, { enterprise });
    expect(await resolve(call)).toEqual({ headers: { Authorization: "Bearer alice-api" } });
    expect(accessToken).toHaveBeenCalledWith(principal);
    accessToken.mockClear();
    for (const overrides of [
      { service: "other" },
      { operation: "other" },
      { method: "POST" },
      { headerNames: ["TraceParent"] },
      { headerNames: ["HOST"] },
      { url: "https://foreign.example/api/internal/orders/123" },
      { url: `${binding.upstreamBaseUrl}/admin` },
      { url: `${binding.upstreamBaseUrl}/internal/orders/x%252fadmin` },
      { url: `${binding.upstreamBaseUrl}/internal/orders/../orders/123` },
      { url: `${binding.upstreamBaseUrl}/internal/orders/x%2fy` },
    ])
      expect(await resolve({ ...call, ...overrides })).toBeNull();
    expect(await resolver.resolve("production", air.operations[0]!.auth)).toBeNull();
    expect(accessToken).not.toHaveBeenCalled();
  });

  it("checks the grant at the instant of each retry and correlates an authorized send", async () => {
    const air = bundle();
    const op = air.operations[0]!;
    op.retries = {
      mode: "safe",
      basis: "read_safe",
      maxAttempts: 2,
      backoff: "none",
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryOn: ["http_503"],
    };
    let disconnected = false;
    const transport = new MockTransport(() => {
      disconnected = true;
      return { status: 503, headers: {}, body: "" };
    });
    const accessToken = vi.fn(async () => {
      if (disconnected) throw new EnterpriseOAuthError(409, "reauth_required");
      return "alice-api";
    });
    const identity = createIdentityRuntime(
      IdentityProfile.parse({
        ...profile,
        authorization: {
          rules: [{ id: "read", service: binding.service, operations: [op.id], effect: "allow" }],
        },
      }),
    );
    const result = await execute(
      op,
      { input: { opaque_order_ref: "123" } },
      {
        serviceId: binding.service,
        baseUrl: binding.upstreamBaseUrl,
        allowedHosts: ["broker.example"],
        env: "dev",
        inbound: {
          subjectToken: "inbound-oauth",
          subjectTokenType: "access_token",
          claims: {
            iss: binding.issuer,
            sub: "alice",
            tenant: "a",
            exp,
            aud: profile.authentication.audience,
          },
        },
        identity,
        credentials: enterpriseCredentialResolver(binding, { accessToken }, air),
        transport,
      },
    );
    expect(result).toMatchObject({
      outcome: "error",
      envelope: { error: { code: "auth_required" } },
    });
    expect(accessToken).toHaveBeenCalledTimes(2);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.headers.traceparent).toEqual(
      `00-${otelTraceId(result.record.traceId)}-${otelSpanId(result.record)}-01`,
    );
  });

  it("keeps the grant addressable after an authorization policy edit and isolates authority changes", () => {
    const namespace = enterpriseOAuthNamespace(binding, profile, env.OAUTH_ID);
    const edited = structuredClone(profile);
    edited.authorization.timeoutMs++;
    expect(enterpriseOAuthNamespace(binding, edited, env.OAUTH_ID)).toEqual(namespace);
    expect(enterpriseOAuthNamespace(binding, profile, "replacement")).not.toEqual(namespace);
    expect(
      enterpriseOAuthNamespace(
        { ...binding, resource: "https://other-api.example" },
        profile,
        env.OAUTH_ID,
      ),
    ).not.toEqual(namespace);
  });
});
