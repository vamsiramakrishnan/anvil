/**
 * Bug-bash coverage pass over credentials.ts, focused on branches the
 * co-located credentials.test.ts does not exercise: profile/precedence edge
 * cases, Secret Manager dereference failure paths, token-exchange client
 * authentication variants, malformed token-endpoint responses, and the
 * fail-closed composite router. Every failure path is also checked for the
 * safety contract: a secret literal must never appear in the resolved
 * AuthMaterial or in any value this module returns to a caller.
 */

import { generateKeyPairSync } from "node:crypto";
import { type AuthRequirement, AuthRequirement as AuthSchema } from "@anvil/air";
import { describe, expect, it } from "vitest";
import type { AuthMaterial, CredentialResolver } from "./auth.js";
import {
  CompositeCredentialResolver,
  resolveCredentials,
  SecretManagerCredentialResolver,
  TokenExchangeResolver,
} from "./credentials.js";

/** A minimal AuthRequirement with sensible defaults for a test case. */
function auth(
  partial: Partial<AuthRequirement> & { type: AuthRequirement["type"] },
): AuthRequirement {
  return AuthSchema.parse({ scopes: [], ...partial });
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

interface FakeResponse {
  status?: number;
  json?: unknown;
  text?: string;
}
/** An injectable fetch that records calls and dispatches by URL substring. */
function fakeFetch(routes: (url: string, body: string) => FakeResponse) {
  const calls: { url: string; method: string; body: string; headers: Record<string, string> }[] =
    [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({
      url,
      method: init?.method ?? "GET",
      body,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    const r = routes(url, body);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.json,
      text: async () => r.text ?? "",
    } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** SM-access + metadata-token router for a single secret payload. */
function smRoutes(secretValue: string, opts: { accessStatus?: number } = {}) {
  return (url: string): FakeResponse => {
    if (url.includes("/token")) return { json: { access_token: "meta-tok", expires_in: 3600 } };
    if (url.includes(":access"))
      return { status: opts.accessStatus ?? 200, json: { payload: { data: b64(secretValue) } } };
    return { status: 404 };
  };
}

/** A stub CredentialResolver that records the profiles it was asked to resolve. */
function stubResolver(material: AuthMaterial | null, withExpected = true) {
  const calls: string[] = [];
  const resolver: CredentialResolver = {
    async resolve(profileName) {
      calls.push(profileName);
      return material;
    },
  };
  if (withExpected) {
    resolver.expectedCredentials = () => ["STUB_VAR"];
  }
  return { calls, resolver };
}

describe("SecretManagerCredentialResolver — auth-type branch coverage", () => {
  it("returns empty material for auth type none", async () => {
    const r = new SecretManagerCredentialResolver({ env: {} });
    expect(await r.resolve("prod", auth({ type: "none" }))).toEqual({});
  });

  it("fails closed when the api key is not configured", async () => {
    const r = new SecretManagerCredentialResolver({ env: {} });
    expect(await r.resolve("prod", auth({ type: "api_key" }))).toBeNull();
  });

  it.each([
    { env: { ANVIL_PROD_USERNAME: "user" }, missing: "password" },
    { env: { ANVIL_PROD_PASSWORD: "pass" }, missing: "username" },
  ])("fails closed for basic auth missing the $missing", async ({ env }) => {
    const r = new SecretManagerCredentialResolver({ env });
    expect(await r.resolve("prod", auth({ type: "basic" }))).toBeNull();
  });

  it.each([
    "mtls",
    "custom_header",
    "oauth2_authorization_code",
  ] as const)("fails closed for the unmodeled %s scheme instead of leaking a bearer", async (type) => {
    const r = new SecretManagerCredentialResolver({
      env: { ANVIL_PROD_TOKEN: "must-not-leak" },
    });
    expect(await r.resolve("prod", auth({ type }))).toBeNull();
  });

  it("fails closed for a static bearer scheme when no token is configured", async () => {
    const r = new SecretManagerCredentialResolver({ env: {} });
    expect(await r.resolve("prod", auth({ type: "jwt_bearer" }))).toBeNull();
  });
});

describe("SecretManagerCredentialResolver — Secret Manager dereference edge cases", () => {
  it("fails closed on a shorthand sm:// reference with no configured secret project", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 500 }));
    const r = new SecretManagerCredentialResolver({
      env: { ANVIL_PROD_TOKEN: "sm://my-secret" },
      fetchImpl: fn,
    });
    expect(await r.resolve("prod", auth({ type: "jwt_bearer" }))).toBeNull();
    // resourceName() rejects the shorthand before any network call is attempted.
    expect(calls).toEqual([]);
  });

  it("resolves a shorthand sm:// reference against the configured default project", async () => {
    const { fn, calls } = fakeFetch(smRoutes("shorthand-secret"));
    const r = new SecretManagerCredentialResolver({
      env: { ANVIL_PROD_TOKEN: "sm://my-secret" },
      fetchImpl: fn,
      metadataToken: async () => "m",
      secretProject: "proj-1",
    });
    const mat = await r.resolve("prod", auth({ type: "jwt_bearer" }));
    expect(mat).toEqual({ headers: { Authorization: "Bearer shorthand-secret" } });
    expect(
      calls.some((c) => c.url.includes("projects/proj-1/secrets/my-secret/versions/latest:access")),
    ).toBe(true);
  });

  it("fails closed when the Secret Manager payload has no data", async () => {
    const { fn } = fakeFetch((url) => {
      if (url.includes("/token")) return { json: { access_token: "m", expires_in: 3600 } };
      if (url.includes(":access")) return { json: { payload: {} } };
      return { status: 404 };
    });
    const r = new SecretManagerCredentialResolver({
      env: { ANVIL_PROD_TOKEN: "sm://projects/p/secrets/tok/versions/1" },
      fetchImpl: fn,
    });
    expect(await r.resolve("prod", auth({ type: "jwt_bearer" }))).toBeNull();
  });

  it("fails closed when the metadata-server token mint fails", async () => {
    const { fn } = fakeFetch((url) => (url.includes("/token") ? { status: 500 } : { status: 404 }));
    const r = new SecretManagerCredentialResolver({
      env: { ANVIL_PROD_TOKEN: "sm://projects/p/secrets/tok/versions/1" },
      fetchImpl: fn,
    });
    expect(await r.resolve("prod", auth({ type: "jwt_bearer" }))).toBeNull();
  });

  it("fails closed when the metadata-server token response has no access_token", async () => {
    const { fn } = fakeFetch((url) => (url.includes("/token") ? { json: {} } : { status: 404 }));
    const r = new SecretManagerCredentialResolver({
      env: { ANVIL_PROD_TOKEN: "sm://projects/p/secrets/tok/versions/1" },
      fetchImpl: fn,
    });
    expect(await r.resolve("prod", auth({ type: "jwt_bearer" }))).toBeNull();
  });

  it("negative-caches a failed dereference so a stranded caller does not hammer Secret Manager", async () => {
    const { fn, calls } = fakeFetch(smRoutes("x", { accessStatus: 403 }));
    const r = new SecretManagerCredentialResolver({
      env: { ANVIL_PROD_TOKEN: "sm://projects/p/secrets/tok/versions/1" },
      fetchImpl: fn,
      metadataToken: async () => "m",
    });
    expect(await r.resolve("prod", auth({ type: "jwt_bearer" }))).toBeNull();
    expect(await r.resolve("prod", auth({ type: "jwt_bearer" }))).toBeNull();
    // Second call hits the negative cache instead of re-fetching.
    expect(calls.filter((c) => c.url.includes(":access"))).toHaveLength(1);
  });
});

