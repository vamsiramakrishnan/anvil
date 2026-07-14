import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAirDocument, type Operation, operationInputSchema } from "@anvil/air";
import type { MockScenario } from "@anvil/generators";
import { z } from "zod";
import {
  argsFor,
  type CaptureRecord,
  diff,
  ensureBundleNodeModules,
  expectedWire,
  MockControl,
  parseJson,
  startMockServer,
  trim,
  wireable,
  withTimeout,
} from "./bundle-driver.js";
import { connectSource, type McpSource } from "./mcp-source.js";

/**
 * Loopback self-test: for spec sources with no reference server to compare
 * against, the generated bundle proves *itself*. The runner boots the bundle's
 * own generated mock upstream and its generated MCP server pointed at that mock
 * (`ANVIL_BASE_URL`), then drives every approved tool over the real MCP
 * transport and verifies NO LOSSES — every argument reaches the wire
 * faithfully, safety gates fire before any side effect, upstream errors surface
 * as structured envelopes, and non-idempotent mutations are never auto-retried.
 */

export const LoopbackLoss = z.object({
  /** JSON path of the divergence, e.g. "body.amount" or "query.limit". */
  path: z.string(),
  sent: z.unknown(),
  received: z.unknown(),
});
export type LoopbackLoss = z.infer<typeof LoopbackLoss>;

export const LoopbackCheck = z.object({
  /** Stable check id: surface | fidelity | confirmation-gate | error-mapping | retry-read | retry-mutation-guard. */
  id: z.string(),
  operationId: z.string().optional(),
  status: z.enum(["pass", "fail", "skipped"]),
  losses: z.array(LoopbackLoss).optional(),
  detail: z.string().optional(),
});
export type LoopbackCheck = z.infer<typeof LoopbackCheck>;

export const LoopbackReport = z.object({
  schemaVersion: z.literal(1),
  bundle: z.string(),
  startedAt: z.string(),
  checks: z.array(LoopbackCheck),
  summary: z.object({
    pass: z.number().int(),
    fail: z.number().int(),
    skipped: z.number().int(),
  }),
});
export type LoopbackReport = z.infer<typeof LoopbackReport>;

export interface LoopbackOptions {
  /** Wall-clock budget for each tool call (default 20s). */
  callTimeoutMs?: number;
  /** Extra environment for the spawned MCP server (e.g. real auth material). */
  env?: Record<string, string>;
}

