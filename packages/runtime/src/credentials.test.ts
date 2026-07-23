import { generateKeyPairSync } from "node:crypto";
import { type AuthRequirement, AuthRequirement as AuthSchema } from "@anvil/air";
import { describe, expect, it } from "vitest";
import {
  isSecretRef,
  registerCredentialBackend,
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

describe("isSecretRef", () => {
  it("recognizes sm:// and bare resource names, not literals", () => {
    expect(isSecretRef("sm://projects/p/secrets/s/versions/1")).toBe(true);
    expect(isSecretRef("sm://my-secret")).toBe(true);
    expect(isSecretRef("projects/p/secrets/s/versions/latest")).toBe(true);
    expect(isSecretRef("just-a-literal-token")).toBe(false);
    expect(isSecretRef("Bearer abc")).toBe(false);
  });
});

describe("SecretManagerCredentialResolver", () => {
  it("passes a literal value through without any fetch (dev unchanged)", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 500 }));
    const r = new SecretManagerCredentialResolver({
      env: { ANVIL_PROD_API_KEY: "literal-key" },
      fetchImpl: fn,
    });
    const mat = await r.resolve("prod", auth({ type: "api_key" }));
    expect(mat).toEqual({ headers: { "X-API-Key": "literal-key" } });
    expect(calls).toHaveLength(0);
  });

  it("dereferences an sm:// bearer reference from Secret Manager", async () => {
    const { fn, calls } = fakeFetch(smRoutes("s3cr3t-token"));
    const r = new SecretManagerCredentialResolver({
      env: { ANVIL_PROD_TOKEN: "sm://projects/p/secrets/tok/versions/1" },
      fetchImpl: fn,
    });
    const mat = await r.resolve("prod", auth({ type: "oauth2_client_credentials" }));
    expect(mat).toEqual({ headers: { Authorization: "Bearer s3cr3t-token" } });
    expect(calls.some((c) => c.url.includes("projects/p/secrets/tok/versions/1:access"))).toBe(
      true,
    );
  });

  it("caches within the TTL and re-fetches after it (rotation)", async () => {
    let clock = 1_000_000;
    let value = "v1";
    const { fn, calls } = fakeFetch((url) => {
      if (url.includes("/token")) return { json: { access_token: "m", expires_in: 3600 } };
      if (url.includes(":access")) return { json: { payload: { data: b64(value) } } };
      return { status: 404 };
    });
    const r = new SecretManagerCredentialResolver({
      env: { ANVIL_PROD_TOKEN: "sm://projects/p/secrets/tok/versions/latest" },
      fetchImpl: fn,
      metadataToken: async () => "m",
      now: () => clock,
      ttlMs: 1000,
    });
    const a = await r.resolve("prod", auth({ type: "jwt_bearer" }));
    const accessCount = () => calls.filter((c) => c.url.includes(":access")).length;
    expect(a).toEqual({ headers: { Authorization: "Bearer v1" } });
    expect(accessCount()).toBe(1);
    // Within TTL: cache hit, no new fetch.
    await r.resolve("prod", auth({ type: "jwt_bearer" }));
    expect(accessCount()).toBe(1);
    // After TTL + a rotated value: re-fetch.
    clock += 2000;
    value = "v2";
    const c = await r.resolve("prod", auth({ type: "jwt_bearer" }));
    expect(c).toEqual({ headers: { Authorization: "Bearer v2" } });
    expect(accessCount()).toBe(2);
  });

  it("mints the metadata token once across two distinct secrets", async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.includes("/token")) return { json: { access_token: "meta", expires_in: 3600 } };
      if (url.includes(":access")) return { json: { payload: { data: b64("x") } } };
      return { status: 404 };
    });
    // Two profiles → two SM refs → one shared SecretDeref only within a resolver.
    const r = new SecretManagerCredentialResolver({
      env: {
        ANVIL_A_TOKEN: "sm://projects/p/secrets/a/versions/1",
        ANVIL_B_TOKEN: "sm://projects/p/secrets/b/versions/1",
      },
      fetchImpl: fn,
      now: () => 5,
    });
    await r.resolve("a", auth({ type: "jwt_bearer" }));
    await r.resolve("b", auth({ type: "jwt_bearer" }));
    expect(calls.filter((c) => c.url.endsWith("/token")).length).toBe(1);
    expect(calls.filter((c) => c.url.includes(":access")).length).toBe(2);
  });

  it("fails closed (null) and never leaks the SM error on 403", async () => {
    const { fn } = fakeFetch(smRoutes("nope", { accessStatus: 403 }));
    const r = new SecretManagerCredentialResolver({
      env: { ANVIL_PROD_TOKEN: "sm://projects/p/secrets/tok/versions/1" },
      fetchImpl: fn,
      metadataToken: async () => "m",
    });
    const mat = await r.resolve("prod", auth({ type: "oauth2_client_credentials" }));
    expect(mat).toBeNull();
  });

  it("honors an env API-key carrier override (header and query)", async () => {
    const rHeader = new SecretManagerCredentialResolver({
      env: { ANVIL_PROD_API_KEY: "k", ANVIL_PROD_API_KEY_HEADER: "X-Custom-Key" },
    });
    expect(await rHeader.resolve("prod", auth({ type: "api_key" }))).toEqual({
      headers: { "X-Custom-Key": "k" },
    });
    const rQuery = new SecretManagerCredentialResolver({
      env: { ANVIL_PROD_API_KEY: "k", ANVIL_PROD_API_KEY_QUERY: "apikey" },
    });
    expect(await rQuery.resolve("prod", auth({ type: "api_key" }))).toEqual({
      query: { apikey: "k" },
    });
  });

  it("honors an AIR provider.apiKey carrier when no env override is set", async () => {
    const r = new SecretManagerCredentialResolver({ env: { ANVIL_PROD_API_KEY: "k" } });
    const mat = await r.resolve(
      "prod",
      auth({ type: "api_key", provider: { apiKey: { in: "query", name: "subscription-key" } } }),
    );
    expect(mat).toEqual({ query: { "subscription-key": "k" } });
  });

  it("dereferences an sm:// basic password", async () => {
    const { fn } = fakeFetch(smRoutes("p@ss"));
    const r = new SecretManagerCredentialResolver({
      env: {
        ANVIL_PROD_USERNAME: "user",
        ANVIL_PROD_PASSWORD: "sm://projects/p/secrets/pw/versions/1",
      },
      fetchImpl: fn,
      metadataToken: async () => "m",
    });
    const mat = await r.resolve("prod", auth({ type: "basic" }));
    expect(mat).toEqual({ headers: { Authorization: `Basic ${b64("user:p@ss")}` } });
  });
});