describe("TokenExchangeResolver — workload identity", () => {
  it("falls back to a metadata-server access token when no audience or resource is set", async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.includes("/token"))
        return { json: { access_token: "META-ACCESS", expires_in: 3600 } };
      return { status: 404 };
    });
    const r = new TokenExchangeResolver({ env: {}, fetchImpl: fn });
    const mat = await r.resolve(
      "prod",
      auth({ type: "workload_identity", secretSource: "workload_identity" }),
    );
    expect(mat).toEqual({ headers: { Authorization: "Bearer META-ACCESS" } });
    expect(calls.some((c) => c.url.endsWith("/token"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/identity"))).toBe(false);
  });

  it("fails closed (and never surfaces the metadata error) when the identity endpoint rejects", async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.includes("/identity") ? { status: 403 } : { status: 404 },
    );
    const r = new TokenExchangeResolver({ env: {}, fetchImpl: fn });
    const mat = await r.resolve(
      "prod",
      auth({
        type: "workload_identity",
        secretSource: "workload_identity",
        audience: "https://svc.run.app",
      }),
    );
    expect(mat).toBeNull();
    expect(calls.some((c) => c.url.includes("/identity"))).toBe(true);
  });
});

describe("TokenExchangeResolver — jwt_bearer grant edge cases", () => {
  it("fails closed when no token endpoint is configured or imported", async () => {
    const r = new TokenExchangeResolver({ env: {} });
    const mat = await r.resolve(
      "prod",
      auth({ type: "jwt_bearer", provider: { grant: "jwt_bearer" } }),
    );
    expect(mat).toBeNull();
  });

  it("fails closed when the assertion signing key is not configured", async () => {
    const { fn, calls } = fakeFetch(() => ({ json: { access_token: "SHOULD_NOT_EXIST" } }));
    const r = new TokenExchangeResolver({
      env: {
        ANVIL_PROD_TOKEN_ENDPOINT: "https://idp.example.com/token",
        ANVIL_PROD_CLIENT_ID: "cid",
      },
      fetchImpl: fn,
    });
    const mat = await r.resolve(
      "prod",
      auth({ type: "jwt_bearer", provider: { grant: "jwt_bearer" } }),
    );
    expect(mat).toBeNull();
    expect(calls).toEqual([]);
  });

  // BUG: acquire() computes `audience`/`resource` from ANVIL_<P>_AUDIENCE /
  // ANVIL_<P>_RESOURCE (and auth.audience/auth.provider.resource) up front and
  // sends them on the token_exchange and client_credentials grants, but the
  // RFC 7523 jwt_bearer branch (credentials.ts, the `post(tokenEndpoint, {
  // grant_type: GRANT_JWT_BEARER, assertion, ...(scope ? { scope } : {}) }, ...)`
  // call) never includes them in the token request body, even though
  // credentialRequirement() (auth.ts) advertises ANVIL_<P>_AUDIENCE as an
  // optional credential for this exact auth shape. An operator who sets the
  // audience for a jwt_bearer grant gets it silently dropped.
  it.fails("BUG: jwt_bearer grant silently drops the configured audience from the token request", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const { fn, calls } = fakeFetch(() => ({
      json: { access_token: "ASSERTED", expires_in: 3600 },
    }));
    const r = new TokenExchangeResolver({
      env: {
        ANVIL_PROD_TOKEN_ENDPOINT: "https://idp.example.com/token",
        ANVIL_PROD_CLIENT_ID: "svc@project.iam",
        ANVIL_PROD_CLIENT_ASSERTION_KEY: privateKey,
      },
      fetchImpl: fn,
    });
    await r.resolve(
      "prod",
      auth({
        type: "jwt_bearer",
        provider: { grant: "jwt_bearer" },
        audience: "https://target.example",
      }),
    );
    const form = new URLSearchParams(calls.find((c) => c.method === "POST")?.body ?? "");
    expect(form.get("audience")).toBe("https://target.example");
  });
});

