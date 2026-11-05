import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AirDocument, AuthRequirement, loadAirDocument } from "@anvil/air";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectFlow, connectorAuthProfile } from "./connect.js";
import {
  ConnectionVault,
  CredentialUnavailableError,
  readVaultKey,
  type StoredConnection,
  VaultCredentialResolver,
} from "./vault.js";

/**
 * The gateway vault and connect flow (ADR-0029): tokens per
 * (sub, connector, account) encrypted at rest, OAuth authorization code with
 * PKCE against a mock authorization server, API-key connections, refresh
 * under a per-connection lock, and `needs_reconnect` on `invalid_grant`.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "anvil-vault-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const KEY = Buffer.alloc(32, 9);
const authOf = (value: Record<string, unknown>) => AuthRequirement.parse(value);
const bearer = authOf({ type: "oauth2_authorization_code", scopes: ["repo"] });

function connection(overrides: Partial<StoredConnection> = {}): StoredConnection {
  const stamp = "2026-01-01T00:00:00.000Z";
  return {
    sub: "local:ada",
    connector: "github",
    account: "default",
    kind: "oauth",
    status: "active",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

interface MockAuthServer {
  url: string;
  tokenRequests: URLSearchParams[];
  authorizations: string[];
  /** What the token endpoint answers next: a body and a status. */
  next: Array<{ status: number; body: Record<string, unknown> }>;
}

/** A mock OAuth authorization server: records token-endpoint requests and answers from a queue. */
async function mockAuthServer(): Promise<MockAuthServer> {
  const state: MockAuthServer = { url: "", tokenRequests: [], authorizations: [], next: [] };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (req.url === "/token" && req.method === "POST") {
        state.tokenRequests.push(new URLSearchParams(raw));
        state.authorizations.push(String(req.headers.authorization ?? ""));
        const answer = state.next.shift() ?? { status: 500, body: { error: "server_error" } };
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  state.url = `http://127.0.0.1:${address.port}`;
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return state;
}

/** Listen on loopback, closed after the test; the server's base URL. */
async function listenLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/**
 * A loopback token endpoint that answers every request with a 307 to a sink,
 * which records whatever reaches it and would hand back a token for it.
 */
async function redirectingTokenEndpoint(): Promise<{ url: string; sinkBodies: string[] }> {
  const sinkBodies: string[] = [];
  const sink = await listenLoopback(
    createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        sinkBodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "stolen", expires_in: 3600 }));
      });
    }),
  );
  const idp = await listenLoopback(
    createServer((req, res) => {
      req.resume();
      res.writeHead(307, { location: `${sink}/token` });
      res.end();
    }),
  );
  return { url: `${idp}/token`, sinkBodies };
}

/** A fetchImpl answering every token request with a fresh access token. */
const okToken = async (_url?: string | URL | Request, _init?: RequestInit) =>
  new Response(JSON.stringify({ access_token: "access-2", expires_in: 3600 }), { status: 200 });