/** Run the loopback self-test over a generated bundle directory. */
export async function runLoopback(
  bundleDir: string,
  options: LoopbackOptions = {},
): Promise<LoopbackReport> {
  const dir = resolve(bundleDir);
  const air = loadAirDocument(JSON.parse(readFileSync(join(dir, "air.json"), "utf8")));
  const scenarios = JSON.parse(
    readFileSync(join(dir, "mock", "scenarios.json"), "utf8"),
  ) as MockScenario[];
  const approved = air.operations.filter((op) => op.state === "approved");
  ensureBundleNodeModules(dir);

  const startedAt = new Date().toISOString();
  // An empty approved surface has nothing to prove — and the generated MCP
  // server would answer tools/list with a raw protocol error (-32601, no tools
  // registered). Fail plainly instead of leaking that.
  if (approved.length === 0) {
    return LoopbackReport.parse({
      schemaVersion: 1,
      bundle: dir,
      startedAt,
      checks: [{ id: "surface", status: "fail", detail: EMPTY_SURFACE_DETAIL }],
      summary: { pass: 0, fail: 1, skipped: 0 },
    });
  }
  const timeoutMs = options.callTimeoutMs ?? 20_000;
  const checks: LoopbackCheck[] = [];
  const mock = await startMockServer(dir);
  let source: McpSource | undefined;
  try {
    const base = `http://127.0.0.1:${mock.port}`;
    source = await connectSource({
      id: "loopback",
      system: "generic",
      transport: {
        kind: "stdio",
        command: process.execPath,
        args: [join(dir, "mcp", "server.js")],
        // Hermetic child env: point the generated server at the mock, force dev
        // semantics, and neutralize any ambient ANVIL_* that would change the
        // safety posture under test. Dummy default-profile credentials let
        // authenticated operations execute; the mock redacts auth headers, so
        // the dummy value is never recorded anywhere.
        env: {
          ANVIL_BASE_URL: base,
          ANVIL_ENV: "dev",
          ANVIL_ALLOWED_HOSTS: "127.0.0.1",
          ANVIL_AUTH_PROFILE: "default",
          ANVIL_LEDGER: "",
          ANVIL_MOCK_SCENARIO: "",
          ANVIL_DEFAULT_TOKEN: "loopback-selftest",
          ANVIL_DEFAULT_API_KEY: "loopback-selftest",
          ANVIL_DEFAULT_USERNAME: "loopback",
          ANVIL_DEFAULT_PASSWORD: "loopback-selftest",
          ...options.env,
        },
      },
      hints: { scope: [] },
    });
    const src = source;
    const ctl = new MockControl(base);
    const call = (tool: string, args: Record<string, unknown>) =>
      withTimeout(src.callRaw(tool, args), timeoutMs, `call ${tool}`);

    checks.push(await checkSurface(src, approved));
    for (const op of approved) checks.push(await checkFidelity(call, ctl, op, scenarios));
    for (const op of approved.filter((o) => o.confirmation.required)) {
      checks.push(await checkConfirmationGate(call, ctl, op));
    }
    checks.push(await checkErrorMapping(call, ctl, approved, scenarios));
    checks.push(await checkRetryOnRead(call, ctl, approved));
    checks.push(await checkRetryMutationGuard(call, ctl, approved));
  } finally {
    await source?.close().catch(() => undefined);
    mock.child.kill("SIGKILL");
  }

  const count = (status: LoopbackCheck["status"]) =>
    checks.filter((c) => c.status === status).length;
  return LoopbackReport.parse({
    schemaVersion: 1,
    bundle: dir,
    startedAt,
    checks,
    summary: { pass: count("pass"), fail: count("fail"), skipped: count("skipped") },
  });
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                      */
/* -------------------------------------------------------------------------- */

type ToolCall = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<{ isError: boolean; text: string }>;

const failCheck = (id: string, operationId: string | undefined, detail: string): LoopbackCheck =>
  operationId === undefined
    ? { id, status: "fail", detail }
    : { id, operationId, status: "fail", detail };

const EMPTY_SURFACE_DETAIL =
  "no approved operations — nothing to self-test. Approve operations via an Anvil manifest " +
  "(operations.<name>.state: approved) and recompile the bundle.";

/** A — the served tool surface equals the approved operations, exactly. */
async function checkSurface(source: McpSource, approved: Operation[]): Promise<LoopbackCheck> {
  const id = "surface";
  try {
    const tools = await source.listTools();
    const got = new Map(tools.map((t) => [t.name, t]));
    const want = new Set(approved.map((op) => op.mcp.toolName));
    const problems: string[] = [];
    for (const op of approved) {
      const tool = got.get(op.mcp.toolName);
      if (!tool) {
        problems.push(`missing tool ${op.mcp.toolName} (${op.id})`);
        continue;
      }
      const schema = op.input.schema ?? operationInputSchema(op);
      const wantRequired = (schema.required as string[] | undefined) ?? [];
      const gotRequired = new Set((tool.inputSchema?.required as string[] | undefined) ?? []);
      for (const key of wantRequired) {
        if (!gotRequired.has(key)) {
          problems.push(`${op.mcp.toolName}: input schema does not require "${key}"`);
        }
      }
    }
    for (const name of got.keys()) {
      if (!want.has(name)) problems.push(`exposes tool ${name} with no approved operation`);
    }
    if (problems.length > 0) return failCheck(id, undefined, problems.join("; "));
    return {
      id,
      status: "pass",
      detail: `${approved.length} tool(s), surface and required inputs match the approved operations exactly`,
    };
  } catch (err) {
    // An MCP server with zero registered tools answers tools/list with a raw
    // -32601 Method not found; surface that as the empty-surface failure, not
    // a protocol error.
    if (/-32601|Method not found/i.test(String(err))) {
      return failCheck(id, undefined, EMPTY_SURFACE_DETAIL);
    }
    return failCheck(id, undefined, String(err));
  }
}

/** B — every argument reaches the wire faithfully and the response round-trips. */
async function checkFidelity(
  call: ToolCall,
  ctl: MockControl,
  op: Operation,
  scenarios: MockScenario[],
): Promise<LoopbackCheck> {
  const id = "fidelity";
  try {
    await ctl.reset();
    const args = argsFor(op, "fidelity");
    const result = await call(op.mcp.toolName, args);
    const requests = await ctl.capture();
    if (result.isError) {
      return failCheck(
        id,
        op.id,
        `tool call errored with ${requests.length} wire request(s) captured: ${trim(result.text)}`,
      );
    }
    if (requests.length !== 1) {
      return failCheck(
        id,
        op.id,
        `${requests.length} wire request(s) captured, expected exactly 1`,
      );
    }
    const req = requests[0] as CaptureRecord;
    if (req.matchedOpId !== op.id && !req.matchedCandidates.includes(op.id)) {
      return failCheck(
        id,
        op.id,
        `wire request routed to ${req.matchedOpId ?? "no operation"} (candidates: ${req.matchedCandidates.join(", ") || "none"})`,
      );
    }

    const losses: LoopbackLoss[] = [];
    const want = expectedWire(op, args);
    if (req.path !== want.path)
      losses.push({ path: "url.path", sent: want.path, received: req.path });
    for (const [k, v] of Object.entries(want.query)) {
      if (req.query[k] !== v) losses.push({ path: `query.${k}`, sent: v, received: req.query[k] });
    }
    for (const [k, v] of Object.entries(want.headers)) {
      if (req.headers[k] !== v)
        losses.push({ path: `header.${k}`, sent: v, received: req.headers[k] });
    }
    if (want.body !== undefined) diff(want.body, req.body, "body", losses);
    if (!req.validation.ok) {
      return {
        id,
        operationId: op.id,
        status: "fail",
        losses,
        detail: `mock rejected the wire request: missing [${req.validation.missing.join(", ")}] invalid [${req.validation.invalid.join(", ")}]`,
      };
    }
    // Round-trip: the tool result must carry back the payload of the scenario
    // the mock ACTUALLY served (its name rides the capture record) — an op can
    // have several success scenarios, and guessing one would diff the tool
    // against a body the wire never carried. A null/absent scenario body has
    // nothing to verify; skipping beats a phantom null-vs-{} loss.
    const served = scenarios.find(
      (s) => s.operationId === op.id && s.name === req.response?.scenario,
    );
    if (served && served.body !== null && served.body !== undefined) {
      let parsed: unknown;
      try {
        parsed = result.text.length > 0 ? JSON.parse(result.text) : null;
      } catch {
        parsed = result.text;
      }
      diff(served.body, parsed, "response", losses);
    }
    if (losses.length > 0) {
      return {
        id,
        operationId: op.id,
        status: "fail",
        losses,
        detail: `${losses.length} loss(es) between the tool call and the wire`,
      };
    }
    return {
      id,
      operationId: op.id,
      status: "pass",
      detail: "all arguments reached the wire and the response round-tripped",
    };
  } catch (err) {
    return failCheck(id, op.id, String(err));
  }
}

/** C — the confirmation gate refuses before any side effect, then executes. */
async function checkConfirmationGate(
  call: ToolCall,
  ctl: MockControl,
  op: Operation,
): Promise<LoopbackCheck> {
  const id = "confirmation-gate";
  try {
    await ctl.reset();
    const { confirm: _omitted, ...unconfirmed } = argsFor(op, "confirm-refusal");
    const refused = await call(op.mcp.toolName, unconfirmed);
    const leaked = await ctl.capture();
    if (!refused.isError) {
      return failCheck(
        id,
        op.id,
        "call without confirm succeeded — the confirmation gate did not fire",
      );
    }
    if (leaked.length !== 0) {
      return failCheck(
        id,
        op.id,
        `confirmation refusal leaked ${leaked.length} wire request(s) — the gate fired after a side effect`,
      );
    }
    // The refusal may come from the tool's input schema (confirm is a required
    // const:true) or from the executor's confirmation_required envelope; both
    // enforce the same AIR contract and must name confirmation.
    if (!/confirm/i.test(refused.text)) {
      return failCheck(
        id,
        op.id,
        `refusal is not a structured confirmation error: ${trim(refused.text)}`,
      );
    }
    const confirmed = await call(op.mcp.toolName, argsFor(op, "confirm-accepted"));
    const after = await ctl.capture();
    if (confirmed.isError) {
      return failCheck(id, op.id, `confirmed call still errored: ${trim(confirmed.text)}`);
    }
    if (after.length !== 1) {
      return failCheck(
        id,
        op.id,
        `${after.length} wire request(s) after the confirmed call, expected exactly 1`,
      );
    }
    return {
      id,
      operationId: op.id,
      status: "pass",
      detail: "refused without confirm (zero wire requests), executed exactly once with it",
    };
  } catch (err) {
    return failCheck(id, op.id, String(err));
  }
}

/** D — a documented upstream error surfaces as a structured envelope. */
async function checkErrorMapping(
  call: ToolCall,
  ctl: MockControl,
  approved: Operation[],
  scenarios: MockScenario[],
): Promise<LoopbackCheck> {
  const id = "error-mapping";
  const byId = new Map(approved.map((op) => [op.id, op]));
  const candidates = scenarios.flatMap((s) => {
    const op = byId.get(s.operationId);
    return op && s.status >= 400 && wireable(op) ? [{ scenario: s, op }] : [];
  });
  // Prefer a read whose error status the runtime will not retry, so the check
  // observes the mapping (one attempt), not the retry engine.
  const retried = (c: (typeof candidates)[number]) =>
    (c.op.retries.retryOn as string[]).includes(`http_${c.scenario.status}`);
  const pick =
    candidates.find((c) => c.op.effect.kind === "read" && !retried(c)) ??
    candidates.find((c) => !retried(c)) ??
    candidates[0];
  if (!pick) {
    return {
      id,
      status: "skipped",
      detail: "no wire-executable operation documents a >=400 error scenario",
    };
  }
  const { op, scenario } = pick;
  try {
    await ctl.reset();
    await ctl.scenario(scenario.name);
    const result = await call(op.mcp.toolName, argsFor(op, "error-mapping"));
    await ctl.scenario(null);
    if (!result.isError) {
      return failCheck(
        id,
        op.id,
        `upstream ${scenario.status} came back as a success — the error was swallowed`,
      );
    }
    const envelope = parseJson(result.text) as
      | { error?: { code?: string; upstream?: { status?: number } } }
      | undefined;
    if (!envelope?.error?.code) {
      return failCheck(id, op.id, `error is not a structured envelope: ${trim(result.text)}`);
    }
    if (envelope.error.upstream?.status !== scenario.status) {
      return failCheck(
        id,
        op.id,
        `envelope carries upstream status ${envelope.error.upstream?.status ?? "none"}, expected ${scenario.status} (code ${envelope.error.code})`,
      );
    }
    return {
      id,
      operationId: op.id,
      status: "pass",
      detail: `scenario ${scenario.name} surfaced as structured ${envelope.error.code} with upstream status ${scenario.status}`,
    };
  } catch (err) {
    return failCheck(id, op.id, String(err));
  }
}

/** E(i) — a transient 503 on a read is handled sanely (retry allowed, not required). */
async function checkRetryOnRead(
  call: ToolCall,
  ctl: MockControl,
  approved: Operation[],
): Promise<LoopbackCheck> {
  const id = "retry-read";
  const reads = approved.filter((op) => op.effect.kind === "read");
  const op = reads.find(wireable);
  if (!op) {
    return {
      id,
      status: "skipped",
      detail:
        reads.length > 0
          ? "reads exist but none is wire-executable (see their fidelity failures)"
          : "no approved read operations",
    };
  }
  try {
    await ctl.reset();
    await ctl.fault(op.id, 503, 1);
    const result = await call(op.mcp.toolName, argsFor(op, "retry-read"));
    const requests = await ctl.capture();
    if (requests.length === 0) return failCheck(id, op.id, "the read never reached the wire");
    if (result.isError && parseJson(result.text) === undefined) {
      return failCheck(id, op.id, `final outcome is not structured: ${trim(result.text)}`);
    }
    return {
      id,
      operationId: op.id,
      status: "pass",
      detail: `injected one 503; observed ${requests.length} attempt(s); final outcome ${result.isError ? "structured error" : "success"}`,
    };
  } catch (err) {
    return failCheck(id, op.id, String(err));
  }
}

/** E(ii) — a non-idempotent mutation is NEVER auto-retried (the hard rule). */
async function checkRetryMutationGuard(
  call: ToolCall,
  ctl: MockControl,
  approved: Operation[],
): Promise<LoopbackCheck> {
  const id = "retry-mutation-guard";
  const op = approved.find(
    (o) => o.effect.kind === "mutation" && o.idempotency.mode === "none" && wireable(o),
  );
  if (!op) {
    return {
      id,
      status: "skipped",
      detail: "no wire-executable non-idempotent mutation in the approved surface",
    };
  }
  try {
    await ctl.reset();
    // times:1 — if the runtime wrongly retries, the second attempt would reach
    // the mock and succeed, so the capture count exposes the violation either way.
    await ctl.fault(op.id, 503, 1);
    const result = await call(op.mcp.toolName, argsFor(op, "retry-guard"));
    const requests = await ctl.capture();
    if (requests.length !== 1) {
      // 0 means the call never reached the wire at all (a different failure
      // from the one this check guards); >1 means it was auto-retried.
      return failCheck(
        id,
        op.id,
        requests.length === 0
          ? "0 wire requests after one injected 503 — the mutation never reached the wire (see its fidelity check)"
          : `${requests.length} wire request(s) after one injected 503 — a non-idempotent mutation was auto-retried`,
      );
    }
    if (!result.isError) {
      return failCheck(id, op.id, "the failed mutation reported success");
    }
    const envelope = parseJson(result.text) as
      | { error?: { upstream?: { status?: number } } }
      | undefined;
    if (envelope?.error?.upstream?.status !== 503) {
      return failCheck(
        id,
        op.id,
        `expected a structured envelope with upstream status 503: ${trim(result.text)}`,
      );
    }
    return {
      id,
      operationId: op.id,
      status: "pass",
      detail: "exactly one attempt on 503; structured error, no auto-retry",
    };
  } catch (err) {
    return failCheck(id, op.id, String(err));
  }
}
