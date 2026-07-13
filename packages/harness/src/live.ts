import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAirDocument, type Operation } from "@anvil/air";
import { exampleInput } from "@anvil/generators";
import { z } from "zod";
import { connectSource, type McpSource } from "./mcp-source.js";

/**
 * The opt-in real lane. `selftest`, `conformance`, and `simulate` are all
 * hermetic — mock upstream, in-process simulator, zero network. This drives the
 * SAME agreement checks against a REAL, deployed MCP endpoint (a Cloud Run
 * `/mcp`, say): does the deployed server serve exactly the operations the bundle
 * certified, and does its confirmation gate actually refuse in production?
 *
 * It is off by default and config-gated: nothing runs unless the operator hands
 * it a config file naming the endpoint. The onus of configuration is on the
 * operator — credentials come from the environment (`${VAR}` refs in headers),
 * never from the config file. And it is production-safe by construction: it
 * lists tools, probes the confirmation gate WITHOUT confirm (the executor
 * refuses before building any request, so no side effect ever reaches the real
 * API), and invokes only the reads the operator explicitly opts into. It NEVER
 * drives a real mutation to completion.
 */

/** Operator-supplied live target. Credentials stay in the environment. */
export const LiveConfig = z.object({
  /** The deployed MCP endpoint, e.g. https://payments-abc.a.run.app/mcp. */
  mcpUrl: z.string(),
  /**
   * Auth headers for the endpoint. Values may reference `${VAR}` and are
   * resolved from the environment at connect time, so no secret is written here.
   */
  headers: z.record(z.string(), z.string()).default({}),
  /**
   * Operation ids whose READ is safe to actually invoke against the real API.
   * Empty by default — a read can still cost money or leak, so it is opt-in.
   */
  probeReads: z.array(z.string()).default([]),
  /** Per-operation inputs for the opt-in reads (id → argument object). */
  inputs: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});
export type LiveConfig = z.infer<typeof LiveConfig>;

export const LiveCheck = z.object({
  /** Stable id: surface-live | gate-live | read-live. */
  id: z.string(),
  operationId: z.string().optional(),
  status: z.enum(["pass", "fail", "skipped"]),
  detail: z.string().optional(),
});
export type LiveCheck = z.infer<typeof LiveCheck>;

export const LiveReport = z.object({
  schemaVersion: z.literal(1),
  bundle: z.string(),
  /** The endpoint probed. Never carries headers — those hold credentials. */
  target: z.string(),
  startedAt: z.string(),
  checks: z.array(LiveCheck),
  summary: z.object({
    pass: z.number().int(),
    fail: z.number().int(),
    skipped: z.number().int(),
  }),
});
export type LiveReport = z.infer<typeof LiveReport>;

export interface LiveOptions {
  /** Wall-clock budget for each live call (default 30s). */
  callTimeoutMs?: number;
}

