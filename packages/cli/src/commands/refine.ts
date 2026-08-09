import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { airToJson, airToYaml } from "@anvil/air";
import {
  applyApproved,
  applyReviewed,
  buildRefinementPlan,
  createRefinementTask,
  createReviewReceipt,
  discoverSkills,
  generateRefinementSkill,
  HarnessProtocolError,
  importHarnessSubmission,
  packFiles,
  parseRefinementPack,
  parseRefinementReviewReceipt,
  type RefinementPack,
  resolveRepositoryRevision,
  runRefinements,
  SEVERITIES,
  type Severity,
  semanticDiff,
  skillFor,
  summarizeRefinementPlan,
  targetKey,
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
 *   export-task/import-proposal process-neutral coding-harness transaction
 *   review  print a pack's human review
 *   approve/reject record a receipt-bound human decision
 *   apply-pack apply the exact reviewed pack (no investigation rerun)
 *   apply   apply only the auto-approved refinements to AIR (mutates AIR)
 * Detection and measurement are deterministic; only `apply` and `apply-pack`
 * change AIR, and only from refinements the policy or a bound receipt approved.
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
          "`export-task` and `import-proposal` expose those same rails as portable JSON, so any coding harness can investigate without importing Anvil's TypeScript package. " +
          "`anvil refine review <pack-dir>` prints the human review. `approve`/`reject` write hash-bound decisions, and `apply-pack` applies those exact reviewed bytes without rerunning investigation. `anvil refine apply` remains the shortcut for auto-approved refinements.",
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
    .command("export-task")
    .summary("Export one hash-bound, process-neutral coding-harness task.")
    .argument("<path>", "generated bundle directory or air.yaml")
    .argument("<target-key>", "a target key printed by `anvil case list`")
    .requiredOption("--out <file>", "write the portable task JSON here")
    .option("--skill <name>", "select a skill when one target has multiple deficiencies")
    .option("--repo-root <dir>", "Git repository the harness may inspect", ".")
    .option("--inspect <paths>", "comma-separated repository-relative inspect scopes")
    .action((path: string, key: string, opts: RefineExportTaskOptions) => {
      ctx.code = runExportTask(path, key, opts, ctx.io);
    });

  refine
    .command("import-proposal")
    .summary("Validate and measure a portable harness submission into a refinement pack.")
    .argument("<path>", "generated bundle directory or air.yaml")
    .argument("<task-file>", "task JSON written by `anvil refine export-task`")
    .argument("<submission-file>", "portable JSON returned by the coding harness")
    .requiredOption("--out <dir>", "write the measured refinement pack here")
    .option("--repo-root <dir>", "Git repository named by the task", ".")
    .option("--json", "emit a structured success or rejection envelope")
    .action(
      (
        path: string,
        taskFile: string,
        submissionFile: string,
        opts: RefineImportProposalOptions,
      ) => {
        ctx.code = runImportProposal(path, taskFile, submissionFile, opts, ctx.io);
      },
    );

  refine
    .command("review")
    .summary("Print a refinement pack's human review.")
    .argument("<pack-dir>", "a pack written by `anvil refine run --out`")
    .action((dir: string) => {
      ctx.code = runReview(dir, ctx.io);
    });

  for (const decision of ["approve", "reject"] as const) {
    refine
      .command(decision)
      .summary(
        `${decision === "approve" ? "Approve" : "Reject"} review-tier refinements with a bound receipt.`,
      )
      .argument("<pack-dir>", "a pack written by `anvil refine run --out`")
      .argument("<refinement-id...>", "exact refinement id(s) printed by `anvil refine review`")
      .requiredOption(
        "--reviewer <identity>",
        "stable reviewer identity (for example, email or handle)",
      )
      .requiredOption("--reason <text>", "why this decision is justified")
      .action((dir: string, ids: string[], opts: { reviewer: string; reason: string }) => {
        ctx.code = runDecision(
          dir,
          ids,
          decision === "approve" ? "approved" : "rejected",
          opts,
          ctx.io,
        );
      });
  }

  refine
    .command("apply-pack")
    .summary("Apply an existing measured pack plus its receipt-bound human decisions.")
    .argument("<path>", "generated bundle directory or air.yaml")
    .argument("<pack-dir>", "a pack written by `anvil refine run --out`")
    .option(
      "--receipt <file>",
      "additional receipt file (repeatable; pack-dir/receipts/*.json is loaded by default)",
      (file: string, files: string[]) => [...files, file],
      [],
    )
    .option("--dry-run", "print the semantic diff without writing AIR")
    .action((path: string, dir: string, opts: { receipt: string[]; dryRun?: boolean }) => {
      ctx.code = runApplyPack(path, dir, opts, ctx.io);
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

interface RefineExportTaskOptions {
  out: string;
  skill?: string;
  repoRoot: string;
  inspect?: string;
}

interface RefineImportProposalOptions {
  out: string;
  repoRoot: string;
  json?: boolean;
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
    io.out(
      `Review it (\`anvil refine review ${opts.out}\`), record decisions, then ` +
        `\`anvil refine apply-pack ${path} ${opts.out}\`.`,
    );
  }
  return 0;
}

function writeWithoutReplacingDifferent(path: string, contents: string): void {
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (current !== contents) {
      throw new Error(`Refusing to replace existing '${path}' with different content.`);
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

/** `anvil refine export-task` — one deterministic JSON job, no harness dependency. */
function runExportTask(
  path: string,
  key: string,
  opts: RefineExportTaskOptions,
  io: CliIO,
): number {
  try {
    const air = loadAir(path);
    const plan = buildRefinementPlan(air);
    const candidates = plan.deficiencies.filter((deficiency) => {
      const skill = skillFor(deficiency.code);
      return (
        targetKey(deficiency.target) === key &&
        skill !== undefined &&
        (opts.skill === undefined || skill.name === opts.skill)
      );
    });
    const bySkill = new Map(
      candidates.flatMap((deficiency) => {
        const skill = skillFor(deficiency.code);
        return skill ? ([[skill.name, deficiency]] as const) : [];
      }),
    );
    if (bySkill.size === 0) {
      throw new Error(
        `No investigable deficiency at target '${key}'${opts.skill ? ` for skill '${opts.skill}'` : ""}. Run \`anvil case list ${path}\`.`,
      );
    }
    if (bySkill.size > 1) {
      throw new Error(
        `Target '${key}' has multiple skills (${[...bySkill.keys()].join(", ")}); select one with --skill.`,
      );
    }
    const deficiency = bySkill.values().next().value;
    if (!deficiency) throw new Error(`No deficiency selected for target '${key}'.`);
    const inspectScopes = opts.inspect
      ?.split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    const task = createRefinementTask(air, deficiency, {
      repositoryRoot: opts.repoRoot,
      repositoryRevision: resolveRepositoryRevision(opts.repoRoot),
      inspectScopes,
    });
    writeWithoutReplacingDifferent(opts.out, `${JSON.stringify(task, null, 2)}\n`);
    io.out(`Exported ${task.taskId} → ${opts.out}`);
    io.out(`  skill: ${task.skill.name} v${task.skill.version}`);
    io.out(`  repository: ${task.repository.revision}`);
    io.out(
      "Give this JSON to any coding harness; it returns one submission matching expectedSubmission.",
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(message);
    return 1;
  }
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** `anvil refine import-proposal` — re-enter deterministic validation and measurement. */
function runImportProposal(
  path: string,
  taskFile: string,
  submissionFile: string,
  opts: RefineImportProposalOptions,
  io: CliIO,
): number {
  try {
    const pack = importHarnessSubmission(
      loadAir(path),
      readJsonFile(taskFile),
      readJsonFile(submissionFile),
      { repositoryRoot: opts.repoRoot },
    );
    const files = packFiles(pack);
    for (const [name, contents] of Object.entries(files)) {
      const destination = join(opts.out, name);
      if (existsSync(destination) && readFileSync(destination, "utf8") !== contents) {
        throw new Error(`Refusing to replace existing '${destination}' with different content.`);
      }
    }
    for (const [name, contents] of Object.entries(files)) {
      writeWithoutReplacingDifferent(join(opts.out, name), contents);
    }
    const record = pack.harnessImports?.[0];
    if (!record) throw new Error("Imported pack is missing its harness provenance record.");
    const refinement = pack.refinements[0];
    if (opts.json === true) {
      io.out(
        JSON.stringify(
          {
            schemaVersion: 1,
            reportType: "anvil.refinement-harness-import",
            ok: true,
            taskId: record.task.taskId,
            packDir: opts.out,
            summary: pack.summary,
          },
          null,
          2,
        ),
      );
    } else {
      io.out(`Imported ${record.task.taskId} → ${opts.out}`);
      io.out(
        refinement === undefined
          ? `  harness declined honestly: ${record.submission.status}`
          : `  refinement: ${refinement.status} (${refinement.approval.tier})`,
      );
      io.out(`Review with \`anvil refine review ${opts.out}\`.`);
    }
    return 0;
  } catch (error) {
    if (error instanceof HarnessProtocolError) {
      if (opts.json === true) {
        io.out(
          JSON.stringify(
            {
              schemaVersion: 1,
              reportType: "anvil.refinement-harness-import-error",
              ok: false,
              ...error.rejection,
            },
            null,
            2,
          ),
        );
      } else {
        io.err(error.rejection.message);
        for (const issue of error.rejection.issues) io.err(`  - ${issue}`);
      }
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (opts.json === true) {
      io.out(
        JSON.stringify(
          {
            schemaVersion: 1,
            reportType: "anvil.refinement-harness-import-error",
            ok: false,
            code: "refinement/import_failed",
            stage: "binding",
            message,
            issues: [],
          },
          null,
          2,
        ),
      );
    } else {
      io.err(message);
    }
    return 1;
  }
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

function readPack(dir: string): RefinementPack {
  const path = join(dir, "pack.json");
  if (!existsSync(path)) {
    throw new Error(`No pack.json in ${dir}. Run \`anvil refine run --out ${dir}\` first.`);
  }
  return parseRefinementPack(JSON.parse(readFileSync(path, "utf8")));
}

function runDecision(
  dir: string,
  ids: string[],
  decision: "approved" | "rejected",
  opts: { reviewer: string; reason: string },
  io: CliIO,
): number {
  try {
    const pack = readPack(dir);
    const receiptsDir = join(dir, "receipts");
    const pending = ids.map((id) => {
      const receipt = createReviewReceipt(pack, id, decision, opts.reviewer, opts.reason);
      const safeId = id.replace(/[^A-Za-z0-9._-]+/g, "_");
      const path = join(receiptsDir, `${safeId}.${decision}.json`);
      if (existsSync(path)) {
        throw new Error(
          `Receipt already exists: ${path}. Remove it deliberately before replacing a decision.`,
        );
      }
      return { id, path, receipt };
    });
    mkdirSync(receiptsDir, { recursive: true });
    for (const { id, path, receipt } of pending) {
      writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      io.out(`${decision === "approved" ? "Approved" : "Rejected"} ${id} → ${path}`);
    }
    return 0;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function runApplyPack(
  path: string,
  dir: string,
  opts: { receipt: string[]; dryRun?: boolean },
  io: CliIO,
): number {
  try {
    const airPath = resolveAirPath(path);
    const air = loadAir(path);
    const pack = readPack(dir);
    const receiptPaths: string[] = [];
    const receiptsDir = join(dir, "receipts");
    if (existsSync(receiptsDir)) {
      receiptPaths.push(
        ...readdirSync(receiptsDir)
          .filter((name) => name.endsWith(".json"))
          .sort()
          .map((name) => join(receiptsDir, name)),
      );
    }
    receiptPaths.push(...opts.receipt);
    const receipts = [...new Set(receiptPaths)].map((receiptPath) =>
      parseRefinementReviewReceipt(JSON.parse(readFileSync(receiptPath, "utf8"))),
    );
    const { air: next, applied, changes } = applyReviewed(air, pack, receipts);
    if (applied.length === 0) {
      io.out("No approved refinements in this pack.");
      return 0;
    }
    io.out(`Applying ${applied.length} refinement(s) from the reviewed pack:`);
    io.out(semanticDiff(changes));
    if (opts.dryRun === true) {
      io.out("\n(dry run — AIR was not written)");
      return 0;
    }
    writeFileSync(airPath, airPath.endsWith(".json") ? airToJson(next) : airToYaml(next), "utf8");
    io.out(`\nWrote ${airPath}. Regenerate the bundle with \`anvil compile\`.`);
    return 0;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
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
  // Write back in whatever format the resolved AIR path names — loadAir reads by
  // this same extension (shared.ts), so the write path must agree with it instead
  // of always serializing YAML (which would corrupt an air.json target).
  writeFileSync(airPath, airPath.endsWith(".json") ? airToJson(next) : airToYaml(next), "utf8");
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
