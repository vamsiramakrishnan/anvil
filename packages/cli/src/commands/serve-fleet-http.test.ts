import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { airToJson, loadAirDocument, Operation } from "@anvil/air";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "../anvil-cli.js";
import { bufferIO } from "../io.js";
import { type FleetHttpHandle, isLoopbackHost, startFleetHttp } from "./serve-fleet-http.js";

/**
 * `anvil serve mcp --fleet --http <port>`: a real MCP client over a real
 * StreamableHTTP connection against two mounted bundles. Same discovery, same
 * per-bundle prefixing, same principal rule as stdio — plus the inbound-auth
 * gate the deployed server enforces, exercised here as an HTTP contract
 * (401 with WWW-Authenticate, not a transport error).
 */

const roots: string[] = [];
const handles: FleetHttpHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function op(id: string, toolName: string): Operation {
  return Operation.parse({
    id,
    canonicalName: toolName,
    displayName: toolName,
    sourceRef: { kind: "openapi", path: "/things", method: "get" },
    effect: { kind: "read", action: "list", resource: "thing", risk: "low", reversible: false },
    input: { params: [] },
    idempotency: { mode: "natural", mechanism: "none" },
    retries: { mode: "safe", maxAttempts: 3, backoff: "exponential", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "things list" },
    mcp: { toolName },
    skill: { intentExamples: [] },
    state: "approved",
  });
}

function writeBundle(dir: string, serviceId: string, toolName: string): void {
  mkdirSync(dir, { recursive: true });
  const air = loadAirDocument({
    service: { id: serviceId, version: "1.0.0", source: { kind: "openapi" } },
    operations: [op(`${serviceId}.list`, toolName)],
  });
  writeFileSync(join(dir, "air.json"), airToJson(air), "utf8");
}

function twoBundleWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "anvil-fleet-http-"));
  roots.push(root);
  writeBundle(join(root, "billing"), "billing", "list_invoices");
  writeBundle(join(root, "shipping"), "shipping", "list_shipments");
  return root;
}

async function start(
  root: string,
  env: NodeJS.ProcessEnv = {},
  host = "127.0.0.1",
): Promise<FleetHttpHandle> {
  const started = await startFleetHttp(root, { host, port: 0, env, io: bufferIO() });
  if (!started.ok) throw new Error(started.message);
  handles.push(started.handle);
  return started.handle;
}