describe("TokenExchangeResolver — RFC 8693 on-behalf-of", () => {
  const oboEnv = {
    ANVIL_PROD_TOKEN_ENDPOINT: "https://sts.example.com/token",
    ANVIL_PROD_CLIENT_ID: "cid",
    ANVIL_PROD_CLIENT_SECRET: "csecret",
  };
  const inbound = {
    subjectToken: "USER.JWT.TOKEN",
    subjectTokenType: "jwt" as const,
    sub: "user-1",
    email: "u@example.com",
  };

  function bodyOf(body: string): URLSearchParams {
    return new URLSearchParams(body);
  }

  it("exchanges the inbound token for a downstream bearer", async () => {
    const { fn, calls } = fakeFetch(() => ({
      json: { access_token: "EXCHANGED", expires_in: 3600 },
    }));
    const r = new TokenExchangeResolver({ env: oboEnv, fetchImpl: fn });
    const mat = await r.resolve(
      "prod",
      auth({
        type: "oauth2_on_behalf_of",
        principal: "delegated",
        audience: "https://up",
        scopes: ["a", "b"],
      }),
      { inbound },
    );
    expect(mat).toEqual({ headers: { Authorization: "Bearer EXCHANGED" } });
    const post = calls.find((c) => c.url === oboEnv.ANVIL_PROD_TOKEN_ENDPOINT);
    expect(post?.method).toBe("POST");
    const form = bodyOf(post?.body ?? "");
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(form.get("subject_token")).toBe("USER.JWT.TOKEN");
    expect(form.get("subject_token_type")).toBe("urn:ietf:params:oauth:token-type:jwt");
    expect(form.get("audience")).toBe("https://up");
    expect(form.get("scope")).toBe("a b");
    expect(form.get("actor_token")).toBeNull(); // no delegation.actor ⇒ impersonation-style
    // client_secret_basic by default.
    expect(post?.headers.authorization).toBe(`Basic ${b64("cid:csecret")}`);
  });

  it("includes actor_token for true delegation when delegation.actor is set", async () => {
    const { fn, calls } = fakeFetch(() => ({ json: { access_token: "E", expires_in: 3600 } }));
    const r = new TokenExchangeResolver({
      env: { ...oboEnv, ANVIL_PROD_ACTOR_TOKEN: "ACTOR.TOK" },
      fetchImpl: fn,
    });
    await r.resolve(
      "prod",
      auth({
        type: "oauth2_on_behalf_of",
        principal: "delegated",
        audience: "https://up",
        delegation: { actor: "svc" },
      }),
      { inbound },
    );
    const form = bodyOf(calls.find((c) => c.method === "POST")?.body ?? "");
    expect(form.get("actor_token")).toBe("ACTOR.TOK");
    expect(form.get("actor_token_type")).toBe("urn:ietf:params:oauth:token-type:jwt");
  });

  it("fails closed instead of downgrading delegation when the actor token is missing", async () => {
    const { fn, calls } = fakeFetch(() => ({ json: { access_token: "E", expires_in: 3600 } }));
    const r = new TokenExchangeResolver({ env: oboEnv, fetchImpl: fn });
    const requirement = auth({
      type: "oauth2_on_behalf_of",
      principal: "delegated",
      delegation: { actor: "agent-service", subject: "end-user" },
    });
    expect(await r.resolve("prod", requirement, { inbound })).toBeNull();
    expect(calls).toEqual([]);
    expect(r.expectedCredentials("prod", requirement)).toContain("ANVIL_PROD_ACTOR_TOKEN");
  });

  it("supports client_secret_post client auth", async () => {
    const { fn, calls } = fakeFetch(() => ({ json: { access_token: "E", expires_in: 3600 } }));
    const r = new TokenExchangeResolver({ env: oboEnv, fetchImpl: fn });
    await r.resolve(
      "prod",
      auth({
        type: "oauth2_on_behalf_of",
        principal: "delegated",
        audience: "https://up",
        provider: { clientAuth: "client_secret_post" },
      }),
      { inbound },
    );
    const post = calls.find((c) => c.method === "POST");
    const form = bodyOf(post?.body ?? "");
    expect(form.get("client_id")).toBe("cid");
    expect(form.get("client_secret")).toBe("csecret");
    expect(post?.headers.authorization).toBeUndefined();
  });

  it("fails closed (null) when no inbound identity is present — no static fallback", async () => {
    const { fn, calls } = fakeFetch(() => ({ json: { access_token: "E", expires_in: 3600 } }));
    const r = new TokenExchangeResolver({ env: oboEnv, fetchImpl: fn });
    const mat = await r.resolve(
      "prod",
      auth({ type: "oauth2_on_behalf_of", principal: "delegated", audience: "https://up" }),
    );
    expect(mat).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("caches per (subject, audience, scopes) and re-mints after expiry", async () => {
    let clock = 0;
    let n = 0;
    const { fn, calls } = fakeFetch(() => ({
      json: { access_token: `T${n++}`, expires_in: 3600 },
    }));
    const r = new TokenExchangeResolver({ env: oboEnv, fetchImpl: fn, now: () => clock });
    const req = () =>
      r.resolve(
        "prod",
        auth({
          type: "oauth2_on_behalf_of",
          principal: "delegated",
          audience: "https://up",
          scopes: ["a"],
        }),
        { inbound },
      );
    const a = await req();
    const b = await req();
    expect(a).toEqual(b); // cache hit
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    // A different audience is a different cache key.
    await r.resolve(
      "prod",
      auth({ type: "oauth2_on_behalf_of", principal: "delegated", audience: "https://other" }),
      { inbound },
    );
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
    // After expiry (3600s - 60s leeway), re-mint.
    clock += 3600_000;
    await req();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(3);
  });

  it("never shares an exchanged token between different inbound bearers with the same sub", async () => {
    let minted = 0;
    const { fn, calls } = fakeFetch(() => ({
      json: { access_token: `T${minted++}`, expires_in: 3600 },
    }));
    const r = new TokenExchangeResolver({ env: oboEnv, fetchImpl: fn });
    const requirement = auth({
      type: "oauth2_on_behalf_of",
      principal: "delegated",
      audience: "https://up",
    });

    const first = await r.resolve("prod", requirement, {
      inbound: { ...inbound, subjectToken: "FIRST.JWT.TOKEN" },
    });
    const second = await r.resolve("prod", requirement, {
      inbound: { ...inbound, subjectToken: "SECOND.JWT.TOKEN" },
    });

    expect(first).not.toEqual(second);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
  });

  it("honors the declared subject token type and dereferences an actor token", async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.includes(":access")
        ? { json: { payload: { data: b64("resolved-actor") } } }
        : { json: { access_token: "EXCHANGED", expires_in: 3600 } },
    );
    const r = new TokenExchangeResolver({
      env: {
        ...oboEnv,
        ANVIL_PROD_ACTOR_TOKEN: "sm://projects/p/secrets/actor-token/versions/latest",
      },
      fetchImpl: fn,
      metadataToken: async () => "metadata-token",
    });
    await r.resolve(
      "prod",
      auth({
        type: "oauth2_on_behalf_of",
        principal: "delegated",
        delegation: { actor: "service-agent" },
        provider: { subjectTokenType: "id_token" },
      }),
      { inbound },
    );
    const form = bodyOf(calls.find((call) => call.method === "POST")?.body ?? "");
    expect(form.get("subject_token_type")).toBe("urn:ietf:params:oauth:token-type:id_token");
    expect(form.get("actor_token")).toBe("resolved-actor");
  });
});