describe("TokenExchangeResolver — private_key_jwt client authentication", () => {
  it("signs a client assertion instead of sending the client secret in a Basic header", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const { fn, calls } = fakeFetch(() => ({ json: { access_token: "SVC", expires_in: 3600 } }));
    const r = new TokenExchangeResolver({
      env: {
        ANVIL_PROD_TOKEN_ENDPOINT: "https://sts.example.com/token",
        ANVIL_PROD_CLIENT_ID: "svc-account",
        ANVIL_PROD_CLIENT_ASSERTION_KEY: privateKey,
      },
      fetchImpl: fn,
      now: () => 1_700_000_000_000,
    });
    const mat = await r.resolve(
      "prod",
      auth({ type: "oauth2_client_credentials", provider: { clientAuth: "private_key_jwt" } }),
    );
    expect(mat).toEqual({ headers: { Authorization: "Bearer SVC" } });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.headers.authorization).toBeUndefined();
    const form = new URLSearchParams(post?.body ?? "");
    expect(form.get("client_assertion_type")).toBe(
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    );
    expect(form.get("client_id")).toBe("svc-account");
    const assertion = form.get("client_assertion") ?? "";
    expect(assertion.split(".")).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString());
    expect(payload.iss).toBe("svc-account");
    expect(payload.aud).toBe("https://sts.example.com/token");
    // The private key must never appear on the wire.
    expect(post?.body ?? "").not.toContain(privateKey);
  });

  it("fails closed when the assertion signing key is not configured", async () => {
    const { fn, calls } = fakeFetch(() => ({ json: { access_token: "SHOULD_NOT_EXIST" } }));
    const r = new TokenExchangeResolver({
      env: {
        ANVIL_PROD_TOKEN_ENDPOINT: "https://sts.example.com/token",
        ANVIL_PROD_CLIENT_ID: "svc-account",
      },
      fetchImpl: fn,
    });
    const mat = await r.resolve(
      "prod",
      auth({ type: "oauth2_client_credentials", provider: { clientAuth: "private_key_jwt" } }),
    );
    expect(mat).toBeNull();
    expect(calls).toEqual([]);
  });

  it("fails closed for client_secret_basic when the client id or secret is missing", async () => {
    const { fn, calls } = fakeFetch(() => ({ json: { access_token: "SHOULD_NOT_EXIST" } }));
    const r = new TokenExchangeResolver({
      env: {
        ANVIL_PROD_TOKEN_ENDPOINT: "https://sts.example.com/token",
        ANVIL_PROD_CLIENT_ID: "cid",
        // ANVIL_PROD_CLIENT_SECRET intentionally absent.
      },
      fetchImpl: fn,
    });
    expect(await r.resolve("prod", auth({ type: "oauth2_client_credentials" }))).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("TokenExchangeResolver — malformed token endpoint responses", () => {
  const env = {
    ANVIL_PROD_TOKEN_ENDPOINT: "https://sts.example.com/token",
    ANVIL_PROD_CLIENT_ID: "cid",
    ANVIL_PROD_CLIENT_SECRET: "topsecret-client-secret",
  };

  it("fails closed on a non-2xx token endpoint status and never surfaces the client secret", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 500, json: {} }));
    const r = new TokenExchangeResolver({ env, fetchImpl: fn });
    const mat = await r.resolve("prod", auth({ type: "oauth2_client_credentials" }));
    expect(mat).toBeNull();
    expect(JSON.stringify(mat)).not.toContain("topsecret-client-secret");
    expect(calls).toHaveLength(1);
  });

  it("fails closed when the token endpoint returns a non-object JSON body", async () => {
    const { fn, calls } = fakeFetch(() => ({ json: "not-an-object" }));
    const r = new TokenExchangeResolver({ env, fetchImpl: fn });
    expect(await r.resolve("prod", auth({ type: "oauth2_client_credentials" }))).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("fails closed when access_token is not a string", async () => {
    const { fn } = fakeFetch(() => ({ json: { access_token: 12345 } }));
    const r = new TokenExchangeResolver({ env, fetchImpl: fn });
    expect(await r.resolve("prod", auth({ type: "oauth2_client_credentials" }))).toBeNull();
  });

  it("fails closed when expires_in is not a finite number", async () => {
    const { fn } = fakeFetch(() => ({ json: { access_token: "T", expires_in: "soon" } }));
    const r = new TokenExchangeResolver({ env, fetchImpl: fn });
    expect(await r.resolve("prod", auth({ type: "oauth2_client_credentials" }))).toBeNull();
  });

  it("returns null, not a partial material, when the response has no access_token", async () => {
    const { fn, calls } = fakeFetch(() => ({ json: {} }));
    const r = new TokenExchangeResolver({ env, fetchImpl: fn });
    expect(await r.resolve("prod", auth({ type: "oauth2_client_credentials" }))).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns a short-lived token without caching it (re-mints on every call)", async () => {
    let minted = 0;
    const { fn, calls } = fakeFetch(() => ({
      // expires_in below the 60s expiry leeway: ttl is not positive, so cached()
      // must not store it.
      json: { access_token: `SHORT${minted++}`, expires_in: 30 },
    }));
    const r = new TokenExchangeResolver({ env, fetchImpl: fn });
    const requirement = auth({ type: "oauth2_client_credentials" });
    const a = await r.resolve("prod", requirement);
    const b = await r.resolve("prod", requirement);
    expect(a).not.toEqual(b);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });
});

