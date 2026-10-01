import { sign as cryptoSign, generateKeyPairSync, type KeyObject, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { airToJson, loadAirDocument, Operation } from "@anvil/air";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";
import { type FleetHttpHandle, startFleetHttp } from "./serve-fleet-http.js";

/**
 * `anvil serve mcp <ws> --fleet --http <port>` as the Branchyard gateway
 * (ADR-0029): per-turn EdDSA tokens, grants enforced per operation before any
 * upstream call, credentials from the vault, the connect flow, and the audit
 * log — exercised over real sockets with a real MCP client, a mock upstream,
 * and a mock OAuth authorization server.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Upstream {
  url: string;
  hits: Array<{ method: string; path: string; authorization: string }>;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function mockUpstream(): Promise<Upstream> {
  const hits: Upstream["hits"] = [];
  const url = await listen(
    createServer((req: IncomingMessage, res) => {
      hits.push({
        method: req.method ?? "",
        path: new URL(req.url ?? "/", "http://x").pathname,
        authorization: String(req.headers.authorization ?? ""),
      });
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ number: 1, title: "First" }]));
    }),
  );
  return { url, hits };
}

async function mockTokenEndpoint(): Promise<{ url: string; forms: URLSearchParams[] }> {
  const forms: URLSearchParams[] = [];
  const url = await listen(
    createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        forms.push(new URLSearchParams(raw));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "oauth-access-1", expires_in: 3600 }));
      });
    }),
  );
  return { url, forms };
}

function op(fields: {
  id: string;
  tool: string;
  kind: "read" | "mutation";
  confirm?: boolean;
  auth: Record<string, unknown>;
}): Operation {
  return Operation.parse({
    id: fields.id,
    canonicalName: fields.tool,
    displayName: fields.tool,
    sourceRef: { kind: "openapi", path: "/items", method: fields.kind === "read" ? "get" : "post" },
    effect: {
      kind: fields.kind,
      action: fields.kind === "read" ? "list" : "create",
      resource: "item",
      risk: fields.kind === "read" ? "low" : "medium",
      reversible: false,
    },
    input: { params: [] },
    idempotency: { mode: fields.kind === "read" ? "natural" : "none", mechanism: "none" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: fields.confirm === true },
    auth: fields.auth,
    cli: { command: `${fields.id.split(".")[0]} ${fields.tool}` },
    mcp: { toolName: fields.tool },
    skill: { intentExamples: [] },
    state: "approved",
  });
}

function writeBundle(dir: string, serviceId: string, baseUrl: string, ops: Operation[]): void {
  mkdirSync(dir, { recursive: true });
  const air = loadAirDocument({
    service: {
      id: serviceId,
      version: "1.0.0",
      source: { kind: "openapi" },
      servers: [{ url: baseUrl }],
    },
    operations: ops,
  });
  writeFileSync(join(dir, "air.json"), airToJson(air), "utf8");
}

interface Yard {
  root: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
  auditFile: string;
  upstream: Upstream;
  tokens: Awaited<ReturnType<typeof mockTokenEndpoint>>;
  mint(grants: unknown[], extra?: Record<string, unknown>): string;
  /** The person's connect token, as `by connect` mints it. */
  connectToken(extra?: Record<string, unknown>): string;
}

const ISSUER = "branchyard:local:test";