/** Load and validate a live-config JSON file. */
export function loadLiveConfig(path: string): LiveConfig {
  return LiveConfig.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Drive production-safe conformance checks against a real MCP endpoint. */
export async function runLiveConformance(
  bundleDir: string,
  config: LiveConfig,
  options: LiveOptions = {},
): Promise<LiveReport> {
  const dir = resolve(bundleDir);
  const air = loadAirDocument(JSON.parse(readFileSync(join(dir, "air.json"), "utf8")));
  const approved = air.operations.filter((op) => op.state === "approved");
  const startedAt = new Date().toISOString();
  const timeoutMs = options.callTimeoutMs ?? 30_000;
  const checks: LiveCheck[] = [];

  let source: McpSource | undefined;
  try {
    source = await connectSource({
      id: "live",
      system: "generic",
      // resolveTransport substitutes ${VAR} in headers from the environment, so
      // the config file never holds a credential.
      transport: { kind: "http", url: config.mcpUrl, headers: config.headers },
      hints: { scope: [] },
    });
  } catch (err) {
    return report(dir, config.mcpUrl, startedAt, [
      {
        id: "surface-live",
        status: "fail",
        detail: `could not connect to ${config.mcpUrl}: ${err}`,
      },
    ]);
  }

  const src = source;
  const withTimeout = <T>(p: Promise<T>, label: string): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, rej) =>
        setTimeout(() => rej(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);

  try {
    // 1. surface-live: the deployed server serves exactly the certified surface.
    checks.push(await checkSurfaceLive(src, approved, withTimeout));

    // 2. gate-live: every gated mutation refuses without confirm, in production.
    for (const op of approved.filter((o) => o.confirmation.required)) {
      checks.push(await checkGateLive(src, op, withTimeout));
    }

    // 3. read-live: only the reads the operator opted into.
    const byId = new Map(approved.map((o) => [o.id, o]));
    for (const id of config.probeReads) {
      const op = byId.get(id);
      if (!op) {
        checks.push({
          id: "read-live",
          operationId: id,
          status: "fail",
          detail: "not an approved operation",
        });
        continue;
      }
      if (op.effect.kind !== "read") {
        checks.push({
          id: "read-live",
          operationId: id,
          status: "skipped",
          detail: "probeReads only invokes read operations; a mutation is never auto-driven",
        });
        continue;
      }
      checks.push(await checkReadLive(src, op, config.inputs[id], withTimeout));
    }
  } finally {
    await src.close().catch(() => undefined);
  }

  return report(dir, config.mcpUrl, startedAt, checks);
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                      */
/* -------------------------------------------------------------------------- */

type Timeout = <T>(p: Promise<T>, label: string) => Promise<T>;

/** The deployed tool surface equals the approved operations, exactly. */
async function checkSurfaceLive(
  src: McpSource,
  approved: Operation[],
  withTimeout: Timeout,
): Promise<LiveCheck> {
  const id = "surface-live";
  try {
    const tools = await withTimeout(src.listTools(), "listTools");
    const served = new Set(tools.map((t) => t.name));
    const want = new Set(approved.map((op) => op.mcp.toolName));
    const missing = [...want].filter((n) => !served.has(n));
    const extra = [...served].filter((n) => !want.has(n));
    if (missing.length > 0 || extra.length > 0) {
      const parts: string[] = [];
      if (missing.length) parts.push(`missing ${missing.join(", ")}`);
      if (extra.length) parts.push(`serves unapproved ${extra.join(", ")}`);
      return { id, status: "fail", detail: parts.join("; ") };
    }
    return {
      id,
      status: "pass",
      detail: `${want.size} tool(s) served, matching the certified surface exactly`,
    };
  } catch (err) {
    return { id, status: "fail", detail: String(err) };
  }
}

/**
 * A gated mutation refuses without confirm — proven against the live server.
 * The executor refuses before building any request, so this never reaches the
 * real upstream: sending example input WITHOUT confirm has no side effect.
 */
async function checkGateLive(
  src: McpSource,
  op: Operation,
  withTimeout: Timeout,
): Promise<LiveCheck> {
  const id = "gate-live";
  try {
    const { confirm: _drop, ...args } = exampleInput(op);
    const res = await withTimeout(src.callRaw(op.mcp.toolName, args), `call ${op.mcp.toolName}`);
    if (!res.isError) {
      return {
        id,
        operationId: op.id,
        status: "fail",
        detail: "the live server executed a gated mutation without confirm",
      };
    }
    if (!/confirm/i.test(res.text)) {
      return {
        id,
        operationId: op.id,
        status: "fail",
        detail: `refusal was not a confirmation error: ${trim(res.text)}`,
      };
    }
    return {
      id,
      operationId: op.id,
      status: "pass",
      detail: "refused without confirm, in production",
    };
  } catch (err) {
    return { id, operationId: op.id, status: "fail", detail: String(err) };
  }
}

/** An opted-in read returns a structured result (success or structured error). */
async function checkReadLive(
  src: McpSource,
  op: Operation,
  input: Record<string, unknown> | undefined,
  withTimeout: Timeout,
): Promise<LiveCheck> {
  const id = "read-live";
  try {
    const args = input ?? exampleInput(op);
    const res = await withTimeout(src.callRaw(op.mcp.toolName, args), `call ${op.mcp.toolName}`);
    // A structured error (auth_required, not_found, …) is still a healthy,
    // well-formed response — the endpoint answered the contract, not a crash.
    if (res.isError && !isStructuredEnvelope(res.text)) {
      return {
        id,
        operationId: op.id,
        status: "fail",
        detail: `unstructured error: ${trim(res.text)}`,
      };
    }
    return {
      id,
      operationId: op.id,
      status: "pass",
      detail: res.isError
        ? "returned a structured error envelope"
        : "returned a structured success",
    };
  } catch (err) {
    return { id, operationId: op.id, status: "fail", detail: String(err) };
  }
}

function isStructuredEnvelope(text: string): boolean {
  try {
    const v = JSON.parse(text) as { error?: { code?: unknown } };
    return typeof v?.error?.code === "string";
  } catch {
    return false;
  }
}

function trim(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

function report(dir: string, target: string, startedAt: string, checks: LiveCheck[]): LiveReport {
  const count = (status: LiveCheck["status"]) => checks.filter((c) => c.status === status).length;
  return LiveReport.parse({
    schemaVersion: 1,
    bundle: dir,
    target,
    startedAt,
    checks,
    summary: { pass: count("pass"), fail: count("fail"), skipped: count("skipped") },
  });
}
