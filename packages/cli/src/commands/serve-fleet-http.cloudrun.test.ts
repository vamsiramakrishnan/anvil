import { sign as cryptoSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { airToJson, loadAirDocument, Operation } from "@anvil/air";
import { bootRuntimeFromEnv, FirestoreLedger } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";
import { type FleetHttpHandle, startFleetHttp } from "./serve-fleet-http.js";

/**
 * Anvil contract v2, item 5 (the fleet gateway on Cloud Run) and the audit side
 * of item 7: the SIGTERM drain, the ANVIL_LEDGER selection, and a by_manifest
 * claim reaching the audit line without any token. Hermetic: loopback sockets
 * only, a held-open upstream, no Firestore and no Cloud Run.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

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

/** An upstream that answers `/items` only when the test lets it. */
async function heldUpstream(): Promise<{
  url: string;
  arrived: Promise<void>;
  release: () => void;
}> {
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const url = await listen(
    createServer((req, res) => {
      req.resume();
      arrive();
      void gate.then(() => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ number: 1 }]));
      });
    }),
  );
  return { url, arrived, release };
}

function readOp(): Operation {
  return Operation.parse({
    id: "things.list",
    canonicalName: "list_things",
    displayName: "list_things",
    sourceRef: { kind: "openapi", path: "/items", method: "get" },
    effect: { kind: "read", action: "list", resource: "thing", risk: "low", reversible: false },
    input: { params: [] },
    idempotency: { mode: "natural", mechanism: "none" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "things list" },
    mcp: { toolName: "list_things" },
    skill: { intentExamples: [] },
    state: "approved",
  });
}

