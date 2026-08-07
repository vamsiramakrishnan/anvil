import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  assessAndPlanLegacyCoverage,
  createLegacyCollectionPlan,
  diffLegacyInventories,
  explainLegacyCandidate,
  type LegacyCapabilityCandidate,
  LegacyCollectionPlan,
  type LegacyInventorySnapshot as LegacyInventorySnapshotType,
  type LegacyProductInput,
  projectLegacyEvidenceGraph,
  reconcileLegacyInventory,
  verifyLegacyCollectionPlan,
  verifyLegacyInventory,
} from "@anvil/compiler/legacy";
import type { Command } from "commander";
import { z } from "zod";
import { emitRefusal } from "../../envelope.js";
import type { CliIO } from "../../io.js";
import type { CommandContext } from "../context.js";
import { annotate } from "../meta.js";

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const ERROR_REPORT_TYPE = "anvil.legacy-product-error";

interface OutputOptions {
  out?: string;
  json?: boolean;
}

interface CoverageOptions extends OutputOptions {
  plan?: string;
  check?: boolean;
}

class LegacyProductCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function registerLegacyProduct(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("plan")
      .summary("Validate and address a fail-closed legacy evidence collection plan.")
      .description(
        "Turns a strict collection-plan manifest into a deterministic plan ID. Repository evidence must be revision-pinned, and unsafe acquisition modes are not expressible.",
      )
      .argument("<manifest>", "unaddressed plan manifest, addressed plan, or plan report JSON")
      .option("--out <file>", "write without overwriting different content")
      .option("--json", "emit the complete collection-plan report")
      .action((manifest: string, options: OutputOptions) => {
        ctx.code = runPlan(manifest, options, ctx.io);
      }),
    { mutates: true },
  );

  annotate(
    parent
      .command("graph")
      .summary("Project an inventory into a typed, evidence-linked graph.")
      .argument("<inventory>", "legacy inventory report or inventory snapshot")
      .option("--out <file>", "write without overwriting different content")
      .option("--json", "emit the complete evidence graph")
      .action((inventory: string, options: OutputOptions) => {
        ctx.code = runGraph(inventory, options, ctx.io);
      }),
    { mutates: true },
  );

  annotate(
    parent
      .command("gaps")
      .summary("Measure semantic coverage and request the evidence still needed.")
      .description(
        "Separates collector yield from semantic completeness. Missing, conflicting, unsupported, and safety-refused evidence remain explicit acquisition work.",
      )
      .argument("<inventory>", "legacy inventory report or inventory snapshot")
      .option("--plan <file>", "assess against an addressed collection plan")
      .option("--check", "exit non-zero unless semantic coverage is complete")
      .option("--out <file>", "write without overwriting different content")
      .option("--json", "emit coverage and gap-plan JSON")
      .action((inventory: string, options: CoverageOptions) => {
        ctx.code = runGaps(inventory, options, ctx.io);
      }),
    { mutates: true },
  );

  annotate(
    parent
      .command("explain")
      .summary("Trace one candidate to every observation, claim, and source artifact.")
      .argument("<inventory>", "legacy inventory report or inventory snapshot")
      .argument("<candidate-id>", "exact lc_ candidate id")
      .option("--out <file>", "write without overwriting different content")
      .option("--json", "emit the complete candidate explanation")
      .action((inventory: string, candidateId: string, options: OutputOptions) => {
        ctx.code = runExplain(inventory, candidateId, options, ctx.io);
      }),
    { mutates: true },
  );

  annotate(
    parent
      .command("diff")
      .summary("Compare legacy inventories by deployment occurrence and logical lineage.")
      .argument("<before>", "earlier legacy inventory report or snapshot")
      .argument("<after>", "later legacy inventory report or snapshot")
      .option("--out <file>", "write without overwriting different content")
      .option("--json", "emit the complete deterministic inventory diff")
      .action((before: string, after: string, options: OutputOptions) => {
        ctx.code = runDiff(before, after, options, ctx.io);
      }),
    { mutates: true },
  );
}

function runPlan(path: string, options: OutputOptions, io: CliIO): number {
  try {
    const raw = unwrap(readJson(path), "plan");
    const addressed = LegacyCollectionPlan.safeParse(raw);
    const plan = addressed.success
      ? verifyLegacyCollectionPlan(addressed.data)
      : createLegacyCollectionPlan(raw as never);
    emit({ schemaVersion: 1, reportType: "anvil.legacy-collection-plan", plan }, options, io, [
      `Legacy collection plan ${plan.planId}`,
      `  ${plan.sources.length} source(s), ${plan.requirements.length} required evidence dimension(s)`,
      "  acquisition: offline, bounded, no secrets, no classloading or execution",
    ]);
    return 0;
  } catch (error) {
    return refuse(error, options, io, { manifest: path });
  }
}

function runGraph(path: string, options: OutputOptions, io: CliIO): number {
  try {
    const graph = projectLegacyEvidenceGraph(readProductInput(path));
    emit({ schemaVersion: 1, reportType: "anvil.legacy-evidence-graph", graph }, options, io, [
      `Legacy evidence graph ${graph.graphId}`,
      `  ${graph.nodes.length} node(s), ${graph.edges.length} evidence-linked edge(s)`,
    ]);
    return 0;
  } catch (error) {
    return refuse(error, options, io, { inventory: path });
  }
}