describe("TokenExchangeResolver — other grants", () => {
  it("runs the client_credentials grant (service principal)", async () => {
    const { fn, calls } = fakeFetch(() => ({ json: { access_token: "SVC", expires_in: 3600 } }));
    const r = new TokenExchangeResolver({
      env: {
        ANVIL_PROD_TOKEN_ENDPOINT: "https://sts.example.com/token",
        ANVIL_PROD_CLIENT_ID: "cid",
        ANVIL_PROD_CLIENT_SECRET: "sec",
      },
      fetchImpl: fn,
    });
    const mat = await r.resolve(
      "prod",
      auth({ type: "oauth2_client_credentials", principal: "service", scopes: ["x"] }),
    );
    expect(mat).toEqual({ headers: { Authorization: "Bearer SVC" } });
    const form = new URLSearchParams(calls.find((c) => c.method === "POST")?.body ?? "");
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("x");
  });

  it("isolates client-credential tokens by endpoint and sends the RFC 8707 resource", async () => {
    const { fn, calls } = fakeFetch((url) => ({
      json: { access_token: url.includes("issuer-a") ? "A" : "B", expires_in: 3600 },
    }));
    const r = new TokenExchangeResolver({
      env: {
        ANVIL_PROD_CLIENT_ID: "cid",
        ANVIL_PROD_CLIENT_SECRET: "sec",
        ANVIL_CREDENTIAL_HOSTS: "issuer-a.example,issuer-b.example",
      },
      fetchImpl: fn,
    });
    const resolveAt = (tokenEndpoint: string) =>
      r.resolve(
        "prod",
        auth({
          type: "oauth2_client_credentials",
          provider: {
            tokenEndpoint,
            resource: "https://resource.example",
          },
        }),
      );

    expect(await resolveAt("https://issuer-a.example/token")).toEqual({
      headers: { Authorization: "Bearer A" },
    });
    expect(await resolveAt("https://issuer-b.example/token")).toEqual({
      headers: { Authorization: "Bearer B" },
    });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
    for (const call of calls.filter((entry) => entry.method === "POST")) {
      expect(new URLSearchParams(call.body).get("resource")).toBe("https://resource.example");
    }
  });

  it("mints a GCP workload-identity ID token for the audience", async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.includes("/identity")) return { text: "GCP.ID.TOKEN" };
      return { status: 404 };
    });
    const r = new TokenExchangeResolver({ env: {}, fetchImpl: fn });
    const mat = await r.resolve(
      "prod",
      auth({
        type: "workload_identity",
        principal: "service",
        secretSource: "workload_identity",
        audience: "https://svc.run.app",
      }),
    );
    expect(mat).toEqual({ headers: { Authorization: "Bearer GCP.ID.TOKEN" } });
    expect(calls[0]?.url).toContain("audience=https%3A%2F%2Fsvc.run.app");
  });

  it.each([
    "http://sts.example.com/token",
    "https://127.0.0.1/token",
    "https://169.254.169.254/latest/token",
    "https://metadata.google.internal/token",
  ])("refuses unsafe token endpoint %s before sending a client secret", async (endpoint) => {
    const { fn, calls } = fakeFetch(() => ({
      json: { access_token: "SHOULD_NOT_EXIST", expires_in: 3600 },
    }));
    const r = new TokenExchangeResolver({
      env: {
        ANVIL_PROD_TOKEN_ENDPOINT: endpoint,
        ANVIL_PROD_CLIENT_ID: "cid",
        ANVIL_PROD_CLIENT_SECRET: "secret",
      },
      fetchImpl: fn,
    });
    expect(await r.resolve("prod", auth({ type: "oauth2_client_credentials" }))).toBeNull();
    expect(calls).toEqual([]);
  });

  it("rejects a DNS name with any private answer", async () => {
    const { fn, calls } = fakeFetch(() => ({
      json: { access_token: "SHOULD_NOT_EXIST", expires_in: 3600 },
    }));
    const r = new TokenExchangeResolver({
      env: {
        ANVIL_PROD_TOKEN_ENDPOINT: "https://sts.example.com/token",
        ANVIL_PROD_CLIENT_ID: "cid",
        ANVIL_PROD_CLIENT_SECRET: "secret",
      },
      fetchImpl: fn,
      resolveHost: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
    });
    expect(await r.resolve("prod", auth({ type: "oauth2_client_credentials" }))).toBeNull();
    expect(calls).toEqual([]);
  });

  it("requires an operator host allowlist for a token endpoint imported from AIR", async () => {
    const { fn, calls } = fakeFetch(() => ({
      json: { access_token: "AIR", expires_in: 3600 },
    }));
    const requirement = auth({
      type: "oauth2_client_credentials",
      provider: { tokenEndpoint: "https://issuer.example/token" },
    });
    const missing = new TokenExchangeResolver({
      env: { ANVIL_PROD_CLIENT_ID: "cid", ANVIL_PROD_CLIENT_SECRET: "secret" },
      fetchImpl: fn,
    });
    expect(await missing.resolve("prod", requirement)).toBeNull();
    expect(calls).toEqual([]);

    const admitted = new TokenExchangeResolver({
      env: {
        ANVIL_PROD_CLIENT_ID: "cid",
        ANVIL_PROD_CLIENT_SECRET: "secret",
        ANVIL_CREDENTIAL_HOSTS: "issuer.example",
      },
      fetchImpl: fn,
    });
    expect(await admitted.resolve("prod", requirement)).toEqual({
      headers: { Authorization: "Bearer AIR" },
    });
  });

  it("bounds the token cache and deduplicates concurrent acquisitions", async () => {
    let minted = 0;
    const { fn, calls } = fakeFetch(asyncRoute);
    function asyncRoute(): FakeResponse {
      minted += 1;
      return { json: { access_token: `T${minted}`, expires_in: 3600 } };
    }
    const r = new TokenExchangeResolver({
      env: {
        ANVIL_PROD_TOKEN_ENDPOINT: "https://sts.example.com/token",
        ANVIL_PROD_CLIENT_ID: "cid",
        ANVIL_PROD_CLIENT_SECRET: "secret",
      },
      fetchImpl: fn,
      maxTokenCacheEntries: 2,
    });
    const requirement = (audience: string) => auth({ type: "oauth2_client_credentials", audience });
    await Promise.all([
      r.resolve("prod", requirement("one")),
      r.resolve("prod", requirement("one")),
    ]);
    expect(calls).toHaveLength(1);
    await r.resolve("prod", requirement("two"));
    await r.resolve("prod", requirement("three"));
    await r.resolve("prod", requirement("one"));
    expect(calls).toHaveLength(4);
  });

  it("runs the RFC 7523 jwt-bearer assertion grant", async () => {
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
      now: () => 1_700_000_000_000,
    });
    const mat = await r.resolve(
      "prod",
      auth({
        type: "jwt_bearer",
        provider: { grant: "jwt_bearer" },
        delegation: { subject: "boss@corp.com" },
      }),
    );
    expect(mat).toEqual({ headers: { Authorization: "Bearer ASSERTED" } });
    const form = new URLSearchParams(calls.find((c) => c.method === "POST")?.body ?? "");
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const assertion = form.get("assertion") ?? "";
    expect(assertion.split(".")).toHaveLength(3);
    const header = JSON.parse(Buffer.from(assertion.split(".")[0], "base64url").toString());
    const payload = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString());
    expect(header.alg).toBe("RS256");
    expect(payload.sub).toBe("boss@corp.com");
    expect(payload.aud).toBe("https://idp.example.com/token");
  });
});

