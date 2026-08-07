import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  assessLegacyRefinementProposal,
  createLegacyRefinementProposal,
  createLegacyRefinementTask,
  createLegacyReviewReceipt,
  createReviewedLegacyCapabilityBinding,
  LegacyCapabilityBinding,
  type LegacyInventorySnapshot,
  LegacyRefinementAssessment,
  LegacyRefinementProposal,
  LegacyRefinementSubmission,
  LegacyRefinementTask,
  LegacyReviewReceipt,
  verifyLegacyInventory,
} from "@anvil/compiler/legacy";
import type { Command } from "commander";
import { z } from "zod";
import { emitRefusal } from "../../envelope.js";
import type { CliIO } from "../../io.js";
import type { CommandContext } from "../context.js";
import { annotate } from "../meta.js";

const TASK_REPORT_TYPE = "anvil.legacy-refinement-task";
const REVIEW_REPORT_TYPE = "anvil.legacy-refinement-review";
const DECISION_REPORT_TYPE = "anvil.legacy-refinement-decision";
const ERROR_REPORT_TYPE = "anvil.legacy-refinement-error";
const MAX_INPUT_BYTES = 32 * 1024 * 1024;

const TaskReport = z
  .object({
    schemaVersion: z.literal(1),
    reportType: z.literal(TASK_REPORT_TYPE),
    task: LegacyRefinementTask,
  })
  .strict();

const ReviewReport = z
  .object({
    schemaVersion: z.literal(1),
    reportType: z.literal(REVIEW_REPORT_TYPE),
    task: LegacyRefinementTask,
    proposal: LegacyRefinementProposal,
    assessment: LegacyRefinementAssessment,
  })
  .strict();

const DecisionReport = z
  .object({
    schemaVersion: z.literal(1),
    reportType: z.literal(DECISION_REPORT_TYPE),
    decision: z.enum(["approved", "rejected"]),
    receipt: LegacyReviewReceipt,
    binding: LegacyCapabilityBinding.optional(),
  })
  .strict();

interface CommonOptions {
  out?: string;
  json?: boolean;
}

interface DecisionOptions extends CommonOptions {
  reviewer: string;
  reason: string;
}

class LegacyRefinementCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function registerLegacyRefinement(parent: Command, ctx: CommandContext): void {
  const refine = parent
    .command("refine")
    .summary("Turn one inventory candidate into a reviewed business and transport binding.")
    .description(
      "Export a hash-bound task for a coding harness, validate its evidence-backed proposal, then record a separate human approval or rejection. A reviewed binding remains a non-executable plan until a deployment-local bridge adapter is implemented.",
    );

  annotate(
    refine
      .command("task")
      .summary("Export one deterministic candidate-refinement task.")
      .argument("<inventory>", "legacy inventory report or inventory snapshot")
      .argument("<candidate-id>", "exact lc_ candidate id")
      .option("--out <file>", "write without overwriting different content")
      .option("--json", "emit the complete task report")
      .action((inventory: string, candidateId: string, options: CommonOptions) => {
        ctx.code = runTask(inventory, candidateId, options, ctx.io);
      }),
    { mutates: true },
  );

  annotate(
    refine
      .command("review")
      .summary("Import and deterministically assess one harness proposal.")
      .argument("<inventory>", "legacy inventory report or inventory snapshot")
      .argument("<task>", "task report or task JSON")
      .argument("<submission>", "untrusted harness submission JSON")
      .option("--out <file>", "write the review pack without overwriting different content")
      .option("--json", "emit the complete review pack")
      .action((inventory: string, task: string, submission: string, options: CommonOptions) => {
        ctx.code = runReview(inventory, task, submission, options, ctx.io);
      }),
    { mutates: true },
  );

  annotate(
    refine
      .command("approve")
      .summary("Approve the exact assessed proposal and emit a non-executable binding plan.")
      .argument("<inventory>", "legacy inventory report or inventory snapshot")
      .argument("<review>", "review pack from `anvil legacy refine review`")
      .requiredOption("--reviewer <identity>", "reviewer identity recorded in the receipt")
      .requiredOption("--reason <text>", "why this exact proposal is approved")
      .option("--out <file>", "write the decision without overwriting different content")
      .option("--json", "emit the complete decision report")
      .action((inventory: string, review: string, options: DecisionOptions) => {
        ctx.code = runDecision("approved", inventory, review, options, ctx.io);
      }),
    { mutates: true },
  );

  annotate(
    refine
      .command("reject")
      .summary("Reject the exact assessed proposal and retain an auditable receipt.")
      .argument("<inventory>", "legacy inventory report or inventory snapshot")
      .argument("<review>", "review pack from `anvil legacy refine review`")
      .requiredOption("--reviewer <identity>", "reviewer identity recorded in the receipt")
      .requiredOption("--reason <text>", "why this exact proposal is rejected")
      .option("--out <file>", "write the decision without overwriting different content")
      .option("--json", "emit the complete decision report")
      .action((inventory: string, review: string, options: DecisionOptions) => {
        ctx.code = runDecision("rejected", inventory, review, options, ctx.io);
      }),
    { mutates: true },
  );
}

function runTask(
  inventoryPath: string,
  candidateId: string,
  options: CommonOptions,
  io: CliIO,
): number {
  try {
    const inventory = readInventory(inventoryPath);
    const task = createLegacyRefinementTask(inventory, candidateId);
    const report = TaskReport.parse({ schemaVersion: 1, reportType: TASK_REPORT_TYPE, task });
    emitReport(report, options, io);
    if (!options.json) {
      io.out(`Legacy refinement task ${task.taskId}`);
      io.out(`  candidate: ${task.candidateId}`);
      io.out(`  ${task.requiredDecisions.length} required decision(s)`);
      if (options.out) io.out(`  report: ${options.out}`);
      io.out(
        "  Next: give this task to the harness, then import its JSON with `anvil legacy refine review`.",
      );
    }
    return 0;
  } catch (error) {
    return refuse(error, options, io, { inventory: inventoryPath, candidateId });
  }
}

