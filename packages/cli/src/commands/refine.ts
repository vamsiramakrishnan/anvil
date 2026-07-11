import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { airToYaml } from "@anvil/air";
import {
  applyApproved,
  buildRefinementPlan,
  discoverSkills,
  generateRefinementSkill,
  packFiles,
  runRefinements,
  SEVERITIES,
  type Severity,
  semanticDiff,
  summarizeRefinementPlan,
} from "@anvil/refinement";
import { type Command, Option } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { loadAir, resolveAirPath } from "./shared.js";

/**
 * `anvil refine <subcommand>` — the quality flywheel.
 *   plan    detect what AIR is missing or weak (read-only)
 *   skills  list the typed skill contracts (read-only)
 *   skill   emit the harness skill package
 *   run     propose → validate → measure → reconcile into a refinement pack
 *   review  print a pack's human review
 *   apply   apply only the auto-approved refinements to AIR (mutates AIR)
 * Detection and measurement are deterministic; only `apply` changes AIR, and only
 * from refinements the policy already approved.
 */
export function registerRefine(parent: Command, ctx: CommandContext): void {
  const refine = annotate(
    parent
      .command("refine")
      .summary("Detect, propose, measure, and apply refinements to AIR (the quality flywheel).")
      .description(
        "`anvil refine plan` runs Anvil's deterministic detectors and reports a refinement plan — documentation gaps, weak naming/routing, unproven safety semantics, and mock/eval coverage holes — grouped by severity, category, and the narrow skill that owns each fix. " +
          "`anvil refine skills` lists those skills as typed contracts (trigger, evidence policy, output boundary, validation), whose executor is kept separate from their semantics. " +
          "`anvil refine run` routes each in-scope deficiency to its skill, proposes an evidence-backed semantic patch, validates it, then MEASURES only the eval families it affects — with a safety guard that must never regress — and reconciles the result through an auto-approval policy into a reviewable refinement pack (--severity/--skill/--safe-only/--out). " +
          "`anvil refine review <pack-dir>` prints the human review. `anvil refine apply` applies only the auto-approved refinements to AIR (the sole mutating step; --dry-run to preview), which `anvil compile` then reprojects across the CLI, MCP, and skill at once.",
      ),
    { mutates: true },
  );

  refine
    .command("plan")
    .summary("Detect what AIR is missing or weak (read-only).")
    .argument("<path>", "generated bundle directory or air.yaml")
    .option("--json", "emit the refinement plan as JSON")
    .action((path: string, opts: { json?: boolean }) => {
      ctx.code = runPlan(path, opts, ctx.io);
    });

  refine
    .command("skills")
    .summary("List the typed refinement skill contracts (read-only).")
    .option("--json", "emit the skill contracts as JSON")
    .action((opts: { json?: boolean }) => {
      ctx.code = runSkills(opts, ctx.io);
    });

  refine
    .command("skill")
    .summary("Emit the progressive-disclosure harness skill package.")
    .argument("[out-dir]", "write the package here instead of printing SKILL.md")
    .action((outDir: string | undefined) => {
      ctx.code = runSkillDoc(outDir, ctx.io);
    });

  refine
    .command("run")
    .summary("Build a refinement pack: propose, validate, measure, reconcile.")
    .argument("<path>", "generated bundle directory or air.yaml")
    .addOption(selectionSeverity())
    .option("--skill <name>", "only run one skill")
    .option("--safe-only", "skip refinements that touch safety semantics")
    .option("--out <dir>", "write the refinement pack here")
    .option("--json", "emit the refinement pack as JSON")
    .action(async (path: string, opts: RefineRunOptions) => {
      ctx.code = await runRun(path, opts, ctx.io);
    });

  refine
    .command("review")
    .summary("Print a refinement pack's human review.")
    .argument("<pack-dir>", "a pack written by `anvil refine run --out`")
    .action((dir: string) => {
      ctx.code = runReview(dir, ctx.io);
    });

  refine
    .command("apply")
    .summary("Apply only the auto-approved refinements to AIR (the sole mutating step).")
    .argument("<path>", "generated bundle directory or air.yaml")
    .addOption(selectionSeverity())
    .option("--skill <name>", "only run one skill")
    .option("--safe-only", "skip refinements that touch safety semantics")
    .option("--dry-run", "print the semantic diff without writing AIR")
    .action(async (path: string, opts: RefineApplyOptions) => {
      ctx.code = await runApply(path, opts, ctx.io);
    });
}

/** The shared run/apply severity selector (an enum, so typos fail fast). */
function selectionSeverity(): Option {
  return new Option("--severity <severity>", "only refine at/above this severity").choices(
    SEVERITIES,
  );
}

interface RefineSelection {
  severity?: Severity;
  skill?: string;
  safeOnly?: boolean;
}

interface RefineRunOptions extends RefineSelection {
  out?: string;
  json?: boolean;
}

interface RefineApplyOptions extends RefineSelection {
  dryRun?: boolean;
}

/** Parse the shared run/apply selection options into RunOptions. */
function refineOptions(opts: RefineSelection) {
  return {
    minSeverity: opts.severity,
    skill: opts.skill,
    safeOnly: opts.safeOnly === true,
  };
}

