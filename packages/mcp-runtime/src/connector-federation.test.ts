import { generateKeyPairSync, sign } from "node:crypto";
import { IdentityProfile, Operation } from "@anvil/air";
import {
  type CredentialCallContext,
  createIdentityRuntime,
  type EnterprisePrincipal,
  execute,
  MockTransport,
  withInboundIdentity,
} from "@anvil/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  inboundAuthorizationHeader,
  inboundIdentityFrom,
  loadInboundAuthConfig,
  verifiedPrincipalFingerprint,
  verifyInboundToken,
} from "./inbound-auth.js";

// These are independent authorities even when they name the same employee.
// The cryptographic issuer is local; no customer or Microsoft system is contacted.
const SITEMINDER = "https://siteminder.example.com/connector-issuer";
const ENTRA = "https://login.microsoftonline.com/example-tenant/v2.0";
const MCP = "https://enterprise-mcp.example.com";
const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = { ...key.publicKey.export({ format: "jwk" }), kid: "qualification", alg: "ES256" };
const fetchJwks = async () => ({ keys: [jwk] });
const claims = (sub = "employee-a") => ({
  iss: SITEMINDER,
  aud: MCP,
  sub,
  exp: Math.floor(Date.now() / 1000) + 300,
  scope: "enterprise.mcp",
  tenant_id: "enterprise",
  groups: ["employee"],
});
function jwt(value: object): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", kid: "qualification", typ: "at+jwt" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const data = `${header}.${payload}`;
  return `${data}.${sign("sha256", Buffer.from(data), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
function profile(opaque = false): IdentityProfile {
  return IdentityProfile.parse({
    version: 1,
    id: "enterprise-connector",
    authentication: {
      provider: opaque ? "oauth2_introspection" : "oidc",
      issuer: SITEMINDER,
      audience: MCP,
      resource: MCP,
      requiredScopes: ["enterprise.mcp"],
      ...(opaque
        ? {
            introspection: {
              endpoint: "https://siteminder.example.com/reviewed-introspection-endpoint",
              clientIdEnv: "ENTERPRISE_CONNECTOR_CLIENT_ID",
              clientSecretEnv: "ENTERPRISE_CONNECTOR_CLIENT_SECRET",
            },
          }
        : {
            jwksUri: "https://siteminder.example.com/reviewed-jwks-endpoint",
            tokenType: "at+jwt",
          }),
    },
    mapping: {
      tenant: { source: "claim", claim: "tenant_id", allowed: ["enterprise"] },
      groupsClaim: "groups",
      upstreamScopes: ["leave.read"],
    },
    authorization: { adapter: "employee-policy", rules: [] },
  });
}
const operation = Operation.parse({
  id: "enterprise.leave.get",
  canonicalName: "get_leave_balance",
  displayName: "Get leave balance",
  sourceRef: { kind: "openapi", path: "/leave", method: "get" },
  effect: { kind: "read", resource: "leave", risk: "low", reversible: true },
  input: {
    params: [{ name: "employeeId", in: "query", required: true, schema: { type: "string" } }],
  },
  idempotency: { mode: "natural" },
  retries: { mode: "none", maxAttempts: 1 },
  confirmation: { required: false },
  auth: { type: "oauth2_on_behalf_of", principal: "delegated", scopes: ["leave.read"] },
  cli: { command: "leave get" },
  mcp: { toolName: "leave_get" },
  skill: { intentExamples: [] },
  state: "approved",
});
function harness(opaque = false) {
  const p = profile(opaque);
  const config = loadInboundAuthConfig({
    ANVIL_IDENTITY_PROFILE_JSON: JSON.stringify(p),
    ENTERPRISE_CONNECTOR_CLIENT_ID: "connector-client",
    ENTERPRISE_CONNECTOR_CLIENT_SECRET: "test-client-secret",
  });
  const principals: EnterprisePrincipal[] = [];
  const identity = createIdentityRuntime(p, {
    "employee-policy": async (context) => {
      principals.push(context.principal);
      // Test policy stands in for a trusted employee/resource lookup. Input is
      // never used to establish identity; only the verified subject can allow it.
      return {
        allowed:
          context.principal.identity.subject === context.input.employee_id &&
          context.principal.identity.groups.includes("employee"),
        reason: "employee_resource",
        policyVersion: "qualification-v1",
      };
    },
  });
  const transport = new MockTransport(() => ({ status: 200, headers: {}, body: "{}" }));
  const resolve = vi.fn(async (_profile: string, _auth: unknown, call?: CredentialCallContext) => ({
    headers: { Authorization: `Bearer downstream-${call?.inbound?.sub}` },
  }));
  async function invoke(
    headers: Record<string, string | string[] | undefined>,
    employeeId: string,
    options: Parameters<typeof verifyInboundToken>[2] = { fetchJwks },
  ) {
    const header = inboundAuthorizationHeader(headers, config);
    const authenticated = await verifyInboundToken(header, config, options);
    if (!authenticated.ok) return { authenticated, execution: undefined };
    const inbound = inboundIdentityFrom(
      header?.replace(/^Bearer\s+/i, ""),
      authenticated.claims,
      config,
    )!;
    const execution = await withInboundIdentity(inbound, () =>
      execute(
        operation,
        { input: { employee_id: employeeId } },
        {
          serviceId: "enterprise",
          baseUrl: "https://enterprise-api.example.com",
          allowedHosts: ["enterprise-api.example.com"],
          env: "dev",
          transport,
          credentials: { resolve },
          identity,
          // A reused server session must never substitute its principal for the
          // verified caller of this request.
          principal: { id: "stale-session-owner", scopes: ["*"] },
        },
      ),
    );
    return { authenticated, execution };
  }
  return { config, principals, transport, resolve, invoke };
}

describe("independent Gemini sign-in and connector authorities", () => {
  it("rejects an Entra token and platform-only credentials before upstream credential resolution", async () => {
    const h = harness();
    for (const headers of [
      { authorization: `Bearer ${jwt({ ...claims(), iss: ENTRA })}` },
      { authorization: `Bearer ${jwt({ ...claims(), aud: "https://gemini.example.com" })}` },
      { "x-serverless-authorization": "Bearer platform-service-agent" },
    ]) {
      const result = await h.invoke(headers, "employee-a");
      expect(result.authenticated.ok).toBe(false);
      expect(result.execution).toBeUndefined();
    }
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.principals).toHaveLength(0);
    expect(h.transport.requests).toHaveLength(0);
  });

  it("keeps two SiteMinder employees isolated through verification, policy and delegated credential resolution", async () => {
    const h = harness();
    const tokens = [jwt(claims("employee-a")), jwt(claims("employee-b"))];
    const results = await Promise.all(
      tokens.map((token, i) =>
        h.invoke(
          {
            authorization: `Bearer ${token}`,
            "x-serverless-authorization": "Bearer platform-service-agent",
          },
          i === 0 ? "employee-a" : "employee-b",
        ),
      ),
    );
    expect(
      results.map((result) => result.execution?.outcome),
      JSON.stringify(results),
    ).toEqual(["success", "success"]);
    expect(new Set(results.map((result) => result.execution?.record.principalId)).size).toBe(2);
    expect(h.principals.map((principal) => principal.identity.subject).sort()).toEqual([
      "employee-a",
      "employee-b",
    ]);
    expect(
      h.principals.every(
        (principal) =>
          principal.identity.issuer === SITEMINDER && principal.identity.tenant === "enterprise",
      ),
    ).toBe(true);
    expect(h.resolve.mock.calls.map((call) => call[2]?.inbound?.subjectToken).sort()).toEqual(
      [...tokens].sort(),
    );
    expect(h.transport.requests.map((request) => request.headers.Authorization).sort()).toEqual([
      "Bearer downstream-employee-a",
      "Bearer downstream-employee-b",
    ]);
    expect(
      h.transport.requests.every(
        (request) => !tokens.some((token) => JSON.stringify(request).includes(token)),
      ),
    ).toBe(true);
    expect(JSON.stringify(results)).not.toContain("platform-service-agent");
    for (const token of tokens) expect(JSON.stringify(results)).not.toContain(token);
    expect(verifiedPrincipalFingerprint(claims("employee-a"), h.config.identityProfile)).not.toBe(
      verifiedPrincipalFingerprint(claims("employee-b"), h.config.identityProfile),
    );
  });

  it("does not let an employee choose another employee's resource through tool arguments", async () => {
    const h = harness();
    const result = await h.invoke(
      { authorization: `Bearer ${jwt(claims("employee-a"))}` },
      "employee-b",
    );
    expect(result.authenticated.ok).toBe(true);
    expect(result.execution?.outcome).toBe("error");
    expect(result.execution?.record.errorCode).toBe("policy_denied");
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.transport.requests).toHaveLength(0);
  });

  it("rechecks opaque-token activity on every request and refuses revoked or foreign identities", async () => {
    const h = harness(true);
    let active = true;
    const introspection = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const token = new URLSearchParams(String(init?.body)).get("token");
      return new Response(
        JSON.stringify({
          ...claims(token === "opaque-b" ? "employee-b" : "employee-a"),
          // SiteMinder can return NumericDate as an integer string.
          exp: String(claims().exp),
          iss: token === "entra-token" ? ENTRA : SITEMINDER,
          token_type: "access_token",
          active,
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const options = { fetchIntrospection: introspection as typeof fetch };
    for (const [token, employee] of [
      ["opaque-a", "employee-a"],
      ["opaque-b", "employee-b"],
    ]) {
      const result = await h.invoke({ authorization: `Bearer ${token}` }, employee!, options);
      expect(result.execution?.outcome).toBe("success");
    }
    expect(h.resolve.mock.calls.map((call) => call[2]?.inbound?.subjectTokenType)).toEqual([
      "access_token",
      "access_token",
    ]);
    expect(new Set(h.principals.map((principal) => principal.id)).size).toBe(2);
    expect(
      (await h.invoke({ authorization: "Bearer entra-token" }, "employee-a", options)).authenticated
        .ok,
    ).toBe(false);
    active = false;
    const revoked = await h.invoke({ authorization: "Bearer opaque-a" }, "employee-a", options);
    expect(revoked.authenticated.ok).toBe(false);
    expect(h.resolve).toHaveBeenCalledTimes(2);
    expect(h.transport.requests).toHaveLength(2);
    expect(introspection).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(h.config)).not.toContain("test-client-secret");
  });
});