function workspace(baseUrl: string): string {
  const root = mkdtempSync(join(tmpdir(), "anvil-cloudrun-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "ws", "things");
  mkdirSync(dir, { recursive: true });
  const air = loadAirDocument({
    service: {
      id: "things",
      version: "1.0.0",
      source: { kind: "openapi" },
      servers: [{ url: baseUrl }],
    },
    operations: [readOp()],
  });
  writeFileSync(join(dir, "air.json"), airToJson(air), "utf8");
  return join(root, "ws");
}

async function start(ws: string, env: NodeJS.ProcessEnv): Promise<FleetHttpHandle> {
  const started = await startFleetHttp(ws, {
    host: "127.0.0.1",
    port: 0,
    env: { ANVIL_ALLOWED_HOSTS: "127.0.0.1", ...env },
    io: bufferIO(),
  });
  if (!started.ok) throw new Error(started.message);
  cleanups.push(() => started.handle.close());
  return started.handle;
}

async function mcpClient(handle: FleetHttpHandle): Promise<Client> {
  const client = new Client({ name: "cloudrun-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)),
  );
  cleanups.push(() => client.close().catch(() => {}));
  return client;
}

describe("the fleet listener on SIGTERM", () => {
  it("lets a running call finish, refuses new work, then closes", async () => {
    const upstream = await heldUpstream();
    const handle = await start(workspace(upstream.url), { ANVIL_SHUTDOWN_GRACE_SECONDS: "20" });
    const client = await mcpClient(handle);
    const running = client.callTool({ name: "list_things", arguments: {} });
    await upstream.arrived;

    let closed = false;
    const closing = handle.close().then(() => {
      closed = true;
    });
    // The listener stops accepting at once: a new connection is refused.
    await expect(fetch(`http://127.0.0.1:${handle.port}/healthz`)).rejects.toThrow();
    // The drain is waiting for the running call, not finished.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed).toBe(false);

    upstream.release();
    const result = await running;
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain("number");
    await closing;
    expect(closed).toBe(true);
  });

  it("cuts a call that outlasts the grace period, and still closes", async () => {
    const upstream = await heldUpstream();
    const handle = await start(workspace(upstream.url), { ANVIL_SHUTDOWN_GRACE_SECONDS: "0" });
    const client = await mcpClient(handle);
    // The client may keep waiting on its cut socket; only the server's close matters here.
    void client.callTool({ name: "list_things", arguments: {} }).catch(() => undefined);
    await upstream.arrived;
    const started = Date.now();
    await handle.close();
    expect(Date.now() - started).toBeLessThan(5000);
    // The listener is gone.
    await expect(fetch(`http://127.0.0.1:${handle.port}/healthz`)).rejects.toThrow();
    upstream.release();
  });

  it("refuses an unusable ANVIL_SHUTDOWN_GRACE_SECONDS before binding a port", async () => {
    const ws = workspace("http://127.0.0.1:1");
    for (const value of ["-1", "abc", "1.5", "99999"]) {
      const started = await startFleetHttp(ws, {
        host: "127.0.0.1",
        port: 0,
        env: { ANVIL_SHUTDOWN_GRACE_SECONDS: value },
        io: bufferIO(),
      });
      expect(started).toMatchObject({
        ok: false,
        message: expect.stringContaining("ANVIL_SHUTDOWN_GRACE_SECONDS"),
      });
    }
  });

  it("exits 0 from `anvil serve mcp --fleet --http` when SIGTERM arrives", async () => {
    const ws = workspace("http://127.0.0.1:1");
    const io = bufferIO();
    const port = await freePort();
    const before = process.listenerCount("SIGTERM");
    const run = runAnvilCli(["serve", "mcp", ws, "--fleet", "--http", String(port)], { io });
    // Wait until the listener is up.
    for (let i = 0; i < 100; i++) {
      if (
        await fetch(`http://127.0.0.1:${port}/healthz`).then(
          (r) => r.ok,
          () => false,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(process.listenerCount("SIGTERM")).toBeGreaterThan(before);
    process.emit("SIGTERM");
    expect(await run).toBe(0);
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("the fleet listener's idempotency ledger", () => {
  const URI = "firestore://proj/(default)/gateway";

  it("boots the Firestore ledger when ANVIL_LEDGER names one", async () => {
    const boot = await bootRuntimeFromEnv({
      env: { ANVIL_ENV: "prod", ANVIL_LEDGER: URI },
      serviceId: "fleet",
      log: () => {},
      recordWrite: () => {},
    });
    expect(boot.contextDeps.ledger).toBeInstanceOf(FirestoreLedger);
    expect(boot.contextDeps.ledger.durable).toBe(true);
    const none = await bootRuntimeFromEnv({
      env: { ANVIL_ENV: "dev" },
      serviceId: "fleet",
      log: () => {},
      recordWrite: () => {},
    });
    expect(none.contextDeps.ledger.durable).toBe(false);
  });

  it("makes the fleet listener read ANVIL_LEDGER: a bad or unknown URI stops the start", async () => {
    const ws = workspace("http://127.0.0.1:1");
    const bad = await startFleetHttp(ws, {
      host: "127.0.0.1",
      port: 0,
      env: { ANVIL_LEDGER: "firestore://only-a-project" },
      io: bufferIO(),
    }).catch((error: Error) => ({ ok: false as const, message: error.message }));
    expect(bad.ok).toBe(false);
    expect((bad as { message: string }).message).toContain("ANVIL_LEDGER");
    const unknown = await startFleetHttp(ws, {
      host: "127.0.0.1",
      port: 0,
      env: { ANVIL_LEDGER: "redis://x" },
      io: bufferIO(),
    }).catch((error: Error) => ({ ok: false as const, message: error.message }));
    expect(unknown.ok).toBe(false);
    expect((unknown as { message: string }).message).toContain("redis");
    // A well-formed Firestore URI starts: no network is touched at boot.
    const good = await start(ws, { ANVIL_LEDGER: URI });
    expect(good.port).toBeGreaterThan(0);
  });
});

describe("by_manifest through the gateway", () => {
  async function gatewayWithAudit(ws: string, upstreamUrl: string) {
    void upstreamUrl;
    const root = mkdtempSync(join(tmpdir(), "anvil-manifest-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
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
    const port = await freePort();
    const audience = `http://127.0.0.1:${port}/mcp`;
    const env: NodeJS.ProcessEnv = {
      ANVIL_INBOUND_AUTH_MODE: "branchyard",
      ANVIL_INBOUND_ISSUER: "branchyard:local:test",
      ANVIL_INBOUND_AUDIENCE: audience,
      ANVIL_INBOUND_JWKS_URI: pathToFileURL(jwks).href,
      ANVIL_VAULT_KEY_FILE: vaultKey,
      ANVIL_VAULT_DIR: join(root, "vault"),
      ANVIL_AUDIT_FILE: auditFile,
      ANVIL_ALLOWED_HOSTS: "127.0.0.1",
    };
    const started = await startFleetHttp(ws, { host: "127.0.0.1", port, env, io: bufferIO() });
    if (!started.ok) throw new Error(started.message);
    cleanups.push(() => started.handle.close());
    const mint = (extra: Record<string, unknown>) => {
      const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const input = `${b64({ alg: "EdDSA", typ: "JWT", kid: "k1" })}.${b64({
        iss: "branchyard:local:test",
        aud: audience,
        sub: "local:ada",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
        jti: randomUUID(),
        by_tenant: "t1",
        by_branch: "feature-x",
        by_turn: "1",
        by_grants: [{ connector: "things", operations: ["*"], mode: "read" }],
        ...extra,
      })}`;
      return `${input}.${cryptoSign(null, Buffer.from(input), privateKey).toString("base64url")}`;
    };
    const call = async (token: string) => {
      const client = new Client({ name: "manifest-test", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(audience), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      try {
        return await client.callTool({ name: "things__list_things", arguments: {} });
      } finally {
        await client.close().catch(() => {});
      }
    };
    const lines = () =>
      readFileSync(auditFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { mint, call, lines, audience, auditFile };
  }

  it("records the claim in the audit line, null when absent, and decides the same", async () => {
    const upstream = await heldUpstream();
    upstream.release();
    const g = await gatewayWithAudit(workspace(upstream.url), upstream.url);
    const digest = `blake3:${"ab".repeat(32)}`;
    const a = await g.call(g.mint({ by_manifest: digest }));
    const b = await g.call(g.mint({}));
    const c = await g.call(g.mint({ by_manifest: "blake3:other" }));
    expect([a.isError, b.isError, c.isError]).toEqual([a.isError, a.isError, a.isError]);
    const lines = g.lines();
    expect(lines.map((line) => line.by_manifest)).toEqual([digest, null, "blake3:other"]);
    expect(
      new Set(lines.map((line) => `${line.sub}|${line.decision}|${line.operation}`)).size,
    ).toBe(1);
    // The audit file holds the claim and no token: a JWT starts with "eyJ".
    expect(readFileSync(g.auditFile, "utf8")).not.toContain("eyJ");
  });

  it("refuses a 257-character by_manifest with 401 before any call", async () => {
    const upstream = await heldUpstream();
    upstream.release();
    const g = await gatewayWithAudit(workspace(upstream.url), upstream.url);
    const res = await fetch(g.audience, {
      method: "POST",
      headers: {
        authorization: `Bearer ${g.mint({ by_manifest: "x".repeat(257) })}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    const ok = await fetch(g.audience, {
      method: "POST",
      headers: {
        authorization: `Bearer ${g.mint({ by_manifest: "x".repeat(256) })}`,
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
    expect(ok.status).toBe(200);
  });
});
