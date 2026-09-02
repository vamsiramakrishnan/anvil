import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { compile } from "@anvil/compiler";
import {
  bundleHash,
  generateBundle,
  loadBundleAir,
  readBundleDir,
  writeBundle,
} from "@anvil/generators";
import {
  analyzeConfusion,
  BENCHMARK_REPORT_FILE,
  type BenchmarkOperationResult,
  bareCatalog,
  benchmarkOperations,
  curatedCatalog,
  lexicalRouter,
  parseBenchmarkReport,
  routeAndScore,
} from "@anvil/refinement";
import { createConsoleServer } from "./index.js";

/**
 * Test fixtures for the console server: a workspace holding the REAL
 * `examples/payments` bundle (compiled, generated, written to disk — exactly
 * what `anvil compile` writes), a benchmark report produced by the library's
 * own routing core, and an HTTP client that speaks the security contract so a
 * test can choose which line of it to break. Not a test file itself: several
 * test files share it, and a test file imported by another would register its
 * cases twice.
 */

const examples = fileURLToPath(new URL("../../../../examples/payments/", import.meta.url));

export interface Workspace {
  root: string;
  bundleId: string;
  bundleDir: string;
  air: AirDocument;
}

/**
 * A fresh temp workspace with the payments bundle at `<root>/payments` and a
 * git history. Compiled WITHOUT the example manifest, the way `anvil compile
 * <spec>` first meets a spec: two operations sit in `review_required` and every
 * discovered capability is `proposed` — the decisions the console exists for.
 */
export async function paymentsWorkspace(): Promise<Workspace> {
  const root = mkdtempSync(join(tmpdir(), "anvil-console-"));
  const bundleDir = join(root, "payments");
  const compiled = await compile({
    spec: readFileSync(join(examples, "openapi.yaml"), "utf8"),
    serviceId: "payments",
  });
  writeBundle(bundleDir, generateBundle(compiled));
  gitInit(root);
  return { root, bundleId: "payments", bundleDir, air: loadAir(bundleDir) };
}

/** The export/import rails bind a repository revision, so a workspace is a git repository. */
export function gitInit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "anvil@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Anvil Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
}

export function loadAir(bundleDir: string): AirDocument {
  return loadBundleAir(bundleDir, readBundleDir(bundleDir));
}

/** Write `benchmark.report.json` beside a bundle, measured by the library's lexical router. */
export async function writeBenchmarkReport(bundleDir: string): Promise<void> {
  const document = loadAir(bundleDir);
  const ops = benchmarkOperations(document);
  const curated = curatedCatalog(ops);
  const bare = bareCatalog(ops);
  const router = lexicalRouter();
  const operations: BenchmarkOperationResult[] = [];
  for (const op of ops) {
    const tasks = [];
    for (const intent of op.skill.intentExamples) {
      const curatedOutcome = await routeAndScore(router, intent, curated, op.id);
      const bareOutcome = await routeAndScore(router, intent, bare, op.id);
      tasks.push({
        intent,
        curated: curatedOutcome,
        bare: bareOutcome,
        satisfiable: true,
        pass: curatedOutcome.pass,
      });
    }
    operations.push({
      operationId: op.id,
      toolName: op.mcp.toolName,
      tasks,
      score: tasks.length > 0 ? tasks.filter((t) => t.pass).length / tasks.length : 0,
    });
  }
  const all = operations.flatMap((o) => o.tasks);
  const passed = all.filter((t) => t.pass).length;
  const report = parseBenchmarkReport({
    schemaVersion: 2,
    router: router.name,
    catalogSize: curated.length,
    operations,
    confusion: analyzeConfusion(operations),
    summary: {
      total: all.length,
      passed,
      score: all.length > 0 ? passed / all.length : 0,
      curatedRouted: all.filter((t) => t.curated.pass).length,
      bareRouted: all.filter((t) => t.bare.pass).length,
      upliftPts: 0,
    },
    bundleHash: bundleHash(readBundleDir(bundleDir)),
  });
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, BENCHMARK_REPORT_FILE), `${JSON.stringify(report)}\n`, "utf8");
}

/* --------------------------------- client --------------------------------- */

interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

interface RequestOptions {
  /** Defaults to the server's token; pass `null` to omit the header. */
  token?: string | null;
  /** Defaults to the server's origin; pass `null` to omit the header. */
  origin?: string | null;
  headers?: Record<string, string>;
  /** Raw body, sent as-is (bypasses JSON encoding). */
  raw?: string;
  contentType?: string | null;
}

export type Client = ReturnType<typeof clientFor>;

/** An HTTP client that satisfies the security contract by default, so tests break it deliberately. */
function clientFor(server: { url: string; token: string }) {
  async function send(
    method: string,
    path: string,
    body?: unknown,
    opts: RequestOptions = {},
  ): Promise<Reply> {
    const headers: Record<string, string> = { ...opts.headers };
    const token = opts.token === undefined ? server.token : opts.token;
    if (token !== null) headers["x-anvil-console-token"] = token;
    const origin = opts.origin === undefined ? server.url : opts.origin;
    if (origin !== null) headers.origin = origin;
    let payload: string | undefined;
    if (opts.raw !== undefined || body !== undefined) {
      payload = opts.raw ?? JSON.stringify(body);
      const contentType = opts.contentType === undefined ? "application/json" : opts.contentType;
      if (contentType !== null) headers["content-type"] = contentType;
    }
    const response = await fetch(`${server.url}${path}`, { method, headers, body: payload });
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, text, json };
  }
  return {
    get: (path: string, opts?: RequestOptions) => send("GET", path, undefined, opts),
    post: (path: string, body: unknown, opts?: RequestOptions) => send("POST", path, body, opts),
    send,
  };
}

/** Start a server over a workspace with a captured log, returning what a test needs to drive it. */
export async function startServer(root: string, extra: { uiDir?: string } = {}) {
  const log: string[] = [];
  const server = await createConsoleServer({
    root,
    log: (line) => log.push(line),
    ...extra,
  }).listen();
  return { server, log, client: clientFor(server) };
}