describe("ConnectionVault", () => {
  it("round-trips a connection and keeps no secret in plaintext on disk", () => {
    const dir = tmp();
    const vault = new ConnectionVault(dir, KEY);
    vault.put(connection({ accessToken: "super-secret-access" }));
    expect(vault.get("local:ada", "github", "default")?.accessToken).toBe("super-secret-access");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const onDisk = readFileSync(join(dir, files[0] as string), "utf8");
    expect(onDisk).not.toContain("super-secret-access");
    expect(onDisk).not.toContain("local:ada");
    expect(vault.get("local:ada", "github", "work")).toBeUndefined();
    expect(vault.get("local:bob", "github", "default")).toBeUndefined();
  });

  it("binds each record to its coordinates: a file moved onto another person fails to open", () => {
    const dir = tmp();
    const vault = new ConnectionVault(dir, KEY);
    vault.put(connection());
    vault.put(connection({ sub: "local:bob", accessToken: "bob-token" }));
    const name = (sub: string) =>
      `${createHash("sha256")
        .update(JSON.stringify([sub, "github", "default"]))
        .digest("hex")}.json`;
    copyFileSync(join(dir, name("local:ada")), join(dir, name("local:bob")));
    expect(() => vault.get("local:bob", "github", "default")).toThrow();
    expect(vault.list("local:bob")).toEqual([]);
    expect(vault.list("local:ada")).toHaveLength(1);
  });

  it("refuses a different key", () => {
    const dir = tmp();
    new ConnectionVault(dir, KEY).put(connection());
    expect(() =>
      new ConnectionVault(dir, Buffer.alloc(32, 1)).get("local:ada", "github", "default"),
    ).toThrow();
  });

  it("lists a person's connections without secrets", () => {
    const vault = new ConnectionVault(tmp(), KEY);
    vault.put(connection({ account: "work" }));
    vault.put(connection({ kind: "static", secret: "pat", accessToken: undefined }));
    const listed = vault.list("local:ada");
    expect(listed.map((c) => `${c.connector}/${c.account}/${c.kind}`)).toEqual([
      "github/default/static",
      "github/work/oauth",
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/access-1|refresh-1|pat/);
  });

  it("reads a 32-byte key as raw, hex, or base64 and refuses a group-readable file", () => {
    const dir = tmp();
    const hex = join(dir, "hex.key");
    writeFileSync(hex, KEY.toString("hex"), { mode: 0o600 });
    expect(readVaultKey(hex).equals(KEY)).toBe(true);
    const b64 = join(dir, "b64.key");
    writeFileSync(b64, KEY.toString("base64"), { mode: 0o600 });
    expect(readVaultKey(b64).equals(KEY)).toBe(true);
    const raw = join(dir, "raw.key");
    writeFileSync(raw, KEY, { mode: 0o600 });
    expect(readVaultKey(raw).equals(KEY)).toBe(true);
    const short = join(dir, "short.key");
    writeFileSync(short, "abc", { mode: 0o600 });
    expect(() => readVaultKey(short)).toThrow(/32 bytes/);
    if (process.platform !== "win32") {
      chmodSync(hex, 0o644);
      expect(() => readVaultKey(hex)).toThrow(/group or others/);
    }
    expect(() => readVaultKey(join(dir, "missing.key"))).toThrow(/does not exist/);
  });
});

describe("VaultCredentialResolver", () => {
  const call = { principalId: "local:ada", connector: "github", account: "default" };

  it("names the connector when nothing is connected", async () => {
    const resolver = new VaultCredentialResolver(new ConnectionVault(tmp(), KEY), () => undefined);
    const error = await resolver.resolve("p", bearer, call).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialUnavailableError);
    expect((error as CredentialUnavailableError).details).toEqual({
      code: "connector/not_connected",
      connector: "github",
      account: "default",
    });
  });

  it("refuses without a principal and connector rather than guessing", async () => {
    const resolver = new VaultCredentialResolver(new ConnectionVault(tmp(), KEY), () => undefined);
    await expect(resolver.resolve("p", bearer, {})).rejects.toMatchObject({
      details: { code: "connector/unresolved" },
    });
  });

  it("refuses auth the vault does not hold per person, and a record it cannot read", async () => {
    const dir = tmp();
    const vault = new ConnectionVault(dir, KEY);
    vault.put(connection());
    const resolver = new VaultCredentialResolver(vault, () => undefined);
    await expect(
      resolver.resolve("p", authOf({ type: "mtls", scopes: [] }), call),
    ).rejects.toMatchObject({
      details: { code: "connector/unsupported_auth", connector: "github" },
    });
    for (const name of readdirSync(dir))
      writeFileSync(join(dir, name), '{"v":1,"iv":"AAAA","tag":"AAAA","ct":"AAAA"}');
    await expect(resolver.resolve("p", bearer, call)).rejects.toMatchObject({
      details: { code: "connector/vault_unreadable", connector: "github" },
    });
  });

  it("places a static key under the carrier AIR declares", async () => {
    const vault = new ConnectionVault(tmp(), KEY);
    vault.put(connection({ kind: "static", secret: "k-1", accessToken: undefined }));
    const resolver = new VaultCredentialResolver(vault, () => undefined);
    expect(await resolver.resolve("p", authOf({ type: "api_key", scopes: [] }), call)).toEqual({
      headers: { "X-API-Key": "k-1" },
    });
    expect(
      await resolver.resolve(
        "p",
        authOf({
          type: "custom_header",
          scopes: [],
          carrier: { in: "header", name: "X-Token", scheme: "Token" },
        }),
        call,
      ),
    ).toEqual({ headers: { "X-Token": "Token k-1" } });
    expect(await resolver.resolve("p", authOf({ type: "jwt_bearer", scopes: [] }), call)).toEqual({
      headers: { Authorization: "Bearer k-1" },
    });
  });

  it("refreshes an expiring token once, under a lock, and keeps a rotated refresh token", async () => {
    const auth = await mockAuthServer();
    const vault = new ConnectionVault(tmp(), KEY);
    let now = 1_000_000;
    vault.put(connection({ expiresAt: now + 10_000 }));
    auth.next.push({
      status: 200,
      body: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 },
    });
    const resolver = new VaultCredentialResolver(
      vault,
      () => ({
        tokenEndpoint: `${auth.url}/token`,
        clientId: "client-1",
        clientSecret: "shh",
        clientAuth: "client_secret_basic",
      }),
      { now: () => now },
    );
    const [a, b, c] = await Promise.all([
      resolver.resolve("p", bearer, call),
      resolver.resolve("p", bearer, call),
      resolver.resolve("p", bearer, call),
    ]);
    for (const material of [a, b, c]) {
      expect(material).toEqual({ headers: { Authorization: "Bearer access-2" } });
    }
    expect(auth.tokenRequests).toHaveLength(1);
    expect(auth.tokenRequests[0]?.get("grant_type")).toBe("refresh_token");
    expect(auth.tokenRequests[0]?.get("refresh_token")).toBe("refresh-1");
    expect(auth.authorizations[0]).toBe(`Basic ${Buffer.from("client-1:shh").toString("base64")}`);
    const stored = vault.get("local:ada", "github", "default");
    expect(stored).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      status: "active",
    });
    now += 1000;
    await resolver.resolve("p", bearer, call);
    expect(auth.tokenRequests).toHaveLength(1);
  });

  it("marks the connection needs_reconnect when the provider answers invalid_grant", async () => {
    const auth = await mockAuthServer();
    const vault = new ConnectionVault(tmp(), KEY);
    vault.put(connection({ expiresAt: 0 }));
    auth.next.push({ status: 400, body: { error: "invalid_grant" } });
    const resolver = new VaultCredentialResolver(vault, () => ({
      tokenEndpoint: `${auth.url}/token`,
      clientId: "client-1",
      clientAuth: "none",
    }));
    await expect(resolver.resolve("p", bearer, call)).rejects.toMatchObject({
      details: { code: "connector/needs_reconnect", connector: "github" },
    });
    expect(vault.get("local:ada", "github", "default")?.status).toBe("needs_reconnect");
    expect(auth.tokenRequests[0]?.get("client_id")).toBe("client-1");
    // A second call does not hammer the provider again.
    await expect(resolver.resolve("p", bearer, call)).rejects.toMatchObject({
      details: { code: "connector/needs_reconnect" },
    });
    expect(auth.tokenRequests).toHaveLength(1);
  });

  it("reports a transient refresh failure without marking the connection", async () => {
    const auth = await mockAuthServer();
    const vault = new ConnectionVault(tmp(), KEY);
    vault.put(connection({ expiresAt: 0 }));
    auth.next.push({ status: 503, body: { error: "temporarily_unavailable" } });
    const resolver = new VaultCredentialResolver(vault, () => ({
      tokenEndpoint: `${auth.url}/token`,
      clientId: "client-1",
      clientAuth: "none",
    }));
    await expect(resolver.resolve("p", bearer, call)).rejects.toMatchObject({
      details: { code: "connector/refresh_failed" },
    });
    expect(vault.get("local:ada", "github", "default")?.status).toBe("active");
  });

  // The refresh grant carries the refresh token and client secret, so it goes
  // over HTTPS only (plain HTTP to the exact 127.0.0.1 literal), and a refused
  // endpoint is the gateway's configuration: nothing is sent and nothing marked.
  /** An expiring connection refreshed against `tokenEndpoint`; platform fetch unless one is given. */
  const refreshVia = (tokenEndpoint: string, fetchImpl?: typeof okToken) => {
    const vault = new ConnectionVault(tmp(), KEY);
    vault.put(connection({ expiresAt: 0 }));
    const resolver = new VaultCredentialResolver(
      vault,
      () => ({
        tokenEndpoint,
        clientId: "client-1",
        clientSecret: "shh",
        clientAuth: "client_secret_post",
      }),
      fetchImpl ? { fetchImpl: fetchImpl as unknown as typeof fetch } : {},
    );
    return { vault, refreshed: resolver.resolve("p", bearer, call) };
  };

  it.each([
    "http://idp.example.com/token",
    "http://localhost:8123/token",
    "not a url",
  ])("refuses to send the refresh grant to %s, without marking the connection", async (endpoint) => {
    const fetchImpl = vi.fn(okToken);
    const { vault, refreshed } = refreshVia(endpoint, fetchImpl);
    await expect(refreshed).rejects.toMatchObject({
      details: { code: "connector/refresh_failed", connector: "github" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vault.get("local:ada", "github", "default")?.status).toBe("active");
  });

  it("refuses the refresh when the gateway's token endpoint override is plain HTTP", async () => {
    const profile = connectorAuthProfile(
      "github",
      oauthAir("https://idp.example.com/authorize", "https://idp.example.com/token"),
      {
        ANVIL_CONNECT_GITHUB_CLIENT_ID: "client-1",
        ANVIL_CONNECT_GITHUB_CLIENT_SECRET: "shh",
        ANVIL_CONNECT_GITHUB_TOKEN_ENDPOINT: "http://idp.example.com/token",
      },
    );
    const vault = new ConnectionVault(tmp(), KEY);
    vault.put(connection({ expiresAt: 0 }));
    const fetchImpl = vi.fn(okToken);
    // Wired as the gateway wires it (packages/cli/src/commands/gateway.ts).
    const resolver = new VaultCredentialResolver(vault, () => profile.client, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(resolver.resolve("p", bearer, call)).rejects.toMatchObject({
      details: { code: "connector/refresh_failed" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vault.get("local:ada", "github", "default")?.status).toBe("active");
  });

  it.each([
    "https://idp.example.com/token",
    "http://127.0.0.1:8123/token",
  ])("sends the refresh grant to %s with redirect: error", async (endpoint) => {
    const fetchImpl = vi.fn(okToken);
    const { refreshed } = refreshVia(endpoint, fetchImpl);
    expect(await refreshed).toEqual({ headers: { Authorization: "Bearer access-2" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(endpoint);
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("does not follow a real 307 from the token endpoint: the redirect target never sees the grant", async () => {
    const idp = await redirectingTokenEndpoint();
    const { vault, refreshed } = refreshVia(idp.url);
    await expect(refreshed).rejects.toMatchObject({
      details: { code: "connector/refresh_failed" },
    });
    expect(idp.sinkBodies).toEqual([]);
    expect(vault.get("local:ada", "github", "default")).toMatchObject({
      accessToken: "access-1",
      status: "active",
    });
  });
});

function oauthAir(authorizationEndpoint: string, tokenEndpoint: string): AirDocument {
  return loadAirDocument({
    service: { id: "github", version: "1.0.0", source: { kind: "openapi" } },
    operations: [
      {
        id: "github.issues.list",
        canonicalName: "list_issues",
        displayName: "List issues",
        sourceRef: { kind: "openapi", path: "/issues", method: "get" },
        effect: { kind: "read", action: "list", resource: "issue", risk: "low", reversible: false },
        input: { params: [] },
        idempotency: { mode: "natural", mechanism: "none" },
        retries: { mode: "safe", maxAttempts: 1, backoff: "none", retryOn: [] },
        confirmation: { required: false },
        auth: {
          type: "oauth2_authorization_code",
          scopes: ["repo", "read:org"],
          issuer: "https://idp.example.com",
          provider: { authorizationEndpoint, tokenEndpoint, pkce: true },
        },
        cli: { command: "github issues list" },
        mcp: { toolName: "list_issues" },
        skill: { intentExamples: [] },
        state: "approved",
      },
    ],
  });
}

describe("the connect flow", () => {
  async function flow(env: NodeJS.ProcessEnv = {}) {
    const auth = await mockAuthServer();
    const vault = new ConnectionVault(tmp(), KEY);
    const air = oauthAir("https://idp.example.com/authorize", `${auth.url}/token`);
    const profile = connectorAuthProfile("github", air, {
      ANVIL_CONNECT_GITHUB_CLIENT_ID: "client-1",
      ANVIL_CONNECT_GITHUB_CLIENT_SECRET: "shh",
      ...env,
    });
    const connect = new ConnectFlow({
      vault,
      profiles: new Map([["github", profile]]),
      redirectUri: "http://127.0.0.1:8788/connect/callback",
    });
    return { auth, vault, connect, profile };
  }

  it("derives an OAuth profile from AIR and the gateway's client configuration", async () => {
    const { profile } = await flow();
    expect(profile).toMatchObject({
      kind: "oauth",
      authorizationEndpoint: "https://idp.example.com/authorize",
      scopes: ["read:org", "repo"],
      issuer: "https://idp.example.com",
      client: { clientId: "client-1", clientSecret: "shh", clientAuth: "client_secret_basic" },
    });
    const missing = connectorAuthProfile(
      "github",
      oauthAir("https://idp.example.com/authorize", "https://idp.example.com/token"),
      {},
    );
    expect(missing.problem).toContain("ANVIL_CONNECT_GITHUB_CLIENT_ID");
  });

  it("runs authorization code with PKCE and stores the tokens for the person who started it", async () => {
    const { auth, vault, connect } = await flow();
    const started = connect.start({ sub: "local:ada", connector: "github", account: "work" });
    if (!started.ok || started.kind !== "oauth") throw new Error("expected an OAuth start");
    const url = new URL(started.url);
    expect(url.origin + url.pathname).toBe("https://idp.example.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8788/connect/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("read:org repo");
    const state = url.searchParams.get("state") as string;
    const challenge = url.searchParams.get("code_challenge") as string;

    auth.next.push({
      status: 200,
      body: { access_token: "gho_1", refresh_token: "ghr_1", expires_in: 28800, scope: "repo" },
    });
    const done = await connect.callback({ state, code: "code-1", iss: "https://idp.example.com" });
    expect(done).toEqual({ ok: true, connector: "github", account: "work" });
    const exchange = auth.tokenRequests[0] as URLSearchParams;
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code")).toBe("code-1");
    expect(exchange.get("redirect_uri")).toBe("http://127.0.0.1:8788/connect/callback");
    const verifier = exchange.get("code_verifier") as string;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
    expect(vault.get("local:ada", "github", "work")).toMatchObject({
      kind: "oauth",
      accessToken: "gho_1",
      refreshToken: "ghr_1",
      status: "active",
    });
    expect(vault.get("local:bob", "github", "work")).toBeUndefined();

    // The state is single use.
    const replay = await connect.callback({ state, code: "code-1" });
    expect(replay).toMatchObject({ ok: false, code: "invalid_state" });
  });

  it("rejects an unknown state, an expired state, and an issuer mix-up without calling the token endpoint", async () => {
    const { auth, connect } = await flow();
    expect(await connect.callback({ state: "forged", code: "c" })).toMatchObject({
      ok: false,
      code: "invalid_state",
    });
    const started = connect.start({ sub: "local:ada", connector: "github" });
    if (!started.ok || started.kind !== "oauth") throw new Error("expected an OAuth start");
    const state = new URL(started.url).searchParams.get("state") as string;
    expect(
      await connect.callback({ state, code: "c", iss: "https://evil.example.com" }),
    ).toMatchObject({
      ok: false,
      code: "issuer_mismatch",
    });
    expect(auth.tokenRequests).toHaveLength(0);

    let now = 0;
    const expiring = new ConnectFlow({
      vault: new ConnectionVault(tmp(), KEY),
      profiles: new Map([
        [
          "github",
          connectorAuthProfile(
            "github",
            oauthAir("https://idp.example.com/authorize", `${auth.url}/token`),
            { ANVIL_CONNECT_GITHUB_CLIENT_ID: "c" },
          ),
        ],
      ]),
      redirectUri: "http://127.0.0.1/connect/callback",
      now: () => now,
      stateTtlMs: 1000,
    });
    const late = expiring.start({ sub: "local:ada", connector: "github" });
    if (!late.ok || late.kind !== "oauth") throw new Error("expected an OAuth start");
    now = 5000;
    expect(
      await expiring.callback({
        state: new URL(late.url).searchParams.get("state") as string,
        code: "c",
      }),
    ).toMatchObject({ ok: false, code: "invalid_state" });
  });

  it("keeps the stored refresh token when a reconnect's response does not rotate it", async () => {
    const { auth, vault, connect } = await flow();
    const connectOnce = async (body: Record<string, unknown>) => {
      const started = connect.start({ sub: "local:ada", connector: "github" });
      if (!started.ok || started.kind !== "oauth") throw new Error("expected an OAuth start");
      auth.next.push({ status: 200, body });
      const state = new URL(started.url).searchParams.get("state") as string;
      expect(await connect.callback({ state, code: "c" })).toMatchObject({ ok: true });
    };
    await connectOnce({ access_token: "gho_1", refresh_token: "ghr_1", expires_in: 60 });
    await connectOnce({ access_token: "gho_2", expires_in: 60 });
    expect(vault.get("local:ada", "github", "default")).toMatchObject({
      accessToken: "gho_2",
      refreshToken: "ghr_1",
    });
    // A response that does rotate it replaces it.
    await connectOnce({ access_token: "gho_3", refresh_token: "ghr_3" });
    expect(vault.get("local:ada", "github", "default")).toMatchObject({
      accessToken: "gho_3",
      refreshToken: "ghr_3",
    });
  });

  // The exchange carries the client secret, the code, and the PKCE verifier;
  // the authorization endpoint is where the person signs in. Both endpoints
  // face one rule (oauth-endpoint.ts), checked when the profile is resolved.
  const https = ["https://idp.example.com/authorize", "https://idp.example.com/token"] as const;
  it.each([
    { source: "AIR's token endpoint", air: [https[0], "http://idp.example.com/token"], env: {} },
    {
      source: "the token endpoint override",
      air: https,
      env: { ANVIL_CONNECT_GITHUB_TOKEN_ENDPOINT: "http://idp.example.com/token" },
    },
    {
      source: "an unparseable token endpoint override",
      air: https,
      env: { ANVIL_CONNECT_GITHUB_TOKEN_ENDPOINT: "not a url" },
    },
    {
      source: "AIR's authorization endpoint",
      air: ["http://idp.example.com/authorize", https[1]],
      env: {},
      names: "AUTHORIZATION_ENDPOINT",
    },
    {
      source: "the authorization endpoint override",
      air: https,
      env: { ANVIL_CONNECT_GITHUB_AUTHORIZATION_ENDPOINT: "http://idp.example.com/authorize" },
      names: "AUTHORIZATION_ENDPOINT",
    },
  ])("refuses to start a flow when $source may not carry a grant", ({
    air,
    env,
    names = "TOKEN_ENDPOINT",
  }) => {
    const profile = connectorAuthProfile("github", oauthAir(air[0], air[1]), {
      ANVIL_CONNECT_GITHUB_CLIENT_ID: "client-1",
      ANVIL_CONNECT_GITHUB_CLIENT_SECRET: "shh",
      ...env,
    });
    expect(profile.problem).toContain(`(set ANVIL_CONNECT_GITHUB_${names})`);
    const connect = new ConnectFlow({
      vault: new ConnectionVault(tmp(), KEY),
      profiles: new Map([["github", profile]]),
      redirectUri: "http://127.0.0.1:8788/connect/callback",
    });
    expect(connect.start({ sub: "local:ada", connector: "github" })).toEqual({
      ok: false,
      status: 503,
      code: "connector_not_configured",
      message: profile.problem,
    });
  });

  it("refuses to start sign-in at a plain-HTTP authorization endpoint in a profile that skipped the check", () => {
    const { problem, ...unchecked } = connectorAuthProfile("github", oauthAir(https[0], https[1]), {
      ANVIL_CONNECT_GITHUB_CLIENT_ID: "client-1",
      ANVIL_CONNECT_GITHUB_CLIENT_SECRET: "shh",
      ANVIL_CONNECT_GITHUB_AUTHORIZATION_ENDPOINT: "http://idp.example.com/authorize",
    });
    expect(problem).toContain("AUTHORIZATION_ENDPOINT");
    const connect = new ConnectFlow({
      vault: new ConnectionVault(tmp(), KEY),
      profiles: new Map([["github", unchecked]]),
      redirectUri: "http://127.0.0.1:8788/connect/callback",
    });
    expect(connect.start({ sub: "local:ada", connector: "github" })).toMatchObject({
      ok: false,
      status: 503,
      code: "connector_not_configured",
    });
  });

  it("refuses the code exchange to a plain-HTTP token endpoint in a profile that skipped the check", async () => {
    const { problem, ...unchecked } = connectorAuthProfile("github", oauthAir(https[0], https[1]), {
      ANVIL_CONNECT_GITHUB_CLIENT_ID: "client-1",
      ANVIL_CONNECT_GITHUB_CLIENT_SECRET: "shh",
      ANVIL_CONNECT_GITHUB_TOKEN_ENDPOINT: "http://idp.example.com/token",
    });
    expect(problem).toContain("TOKEN_ENDPOINT");
    const vault = new ConnectionVault(tmp(), KEY);
    const fetchImpl = vi.fn(okToken);
    const connect = new ConnectFlow({
      vault,
      profiles: new Map([["github", unchecked]]),
      redirectUri: "http://127.0.0.1:8788/connect/callback",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const started = connect.start({ sub: "local:ada", connector: "github" });
    if (!started.ok || started.kind !== "oauth") throw new Error("expected an OAuth start");
    const state = new URL(started.url).searchParams.get("state") as string;
    expect(await connect.callback({ state, code: "c" })).toMatchObject({
      ok: false,
      code: "connector_not_configured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vault.list("local:ada")).toEqual([]);
  });

  it.each([
    "https://idp.example.com/token",
    "http://127.0.0.1:8123/token",
  ])("sends the code exchange to %s with redirect: error", async (endpoint) => {
    const profile = connectorAuthProfile("github", oauthAir(https[0], https[1]), {
      ANVIL_CONNECT_GITHUB_CLIENT_ID: "client-1",
      ANVIL_CONNECT_GITHUB_CLIENT_SECRET: "shh",
      ANVIL_CONNECT_GITHUB_TOKEN_ENDPOINT: endpoint,
    });
    expect(profile.problem).toBeUndefined();
    const fetchImpl = vi.fn(okToken);
    const connect = new ConnectFlow({
      vault: new ConnectionVault(tmp(), KEY),
      profiles: new Map([["github", profile]]),
      redirectUri: "http://127.0.0.1:8788/connect/callback",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const started = connect.start({ sub: "local:ada", connector: "github" });
    if (!started.ok || started.kind !== "oauth") throw new Error("expected an OAuth start");
    const state = new URL(started.url).searchParams.get("state") as string;
    expect(await connect.callback({ state, code: "c" })).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(endpoint);
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("does not follow a real 307 from the token endpoint: the redirect target never sees the code", async () => {
    const idp = await redirectingTokenEndpoint();
    const vault = new ConnectionVault(tmp(), KEY);
    const connect = new ConnectFlow({
      vault,
      profiles: new Map([
        [
          "github",
          connectorAuthProfile("github", oauthAir(https[0], idp.url), {
            ANVIL_CONNECT_GITHUB_CLIENT_ID: "client-1",
            ANVIL_CONNECT_GITHUB_CLIENT_SECRET: "shh",
          }),
        ],
      ]),
      redirectUri: "http://127.0.0.1:8788/connect/callback",
    });
    const started = connect.start({ sub: "local:ada", connector: "github" });
    if (!started.ok || started.kind !== "oauth") throw new Error("expected an OAuth start");
    const state = new URL(started.url).searchParams.get("state") as string;
    expect(await connect.callback({ state, code: "c" })).toMatchObject({
      ok: false,
      status: 502,
      code: "token_endpoint_unreachable",
    });
    expect(idp.sinkBodies).toEqual([]);
    expect(vault.list("local:ada")).toEqual([]);
  });

  it("does not store anything when the provider refuses the code", async () => {
    const { auth, vault, connect } = await flow();
    const started = connect.start({ sub: "local:ada", connector: "github" });
    if (!started.ok || started.kind !== "oauth") throw new Error("expected an OAuth start");
    auth.next.push({ status: 400, body: { error: "invalid_grant" } });
    const state = new URL(started.url).searchParams.get("state") as string;
    expect(await connect.callback({ state, code: "bad" })).toMatchObject({
      ok: false,
      code: "token_exchange_failed",
    });
    expect(vault.list("local:ada")).toEqual([]);
  });

  it("stores an API key for a key-based connector and refuses one for an OAuth connector", async () => {
    const vault = new ConnectionVault(tmp(), KEY);
    const keyAir = loadAirDocument({
      service: { id: "linear", version: "1.0.0", source: { kind: "openapi" } },
      operations: [
        {
          ...oauthAir("https://x.example/a", "https://x.example/t").operations[0],
          id: "linear.issues.list",
          auth: { type: "api_key", scopes: [] },
        },
      ],
    });
    const profiles = new Map([
      ["linear", connectorAuthProfile("linear", keyAir, {})],
      [
        "github",
        connectorAuthProfile("github", oauthAir("https://x.example/a", "https://x.example/t"), {
          ANVIL_CONNECT_GITHUB_CLIENT_ID: "c",
        }),
      ],
    ]);
    const connect = new ConnectFlow({ vault, profiles, redirectUri: "http://127.0.0.1/cb" });
    expect(connect.start({ sub: "local:ada", connector: "linear" })).toEqual({
      ok: true,
      kind: "static",
      submit: "/connect/api-key",
    });
    expect(
      await connect.putStatic({ sub: "local:ada", connector: "linear", secret: "lin_1" }),
    ).toEqual({
      ok: true,
      connector: "linear",
      account: "default",
    });
    expect(vault.get("local:ada", "linear", "default")).toMatchObject({
      kind: "static",
      secret: "lin_1",
    });
    expect(
      await connect.putStatic({ sub: "local:ada", connector: "github", secret: "x" }),
    ).toMatchObject({
      ok: false,
      code: "wrong_connect_kind",
    });
    expect(
      await connect.putStatic({ sub: "local:ada", connector: "linear", secret: "a\nb" }),
    ).toMatchObject({
      ok: false,
      code: "invalid_secret",
    });
    expect(connect.start({ sub: "local:ada", connector: "nope" })).toMatchObject({
      ok: false,
      code: "unknown_connector",
    });
  });
});