async function yard(port: number, opts: { singleBundle?: boolean } = {}): Promise<Yard> {
  const root = mkdtempSync(join(tmpdir(), "anvil-gateway-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const upstream = await mockUpstream();
  const tokens = await mockTokenEndpoint();
  const workspace = join(root, "ws");
  const bearer = { type: "jwt_bearer", scopes: [] };
  writeBundle(join(workspace, "github"), "github", upstream.url, [
    op({ id: "github.issues.list", tool: "list_issues", kind: "read", auth: bearer }),
    op({
      id: "github.issues.create",
      tool: "create_issue",
      kind: "mutation",
      confirm: true,
      auth: bearer,
    }),
    op({ id: "github.labels.create", tool: "create_label", kind: "mutation", auth: bearer }),
  ]);
  if (!opts.singleBundle) {
    writeBundle(join(workspace, "tracker"), "tracker", upstream.url, [
      op({
        id: "tracker.tickets.list",
        tool: "list_tickets",
        kind: "read",
        auth: {
          type: "oauth2_authorization_code",
          scopes: ["read"],
          provider: {
            authorizationEndpoint: "https://idp.example.com/authorize",
            tokenEndpoint: `${tokens.url}/token`,
            pkce: true,
          },
        },
      }),
    ]);
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwks = join(root, "jwks.json");
  writeFileSync(
    jwks,
    JSON.stringify({
      keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "EdDSA", use: "sig" }],
    }),
  );
  const vaultKey = join(root, "vault.key");
  writeFileSync(vaultKey, Buffer.alloc(32, 5).toString("hex"), { mode: 0o600 });
  const auditFile = join(root, "audit.jsonl");
  const audience = `http://127.0.0.1:${port}/mcp`;
  const env: NodeJS.ProcessEnv = {
    ANVIL_INBOUND_AUTH_MODE: "branchyard",
    ANVIL_INBOUND_ISSUER: ISSUER,
    ANVIL_INBOUND_AUDIENCE: audience,
    ANVIL_INBOUND_JWKS_URI: pathToFileURL(jwks).href,
    ANVIL_VAULT_KEY_FILE: vaultKey,
    ANVIL_VAULT_DIR: join(root, "vault"),
    ANVIL_AUDIT_FILE: auditFile,
    ANVIL_ALLOWED_HOSTS: "127.0.0.1",
    ANVIL_CONNECT_TRACKER_CLIENT_ID: "tracker-client",
    // Set, and wrong: a granted call must never resolve credentials from here.
    ANVIL_DEFAULT_TOKEN: "env-token-must-not-be-used",
    ANVIL_DEFAULT_GITHUB_TOKEN: "env-token-must-not-be-used",
  };
  const mint = (grants: unknown[], extra: Record<string, unknown> = {}) =>
    signToken(privateKey, {
      iss: ISSUER,
      aud: audience,
      sub: "local:ada",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
      jti: randomUUID(),
      by_tenant: "t1",
      by_branch: "feature-x",
      by_turn: "1",
      by_grants: grants,
      ...extra,
    });
  const connectToken = (extra: Record<string, unknown> = {}) =>
    mint([], { by_branch: "", by_turn: "", by_purpose: "connect", ...extra });
  return { root, workspace, env, auditFile, upstream, tokens, mint, connectToken };
}

function signToken(key: KeyObject, claims: Record<string, unknown>): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${b64({ alg: "EdDSA", typ: "JWT", kid: "k1" })}.${b64(claims)}`;
  return `${input}.${cryptoSign(null, Buffer.from(input), key).toString("base64url")}`;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startGateway(y: Yard, port: number): Promise<FleetHttpHandle> {
  const started = await startFleetHttp(y.workspace, {
    host: "127.0.0.1",
    port,
    env: y.env,
    io: bufferIO(),
  });
  if (!started.ok) throw new Error(started.message);
  cleanups.push(() => started.handle.close());
  return started.handle;
}

async function client(port: number, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const mcp = new Client({ name: "branchyard-test", version: "0.0.0" });
  await mcp.connect(transport);
  cleanups.push(() => mcp.close());
  return mcp;
}

async function post(port: number, path: string, token: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function envelope(result: unknown): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}";
  return JSON.parse(text).error;
}

const githubRead = [{ connector: "github", operations: ["*"], mode: "read" }];

describe("the Branchyard gateway", () => {
  it("refuses to start in branchyard mode without a vault key", async () => {
    const port = await freePort();
    const y = await yard(port);
    const started = await startFleetHttp(y.workspace, {
      host: "127.0.0.1",
      port,
      env: { ...y.env, ANVIL_VAULT_KEY_FILE: undefined },
      io: bufferIO(),
    });
    expect(started).toMatchObject({
      ok: false,
      message: expect.stringContaining("ANVIL_VAULT_KEY_FILE"),
    });
  });

  it("rejects a missing or foreign token before any session exists", async () => {
    const port = await freePort();
    const y = await yard(port);
    await startGateway(y, port);
    const bare = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(bare.status).toBe(401);
    await expect(
      client(port, y.mint(githubRead, { iss: "branchyard:local:other" })),
    ).rejects.toThrow();
  });

  it("offers only granted tools, under their connector prefix", async () => {
    const port = await freePort();
    const y = await yard(port);
    await startGateway(y, port);
    const read = await client(port, y.mint(githubRead));
    expect((await read.listTools()).tools.map((t) => t.name)).toEqual(["github__list_issues"]);
    const write = await client(
      port,
      y.mint([
        { connector: "github", operations: ["*"], mode: "write" },
        { connector: "tracker", operations: ["tickets.list"], mode: "read" },
      ]),
    );
    // create_issue needs confirmation and the entry lacks confirm: "allow".
    expect((await write.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "github__create_label",
      "github__list_issues",
      "tracker__list_tickets",
    ]);
  });

  it("prefixes a single served bundle too: the bundle id is the connector", async () => {
    const port = await freePort();
    const y = await yard(port, { singleBundle: true });
    await startGateway(y, port);
    const mcp = await client(port, y.mint(githubRead));
    expect((await mcp.listTools()).tools.map((t) => t.name)).toEqual(["github__list_issues"]);
  });

  it("refuses an ungranted call policy_denied naming the rule, with no byte upstream, and audits it", async () => {
    const port = await freePort();
    const y = await yard(port);
    await startGateway(y, port);
    const token = y.mint(githubRead);
    expect(
      (
        await post(port, "/connect/api-key", y.connectToken(), {
          connector: "github",
          api_key: "pat-1",
        })
      ).status,
    ).toBe(200);
    const mcp = await client(port, token);
    const denied = await mcp.callTool({
      name: "github__create_issue",
      arguments: { confirm: true },
    });
    expect(denied.isError).toBe(true);
    expect(envelope(denied)).toMatchObject({
      code: "policy_denied",
      details: {
        code: "policy/grant_denied",
        connector: "github",
        rule: { index: 0, connector: "github", mode: "read" },
      },
    });
    const otherConnector = await mcp.callTool({ name: "tracker__list_tickets", arguments: {} });
    expect(envelope(otherConnector)).toMatchObject({
      code: "policy_denied",
      details: { code: "policy/grant_denied", rule: null },
    });
    expect(y.upstream.hits).toHaveLength(0);
    const audit = readFileSync(y.auditFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(audit.map((l) => [l.connector, l.operation, l.decision])).toEqual([
      ["github", "github.issues.create", "denied"],
      ["tracker", "tracker.tickets.list", "denied"],
    ]);
  });

  it("names the connector, not a link, until the person connects; then uses the vault's token", async () => {
    const port = await freePort();
    const y = await yard(port);
    await startGateway(y, port);
    const token = y.mint(githubRead);
    const mcp = await client(port, token);
    const before = await mcp.callTool({ name: "github__list_issues", arguments: {} });
    const refused = envelope(before);
    expect(refused).toMatchObject({
      code: "auth_required",
      details: { code: "connector/not_connected", connector: "github", account: "default" },
    });
    expect(JSON.stringify(before)).not.toMatch(/https?:\/\/|connect\/start/);
    expect(y.upstream.hits).toHaveLength(0);

    const stored = await post(port, "/connect/api-key", y.connectToken(), {
      connector: "github",
      api_key: "pat-ada",
    });
    expect(stored).toEqual({
      status: 200,
      json: { connected: true, connector: "github", account: "default" },
    });
    const after = await mcp.callTool({ name: "github__list_issues", arguments: {} });
    expect(after.isError).toBeFalsy();
    expect(y.upstream.hits).toEqual([
      { method: "GET", path: "/items", authorization: "Bearer pat-ada" },
    ]);

    const status = await fetch(`http://127.0.0.1:${port}/connect/status`, {
      headers: { authorization: `Bearer ${y.connectToken()}` },
    });
    const listed = (await status.json()) as { connections: unknown[] };
    expect(listed.connections).toMatchObject([
      { connector: "github", account: "default", kind: "static" },
    ]);
    expect(JSON.stringify(listed)).not.toContain("pat-ada");

    const audit = readFileSync(y.auditFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(audit.map((l) => [l.decision, l.error_code, l.upstream_status])).toEqual([
      ["allowed", "auth_required", null],
      ["allowed", null, 200],
    ]);
    expect(audit[1]).toMatchObject({
      sub: "local:ada",
      by_branch: "feature-x",
      by_turn: "1",
      account: "default",
    });
  });

  it("runs the OAuth connect flow through the gateway and uses the connected token", async () => {
    const port = await freePort();
    const y = await yard(port);
    await startGateway(y, port);
    const token = y.mint([{ connector: "tracker", operations: ["*"], mode: "read" }]);
    const started = await post(port, "/connect/start", y.connectToken(), {
      connector: "tracker",
    });
    expect(started.status).toBe(200);
    expect(started.json.kind).toBe("oauth");
    const url = new URL(started.json.url as string);
    expect(url.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${port}/connect/callback`);
    expect(url.searchParams.get("client_id")).toBe("tracker-client");
    const state = url.searchParams.get("state") as string;

    const callback = await fetch(
      `http://127.0.0.1:${port}/connect/callback?state=${encodeURIComponent(state)}&code=auth-code-1`,
    );
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("Connected tracker");
    expect(y.tokens.forms[0]?.get("code")).toBe("auth-code-1");
    expect(y.tokens.forms[0]?.get("code_verifier")).toBeTruthy();

    const mcp = await client(port, token);
    const listed = await mcp.callTool({ name: "tracker__list_tickets", arguments: {} });
    expect(listed.isError).toBeFalsy();
    expect(y.upstream.hits.at(-1)?.authorization).toBe("Bearer oauth-access-1");

    // A replayed callback is refused.
    const replay = await fetch(`http://127.0.0.1:${port}/connect/callback?state=${state}&code=x`);
    expect(replay.status).toBe(400);
  });

  it("anvil connect prints the authorization URL the gateway issues", async () => {
    const port = await freePort();
    const y = await yard(port);
    await startGateway(y, port);
    const tokenFile = join(y.root, "turn.token");
    writeFileSync(tokenFile, y.connectToken(), { mode: 0o600 });
    const io = bufferIO();
    const code = await runAnvilCli(
      [
        "connect",
        y.workspace,
        "tracker",
        "--account",
        "work",
        "--gateway",
        `http://127.0.0.1:${port}/mcp`,
        "--token-file",
        tokenFile,
      ],
      { io },
    );
    expect(code).toBe(0);
    expect(io.stdout[0]).toMatch(/^https:\/\/idp\.example\.com\/authorize\?/);
    const unknown = bufferIO();
    expect(
      await runAnvilCli(
        [
          "connect",
          y.workspace,
          "nope",
          "--gateway",
          `http://127.0.0.1:${port}/mcp`,
          "--token-file",
          tokenFile,
        ],
        {
          io: unknown,
        },
      ),
    ).toBe(1);
    expect(unknown.text()).toContain("it serves: github, tracker");
    const keyBased = bufferIO();
    expect(
      await runAnvilCli(
        [
          "connect",
          y.workspace,
          "github",
          "--gateway",
          `http://127.0.0.1:${port}/mcp`,
          "--token-file",
          tokenFile,
        ],
        {
          io: keyBased,
        },
      ),
    ).toBe(1);
    expect(keyBased.text()).toContain("--api-key-stdin");
  });

  it("takes connect mutations only from a connect token, never from a harness's turn token", async () => {
    const port = await freePort();
    const y = await yard(port);
    await startGateway(y, port);
    const person = y.connectToken();
    expect(
      (await post(port, "/connect/api-key", person, { connector: "github", api_key: "pat-ada" }))
        .status,
    ).toBe(200);
    // Every turn token a harness could hold — any grant, even a write grant
    // on the very connector — is refused at every connect route, and the
    // stored credential is left alone.
    for (const turn of [
      y.mint(githubRead),
      y.mint([{ connector: "github", operations: ["*"], mode: "write" }]),
      y.mint([]),
    ]) {
      const overwrite = await post(port, "/connect/api-key", turn, {
        connector: "github",
        api_key: "pat-attacker",
      });
      expect(overwrite).toMatchObject({
        status: 403,
        json: { error: { code: "connect_token_required" } },
      });
      expect((await post(port, "/connect/start", turn, { connector: "tracker" })).status).toBe(403);
      const status = await fetch(`http://127.0.0.1:${port}/connect/status`, {
        headers: { authorization: `Bearer ${turn}` },
      });
      expect(status.status).toBe(403);
      await status.text();
    }
    // An unknown purpose, and a connect token living past ten minutes, are invalid.
    const now = Math.floor(Date.now() / 1000);
    for (const bad of [
      y.connectToken({ by_purpose: "admin" }),
      y.connectToken({ iat: now, exp: now + 3600 }),
    ]) {
      expect(
        (await post(port, "/connect/api-key", bad, { connector: "github", api_key: "x" })).status,
      ).toBe(401);
    }
    const mcp = await client(port, y.mint(githubRead));
    expect(await mcp.callTool({ name: "github__list_issues", arguments: {} })).not.toHaveProperty(
      "isError",
      true,
    );
    expect(y.upstream.hits.map((h) => h.authorization)).toEqual(["Bearer pat-ada"]);
  });

  it("refuses a connect token for tools/list and tool calls", async () => {
    const port = await freePort();
    const y = await yard(port);
    await startGateway(y, port);
    const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${y.connectToken()}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    expect(init.status).toBe(403);
    expect(await init.json()).toMatchObject({ error: { code: "turn_token_required" } });
    // A connect token that also carries a grant is still not a tool caller.
    await expect(client(port, y.connectToken({ by_grants: githubRead }))).rejects.toThrow();
    expect(y.upstream.hits).toHaveLength(0);
  });

  it("binds a session to one turn's token", async () => {
    const port = await freePort();
    const y = await yard(port);
    await startGateway(y, port);
    const first = y.mint(githubRead);
    const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${first}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    const session = init.headers.get("mcp-session-id") as string;
    await init.text();
    const reuse = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${y.mint(githubRead, { by_turn: "2" })}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": session,
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(reuse.status).toBe(403);
  });
});
