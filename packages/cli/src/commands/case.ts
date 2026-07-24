import { join } from "node:path";
import {
  type AddEvidenceInput,
  BATTERY_SCENARIOS,
  buildRefinementPlan,
  caseService,
  createAgentDriver,
  EFFECTIVENESS_CASES,
  type EffectivenessMetrics,
  type EffectivenessRow,
  effectivenessMetrics,
  runBattery,
  runEffectivenessCase,
  skillFor,
  targetKey,
} from "@anvil/refinement";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { loadAir } from "./shared.js";

/**
 * `anvil case <subcommand>` — the investigation framework. `open`/`list` operate on
 * an AIR model; the in-case helpers (`inspect`, `add-evidence`, …) operate
 * on a materialized case directory. Only `open`/`add-evidence`/`validate-proposal`/
 * `finalize`/`investigate` write, and only ever inside the case directory — never AIR.
 */
export function registerCase(parent: Command, ctx: CommandContext): void {
  const caseCmd = annotate(
    parent
      .command("case")
      .summary("Run a bounded investigation for one deficiency as an isolated case.")
      .description(
        "The investigation framework. `anvil case list <dir>` shows the deficiencies a case can be opened for; `anvil case open <dir> <target-key>` materializes an isolated case workspace (CASE.md + task/target/evidence-policy/allowed-tools/expected-output.schema + workspace/ + output/) that gives a coding agent a *case, not a prompt*. " +
          "Inside a case, the agent works only with rails that enforce Anvil semantics — repository search and language tooling are the agent's own job, not Anvil's: `inspect`, `add-evidence` (enforces the source AND predicate policy), `validate-claims` (strength + contradictions + predicate policy), `synthesize` (composes the proposal from gathered claims), `validate-proposal` (deterministic validation), and `finalize` (records an honest status — proposal_generated / conflicted / insufficient_evidence / …). " +
          "`anvil case investigate <case>` drives the live coding agent; `anvil case close <case> <air>` re-enters Anvil's rails — validating and reconciling the proposal into a refinement, bound to the case identity. " +
          "The agent owns investigation and synthesis; Anvil owns admissibility, safety, validation, and application. AIR is never edited by a case.",
      ),
    { mutates: true },
  );

  caseCmd
    .command("list")
    .summary("List the deficiencies a case can be opened for (those with a skill).")
    .argument("<path>", "generated bundle directory or air.yaml")
    .option("--json", "emit the rows as JSON")
    .action((path: string, opts: { json?: boolean }) => {
      ctx.code = runCaseList(path, opts, ctx.io);
    });

  caseCmd
    .command("open")
    .summary("Materialize a fresh, immutable case run for one target.")
    .argument("<path>", "generated bundle directory or air.yaml")
    .argument("<target-key>", "a target from `anvil case list`")
    .option("--out <dir>", "case root directory", ".refinement")
    .option("--inspect <fields>", "comma-separated AIR fields to pre-inspect")
    .option("--repo-root <dir>", "repository root recorded for filesystem evidence")
    .option("--executor <executor>", "executor identity recorded in the case", "cli")
    .action((path: string, key: string, opts: CaseOpenOptions) => {
      ctx.code = runCaseOpen(path, key, opts, ctx.io);
    });

  caseCmd
    .command("battery")
    .summary("Run the investigator benchmark battery.")
    .description(
      "Run either the deterministic baseline-vs-investigation battery (default, scripted, fast) or, when explicitly enabled, the real-agent investigator effectiveness battery. The default mode is deterministic and does not invoke an external agent.",
    )
    .option("--real", "invoke a real coding agent for the effectiveness battery")
    .option("--json", "emit JSON report")
    .option("--command <command>", "agent CLI to drive (default: claude)")
    .option("--model <model>", "model passed through to the agent CLI")
    .option("--check", "fail on scripted battery expectation mismatches")
    .option("--allow-degraded-native", "proceed even when native execution cannot enforce split")
    .action(async (opts: CaseBatteryOptions) => {
      ctx.code = await runCaseBattery(opts, ctx.io);
    });

  caseCmd
    .command("inspect")
    .alias("inspect-target")
    .summary("Print the case's target inspection.")
    .argument("<case-dir>", "a materialized case run directory")
    .action((dir: string) => {
      ctx.code = emit(ctx.io, () => caseService.inspect(dir));
    });

  caseCmd
    .command("add-evidence")
    .summary("Record one evidence claim (the source and predicate policy gate it).")
    .argument("<case-dir>", "a materialized case run directory")
    .requiredOption("--predicate <predicate>", "the semantic predicate the claim is about")
    .requiredOption("--source <kind>", "the evidence source kind")
    .option("--value <value>", "the claimed value (JSON when it parses, else a string)")
    .option("--path <file>", "file the evidence points at (verified against --lines)")
    .option("--lines <range>", "line coordinate for --path, as `a-b` or `a`")
    .option("--uri <uri>", "external coordinate for non-filesystem evidence")
    .option("--ref <ref>", "revision/reference the coordinate was read at")
    .option("--note <note>", "free-form annotation")
    .option("--confidence <n>", "claim confidence in [0,1]")
    .action(async (dir: string, opts: CaseAddEvidenceOptions) => {
      ctx.code = await runCaseAddEvidence(dir, opts, ctx.io);
    });

  caseCmd
    .command("validate-claims")
    .summary("Judge the gathered claims: strength, contradictions, predicate policy.")
    .argument("<case-dir>", "a materialized case run directory")
    .action((dir: string) => {
      ctx.code = emit(ctx.io, () => caseService.validateClaims(dir));
    });

  caseCmd
    .command("synthesize")
    .summary("Compose the proposal from gathered claims (field=value pairs).")
    .argument("<case-dir>", "a materialized case run directory")
    .argument("[pairs...]", "field=value pairs (values parse as JSON when they can)")
    .action((dir: string, pairs: string[]) => {
      ctx.code = emit(ctx.io, () => caseService.synthesize(dir, parseSetPairs(pairs) as never));
    });

  caseCmd
    .command("validate-proposal")
    .summary("Deterministically validate the case's proposal against AIR.")
    .argument("<case-dir>", "a materialized case run directory")
    .argument("<path>", "generated bundle directory or air.yaml")
    .action((dir: string, path: string) => {
      ctx.code = emit(ctx.io, () => caseService.validateProposal(loadAir(path), dir));
    });

  caseCmd
    .command("investigate")
    .summary("Drive a live coding agent against the case.")
    .argument("<case-dir>", "a materialized case run directory")
    .option("--command <command>", "agent CLI to drive (default: claude; codex is protocol-aware)")
    .option("--model <model>", "model passed through to the agent CLI")
    .option("--allow-degraded-native", "proceed even when native tooling is degraded")
    .action(async (dir: string, opts: CaseInvestigateOptions) => {
      ctx.code = await runCaseInvestigate(dir, opts, ctx.io);
    });

  caseCmd
    .command("finalize")
    .summary("Record an honest terminal status for the run.")
    .argument("<case-dir>", "a materialized case run directory")
    .option("--status <status>", "terminal status to record")
    .option("--summary <summary>", "one-line summary recorded with the status")
    .option(
      "--blocked-sources <json>",
      'JSON list of blocked sources, e.g. \'[{"source":"..","reason":".."}]\'',
    )
    .action((dir: string, opts: CaseFinalizeOptions) => {
      ctx.code = emit(ctx.io, () =>
        caseService.finalize(dir, {
          status: opts.status as never,
          summary: opts.summary,
          blockedSources:
            opts.blockedSources !== undefined
              ? (JSON.parse(opts.blockedSources) as never)
              : undefined,
        }),
      );
    });

  caseCmd
    .command("delete")
    .summary("Discard one case run directory.")
    .argument("<case-dir>", "a materialized case run directory")
    .action((dir: string) => {
      ctx.code = emit(ctx.io, () => {
        caseService.delete(dir);
        return `Deleted run ${dir}.`;
      });
    });

  caseCmd
    .command("close")
    .summary("Re-enter Anvil's rails: reconcile the proposal into a refinement.")
    .argument("<case-dir>", "a materialized case run directory")
    .argument("<path>", "generated bundle directory or air.yaml")
    .option("--json", "emit the refinement as JSON")
    .action((dir: string, path: string, opts: { json?: boolean }) => {
      ctx.code = runCaseClose(dir, path, opts, ctx.io);
    });
}

