import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSdks } from "./sdk/index.js";

/**
 * Gateway mode for the generated SDKs (ADR-0029, docs/branchyard.md): with
 * ANVIL_GATEWAY_URL set, a Python or TypeScript client sends every call to the
 * gateway over MCP Streamable HTTP as `<connector>__<tool>`, reads the bearer
 * from ANVIL_GATEWAY_TOKEN_FILE on every call, never calls the upstream, and
 * never reads `<SERVICE>_TOKEN` — even when it is set. Results come back in the
 * direct-mode contract: data, a dry-run plan, or an AnvilError with the
 * gateway's code and details.
 *
 * The gateway here is a stub that speaks the Streamable HTTP wire (JSON for
 * `initialize`, SSE for `tools/call`) and records what it was sent; the
 * upstream is a listener that records any request that reaches it (none
 * should). Both run in a child process because the clients are driven with
 * blocking `execFileSync`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(join(here, "../../../examples/github-mini", rel), "utf8");
const TYPESCRIPT = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const has = (tool: string, args: string[]) =>
  spawnSync(tool, args, { stdio: "ignore" }).status === 0;
const PYTHON = has("python3", ["--version"]);
const TYPE_ROOTS = fileURLToPath(new URL("../../../node_modules/@types", import.meta.url));

const STUB = String.raw`import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
const log = process.argv[2];
const record = (entry) => appendFileSync(log, JSON.stringify(entry) + "\n");
const upstream = createServer((req, res) => {
  record({ upstream: true, method: req.method, url: req.url, authorization: req.headers.authorization ?? null });
  res.writeHead(500);
  res.end();
});
const gateway = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    if (req.method === "DELETE") { res.writeHead(200); res.end(); return; }
    const message = JSON.parse(raw);
    record({ gateway: true, method: message.method, params: message.params ?? null, authorization: req.headers.authorization ?? null, session: req.headers["mcp-session-id"] ?? null });
    if (message.method === "initialize") {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-1" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } } }));
      return;
    }
    if (message.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
    const name = message.params.name;
    const args = message.params.arguments ?? {};
    let result;
    if (name.endsWith("_create_issue")) {
      result = { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: "policy_denied", message: "read-only grant", retryable: false, safe_to_retry: false, operation: "github.issues.create", trace_id: "t-1", details: { code: "policy/grant_denied", connector: "github" } } }) }] };
    } else if (args.anvil_dry_run) {
      const plan = { operation: "github.issues.list", method: "GET", url: "https://api.github.example/repos/o/r/issues", headers: {} };
      result = { content: [{ type: "text", text: JSON.stringify(plan) }], structuredContent: { anvil_dry_run: plan } };
    } else {
      const data = [{ number: 1, title: "First", state: "open" }];
      result = { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { result: data } };
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n\n");
  });
});
upstream.listen(0, "127.0.0.1", () => gateway.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ upstream: upstream.address().port, gateway: gateway.address().port }) + "\n");
}));
`;

let work = "";
let child: ChildProcess | undefined;
let gatewayUrl = "";
let upstreamUrl = "";
let logFile = "";

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "anvil-sdk-gateway-"));
  logFile = join(work, "log.jsonl");
  writeFileSync(logFile, "");
  writeFileSync(join(work, "stub.mjs"), STUB);
  child = spawn(process.execPath, [join(work, "stub.mjs"), logFile], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ports = await new Promise<{ upstream: number; gateway: number }>((resolve, reject) => {
    child?.stdout?.once("data", (chunk) => resolve(JSON.parse(String(chunk))));
    child?.once("error", reject);
  });
  gatewayUrl = `http://127.0.0.1:${ports.gateway}/mcp`;
  upstreamUrl = `http://127.0.0.1:${ports.upstream}`;
  const air = await compile({
    spec: read("openapi.yaml").replace("https://api.github.example", upstreamUrl),
    manifest: read("anvil.yaml"),
    serviceId: "github",
  });
  for (const [rel, text] of Object.entries(generateSdks(air, { gatewayConnector: "github" }))) {
    const full = join(work, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, "utf8");
  }
});

afterAll(() => {
  child?.kill();
  rmSync(work, { recursive: true, force: true });
});

function log(): Array<Record<string, unknown>> {
  return readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function clean(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /TOKEN|SECRET|PROXY|^ANVIL_/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

describe.runIf(PYTHON)("Python SDK in gateway mode", () => {
  it("calls the gateway, re-reads the token per call, decodes results, and never reads GITHUB_TOKEN", () => {
    writeFileSync(logFile, "");
    const tokenFile = join(work, "py.token");
    writeFileSync(tokenFile, "turn-token-A\n");
    const script = `
import json, os, sys

class Spy(dict):
    reads = []
    def get(self, key, default=None):
        Spy.reads.append(key)
        return dict.get(self, key, default)
    def __getitem__(self, key):
        Spy.reads.append(key)
        return dict.__getitem__(self, key)

os.environ = Spy(os.environ)
from anvil_github import GithubClient, AnvilError
client = GithubClient()
first = client.list_issue(owner="o", repo="r")
with open(os.environ["ANVIL_GATEWAY_TOKEN_FILE"], "w") as handle:
    handle.write("turn-token-B")
second = client.list_issue(owner="o", repo="r", state="open")
plan = client.list_issue(owner="o", repo="r", dry_run=True)
try:
    client.create_issue(owner="o", repo="r", title="t")
    local = None
except AnvilError as error:
    local = error.code
try:
    client.create_issue(owner="o", repo="r", title="t", confirm=True)
    remote = None
except AnvilError as error:
    remote = {"code": error.code, "details": error.details, "trace": error.trace_id}
print(json.dumps({"first": first, "second": second, "plan": plan, "local": local, "remote": remote, "reads": Spy.reads}))
`;
    const out = execFileSync("python3", ["-c", script], {
      env: {
        ...clean(),
        PYTHONPATH: join(work, "sdk", "python"),
        ANVIL_GATEWAY_URL: gatewayUrl,
        ANVIL_GATEWAY_TOKEN_FILE: tokenFile,
        GITHUB_TOKEN: "upstream-token-must-not-be-read",
      },
      encoding: "utf8",
    });
    const result = JSON.parse(out.trim());
    expect(result.first).toEqual([{ number: 1, title: "First", state: "open" }]);
    expect(result.second).toEqual(result.first);
    expect(result.plan).toMatchObject({ operation: "github.issues.list", method: "GET" });
    expect(result.local).toBe("confirmation_required");
    expect(result.remote).toEqual({
      code: "policy_denied",
      details: { code: "policy/grant_denied", connector: "github" },
      trace: "t-1",
    });
    expect(result.reads).not.toContain("GITHUB_TOKEN");
    expect(result.reads).toContain("ANVIL_GATEWAY_URL");

    const entries = log();
    expect(entries.filter((e) => e.upstream)).toEqual([]);
    const calls = entries.filter((e) => e.method === "tools/call");
    const argsOf = (index: number) =>
      (calls[index]?.params as { arguments?: unknown } | undefined)?.arguments;
    expect(calls.map((e) => (e.params as { name: string }).name)).toEqual([
      "github__github_list_issue",
      "github__github_list_issue",
      "github__github_list_issue",
      "github__github_create_issue",
    ]);
    expect(calls.map((e) => e.authorization)).toEqual([
      "Bearer turn-token-A",
      "Bearer turn-token-B",
      "Bearer turn-token-B",
      "Bearer turn-token-B",
    ]);
    expect(argsOf(1)).toEqual({
      owner: "o",
      repo: "r",
      state: "open",
    });
    expect(argsOf(2)).toMatchObject({
      anvil_dry_run: true,
    });
    expect(argsOf(3)).toMatchObject({ confirm: true });
    expect(calls.every((e) => e.session === "s-1")).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("upstream-token-must-not-be-read");
  });

  it("refuses with auth_required, naming no token, when the token file is missing", () => {
    const script = `
import json
from anvil_github import GithubClient, AnvilError
try:
    GithubClient().list_issue(owner="o", repo="r")
except AnvilError as error:
    print(json.dumps({"code": error.code, "message": error.message}))
`;
    const out = execFileSync("python3", ["-c", script], {
      env: {
        ...clean(),
        PYTHONPATH: join(work, "sdk", "python"),
        ANVIL_GATEWAY_URL: gatewayUrl,
        ANVIL_GATEWAY_TOKEN_FILE: join(work, "missing.token"),
      },
      encoding: "utf8",
    });
    expect(JSON.parse(out.trim())).toMatchObject({ code: "auth_required" });
  });
});

describe("TypeScript SDK in gateway mode", () => {
  it("calls the gateway with the per-call token and never reads GITHUB_TOKEN", () => {
    writeFileSync(logFile, "");
    const root = join(work, "sdk", "typescript");
    execFileSync(process.execPath, [TYPESCRIPT, "-p", "tsconfig.json", "--typeRoots", TYPE_ROOTS], {
      cwd: root,
    });
    const tokenFile = join(work, "ts.token");
    writeFileSync(tokenFile, "ts-token-A");
    const script = `
import { writeFileSync } from "node:fs";
const reads = [];
const real = process.env;
process.env = new Proxy(real, { get(target, key) { reads.push(String(key)); return target[key]; } });
const { GithubClient, AnvilError } = await import(${JSON.stringify(join(root, "dist", "index.js"))});
const client = new GithubClient();
const first = await client.listIssue({ owner: "o", repo: "r" });
writeFileSync(real.ANVIL_GATEWAY_TOKEN_FILE, "ts-token-B");
const plan = await client.listIssue({ owner: "o", repo: "r" }, { dryRun: true });
let remote;
try { await client.createIssue({ owner: "o", repo: "r", title: "t" }, { confirm: true }); }
catch (error) { remote = { code: error.code, details: error.details, isAnvil: error instanceof AnvilError }; }
process.stdout.write(JSON.stringify({ first, plan, remote, reads }));
`;
    writeFileSync(join(work, "run.mjs"), script);
    const out = execFileSync(process.execPath, [join(work, "run.mjs")], {
      env: {
        ...clean(),
        ANVIL_GATEWAY_URL: gatewayUrl,
        ANVIL_GATEWAY_TOKEN_FILE: tokenFile,
        GITHUB_TOKEN: "upstream-token-must-not-be-read",
      },
      encoding: "utf8",
    });
    const result = JSON.parse(out);
    expect(result.first).toEqual([{ number: 1, title: "First", state: "open" }]);
    expect(result.plan).toMatchObject({ operation: "github.issues.list" });
    expect(result.remote).toEqual({
      code: "policy_denied",
      details: { code: "policy/grant_denied", connector: "github" },
      isAnvil: true,
    });
    expect(result.reads).not.toContain("GITHUB_TOKEN");
    const calls = log().filter((e) => e.method === "tools/call");
    expect(calls.map((e) => e.authorization)).toEqual([
      "Bearer ts-token-A",
      "Bearer ts-token-B",
      "Bearer ts-token-B",
    ]);
    expect(log().filter((e) => e.upstream)).toEqual([]);
  });
});
