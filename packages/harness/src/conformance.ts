import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAirDocument, type Operation } from "@anvil/air";
import { z } from "zod";
import {
  argsFor,
  type BundleLink,
  type CaptureRecord,
  cliFlagsFor,
  diff,
  ensureBundleNodeModules,
  expectedWire,
  hermeticCredentialEnv,
  MockControl,
  parseJson,
  startMockServer,
  trim,
  type WireLoss,
  wireable,
  withTimeout,
} from "./bundle-driver.js";
import { connectSource, type McpSource } from "./mcp-source.js";

/**
 * Tri-surface conformance: the loopback self-test proves the *MCP* surface end
 * to end; this proves that all three generated surfaces — MCP server, CLI, and
 * skill — agree on what each operation means. It drives the SAME seeded input
 * through the MCP tool transport AND the generated CLI entrypoint against the
 * same mock upstream, and asserts they produce the same wire request and the
 * same safety behaviour; then it checks the skill package documents that exact
 * contract. Anvil's whole promise is "the agent stopped guessing" — this is the
 * test that the promise holds across every surface an agent might touch.
 */

export const SURFACES = ["mcp", "cli", "skill"] as const;
export type Surface = (typeof SURFACES)[number];

/** A divergence between two surfaces on one dimension. */
export const ConformanceDivergence = z.object({
  /** What diverged, e.g. "wire.body.amount", "tool-name", "confirm-required". */
  path: z.string(),
  /** The surfaces disagreeing, e.g. ["mcp", "cli"]. */
  between: z.array(z.enum(SURFACES)),
  left: z.unknown(),
  right: z.unknown(),
});
export type ConformanceDivergence = z.infer<typeof ConformanceDivergence>;

export const ConformanceCheck = z.object({
  /** Stable id: surface-agreement | skill-claim | wire-agreement | gate-agreement. */
  id: z.string(),
  operationId: z.string().optional(),
  /** The surfaces this check spans. */
  surfaces: z.array(z.enum(SURFACES)),
  status: z.enum(["pass", "fail", "skipped"]),
  divergences: z.array(ConformanceDivergence).optional(),
  detail: z.string().optional(),
});
export type ConformanceCheck = z.infer<typeof ConformanceCheck>;

export const ConformanceReport = z.object({
  schemaVersion: z.literal(1),
  bundle: z.string(),
  startedAt: z.string(),
  /** The surfaces actually exercised (cli is dropped when it cannot be driven). */
  surfaces: z.array(z.enum(SURFACES)),
  checks: z.array(ConformanceCheck),
  summary: z.object({
    pass: z.number().int(),
    fail: z.number().int(),
    skipped: z.number().int(),
  }),
});
export type ConformanceReport = z.infer<typeof ConformanceReport>;

export interface ConformanceOptions {
  /** Wall-clock budget for each surface invocation (default 30s). */
  callTimeoutMs?: number;
  /**
   * The resolved `@anvil/cli` package directory. The harness must not depend on
   * `@anvil/cli` (it would cycle), so the `anvil conformance` command passes its
   * own package directory here; the harness links it into the bundle so
   * `node cli/<svc>.mjs` resolves. Without it, the CLI surface is skipped and
   * only MCP↔skill agreement is proven.
   */
  cliPackageDir?: string;
}

/* -------------------------------------------------------------------------- */
/* Documented contract, extracted from the generated artifacts                 */
/* -------------------------------------------------------------------------- */

/** What the SKILL documents for one operation (parsed from operations.md). */
interface SkillOpDoc {
  id: string;
  cliCommand: string;
  toolName: string;
  confirmRequired: boolean;
  idempotencyKeyRequired: boolean;
  retrySafe: boolean;
}

/**
 * Parse the skill's operation catalog (reference/operations.md). Each operation
 * is a `### \`<cli>\`  (id: \`<id>\`, tool: \`<tool>\`)` header followed by a
 * `- Semantics: <flags>` line. Parsing the emitted markdown — not re-deriving
 * from AIR — is the point: it catches a skill doc that drifts from the contract.
 */