interface CaseOpenOptions {
  out?: string;
  inspect?: string;
  repoRoot?: string;
  executor?: string;
}

interface CaseBatteryOptions {
  real?: boolean;
  json?: boolean;
  command?: string;
  model?: string;
  check?: boolean;
  allowDegradedNative?: boolean;
}

interface CaseAddEvidenceOptions {
  predicate: string;
  source: string;
  value?: string;
  path?: string;
  lines?: string;
  uri?: string;
  ref?: string;
  note?: string;
  confidence?: string;
}

interface CaseInvestigateOptions {
  command?: string;
  model?: string;
  allowDegradedNative?: boolean;
}

interface CaseFinalizeOptions {
  status?: string;
  summary?: string;
  blockedSources?: string;
}

/** Run a case helper that returns text, printing it (or the error) with a stable exit code. */
function emit(io: CliIO, fn: () => string): number {
  io.out(fn());
  return 0;
}

/** `anvil case list` — the deficiencies a case can be opened for (those with a skill). */
function runCaseList(path: string, opts: { json?: boolean }, io: CliIO): number {
  const air = loadAir(path);
  const plan = buildRefinementPlan(air);
  const rows = plan.deficiencies
    .filter((d) => skillFor(d.code))
    .map((d) => ({
      key: targetKey(d.target),
      skill: skillFor(d.code)?.name,
      code: d.code,
      severity: d.severity,
    }));
  if (opts.json === true) {
    io.out(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    io.out("No deficiencies with an implemented skill. Nothing to investigate.");
    return 0;
  }
  io.out(`Cases available for ${plan.service.id} @ ${plan.service.version}:`);
  for (const r of rows) {
    io.out(
      `  ${(r.key as string).padEnd(44)} ${(r.skill ?? "").padEnd(20)} ${r.code} (${r.severity})`,
    );
  }
  io.out("\nOpen one with `anvil case open <dir|air.yaml> <target-key>`.");
  return 0;
}

/** `anvil case open` — materialize a case for a specific target. */
function runCaseOpen(path: string, key: string, opts: CaseOpenOptions, io: CliIO): number {
  const air = loadAir(path);
  const plan = buildRefinementPlan(air);
  const deficiency = plan.deficiencies.find((d) => targetKey(d.target) === key && skillFor(d.code));
  if (!deficiency) {
    io.err(`No investigable deficiency at target '${key}'. Run \`anvil case list ${path}\`.`);
    return 1;
  }
  const inspect = opts.inspect?.split(",").map((s) => s.trim());
  // `open` always creates a fresh, immutable run. To reopen an existing run, pass its
  // directory to the in-case helpers; to discard one, `anvil case delete <dir>`.
  const c = caseService.open(air, deficiency, {
    root: opts.out ?? ".refinement",
    inspect,
    repositoryRoot: opts.repoRoot,
    executor: opts.executor ?? "cli",
  });
  io.out(`Opened case '${c.ref.caseKey}' run ${c.ref.runId} at ${c.dir}`);
  io.out(`  skill: ${c.skill.name}  ·  question: ${c.task.question}`);
  io.out(
    `  read CASE.md, then use \`anvil case ...\` helpers or \`anvil case investigate ${c.dir}\`.`,
  );
  return 0;
}

async function runCaseBattery(opts: CaseBatteryOptions, io: CliIO): Promise<number> {
  if (opts.real !== true) {
    const report = await runBattery(BATTERY_SCENARIOS);
    if (opts.json === true) {
      io.out(JSON.stringify(report, null, 2));
    } else {
      io.out(renderScriptedBatteryReport(report));
    }
    if (opts.check === true && report.totals.mismatches > 0) {
      io.err(
        `investigator battery mismatched ${report.totals.mismatches} scenario(s); add fixes or use --real.`,
      );
      return 1;
    }
    return 0;
  }

  const extraArgs = opts.model !== undefined ? ["--model", opts.model] : [];
  const driver = createAgentDriver({
    command: opts.command,
    extraArgs,
    allowDegradedNative: opts.allowDegradedNative === true,
  });
  io.err(`anvil: running effectiveness battery with ${driver.name}…`);

  const rows: EffectivenessRow[] = [];
  for (const c of EFFECTIVENESS_CASES) {
    rows.push(await runEffectivenessCase(c, driver));
  }
  const metrics = effectivenessMetrics(rows);

  if (opts.json === true) {
    io.out(JSON.stringify({ rows, metrics }, null, 2));
    return 0;
  }
  io.out(renderEffectivenessBatteryReport(rows, metrics));
  return 0;
}

function renderScriptedBatteryReport({
  totals,
  byClass,
  rows,
}: Awaited<ReturnType<typeof runBattery>>): string {
  const lines: string[] = [];
  const t = totals;
  lines.push("Investigation battery — deterministic baseline vs case investigation");
  lines.push(
    `  runs=${t.runs} baselineClosed=${t.baselineClosed} investigationClosed=${t.investigationClosed}`,
  );
  lines.push(
    `  investigationOnly=${t.investigationOnly} conflicts=${t.conflictsFound} declined=${t.declined}`,
  );
  if (t.mismatches > 0) lines.push(`  mismatches=${t.mismatches}`);
  lines.push("");

  lines.push("By class:");
  for (const row of byClass) {
    lines.push(
      `  ${row.class.padEnd(20)} runs=${String(row.runs).padStart(4)} base=${String(
        row.baselineClosed,
      ).padStart(4)} inv=${String(row.investigationClosed).padStart(5)} only=${String(
        row.investigationOnly,
      ).padStart(4)} decline=${String(row.declined).padStart(4)}`,
    );
  }

  lines.push("\nPer scenario:");
  for (const row of rows) {
    const flag = row.matchedExpectation ? " " : "⚠";
    lines.push(
      `${flag} ${row.id.padEnd(28)} base=${String(row.baselineProposed).padStart(5)} inv=${row.investigationStatus.padEnd(17)}`,
    );
  }
  return lines.join("\n");
}

function renderEffectivenessBatteryReport(
  rows: readonly EffectivenessRow[],
  metrics: EffectivenessMetrics,
): string {
  const lines: string[] = [];
  lines.push("Investigator effectiveness battery (real agent)");
  lines.push(`  cases=${metrics.cases}`);
  lines.push(`  outcomeAccuracy=${metrics.outcomeAccuracy.toFixed(3)}`);
  lines.push(`  groundedProposalPrecision=${metrics.groundedProposalPrecision.toFixed(3)}`);
  lines.push(`  correctDeclineRate=${metrics.correctDeclineRate.toFixed(3)}`);
  lines.push(`  conflictDetectionRecall=${metrics.conflictDetectionRecall.toFixed(3)}`);
  lines.push(`  unsupportedClaimRate=${metrics.unsupportedClaimRate.toFixed(3)}`);
  lines.push(`  meanEvidenceRecall=${metrics.meanEvidenceRecall.toFixed(3)}`);

  lines.push("\nPer category:");
  const byCategory = new Map<string, { cases: number; outcomes: number }>();
  for (const row of rows) {
    const bucket = byCategory.get(row.category) ?? { cases: 0, outcomes: 0 };
    bucket.cases++;
    if (row.outcomeCorrect) bucket.outcomes++;
    byCategory.set(row.category, bucket);
  }
  for (const [category, bucket] of byCategory.entries()) {
    lines.push(
      `  ${category.padEnd(18)} cases=${String(bucket.cases).padStart(2)} correct=${String(
        bucket.outcomes,
      ).padStart(2)}`,
    );
  }

  lines.push("\nPer scenario:");
  for (const row of rows) {
    const mark = row.outcomeCorrect ? "✓" : "⚠";
    lines.push(
      `${mark} ${row.id.padEnd(28)} exp=${row.expected.toString().padEnd(11)} obs=${row.observed.toString().padEnd(11)} grounded=${row.grounded.toString().padEnd(5)} unsupported=${row.unsupportedClaims}`,
    );
  }
  return lines.join("\n");
}

async function runCaseAddEvidence(
  dir: string,
  opts: CaseAddEvidenceOptions,
  io: CliIO,
): Promise<number> {
  const value = opts.value !== undefined ? coerceValue(opts.value) : undefined;
  const confidence = opts.confidence !== undefined ? Number(opts.confidence) : undefined;
  // --lines a-b (or a) → a verified filesystem coordinate for --path.
  let startLine: number | undefined;
  let endLine: number | undefined;
  if (opts.lines !== undefined) {
    const [a, b] = opts.lines.split("-").map((n) => Number(n.trim()));
    startLine = Number.isFinite(a) ? a : undefined;
    endLine = Number.isFinite(b) ? b : startLine;
  }
  const input: AddEvidenceInput = {
    predicate: opts.predicate,
    value: value as never,
    source: opts.source,
    path: opts.path,
    startLine,
    endLine,
    uri: opts.uri,
    ref: opts.ref,
    note: opts.note,
    confidence: Number.isFinite(confidence) ? confidence : undefined,
  };
  io.out(await caseService.addEvidence(dir, input));
  return 0;
}

async function runCaseInvestigate(
  dir: string,
  opts: CaseInvestigateOptions,
  io: CliIO,
): Promise<number> {
  const extraArgs = opts.model !== undefined ? ["--model", opts.model] : [];
  const driver = createAgentDriver({
    command: opts.command,
    extraArgs,
    allowDegradedNative: opts.allowDegradedNative === true,
  });
  io.err(`anvil: driving ${driver.name} against ${dir} …`);
  await driver.run(dir);
  io.out(
    `Investigation finished. Review ${join(dir, "output")}, then \`anvil case close ${dir} <air>\`.`,
  );
  return 0;
}

function runCaseClose(dir: string, path: string, opts: { json?: boolean }, io: CliIO): number {
  const air = loadAir(path);
  const refinement = caseService.close(air, dir);
  if (!refinement) {
    io.out("Case produced no proposal (an honest decline). Nothing to reconcile.");
    return 0;
  }
  if (opts.json === true) {
    io.out(JSON.stringify(refinement, null, 2));
    return 0;
  }
  const set = Object.entries(refinement.proposal.set)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  io.out(
    `Refinement: [${refinement.status}] ${refinement.skill} → ${refinement.id.split(":").slice(1).join(":")}`,
  );
  io.out(`  ${set}`);
  io.out(`  approval: ${refinement.approval.tier} — ${refinement.approval.reason}`);
  const failed = refinement.validation.filter((v) => !v.ok);
  if (failed.length > 0) io.out(`  validation failed: ${failed.map((v) => v.check).join(", ")}`);
  io.out("\nApply approved refinements with `anvil refine apply` (the reconciler is shared).");
  return 0;
}

/** Coerce a --value string to JSON when it parses, else keep it as a string. */
function coerceValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Parse `field=value` positionals into a patch set, coercing each value to JSON when it parses. */
function parseSetPairs(pairs: string[]): Record<string, ReturnType<typeof coerceValue>> {
  const set: Record<string, unknown> = {};
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq < 0) throw new Error(`Expected field=value, got '${p}'.`);
    set[p.slice(0, eq)] = coerceValue(p.slice(eq + 1));
  }
  return set;
}