describe("resolveCredentials — fail-closed routing", () => {
  const opts = { env: {} as NodeJS.ProcessEnv };

  it("admits a hermetic loopback token issuer only in explicit dev mode", async () => {
    const env = {
      ANVIL_DEF_TOKEN_ENDPOINT: "http://127.0.0.1:8123/__anvil/oauth/token",
      ANVIL_DEF_CLIENT_ID: "client",
      ANVIL_DEF_CLIENT_SECRET: "secret",
    };
    const requirement = auth({ type: "oauth2_client_credentials" });

    const devFetch = fakeFetch(() => ({
      json: { access_token: "LOCAL", expires_in: 3600 },
    }));
    const dev = resolveCredentials(
      { env: "dev", allowedHosts: [] },
      { env, fetchImpl: devFetch.fn },
    );
    expect(await dev.resolve("def", requirement)).toEqual({
      headers: { Authorization: "Bearer LOCAL" },
    });
    expect(devFetch.calls).toHaveLength(1);

    const prodFetch = fakeFetch(() => ({
      json: { access_token: "MUST_NOT_MINT", expires_in: 3600 },
    }));
    const prod = resolveCredentials(
      { env: "prod", allowedHosts: [] },
      { env, fetchImpl: prodFetch.fn, allowLoopbackHttp: true },
    );
    expect(await prod.resolve("def", requirement)).toBeNull();
    expect(prodFetch.calls).toHaveLength(0);
  });

  it("passes a literal static api_key through by default", async () => {
    const r = resolveCredentials(
      { env: "dev", allowedHosts: [] },
      { env: { ANVIL_DEF_API_KEY: "k" } },
    );
    expect(await r.resolve("def", auth({ type: "api_key" }))).toEqual({
      headers: { "X-API-Key": "k" },
    });
  });

  it.each([
    {
      name: "api key",
      env: { ANVIL_DEF_API_KEY: "sm://projects/p/secrets/credential/versions/latest" },
      requirement: auth({ type: "api_key" }),
      expected: { headers: { "X-API-Key": "resolved" } },
    },
    {
      name: "basic password",
      env: {
        ANVIL_DEF_USERNAME: "operator",
        ANVIL_DEF_PASSWORD: "sm://projects/p/secrets/credential/versions/latest",
      },
      requirement: auth({ type: "basic" }),
      expected: { headers: { Authorization: `Basic ${b64("operator:resolved")}` } },
    },
    {
      name: "static bearer",
      env: { ANVIL_DEF_TOKEN: "sm://projects/p/secrets/credential/versions/latest" },
      requirement: auth({ type: "jwt_bearer" }),
      expected: { headers: { Authorization: "Bearer resolved" } },
    },
  ])("dereferences the deploy journey's default sm:// $name reference", async ({
    env,
    requirement,
    expected,
  }) => {
    const { fn } = fakeFetch(smRoutes("resolved"));
    const r = resolveCredentials(
      { env: "dev", allowedHosts: [] },
      { env, fetchImpl: fn, metadataToken: async () => "metadata-token" },
    );
    expect(await r.resolve("def", requirement)).toEqual(expected);
  });

  it("routes secret_manager secretSource to the SM resolver", async () => {
    const { fn } = fakeFetch(smRoutes("resolved"));
    const r = resolveCredentials(
      { env: "dev", allowedHosts: [] },
      {
        env: { ANVIL_DEF_API_KEY: "sm://projects/p/secrets/k/versions/1" },
        fetchImpl: fn,
        metadataToken: async () => "m",
      },
    );
    expect(
      await r.resolve("def", auth({ type: "api_key", secretSource: "secret_manager" })),
    ).toEqual({
      headers: { "X-API-Key": "resolved" },
    });
  });

  it("routes a delegated principal to the exchange resolver", async () => {
    const { fn } = fakeFetch(() => ({ json: { access_token: "E", expires_in: 3600 } }));
    const r = resolveCredentials(
      { env: "dev", allowedHosts: [] },
      {
        env: {
          ANVIL_DEF_TOKEN_ENDPOINT: "https://sts/token",
          ANVIL_DEF_CLIENT_ID: "c",
          ANVIL_DEF_CLIENT_SECRET: "s",
        },
        fetchImpl: fn,
      },
    );
    const mat = await r.resolve(
      "def",
      auth({ type: "oauth2_on_behalf_of", principal: "delegated", audience: "https://up" }),
      { inbound: { subjectToken: "T", subjectTokenType: "jwt", sub: "u" } },
    );
    expect(mat).toEqual({ headers: { Authorization: "Bearer E" } });
  });

  it("keeps an ordinary OpenAPI bearer token on the static resolver", async () => {
    const { fn, calls } = fakeFetch(() => ({
      json: { access_token: "wrong", expires_in: 3600 },
    }));
    const r = resolveCredentials(
      { env: "dev", allowedHosts: [] },
      { env: { ANVIL_DEF_TOKEN: "pre-issued" }, fetchImpl: fn },
    );
    expect(await r.resolve("def", auth({ type: "jwt_bearer" }))).toEqual({
      headers: { Authorization: "Bearer pre-issued" },
    });
    expect(calls).toEqual([]);
  });

  it("fails closed when provider grant mechanics disagree with the auth type", async () => {
    const { fn, calls } = fakeFetch(() => ({
      json: { access_token: "must-not-use", expires_in: 3600 },
    }));
    const r = resolveCredentials(
      { env: "dev", allowedHosts: [] },
      {
        env: {
          ANVIL_DEF_API_KEY: "must-not-send",
          ANVIL_DEF_TOKEN_ENDPOINT: "https://sts.example/token",
          ANVIL_DEF_CLIENT_ID: "c",
          ANVIL_DEF_CLIENT_ASSERTION_KEY: "k",
        },
        fetchImpl: fn,
      },
    );
    expect(
      await r.resolve("def", auth({ type: "api_key", provider: { grant: "jwt_bearer" } })),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it.each([
    "mtls",
    "custom_header",
    "oauth2_authorization_code",
  ] as const)("fails closed for unmodeled %s instead of leaking a bearer", async (type) => {
    const r = resolveCredentials(
      { env: "dev", allowedHosts: [] },
      { env: { ANVIL_DEF_TOKEN: "must-not-leak" } },
    );
    expect(await r.resolve("def", auth({ type }))).toBeNull();
  });

  it("throws (fails closed) for an unregistered vault secretSource", () => {
    const r = resolveCredentials({ env: "dev", allowedHosts: [] }, opts);
    expect(() => r.resolve("def", auth({ type: "api_key", secretSource: "vault" }))).toThrow(
      /vault/,
    );
  });

  it("limits ANVIL_CREDENTIALS to static secret storage and throws on a grant override", () => {
    const forced = resolveCredentials(
      { env: "dev", allowedHosts: [], credentials: "env" },
      { env: { ANVIL_DEF_API_KEY: "k" } },
    );
    expect(forced).toBeDefined();
    expect(() =>
      resolveCredentials({ env: "dev", allowedHosts: [], credentials: "delegated" }, opts),
    ).toThrow(/always selected per operation/);
  });

  it("routes expectedCredentials to the same backend", () => {
    const r = resolveCredentials({ env: "dev", allowedHosts: [] }, opts);
    const names = r.expectedCredentials?.(
      "def",
      auth({ type: "oauth2_on_behalf_of", principal: "delegated" }),
    );
    expect(names?.some((n) => n.includes("TOKEN_ENDPOINT"))).toBe(true);
  });

  it("supports registering a vault backend selected by operation metadata", async () => {
    registerCredentialBackend("vault", () => ({
      async resolve() {
        return { headers: { "X-Test": "1" } };
      },
    }));
    const r = resolveCredentials({ env: "dev", allowedHosts: [] }, opts);
    expect(await r.resolve("def", auth({ type: "api_key", secretSource: "vault" }))).toEqual({
      headers: { "X-Test": "1" },
    });
  });
});