function parseSkillOps(md: string): SkillOpDoc[] {
  const docs: SkillOpDoc[] = [];
  const header = /^### `([^`]+)`\s+\(id: `([^`]+)`, tool: `([^`]+)`\)/;
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = header.exec(lines[i] as string);
    if (!m) continue;
    const [, cliCommand, id, toolName] = m as unknown as [string, string, string, string];
    const semantics = lines.slice(i + 1, i + 8).find((l) => l.startsWith("- Semantics:")) ?? "";
    docs.push({
      id,
      cliCommand,
      toolName,
      confirmRequired: semantics.includes("confirm-required"),
      idempotencyKeyRequired: semantics.includes("idempotency-key-required"),
      retrySafe: /(?:^|[,\s])retry-safe/.test(semantics) && !semantics.includes("not-retry-safe"),
    });
  }
  return docs;
}

/** What the runtime manifest declares — the executor's authoritative posture. */
interface ManifestOp {
  id: string;
  toolName: string;
  cli: string;
  confirmRequired: boolean;
  idempotencyKeyRequired: boolean;
  retrySafe: boolean;
}

function loadManifestOps(dir: string): ManifestOp[] {
  const raw = JSON.parse(readFileSync(join(dir, "runtime", "operations.manifest.json"), "utf8"));
  return (raw.operations as Array<Record<string, unknown>>).map((o) => ({
    id: String(o.id),
    toolName: String(o.toolName),
    cli: String(o.cli),
    confirmRequired: (o.confirmation as { required?: boolean })?.required === true,
    idempotencyKeyRequired: (o.idempotency as { mode?: string })?.mode === "required",
    retrySafe: (o.retries as { mode?: string })?.mode === "safe",
  }));
}