/** `anvil refine plan` — the deterministic deficiency report. */
function runPlan(path: string, opts: { json?: boolean }, io: CliIO): number {
  const air = loadAir(path);
  const plan = buildRefinementPlan(air);
  if (opts.json === true) {
    io.out(JSON.stringify(plan, null, 2));
  } else {
    io.out(summarizeRefinementPlan(plan));
  }
  // Blocking safety gaps are the signal that the artifact should not ship as-is.
  return plan.blocking.length > 0 ? 1 : 0;
}

/** `anvil refine skill` — emit the progressive-disclosure harness skill package. */
function runSkillDoc(outDir: string | undefined, io: CliIO): number {
  const files = generateRefinementSkill();
  if (!outDir) {
    io.out(files["SKILL.md"] ?? "");
    return 0;
  }
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(outDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  io.out(`Wrote the refinement skill to ${outDir} (SKILL.md + reference/ + evals/).`);
  io.out("Point a coding-agent harness (Claude Code, Codex, Antigravity) at it to run the loop.");
  return 0;
}

/** `anvil refine run` — build a refinement pack; optionally write it to --out. */
async function runRun(path: string, opts: RefineRunOptions, io: CliIO): Promise<number> {
  const air = loadAir(path);
  const pack = await runRefinements(air, refineOptions(opts));

  if (opts.json === true) {
    io.out(JSON.stringify(pack, null, 2));
  } else {
    const s = pack.summary;
    io.out(`Refinement run — ${pack.service.id} @ ${pack.service.version}`);
    io.out(
      `  ${s.proposed} proposed · ${s.approved} approved · ${s.review} awaiting review · ` +
        `${s.rejected} rejected · ${s.regressed} regressed · ${s.skipped} skipped`,
    );
    for (const r of pack.refinements) {
      const set = Object.entries(r.proposal.set)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ");
      io.out(
        `  [${r.status.padEnd(9)}] ${r.skill} → ${r.id.split(":").slice(1).join(":")}  ${set}`,
      );
    }
    io.out("\nDetection and measurement were deterministic; AIR was not changed.");
  }

  if (opts.out) {
    mkdirSync(opts.out, { recursive: true });
    for (const [name, contents] of Object.entries(packFiles(pack))) {
      writeFileSync(join(opts.out, name), contents, "utf8");
    }
    io.out(
      `\nWrote refinement pack (${Object.keys(packFiles(pack)).length} files) to ${opts.out}.`,
    );
    io.out(`Review it (\`anvil refine review ${opts.out}\`), then \`anvil refine apply\`.`);
  }
  return 0;
}

/** `anvil refine review` — print the human review from a pack directory. */
function runReview(dir: string, io: CliIO): number {
  const reviewPath = join(dir, "review.md");
  if (!existsSync(reviewPath)) {
    io.err(`No review.md in ${dir}. Run \`anvil refine run --out ${dir}\` first.`);
    return 1;
  }
  io.out(readFileSync(reviewPath, "utf8"));
  return 0;
}

/** `anvil refine apply` — apply only the auto-approved refinements to AIR. */
async function runApply(path: string, opts: RefineApplyOptions, io: CliIO): Promise<number> {
  const airPath = resolveAirPath(path);
  const air = loadAir(path);
  const pack = await runRefinements(air, refineOptions(opts));
  const { air: next, applied, changes } = applyApproved(air, pack);

  if (applied.length === 0) {
    io.out("No auto-approved refinements to apply.");
    if (pack.summary.review > 0)
      io.out(
        `  ${pack.summary.review} refinement(s) await human review; promote them deliberately.`,
      );
    return 0;
  }

  io.out(`Applying ${applied.length} approved refinement(s):`);
  io.out(semanticDiff(changes));

  if (opts.dryRun === true) {
    io.out("\n(dry run — AIR was not written)");
    return 0;
  }
  writeFileSync(airPath, airToYaml(next), "utf8");
  io.out(
    `\nWrote ${airPath}. Regenerate the bundle with \`anvil compile\` to reproject the change.`,
  );
  if (pack.summary.review > 0)
    io.out(`  ${pack.summary.review} refinement(s) left for human review (not applied).`);
  return 0;
}

/** `anvil refine skills` — list the typed skill contracts (read-only). */
function runSkills(opts: { json?: boolean }, io: CliIO): number {
  const skills = discoverSkills();
  if (opts.json === true) {
    io.out(JSON.stringify(skills, null, 2));
    return 0;
  }
  io.out("Refinement skills (typed procedures; executor is separate from semantics):\n");
  for (const s of skills) {
    io.out(`  ${s.name} v${s.version}  → ${s.triggers.join(", ")}`);
    io.out(`    target: ${s.targetKind}   writes: ${s.output.fields.join(", ")}`);
    io.out(`    evidence: ${s.evidence.minimumStrength} from ${s.evidence.allowed.join("/")}`);
    io.out(`    validation: ${s.validation.join(", ")}`);
  }
  io.out(
    "\nProposals from any executor are judged by these deterministic checks before they count.",
  );
  return 0;
}