describe("TokenExchangeResolver — redundant coherence guard", () => {
  it("fails closed directly (not only via the composite router) for an incoherent auth shape", async () => {
    const { fn, calls } = fakeFetch(() => ({ json: { access_token: "SHOULD_NOT_EXIST" } }));
    const r = new TokenExchangeResolver({ env: {}, fetchImpl: fn });
    // workload_identity without the required workload_identity secret source.
    const mat = await r.resolve("prod", auth({ type: "workload_identity" }));
    expect(mat).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("CompositeCredentialResolver — routing precedence", () => {
  it("routes a declared vault secret source ahead of OAuth grant routing", async () => {
    const exR = stubResolver(null);
    const vaultR = stubResolver({ headers: { "X-Vault": "1" } });
    const composite = new CompositeCredentialResolver(
      stubResolver(null).resolver,
      () => stubResolver(null).resolver,
      () => exR.resolver,
      () => vaultR.resolver,
    );
    const mat = await composite.resolve(
      "prod",
      auth({ type: "oauth2_on_behalf_of", principal: "delegated", secretSource: "vault" }),
      { inbound: { subjectToken: "T", subjectTokenType: "jwt", sub: "u" } },
    );
    expect(mat).toEqual({ headers: { "X-Vault": "1" } });
    expect(exR.calls).toEqual([]);
    expect(vaultR.calls).toEqual(["prod"]);
  });

  it.each([
    {
      name: "workload_identity",
      requirement: auth({ type: "workload_identity", secretSource: "workload_identity" }),
    },
    {
      name: "jwt_bearer with the jwt_bearer grant",
      requirement: auth({ type: "jwt_bearer", provider: { grant: "jwt_bearer" } }),
    },
    { name: "oauth2_client_credentials", requirement: auth({ type: "oauth2_client_credentials" }) },
  ])("routes $name to the token-exchange resolver", async ({ requirement }) => {
    const staticR = stubResolver(null);
    const exR = stubResolver({ headers: { Authorization: "Bearer EX" } });
    const composite = new CompositeCredentialResolver(
      staticR.resolver,
      () => stubResolver(null).resolver,
      () => exR.resolver,
      () => stubResolver(null).resolver,
    );
    const mat = await composite.resolve("prod", requirement);
    expect(mat).toEqual({ headers: { Authorization: "Bearer EX" } });
    expect(exR.calls).toEqual(["prod"]);
    expect(staticR.calls).toEqual([]);
  });

  it("keeps a jwt_bearer type without the jwt_bearer grant on the static/secret_manager path", async () => {
    const staticR = stubResolver({ headers: { Authorization: "Bearer STATIC" } });
    const exR = stubResolver(null);
    const composite = new CompositeCredentialResolver(
      staticR.resolver,
      () => stubResolver(null).resolver,
      () => exR.resolver,
      () => stubResolver(null).resolver,
    );
    const mat = await composite.resolve("prod", auth({ type: "jwt_bearer" }));
    expect(mat).toEqual({ headers: { Authorization: "Bearer STATIC" } });
    expect(exR.calls).toEqual([]);
  });

  it("routes a secret_manager secret source to the Secret Manager resolver", async () => {
    const staticR = stubResolver(null);
    const smR = stubResolver({ headers: { "X-API-Key": "SM" } });
    const composite = new CompositeCredentialResolver(
      staticR.resolver,
      () => smR.resolver,
      () => stubResolver(null).resolver,
      () => stubResolver(null).resolver,
    );
    const mat = await composite.resolve(
      "prod",
      auth({ type: "api_key", secretSource: "secret_manager" }),
    );
    expect(mat).toEqual({ headers: { "X-API-Key": "SM" } });
    expect(smR.calls).toEqual(["prod"]);
    expect(staticR.calls).toEqual([]);
  });

  it("short-circuits resolve() and expectedCredentials() to fail-closed for an incoherent auth shape", async () => {
    const staticR = stubResolver({ headers: { Authorization: "Bearer MUST_NOT_USE" } });
    const composite = new CompositeCredentialResolver(
      staticR.resolver,
      () => stubResolver(null).resolver,
      () => stubResolver(null).resolver,
      () => stubResolver(null).resolver,
    );
    // api_key is a shared-runtime-credential type, so a non-service principal
    // (here "anonymous") is incoherent per authCoherenceIssues.
    const incoherent = auth({ type: "api_key", principal: "anonymous" });
    expect(await composite.resolve("prod", incoherent)).toBeNull();
    expect(composite.expectedCredentials("prod", incoherent)).toEqual([]);
    expect(staticR.calls).toEqual([]);
  });

  it("falls back to an empty list when the routed resolver has no expectedCredentials method", () => {
    const bareResolver: CredentialResolver = {
      async resolve() {
        return null;
      },
    };
    const composite = new CompositeCredentialResolver(
      bareResolver,
      () => bareResolver,
      () => bareResolver,
      () => bareResolver,
    );
    expect(composite.expectedCredentials("prod", auth({ type: "api_key" }))).toEqual([]);
  });
});

describe("resolveCredentials — additional precedence & redaction", () => {
  it("disables the loopback token-issuer exception when the caller explicitly opts out, even in dev", async () => {
    const env = {
      ANVIL_DEF_TOKEN_ENDPOINT: "http://127.0.0.1:8123/__anvil/oauth/token",
      ANVIL_DEF_CLIENT_ID: "client",
      ANVIL_DEF_CLIENT_SECRET: "secret",
    };
    const { fn, calls } = fakeFetch(() => ({
      json: { access_token: "MUST_NOT_MINT", expires_in: 3600 },
    }));
    const r = resolveCredentials(
      { env: "dev", allowedHosts: [] },
      { env, fetchImpl: fn, allowLoopbackHttp: false },
    );
    expect(await r.resolve("def", auth({ type: "oauth2_client_credentials" }))).toBeNull();
    expect(calls).toEqual([]);
  });

  it("routes workload_identity end to end through the full resolveCredentials stack", async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.includes("/identity") ? { text: "GCP.ID.TOKEN" } : { status: 404 },
    );
    const r = resolveCredentials({ env: "dev", allowedHosts: [] }, { env: {}, fetchImpl: fn });
    const mat = await r.resolve(
      "def",
      auth({
        type: "workload_identity",
        secretSource: "workload_identity",
        audience: "https://svc.run.app",
      }),
    );
    expect(mat).toEqual({ headers: { Authorization: "Bearer GCP.ID.TOKEN" } });
    expect(calls[0]?.url).toContain("audience=https%3A%2F%2Fsvc.run.app");
  });

  it("never leaks the configured client secret when the token endpoint rejects the request", async () => {
    const { fn } = fakeFetch(() => ({ status: 401, json: { error: "invalid_client" } }));
    const r = resolveCredentials(
      { env: "dev", allowedHosts: [] },
      {
        env: {
          ANVIL_DEF_TOKEN_ENDPOINT: "https://sts.example.com/token",
          ANVIL_DEF_CLIENT_ID: "cid",
          ANVIL_DEF_CLIENT_SECRET: "super-secret-value",
        },
        fetchImpl: fn,
      },
    );
    const mat = await r.resolve("def", auth({ type: "oauth2_client_credentials" }));
    expect(mat).toBeNull();
    expect(JSON.stringify(mat)).not.toContain("super-secret-value");
  });
});