function runGaps(path: string, options: CoverageOptions, io: CliIO): number {
  try {
    const input = readProductInput(path);
    const plan = options.plan ? readPlan(options.plan) : undefined;
    const result = assessAndPlanLegacyCoverage(input, plan ? { plan } : {});
    emit(
      {
        schemaVersion: 1,
        reportType: "anvil.legacy-coverage-and-gaps",
        coverage: result.report,
        gapPlan: result.gapPlan,
      },
      options,
      io,
      [
        `Legacy coverage ${result.report.reportId}`,
        `  outcome: ${result.report.outcome}; semantic completeness: ${result.report.semanticComplete ? "complete" : "incomplete"}`,
        `  ${result.gapPlan.gaps.length} evidence acquisition gap(s)`,
      ],
    );
    return options.check && !result.report.semanticComplete ? 1 : 0;
  } catch (error) {
    return refuse(error, options, io, {
      inventory: path,
      ...(options.plan ? { plan: options.plan } : {}),
    });
  }
}

function runExplain(path: string, candidateId: string, options: OutputOptions, io: CliIO): number {
  try {
    const explanation = explainLegacyCandidate(readProductInput(path), candidateId);
    emit(
      { schemaVersion: 1, reportType: "anvil.legacy-candidate-explanation", explanation },
      options,
      io,
      [
        `Legacy candidate explanation ${explanation.explanationId}`,
        `  candidate: ${candidateId}`,
        `  ${explanation.evidence.length} evidence record(s), ${explanation.unknownDimensions.length} unknown claim dimension(s)`,
      ],
    );
    return 0;
  } catch (error) {
    return refuse(error, options, io, { inventory: path, candidateId });
  }
}

function runDiff(beforePath: string, afterPath: string, options: OutputOptions, io: CliIO): number {
  try {
    const diff = diffLegacyInventories(readProductInput(beforePath), readProductInput(afterPath));
    emit({ schemaVersion: 1, reportType: "anvil.legacy-inventory-diff", diff }, options, io, [
      `Legacy inventory diff ${diff.diffId}`,
      `  ${diff.addedLineages.length} added, ${diff.removedLineages.length} removed, ${diff.changedLineages.length} changed logical lineage(s)`,
      `  ${diff.addedOccurrenceIds.length} added, ${diff.removedOccurrenceIds.length} removed deployment occurrence(s)`,
    ]);
    return 0;
  } catch (error) {
    return refuse(error, options, io, { before: beforePath, after: afterPath });
  }
}

function readPlan(path: string): z.infer<typeof LegacyCollectionPlan> {
  return verifyLegacyCollectionPlan(unwrap(readJson(path), "plan"));
}

function readProductInput(path: string): LegacyProductInput {
  const raw = readJson(path);
  if (isRecord(raw) && "inventory" in raw) {
    const snapshot = verifyLegacyInventory(raw.inventory);
    const candidates = Array.isArray(raw.candidates)
      ? (raw.candidates as LegacyCapabilityCandidate[])
      : reconcileLegacyInventory(snapshot);
    const collectors = Array.isArray(raw.collectors) ? raw.collectors : [];
    return { snapshot, candidates, collectors: collectors as LegacyProductInput["collectors"] };
  }
  const snapshot = verifyLegacyInventory(raw) as LegacyInventorySnapshotType;
  return { snapshot, candidates: reconcileLegacyInventory(snapshot), collectors: [] };
}

function readJson(path: string): unknown {
  const target = resolve(path);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new LegacyProductCommandError(
      "legacy/product_input_refused",
      `Refused '${path}': expected a regular, non-symbolic-link JSON file.`,
    );
  }
  if (stat.size > MAX_INPUT_BYTES) {
    throw new LegacyProductCommandError(
      "legacy/product_input_too_large",
      `Refused '${path}': input exceeds ${MAX_INPUT_BYTES} bytes.`,
    );
  }
  try {
    return JSON.parse(readFileSync(target, "utf8")) as unknown;
  } catch {
    throw new LegacyProductCommandError(
      "legacy/product_input_invalid",
      `Refused '${path}': input is not valid JSON.`,
    );
  }
}

function unwrap(value: unknown, key: string): unknown {
  return isRecord(value) && key in value ? value[key] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emit(
  report: unknown,
  options: OutputOptions,
  io: CliIO,
  summary: readonly string[],
): void {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) writeReport(options.out, serialized);
  if (options.json) io.out(serialized.trimEnd());
  else {
    for (const line of summary) io.out(line);
    if (options.out) io.out(`  report: ${options.out}`);
  }
}

function writeReport(path: string, content: string): void {
  const target = resolve(path);
  if (existsSync(target)) {
    if (readFileSync(target, "utf8") === content) return;
    throw new LegacyProductCommandError(
      "legacy/product_output_exists",
      `Refused to overwrite different legacy product output '${path}'.`,
    );
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
}

function refuse(
  error: unknown,
  options: OutputOptions,
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
  if (error instanceof LegacyProductCommandError) return error.code;
  const nodeCode =
    error !== null && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  if (["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(nodeCode ?? "")) {
    return "legacy/product_input_unreadable";
  }
  if (error instanceof z.ZodError) return "legacy/product_input_invalid";
  const message = error instanceof Error ? error.message : String(error);
  if (/candidate.+not found/i.test(message)) return "legacy/candidate_not_found";
  if (/does not match|do not match|stale|reconcile/i.test(message)) {
    return "legacy/product_input_stale";
  }
  return "legacy/product_failed";
}
