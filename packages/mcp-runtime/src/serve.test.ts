import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Structural safety properties of the deployable runtime, pinned on its source.
 *
 * These assertions used to live in `@anvil/generators` and read the server as a
 * template string. The server is real code now — typechecked, bundled once at
 * Anvil's build — so they read `serve.ts` itself. They are ORDERING checks: not
 * "does the server authenticate" but "does it authenticate before it looks up a
 * session, and look up the session before it dispatches". A refactor that keeps
 * every function and reorders two lines can undo a security property while
 * every behavioural test still passes, which is exactly what makes these worth
 * keeping as source-level checks rather than folding into the boot tests.
 */
const source = readFileSync(new URL("./serve.ts", import.meta.url), "utf8");

function ordered(...markers: string[]): void {
  let last = -1;
  for (const marker of markers) {
    const at = source.indexOf(marker);
    expect(at, `missing: ${marker}`).toBeGreaterThan(-1);
    expect(at, `out of order: ${marker}`).toBeGreaterThan(last);
    last = at;
  }
}

describe("one runtime, no template", () => {
  it("reads every per-service value from the artifact beside it, never from baked-in code", () => {
    // The two values that used to make the file per-service.
    expect(source).toContain('readArtifactJson("webhooks.json")');
    expect(source).toContain('operation.idempotency.mode === "required"');
    // And the data files every service shares the shape of.
    for (const name of ["air.json", "resources.json", "operations.manifest.json"]) {
      expect(source).toContain(`readArtifactJson("${name}")`);
    }
    // No JSON literal of a route table anywhere — that was the template.
    expect(source).not.toMatch(/const webhookRoutes = \[/);
  });

  it("fails closed on a missing artifact file instead of serving without it", () => {
    expect(source).toContain("refusing to serve a partial deployment");
    // The refusal happens at module load, before the server is created.
    ordered("refusing to serve a partial deployment", "const server = createServer(");
  });

  it("imports its own package relatively, so bundling it never resolves @anvil/mcp-runtime", () => {
    expect(source).toContain('from "./server.js"');
    expect(source).toContain('from "./inbound-auth.js"');
    expect(source).toContain('from "./async-completion.js"');
    expect(source).not.toContain('from "@anvil/mcp-runtime"');
  });
});

describe("public StreamableHTTP server hardening", () => {
  it("binds every authenticated session to a one-way verified-principal fingerprint", () => {
    expect(source).toContain("callerFingerprint: auth.callerFingerprint");
    expect(source).toContain("entry.callerFingerprint !== auth.callerFingerprint");
    expect(source).toContain("verifiedPrincipalFingerprint(result.claims)");
    expect(source).toContain("JSON.stringify({ issuer, sub, oid, authorizedParty, tenant })");
    expect(source).not.toContain('createHash("sha256").update(rawToken)');
    expect(source).toContain("This MCP session belongs to a different authenticated caller.");
    ordered(
      "const auth = await authorized(req, res)",
      "let entry = sid ? sessions.get(sid) : undefined",
      "entry.callerFingerprint !== auth.callerFingerprint",
      "live.transport.handleRequest(req, res, body)",
    );
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
    ordered(
      'mediaType !== "application/json"',
      "const parsed = await readJsonBody(req, res)",
      "live.transport.handleRequest(req, res, body)",
    );
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

describe("inbound webhook routes", () => {
  it("dispatches /webhooks/ paths before the inbound-OAuth-gated routes, unauthenticated", () => {
    ordered(
      'url.pathname.startsWith("/webhooks/")',
      "Everything below exposes the tool surface — gate it on the inbound token.",
    );
  });

  it("wires the route to handleWebhook with the operation's own resolved WebhookContract", () => {
    expect(source).toContain("resolveAsyncContract(submitOp, allOpsById)");
    expect(source).toContain("operation: resolution.webhookOperation,");
    expect(source).toContain("contract: resolution.contract.webhook,");
    expect(source).toContain("resolveRef: resolveWebhookRef,");
  });

  it("verifies before it ever records a cache entry", () => {
    // Inside handleWebhookRoute: the durable handleWebhook() call (whose OWN
    // first step is signature verification, before the ledger is touched)
    // always precedes the best-effort status cache write, which only ever runs
    // after a 200.
    ordered(
      "async function handleWebhookRoute(",
      "const outcome = await handleWebhook({",
      "void recordWebhookCompletionIfIndexed({",
      "return handleWebhookRoute(req, res, route);",
    );
  });

  it("resolves every *Ref field through a plain runtime environment variable, never a literal", () => {
    expect(source).toContain("process.env[ref]");
  });
});
