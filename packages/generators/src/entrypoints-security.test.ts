import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import { generateRuntimeServer } from "./entrypoints.js";

const readExample = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/payments/${name}`, import.meta.url)),
    "utf8",
  );

let source: string;

beforeAll(async () => {
  const air: AirDocument = await compile({
    spec: readExample("openapi.yaml"),
    manifest: readExample("anvil.yaml"),
    serviceId: "payments",
  });
  source = generateRuntimeServer(air);
});

describe("generated public StreamableHTTP server hardening", () => {
  it("emits syntactically valid JavaScript", () => {
    const checked = spawnSync(process.execPath, ["--input-type=module", "--check", "-"], {
      input: source,
      encoding: "utf8",
    });
    expect(checked.status, checked.stderr).toBe(0);
  });

  it("binds every authenticated session to a one-way verified-principal fingerprint", () => {
    expect(source).toContain("callerFingerprint: auth.callerFingerprint");
    expect(source).toContain("entry.callerFingerprint !== auth.callerFingerprint");
    expect(source).toContain("verifiedPrincipalFingerprint(result.claims)");
    expect(source).toContain("JSON.stringify({ issuer, sub, oid, authorizedParty, tenant })");
    expect(source).not.toContain('createHash("sha256").update(rawToken)');
    expect(source).toContain("This MCP session belongs to a different authenticated caller.");

    const authenticate = source.indexOf("const auth = await authorized(req, res)");
    const lookup = source.indexOf("let entry = sid ? sessions.get(sid) : undefined");
    const identityCheck = source.indexOf("entry.callerFingerprint !== auth.callerFingerprint");
    const dispatch = source.indexOf("entry.transport.handleRequest(req, res, body)");
    expect(authenticate).toBeGreaterThan(-1);
    expect(authenticate).toBeLessThan(lookup);
    expect(lookup).toBeLessThan(identityCheck);
    expect(identityCheck).toBeLessThan(dispatch);
  });

  it("bounds session count and lifetime, evicts only inactive LRU entries, and cleans up", () => {
    expect(source).toContain("const MCP_SESSION_IDLE_TTL_MS = 15 * 60 * 1000");
    expect(source).toContain("const MCP_MAX_SESSIONS = 1000");
    expect(source).toContain("sessions.size + pendingSessionCount >= MCP_MAX_SESSIONS");
    expect(source).toContain("function leastRecentlyUsedIdleSession()");
    expect(source).toContain("entry.activeRequests !== 0");
    expect(source).toContain("void closeSession(oldest)");
    expect(source).toContain("setInterval(() => pruneIdleSessions()");
    expect(source).toContain("clearInterval(sessionSweep)");
    expect(source).toContain('process.once("SIGTERM", () => void shutdown())');
    expect(source).toContain('process.once("SIGINT", () => void shutdown())');
    expect(source).toContain("Promise.allSettled([...liveSessionEntries]");
  });

  it("requires JSON and rejects oversized or malformed request bodies before dispatch", () => {
    expect(source).toContain("const MCP_REQUEST_MAX_BYTES = 1024 * 1024");
    expect(source).toContain('mediaType !== "application/json"');
    expect(source).toContain("Content-Type must be application/json.");
    expect(source).toContain(
      'jsonRpcError(res, 413, -32600, "MCP request body exceeds the size limit.")',
    );
    expect(source).toContain("received > MCP_REQUEST_MAX_BYTES");
    expect(source).toContain("MCP request body is malformed JSON.");

    const contentTypeCheck = source.indexOf('mediaType !== "application/json"');
    const bodyRead = source.indexOf("const parsed = await readJsonBody(req, res)");
    const dispatch = source.indexOf("entry.transport.handleRequest(req, res, body)");
    expect(contentTypeCheck).toBeGreaterThan(-1);
    expect(contentTypeCheck).toBeLessThan(bodyRead);
    expect(bodyRead).toBeLessThan(dispatch);
  });

  it("fails readiness closed on ledger access without leaking provider details", () => {
    expect(source).toContain("probeLedgerReadiness");
    expect(source).toContain('config.env !== "dev"');
    expect(source).toContain('code: "ledger_unavailable"');
    expect(source).toContain("json(res, 503");
    expect(source).toContain("service: air.service.id");
    expect(source).not.toContain("service: config.serviceId");
  });
});