async function connect(
  handle: FleetHttpHandle,
  headers: Record<string, string> = {},
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://${handle.host}:${handle.port}/mcp`),
    { requestInit: { headers } },
  );
  const client = new Client({ name: "fleet-http-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

describe("anvil serve mcp --fleet --http", () => {
  it("serves two mounted bundles to a real MCP client over StreamableHTTP under their fleet prefixes", async () => {
    const handle = await start(twoBundleWorkspace());
    expect(handle.host).toBe("127.0.0.1");
    expect(handle.bundleIds).toEqual(["billing", "shipping"]);
    const { client, transport } = await connect(handle);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "billing__list_invoices",
      "shipping__list_shipments",
    ]);
    expect(transport.sessionId).toBeDefined();
    // A second client gets its own session and its own fleet composition.
    const second = await connect(handle);
    expect(second.transport.sessionId).not.toBe(transport.sessionId);
    expect((await second.client.listTools()).tools).toHaveLength(2);
    // A call routes to the owning bundle: the read op has no upstream to reach
    // in this test, so it must fail on the wire — never as a routing error.
    const result = await client.callTool({ name: "shipping__list_shipments", arguments: {} });
    const text = JSON.stringify(result.content);
    expect(text).not.toContain("Unknown tool");
    expect(text).not.toContain("policy/principal_unresolved");
    await client.close();
    await second.client.close();
  });

  it("keeps /readyz and /healthz on the same listener, open without a token", async () => {
    const handle = await start(twoBundleWorkspace());
    const readyz = await fetch(`http://127.0.0.1:${handle.port}/readyz`);
    expect(readyz.status).toBe(503); // uncertified bundles are mounted but not ready
    const body = (await readyz.json()) as { ready: boolean; bundles: Array<{ id: string }> };
    expect(body.ready).toBe(false);
    expect(body.bundles.map((b) => b.id)).toEqual(["billing", "shipping"]);
    const healthz = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    expect(healthz.status).toBe(200);
    expect(await healthz.json()).toMatchObject({ status: "ok", fleet: true, bundles: 2 });
    const other = await fetch(`http://127.0.0.1:${handle.port}/anything`);
    expect(other.status).toBe(404);
  });

  it("enforces inbound auth on /mcp exactly as the deployed server does: 401 + WWW-Authenticate before any session exists", async () => {
    const handle = await start(twoBundleWorkspace(), {
      ANVIL_INBOUND_AUTH_MODE: "oidc",
      ANVIL_INBOUND_ISSUER: "https://issuer.example.com/",
      ANVIL_INBOUND_AUDIENCE: "api://anvil-fleet",
      ANVIL_INBOUND_RESOURCE: "https://fleet.example.com/mcp",
      ANVIL_INBOUND_JWKS_URI: "https://issuer.example.com/jwks",
    });
    // An incomplete inbound configuration is a refusal, never a throw or a
    // silently unauthenticated listener.
    const incomplete = await startFleetHttp(twoBundleWorkspace(), {
      host: "127.0.0.1",
      port: 0,
      env: { ANVIL_INBOUND_AUTH_MODE: "oidc" },
      io: bufferIO(),
    });
    expect(incomplete.ok).toBe(false);
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    };
    const anonymous = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initialize),
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toMatch(/^Bearer/);
    const forged = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer not.a.jwt",
      },
      body: JSON.stringify(initialize),
    });
    expect(forged.status).toBe(401);
    // The SDK client sees the same refusal, not a silently anonymous session.
    await expect(connect(handle)).rejects.toThrow(/No bearer token was presented/);
    // Discovery stays open so a client can find the authorization server.
    const metadata = await fetch(
      `http://127.0.0.1:${handle.port}/.well-known/oauth-protected-resource`,
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      resource: "https://fleet.example.com/mcp",
      authorization_servers: ["https://issuer.example.com/"],
    });
    // Probes remain open: a probe has no token.
    expect((await fetch(`http://127.0.0.1:${handle.port}/healthz`)).status).toBe(200);
  });

  it("resolves the session principal from the bearer token against ANVIL_PRINCIPALS and refuses an unlisted one fail-closed", async () => {
    const handle = await start(twoBundleWorkspace(), {
      ANVIL_PRINCIPALS: "tok_abc:alice:things.read",
    });
    const unlisted = await connect(handle, { authorization: "Bearer tok_wrong" });
    const refused = await unlisted.client.callTool({
      name: "billing__list_invoices",
      arguments: {},
    });
    expect(refused.isError).toBe(true);
    const text = JSON.stringify(refused.content);
    expect(text).toContain("policy/principal_unresolved");
    expect(text).toContain("policy_denied");
    expect(text).not.toContain('"anonymous"');
    await unlisted.client.close();

    const listed = await connect(handle, { authorization: "Bearer tok_abc" });
    const allowed = await listed.client.callTool({ name: "billing__list_invoices", arguments: {} });
    expect(JSON.stringify(allowed.content)).not.toContain("policy/principal_unresolved");
    await listed.client.close();
  });

  it("refuses a non-loopback bind without inbound auth, and binds it only when explicitly asked for with auth configured", async () => {
    const root = twoBundleWorkspace();
    const refused = await startFleetHttp(root, {
      host: "0.0.0.0",
      port: 0,
      env: {},
      io: bufferIO(),
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.message).toContain("refusing to bind the fleet to 0.0.0.0");
    expect(refused.message).toContain("ANVIL_INBOUND_AUTH_MODE");
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
  });

  it("refuses a workspace with no bundles and a cross-bundle collision before binding a port", async () => {
    const empty = mkdtempSync(join(tmpdir(), "anvil-fleet-http-empty-"));
    roots.push(empty);
    const none = await startFleetHttp(empty, {
      host: "127.0.0.1",
      port: 0,
      env: {},
      io: bufferIO(),
    });
    expect(none.ok).toBe(false);
    if (none.ok) throw new Error("unreachable");
    expect(none.message).toContain("no bundles found");

    const root = mkdtempSync(join(tmpdir(), "anvil-fleet-http-collide-"));
    roots.push(root);
    // Two bundles whose ids fold to the same prefix with the same tool name.
    writeBundle(join(root, "svc"), "svc-a", "list_things");
    writeBundle(join(root, "svc!!"), "svc-b", "list_things");
    const collided = await startFleetHttp(root, {
      host: "127.0.0.1",
      port: 0,
      env: {},
      io: bufferIO(),
    });
    expect(collided.ok).toBe(false);
    if (collided.ok) throw new Error("unreachable");
    expect(collided.message).toMatch(/collision/);
  });

  it("is reachable from the CLI only with --fleet, and validates the port", async () => {
    const root = twoBundleWorkspace();
    const io = bufferIO();
    expect(await runAnvilCli(["serve", "mcp", root, "--http", "8080"], { io })).toBe(1);
    expect(io.text()).toContain("--http and --host apply to --fleet only");
    const bad = bufferIO();
    expect(
      await runAnvilCli(["serve", "mcp", root, "--fleet", "--http", "99999"], { io: bad }),
    ).toBe(1);
    expect(bad.text()).toContain("--http expects a port from 1 to 65535");
  });
});