function runReview(
  inventoryPath: string,
  taskPath: string,
  submissionPath: string,
  options: CommonOptions,
  io: CliIO,
): number {
  try {
    const inventory = readInventory(inventoryPath);
    const task = readTask(taskPath);
    const submission = LegacyRefinementSubmission.parse(readJson(submissionPath));
    const proposal = createLegacyRefinementProposal(task, submission);
    const assessment = assessLegacyRefinementProposal(inventory, task, proposal);
    const report = ReviewReport.parse({
      schemaVersion: 1,
      reportType: REVIEW_REPORT_TYPE,
      task,
      proposal,
      assessment,
    });
    emitReport(report, options, io);
    if (!options.json) {
      io.out(`Legacy refinement proposal ${proposal.proposalId}`);
      io.out(`  assessment: ${assessment.ok ? "ready for human review" : "not approvable"}`);
      for (const issue of assessment.issues) io.out(`  ${issue.code}: ${issue.message}`);
      if (options.out) io.out(`  review pack: ${options.out}`);
      if (assessment.ok) {
        io.out("  Next: inspect the evidence and use `anvil legacy refine approve` or `reject`.");
      }
    }
    return assessment.ok ? 0 : 1;
  } catch (error) {
    return refuse(error, options, io, {
      inventory: inventoryPath,
      task: taskPath,
      submission: submissionPath,
    });
  }
}

function runDecision(
  decision: "approved" | "rejected",
  inventoryPath: string,
  reviewPath: string,
  options: DecisionOptions,
  io: CliIO,
): number {
  try {
    const inventory = readInventory(inventoryPath);
    const review = ReviewReport.parse(readJson(reviewPath));
    const receipt = createLegacyReviewReceipt(inventory, review.task, review.proposal, {
      decision,
      reviewer: options.reviewer,
      reason: options.reason,
    });
    const binding =
      decision === "approved"
        ? createReviewedLegacyCapabilityBinding(inventory, review.task, review.proposal, receipt)
        : undefined;
    const report = DecisionReport.parse({
      schemaVersion: 1,
      reportType: DECISION_REPORT_TYPE,
      decision,
      receipt,
      ...(binding ? { binding } : {}),
    });
    emitReport(report, options, io);
    if (!options.json) {
      io.out(`Legacy refinement ${decision}: ${receipt.receiptId}`);
      if (binding) {
        io.out(`  binding: ${binding.bindingId}`);
        io.out("  runtime: not implemented; build a deployment-local bridge before invocation");
      }
      if (options.out) io.out(`  decision: ${options.out}`);
    }
    return 0;
  } catch (error) {
    return refuse(error, options, io, { inventory: inventoryPath, review: reviewPath, decision });
  }
}

function readInventory(path: string): z.infer<typeof LegacyInventorySnapshot> {
  const value = readJson(path);
  if (value && typeof value === "object" && "inventory" in value) {
    return verifyLegacyInventory((value as { inventory?: unknown }).inventory);
  }
  return verifyLegacyInventory(value);
}

function readTask(path: string): z.infer<typeof LegacyRefinementTask> {
  const value = readJson(path);
  if (value && typeof value === "object" && "task" in value) {
    return LegacyRefinementTask.parse((value as { task?: unknown }).task);
  }
  return LegacyRefinementTask.parse(value);
}

function readJson(path: string): unknown {
  const target = resolve(path);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new LegacyRefinementCommandError(
      "legacy/refinement_input_refused",
      `Refused '${path}': expected a regular, non-symbolic-link JSON file.`,
    );
  }
  if (stat.size > MAX_INPUT_BYTES) {
    throw new LegacyRefinementCommandError(
      "legacy/refinement_input_too_large",
      `Refused '${path}': input exceeds ${MAX_INPUT_BYTES} bytes.`,
    );
  }
  const raw = readFileSync(target, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new LegacyRefinementCommandError(
      "legacy/refinement_input_invalid",
      `Refused '${path}': input is not valid JSON.`,
    );
  }
}

function emitReport(report: unknown, options: CommonOptions, io: CliIO): void {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) writeReport(options.out, serialized);
  if (options.json) io.out(serialized.trimEnd());
}

function writeReport(path: string, content: string): void {
  const target = resolve(path);
  if (existsSync(target)) {
    if (readFileSync(target, "utf8") === content) return;
    throw new LegacyRefinementCommandError(
      "legacy/refinement_output_exists",
      `Refused to overwrite different legacy refinement output '${path}'.`,
    );
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
}

function refuse(
  error: unknown,
  options: CommonOptions,
  io: CliIO,
  details: Record<string, unknown>,
): number {
  return emitRefusal(io, options.json, {
    reportType: ERROR_REPORT_TYPE,
    code: errorCode(error),
    message: error instanceof Error ? error.message : String(error),
    details,
  });
}

function errorCode(error: unknown): string {
  if (error instanceof LegacyRefinementCommandError) return error.code;
  const nodeCode =
    error !== null && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  if (["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(nodeCode ?? "")) {
    return "legacy/refinement_input_unreadable";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    /different inventory|changed after|different task|binding mismatch|does not match/i.test(
      message,
    )
  ) {
    return "legacy/refinement_stale";
  }
  if (/cannot be approved|not valid for binding|not approved|declined/i.test(message)) {
    return "legacy/refinement_not_approvable";
  }
  if (error instanceof z.ZodError) return "legacy/refinement_input_invalid";
  return "legacy/refinement_failed";
}