/** The CLI's own catalog (command + declared MCP tool), from `catalog.json`. */
function loadCatalogOps(dir: string): Array<{ id: string; command: string; toolName: string }> {
  const raw = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8"));
  return (raw.operations as Array<{ id: string; cli: string; mcpTool: string }>).map((o) => ({
    id: o.id,
    command: o.cli,
    toolName: o.mcpTool,
  }));
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                      */
/* -------------------------------------------------------------------------- */

/** Run the tri-surface conformance harness over a generated bundle directory. */
export async function runConformance(
  bundleDir: string,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const dir = resolve(bundleDir);
  const air = loadAirDocument(JSON.parse(readFileSync(join(dir, "air.json"), "utf8")));
  const approved = air.operations.filter((op) => op.state === "approved");
  const startedAt = new Date().toISOString();
  const timeoutMs = options.callTimeoutMs ?? 30_000;

  const cliEnabled = options.cliPackageDir !== undefined;
  const surfaces: Surface[] = cliEnabled ? ["mcp", "cli", "skill"] : ["mcp", "skill"];
  const checks: ConformanceCheck[] = [];

  if (approved.length === 0) {
    return finish(dir, startedAt, surfaces, [
      {
        id: "surface-agreement",
        surfaces,
        status: "fail",
        detail:
          "no approved operations — nothing to prove. Approve operations via an Anvil manifest and recompile.",
      },
    ]);
  }

  // --- Static: the three surfaces document the same operations & posture. -----
  checks.push(checkSurfaceAgreement(dir, approved, surfaces));
  checks.push(...checkSkillClaims(dir, approved));

  // --- Behavioural: drive both surfaces against one mock and compare. --------
  const extra: BundleLink[] = cliEnabled
    ? [{ name: "@anvil/cli", dir: options.cliPackageDir }]
    : [];
  ensureBundleNodeModules(dir, extra);

  const mock = await startMockServer(dir);
  let source: McpSource | undefined;
  try {
    const base = `http://127.0.0.1:${mock.port}`;
    const ctl = new MockControl(base);
    const credentialEnv = hermeticCredentialEnv(approved, base);
    source = await connectSource({
      id: "conformance",
      system: "generic",
      transport: {
        kind: "stdio",
        command: process.execPath,
        args: [join(dir, "mcp", "server.js")],
        env: {
          ANVIL_BASE_URL: base,
          ANVIL_ENV: "dev",
          ANVIL_ALLOWED_HOSTS: "127.0.0.1",
          ANVIL_AUTH_PROFILE: "default",
          ANVIL_LEDGER: "",
          ANVIL_MOCK_SCENARIO: "",
          ...credentialEnv,
        },
      },
      hints: { scope: [] },
    });
    const src = source;
    const mcpCall = (tool: string, args: Record<string, unknown>) =>
      withTimeout(src.callRaw(tool, args), timeoutMs, `mcp ${tool}`);
    const cli = (op: Operation, args: Record<string, unknown>, confirm: boolean) =>
      withTimeout(
        driveCli(dir, base, op, args, confirm, credentialEnv),
        timeoutMs,
        `cli ${op.cli.command}`,
      );

    for (const op of approved) {
      if (!wireable(op)) {
        checks.push(skip("wire-agreement", op, surfaces, "operation is not wire-executable"));
        continue;
      }
      checks.push(await checkWireAgreement(mcpCall, cli, ctl, op, cliEnabled));
      if (op.confirmation.required) {
        checks.push(await checkGateAgreement(mcpCall, cli, ctl, op, cliEnabled));
      }
    }
  } finally {
    await source?.close().catch(() => undefined);
    mock.child.kill("SIGKILL");
  }

  return finish(dir, startedAt, surfaces, checks);
}

function finish(
  dir: string,
  startedAt: string,
  surfaces: Surface[],
  checks: ConformanceCheck[],
): ConformanceReport {
  const count = (status: ConformanceCheck["status"]) =>
    checks.filter((c) => c.status === status).length;
  return ConformanceReport.parse({
    schemaVersion: 1,
    bundle: dir,
    startedAt,
    surfaces,
    checks,
    summary: { pass: count("pass"), fail: count("fail"), skipped: count("skipped") },
  });
}

/* -------------------------------------------------------------------------- */
/* Static checks                                                               */
/* -------------------------------------------------------------------------- */

const skip = (
  id: string,
  op: Operation | undefined,
  surfaces: Surface[],
  detail: string,
): ConformanceCheck => ({
  id,
  ...(op ? { operationId: op.id } : {}),
  surfaces,
  status: "skipped",
  detail,
});

/**
 * The three surfaces expose the same operation set with consistent public
 * handles: the skill documents each op's CLI command and MCP tool name, the CLI
 * catalog lists the command, and the runtime manifest binds them all. A public
 * name that differs by surface means an agent that read the skill would call a
 * tool the server does not serve.
 */
function checkSurfaceAgreement(
  dir: string,
  approved: Operation[],
  surfaces: Surface[],
): ConformanceCheck {
  const id = "surface-agreement";
  try {
    const skillDocs = parseSkillOps(
      readFileSync(join(dir, "skill", "reference", "operations.md"), "utf8"),
    );
    const catalog = loadCatalogOps(dir);
    const manifest = loadManifestOps(dir);
    const divergences: ConformanceDivergence[] = [];

    const approvedIds = new Set(approved.map((o) => o.id));
    const skillById = new Map(skillDocs.map((d) => [d.id, d]));
    const catalogById = new Map(catalog.map((c) => [c.id, c]));
    const manifestById = new Map(manifest.map((m) => [m.id, m]));

    for (const op of approved) {
      const skill = skillById.get(op.id);
      const cat = catalogById.get(op.id);
      const man = manifestById.get(op.id);
      if (!skill)
        divergences.push({
          path: "present",
          between: ["skill", "mcp"],
          left: "absent",
          right: op.id,
        });
      if (!cat)
        divergences.push({
          path: "present",
          between: ["cli", "mcp"],
          left: "absent",
          right: op.id,
        });
      if (!man) continue;
      if (skill && skill.toolName !== man.toolName) {
        divergences.push({
          path: "tool-name",
          between: ["skill", "mcp"],
          left: skill.toolName,
          right: man.toolName,
        });
      }
      if (skill && skill.cliCommand !== man.cli) {
        divergences.push({
          path: "cli-command",
          between: ["skill", "cli"],
          left: skill.cliCommand,
          right: man.cli,
        });
      }
      if (cat && cat.command !== man.cli) {
        divergences.push({
          path: "cli-command",
          between: ["cli", "mcp"],
          left: cat.command,
          right: man.cli,
        });
      }
      if (cat && cat.toolName !== man.toolName) {
        divergences.push({
          path: "tool-name",
          between: ["cli", "mcp"],
          left: cat.toolName,
          right: man.toolName,
        });
      }
    }
    // Anything documented by a surface that is not an approved operation is a leak.
    for (const d of skillDocs)
      if (!approvedIds.has(d.id)) {
        divergences.push({
          path: "leak",
          between: ["skill", "mcp"],
          left: d.id,
          right: "not-approved",
        });
      }
    for (const c of catalog)
      if (!approvedIds.has(c.id)) {
        divergences.push({
          path: "leak",
          between: ["cli", "mcp"],
          left: c.id,
          right: "not-approved",
        });
      }

    if (divergences.length > 0) {
      return {
        id,
        surfaces,
        status: "fail",
        divergences,
        detail: `${divergences.length} surface divergence(s)`,
      };
    }
    return {
      id,
      surfaces,
      status: "pass",
      detail: `${approved.length} operation(s) named identically across skill, CLI, and MCP`,
    };
  } catch (err) {
    return { id, surfaces, status: "fail", detail: String(err) };
  }
}

/**
 * The skill documents the exact safety posture the runtime enforces — confirm,
 * idempotency, retry. A skill that under-states a gate is worse than no skill:
 * it tells the agent a write is safe when the executor will refuse it.
 */
function checkSkillClaims(dir: string, approved: Operation[]): ConformanceCheck[] {
  let skillDocs: SkillOpDoc[];
  let manifest: ManifestOp[];
  try {
    skillDocs = parseSkillOps(
      readFileSync(join(dir, "skill", "reference", "operations.md"), "utf8"),
    );
    manifest = loadManifestOps(dir);
  } catch (err) {
    return [{ id: "skill-claim", surfaces: ["skill", "mcp"], status: "fail", detail: String(err) }];
  }
  const skillById = new Map(skillDocs.map((d) => [d.id, d]));
  const manById = new Map(manifest.map((m) => [m.id, m]));
  return approved.map((op) => {
    const s: Surface[] = ["skill", "mcp"];
    const skill = skillById.get(op.id);
    const man = manById.get(op.id);
    if (!skill || !man) {
      return {
        id: "skill-claim",
        operationId: op.id,
        surfaces: s,
        status: "fail",
        detail: "operation missing from skill or manifest",
      };
    }
    const divergences: ConformanceDivergence[] = [];
    const cmp = (path: string, left: boolean, right: boolean) => {
      if (left !== right) divergences.push({ path, between: s, left, right });
    };
    cmp("confirm-required", skill.confirmRequired, man.confirmRequired);
    cmp("idempotency-key-required", skill.idempotencyKeyRequired, man.idempotencyKeyRequired);
    cmp("retry-safe", skill.retrySafe, man.retrySafe);
    if (divergences.length > 0) {
      return {
        id: "skill-claim",
        operationId: op.id,
        surfaces: s,
        status: "fail",
        divergences,
        detail: "skill posture disagrees with the runtime contract",
      };
    }
    return {
      id: "skill-claim",
      operationId: op.id,
      surfaces: s,
      status: "pass",
      detail: "skill documents the enforced posture",
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Behavioural checks                                                          */
/* -------------------------------------------------------------------------- */

type McpCall = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<{ isError: boolean; text: string }>;
type CliRun = (
  op: Operation,
  args: Record<string, unknown>,
  confirm: boolean,
) => Promise<CliResult>;
export interface CliProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}
export interface CliResult extends CliProcessResult {
  /** A workspace build can briefly replace a linked package's dist directory. */
  attempts: number;
}

/**
 * The same input, driven through both surfaces, must reach the wire identically.
 * Each surface runs against a freshly-reset mock; we compare the two captures to
 * each other (the agreement claim) and to the AIR-derived oracle (so a failure
 * names which field, on which surface, diverged).
 */
async function checkWireAgreement(
  mcpCall: McpCall,
  cli: CliRun,
  ctl: MockControl,
  op: Operation,
  cliEnabled: boolean,
): Promise<ConformanceCheck> {
  const id = "wire-agreement";
  const s: Surface[] = cliEnabled ? ["mcp", "cli"] : ["mcp"];
  const confirm = op.confirmation.required;
  const args = argsFor(op, "conformance-wire");
  try {
    // MCP surface.
    await ctl.reset();
    const mcpArgs = confirm ? { ...args, confirm: true } : args;
    const mcpResult = await mcpCall(op.mcp.toolName, mcpArgs);
    const mcpWire = await ctl.capture();
    if (mcpResult.isError) return fail(id, op, s, `MCP surface errored: ${trim(mcpResult.text)}`);
    const mcpReq = single(mcpWire);
    if (!mcpReq)
      return fail(id, op, s, `MCP surface produced ${mcpWire.length} wire request(s), expected 1`);

    if (!cliEnabled) {
      return {
        id,
        operationId: op.id,
        surfaces: s,
        status: "skipped",
        detail: "CLI surface not linked; MCP-only run cannot prove agreement",
      };
    }

    // CLI surface.
    await ctl.reset();
    const cliResult = await cli(op, args, confirm);
    const cliWire = await ctl.capture();
    if (cliResult.exitCode !== 0) {
      return fail(id, op, s, `CLI surface failed: ${safeCliProcessContext(cliResult)}`);
    }
    const cliReq = single(cliWire);
    if (!cliReq)
      return fail(id, op, s, `CLI surface produced ${cliWire.length} wire request(s), expected 1`);

    // Compare the two surfaces to each other and to the contract oracle.
    const want = expectedWire(op, args);
    const divergences: ConformanceDivergence[] = [];
    compareReq(mcpReq, cliReq, want, divergences);
    if (divergences.length > 0) {
      return {
        id,
        operationId: op.id,
        surfaces: s,
        status: "fail",
        divergences,
        detail: `${divergences.length} wire divergence(s) between MCP and CLI`,
      };
    }
    return {
      id,
      operationId: op.id,
      surfaces: s,
      status: "pass",
      detail: `${mcpReq.method} ${mcpReq.path} — identical on both surfaces and matches the contract`,
    };
  } catch (err) {
    return fail(id, op, s, String(err));
  }
}

/**
 * A confirmation-gated mutation refuses without confirm and executes with it —
 * on every surface. If the CLI enforced the gate but the MCP tool did not (or
 * vice-versa), an agent could route around the gate by switching surfaces.
 */
async function checkGateAgreement(
  mcpCall: McpCall,
  cli: CliRun,
  ctl: MockControl,
  op: Operation,
  cliEnabled: boolean,
): Promise<ConformanceCheck> {
  const id = "gate-agreement";
  const s: Surface[] = cliEnabled ? ["mcp", "cli"] : ["mcp"];
  // `exampleInput` bakes in `confirm: true` for gated operations; strip it so
  // the refusal call genuinely omits confirmation (the CLI driver omits
  // `--confirm` independently, and `cliFlagsFor` skips the boolean field).
  const { confirm: _dropped, ...args } = argsFor(op, "conformance-gate");
  try {
    // MCP: refuse without confirm (zero wire), execute with confirm (one wire).
    await ctl.reset();
    const mcpRefused = await mcpCall(op.mcp.toolName, args);
    const mcpLeak = await ctl.capture();
    const mcpGated = mcpRefused.isError && /confirm/i.test(mcpRefused.text) && mcpLeak.length === 0;
    if (!mcpGated) {
      return fail(
        id,
        op,
        s,
        mcpLeak.length > 0
          ? "MCP surface hit the wire before confirmation"
          : `MCP surface did not refuse without confirm: ${trim(mcpRefused.text)}`,
      );
    }

    if (!cliEnabled) {
      return {
        id,
        operationId: op.id,
        surfaces: s,
        status: "skipped",
        detail: "CLI surface not linked; MCP-only run cannot prove agreement",
      };
    }

    // CLI: same gate.
    await ctl.reset();
    const cliRefused = await cli(op, args, false);
    const cliLeak = await ctl.capture();
    const cliErrorCode = parseCliErrorCode(cliRefused);
    const cliGated =
      cliRefused.exitCode !== 0 && cliErrorCode === "confirmation_required" && cliLeak.length === 0;
    if (!cliGated) {
      const divergences: ConformanceDivergence[] = [
        {
          path: "confirm-refusal",
          between: ["mcp", "cli"],
          left: "refused",
          right:
            cliLeak.length > 0
              ? "hit-wire"
              : (cliErrorCode ?? `unrecognized-refusal(exit=${cliRefused.exitCode ?? "null"})`),
        },
      ];
      return {
        id,
        operationId: op.id,
        surfaces: s,
        status: "fail",
        divergences,
        detail:
          "CLI surface did not enforce the confirmation gate the MCP surface enforced. " +
          safeCliProcessContext(cliRefused),
      };
    }
    return {
      id,
      operationId: op.id,
      surfaces: s,
      status: "pass",
      detail: "both surfaces refuse without confirm, before any side effect",
    };
  } catch (err) {
    return fail(id, op, s, String(err));
  }
}

/* -------------------------------------------------------------------------- */
/* Surface drivers + helpers                                                   */
/* -------------------------------------------------------------------------- */

/** Drive the generated CLI entrypoint as a child, exactly as an agent would. */
function driveCli(
  dir: string,
  base: string,
  op: Operation,
  args: Record<string, unknown>,
  confirm: boolean,
  credentialEnv: Record<string, string>,
): Promise<CliResult> {
  const serviceId = op.cli.command.split(" ")[0] as string;
  const rest = op.cli.command.split(" ").slice(1); // <resource> <action>
  const argv = [
    join(dir, "cli", `${serviceId}.mjs`),
    ...rest,
    ...cliFlagsFor(op, args),
    ...(confirm ? ["--confirm"] : []),
    "--base-url",
    base,
    "--json",
  ];
  return retryTransientCliLaunch(() => spawnCliProcess(argv, credentialEnv));
}

const CLI_CAPTURE_LIMIT = 32 * 1024;
const TRANSIENT_CLI_RETRY_DELAYS_MS = [50, 100, 200, 400] as const;
const SENSITIVE_CLI_KEY_SOURCE =
  "(?:ANVIL_[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ASSERTION_KEY)|authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]key|client[-_]secret|access[-_]token|refresh[-_]token|id[-_]token|password|token|secret|private[-_]key|assertion[-_]key|credential)";
const JSON_CLI_SECRET = new RegExp(
  String.raw`((?:["'])${SENSITIVE_CLI_KEY_SOURCE}(?:["'])\s*:\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)`,
  "gi",
);
const ASSIGNED_CLI_SECRET = new RegExp(
  String.raw`((?<![A-Za-z0-9_])${SENSITIVE_CLI_KEY_SOURCE}(?![A-Za-z0-9_])\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)`,
  "gi",
);

function spawnCliProcess(
  argv: string[],
  credentialEnv: Record<string, string>,
): Promise<CliProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, argv, {
      env: {
        ...process.env,
        ANVIL_ENV: "dev",
        ANVIL_ALLOWED_HOSTS: "127.0.0.1",
        ANVIL_AUTH_PROFILE: "default",
        ANVIL_LEDGER: "",
        ...credentialEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    child.stdout?.on("data", (c: Buffer) => {
      const captured = appendBounded(stdout, c.toString("utf8"), CLI_CAPTURE_LIMIT);
      stdout = captured.text;
      stdoutTruncated ||= captured.truncated;
    });
    child.stderr?.on("data", (c: Buffer) => {
      const captured = appendBounded(stderr, c.toString("utf8"), CLI_CAPTURE_LIMIT);
      stderr = captured.text;
      stderrTruncated ||= captured.truncated;
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) =>
      resolvePromise({
        exitCode,
        signal,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
      }),
    );
  });
}

/**
 * Retry only a pre-entrypoint workspace-link race: tsup cleans a linked Anvil
 * package's `dist` directory before atomically writing its replacement. A module
 * resolution failure at that exact path cannot have executed or hit the wire,
 * so retrying is side-effect safe. Every other CLI failure is returned once.
 *
 * Exported to make the concurrency regression deterministic without rebuilding
 * this live workspace from inside a unit test.
 */
export async function retryTransientCliLaunch(
  run: () => Promise<CliProcessResult>,
  wait: (ms: number) => Promise<void> = delay,
): Promise<CliResult> {
  let latest: CliProcessResult | undefined;
  for (let attempt = 1; attempt <= TRANSIENT_CLI_RETRY_DELAYS_MS.length + 1; attempt++) {
    latest = await run();
    if (
      !isTransientWorkspaceModuleFailure(latest) ||
      attempt > TRANSIENT_CLI_RETRY_DELAYS_MS.length
    ) {
      return { ...latest, attempts: attempt };
    }
    await wait(TRANSIENT_CLI_RETRY_DELAYS_MS[attempt - 1] as number);
  }
  throw new Error("unreachable transient CLI retry state");
}

/** Whether the CLI failed before entrypoint execution on a linked Anvil dist. */
export function isTransientWorkspaceModuleFailure(
  result: Pick<CliProcessResult, "exitCode" | "stdout" | "stderr">,
): boolean {
  // This is intentionally exact. The generated CLI statically imports
  // `@anvil/cli`, whose package export resolves to dist/index.js before the
  // entrypoint can execute. A missing dist from any other package may happen
  // after operation execution and is therefore not safe to replay.
  if (result.exitCode !== 1 || result.stdout.trim() !== "" || parseCliErrorCode(result)) {
    return false;
  }
  return (
    /Error \[ERR_MODULE_NOT_FOUND\]: Cannot find (?:module|package) ['"][^'"\r\n]*[\\/]node_modules[\\/]@anvil[\\/]cli[\\/]dist[\\/]index\.js['"]/.test(
      result.stderr,
    ) && /imported from [^\r\n]*[\\/]cli[\\/][^\\/\r\n]+\.mjs/.test(result.stderr)
  );
}

/**
 * Parse a structured CLI error from either stream. Diagnostics or Node warnings
 * can precede the JSON envelope, so inspect complete streams and individual
 * lines instead of choosing `stderr || stdout`.
 */
export function parseCliErrorCode(
  result: Pick<CliProcessResult, "stdout" | "stderr">,
): string | undefined {
  for (const stream of [result.stderr, result.stdout]) {
    const candidates = [stream, ...stream.split(/\r?\n/).reverse()];
    for (const candidate of candidates) {
      const decoded = parseJson(candidate) as { error?: { code?: unknown } } | undefined;
      if (typeof decoded?.error?.code === "string") return decoded.error.code;
    }
  }
  return undefined;
}

/** Bounded, redacted child context safe to persist in a conformance report. */
export function safeCliProcessContext(
  result: Pick<
    CliResult,
    "exitCode" | "signal" | "stdout" | "stderr" | "stdoutTruncated" | "stderrTruncated" | "attempts"
  >,
): string {
  const stdout = safeCliStream(result.stdout);
  const stderr = safeCliStream(result.stderr);
  const truncated = (value: string, wasTruncated: boolean) =>
    `${JSON.stringify(value || "<empty>")}${wasTruncated ? " [capture-truncated]" : ""}`;
  return (
    `exit=${result.exitCode ?? "null"} signal=${result.signal ?? "none"} attempts=${result.attempts}; ` +
    `stdout=${truncated(stdout, result.stdoutTruncated)}; ` +
    `stderr=${truncated(stderr, result.stderrTruncated)}`
  );
}

function safeCliStream(text: string): string {
  return trim(
    text
      .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [REDACTED]")
      .replace(JSON_CLI_SECRET, "$1[REDACTED]")
      .replace(ASSIGNED_CLI_SECRET, "$1[REDACTED]")
      .replace(/\banvil-hermetic-[A-Za-z0-9._-]+\b/g, "[REDACTED]"),
  );
}

function appendBounded(
  current: string,
  chunk: string,
  limit: number,
): { text: string; truncated: boolean } {
  const remaining = Math.max(0, limit - current.length);
  return {
    text: remaining > 0 ? current + chunk.slice(0, remaining) : current,
    truncated: chunk.length > remaining,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

const fail = (
  id: string,
  op: Operation,
  surfaces: Surface[],
  detail: string,
): ConformanceCheck => ({ id, operationId: op.id, surfaces, status: "fail", detail });

function single(reqs: CaptureRecord[]): CaptureRecord | undefined {
  return reqs.length === 1 ? reqs[0] : undefined;
}

/** Compare two captured requests to each other and to the contract oracle. */
function compareReq(
  mcp: CaptureRecord,
  cli: CaptureRecord,
  want: { path: string; query: Record<string, string>; body: unknown },
  divergences: ConformanceDivergence[],
): void {
  const push = (path: string, left: unknown, right: unknown) =>
    divergences.push({ path, between: ["mcp", "cli"], left, right });
  if (mcp.method !== cli.method) push("wire.method", mcp.method, cli.method);
  if (mcp.path !== cli.path) push("wire.path", mcp.path, cli.path);
  else if (mcp.path !== want.path) push("wire.path", mcp.path, `expected ${want.path}`);
  // Query: compare the two surfaces key-by-key.
  for (const key of new Set([...Object.keys(mcp.query), ...Object.keys(cli.query)])) {
    if (mcp.query[key] !== cli.query[key])
      push(`wire.query.${key}`, mcp.query[key], cli.query[key]);
  }
  // Body: a structural diff between the two surfaces' bodies.
  const bodyLosses: WireLoss[] = [];
  diff(mcp.body, cli.body, "wire.body", bodyLosses);
  for (const l of bodyLosses) push(l.path, l.sent, l.received);
}
