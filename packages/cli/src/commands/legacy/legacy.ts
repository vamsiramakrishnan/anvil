import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  collectLegacyInventory,
  EvidenceSourceKind,
  LegacyCollectorKind,
  LegacyIdentifier,
  type LegacyInventoryResult,
} from "@anvil/compiler/legacy";
import type { Command } from "commander";
import { emitRefusal } from "../../envelope.js";
import type { CliIO } from "../../io.js";
import type { CommandContext } from "../context.js";
import { annotate } from "../meta.js";
import { readLegacySourceSet } from "./source-files.js";

const REPORT_TYPE = "anvil.legacy-estate-inventory";
const ERROR_REPORT_TYPE = "anvil.legacy-estate-inventory-error";

interface LegacyInventoryReport {
  schemaVersion: 1;
  reportType: typeof REPORT_TYPE;
  inventory: LegacyInventoryResult["snapshot"];
  collectors: LegacyInventoryResult["collectors"];
  candidates: LegacyInventoryResult["candidates"];
  summary: {
    artifacts: number;
    evidence: number;
    observations: number;
    candidates: number;
    conflicts: number;
    diagnostics: { error: number; warning: number; info: number };
  };
}

interface LegacyInventoryOptions {
  environment: string;
  application: string;
  estate?: string;
  estateName?: string;
  sourceId?: string;
  sourceKind?: string;
  revision?: string;
  collector?: string;
  out?: string;
  check?: boolean;
  json?: boolean;
}

class LegacyInventoryCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function registerLegacy(parent: Command, ctx: CommandContext): void {
  const legacy = parent
    .command("legacy")
    .summary("Inventory offline legacy application and messaging evidence.")
    .description(
      "Discover evidence-backed EJB, WCF, resource-adapter, and messaging invocation candidates from caller-supplied offline exports. Collection never connects to a server or broker, loads an assembly, executes bytecode, opens an archive, reads a queue, or invents business semantics.",
    );

  annotate(
    legacy
      .command("inventory")
      .summary("Build a content-addressed legacy estate inventory without invoking the estate.")
      .description(
        "Reads one regular file or hardened-expanded directory without following symbolic links. The default auto collector recognizes Java EE/WebLogic/WebSphere/JBoss descriptors, .NET Framework/WCF configuration, and supported broker or AsyncAPI exports. Physical bindings remain evidenced claims, and disagreements remain conflicts for review.",
      )
      .argument("<source>", "offline export file or hardened-expanded directory")
      .requiredOption("--environment <id>", "deployment environment coordinate")
      .requiredOption("--application <id>", "application coordinate")
      .option("--estate <id>", "estate id (default: source directory or file name)")
      .option("--estate-name <name>", "human-readable estate name")
      .option("--source-id <id>", "stable evidence-system id (default: <estate>:<environment>)")
      .option(
        "--source-kind <kind>",
        `evidence authority (${EvidenceSourceKind.options.join(" | ")})`,
        "deployed_configuration",
      )
      .option("--revision <revision>", "immutable source revision or export digest label")
      .option(
        "--collector <collector>",
        `collector lane (${LegacyCollectorKind.options.join(" | ")})`,
        "auto",
      )
      .option("--out <file>", "write the complete report without overwriting different content")
      .option("--check", "exit non-zero when any candidate contains a conflict")
      .option("--json", "emit the complete machine-readable report")
      .action((source: string, options: LegacyInventoryOptions) => {
        ctx.code = runLegacyInventory(source, options, ctx.io);
      }),
    { mutates: true },
  );
}

function runLegacyInventory(source: string, options: LegacyInventoryOptions, io: CliIO): number {
  try {
    const sourceKind = parseOption(
      "--source-kind",
      options.sourceKind ?? "deployed_configuration",
      EvidenceSourceKind,
    );
    const collector = parseOption("--collector", options.collector ?? "auto", LegacyCollectorKind);
    const sourceSet = readLegacySourceSet(source);
    const estate = parseIdentifier("--estate", options.estate ?? sourceSet.label);
    const environment = parseIdentifier("--environment", options.environment);
    const application = parseIdentifier("--application", options.application);
    const sourceId = parseIdentifier("--source-id", options.sourceId ?? `${estate}:${environment}`);
    const result = collectLegacyInventory({
      estate: { id: estate, ...(options.estateName ? { name: options.estateName } : {}) },
      environment,
      application,
      source: {
        kind: sourceKind,
        systemId: sourceId,
        ...(options.revision ? { revision: options.revision } : {}),
      },
      collector,
      members: sourceSet.members.map(({ path, bytes }) => ({ path, bytes })),
    });
    const report = buildLegacyInventoryReport(result);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.out) writeReport(options.out, serialized);

    if (options.json) io.out(serialized.trimEnd());
    else renderSummary(report, options.out, io);

    if (report.summary.diagnostics.error > 0) return 1;
    if (options.check && report.summary.conflicts > 0) return 1;
    return 0;
  } catch (error) {
    return emitRefusal(io, options.json, {
      reportType: ERROR_REPORT_TYPE,
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
      details: { source },
    });
  }
}

function buildLegacyInventoryReport(result: LegacyInventoryResult): LegacyInventoryReport {
  const diagnostics = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of result.snapshot.diagnostics) diagnostics[diagnostic.level] += 1;
  return {
    schemaVersion: 1,
    reportType: REPORT_TYPE,
    inventory: result.snapshot,
    collectors: result.collectors,
    candidates: result.candidates,
    summary: {
      artifacts: result.snapshot.artifacts.length,
      evidence: result.snapshot.evidence.length,
      observations: result.snapshot.observations.length,
      candidates: result.candidates.length,
      conflicts: result.candidates.reduce(
        (total, candidate) => total + candidate.conflicts.length,
        0,
      ),
      diagnostics,
    },
  };
}

function writeReport(path: string, content: string): void {
  const target = resolve(path);
  if (existsSync(target)) {
    if (readFileSync(target, "utf8") === content) return;
    throw new Error(`Refused to overwrite different legacy inventory report '${path}'.`);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
}

function renderSummary(report: LegacyInventoryReport, output: string | undefined, io: CliIO): void {
  io.out(`Legacy inventory ${report.inventory.inventoryId}`);
  io.out(
    `  ${report.summary.artifacts} artifact(s), ${report.summary.evidence} evidence record(s), ${report.summary.observations} invocation observation(s)`,
  );
  io.out(
    `  ${report.summary.candidates} candidate(s), ${report.summary.conflicts} explicit conflict(s)`,
  );
  io.out(
    `  diagnostics: ${report.summary.diagnostics.error} error(s), ${report.summary.diagnostics.warning} warning(s), ${report.summary.diagnostics.info} info`,
  );
  if (output) io.out(`  report: ${output}`);
  if (report.summary.candidates > 0) {
    io.out(
      "  Next: review technical bindings and supply business semantics before generating a bridge.",
    );
  }
}

function errorCode(error: unknown): string {
  if (error instanceof LegacyInventoryCommandError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  const nodeCode =
    error !== null && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  if (["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(nodeCode ?? "")) {
    return "legacy/source_unreadable";
  }
  if (nodeCode === "EEXIST") return "legacy/output_exists";
  if (/symbolic link/i.test(message)) return "legacy/source_symlink_refused";
  if (/limit|exceeds/i.test(message)) return "legacy/source_limit_exceeded";
  if (/non-regular|regular file or directory/i.test(message)) {
    return "legacy/source_member_refused";
  }
  if (/overwrite/i.test(message)) return "legacy/output_exists";
  return "legacy/inventory_failed";
}

function parseIdentifier(option: string, value: string): string {
  const parsed = LegacyIdentifier.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new LegacyInventoryCommandError(
    "legacy/invalid_coordinate",
    `Invalid ${option} '${value}'. Use 1-256 characters beginning with a letter or digit; spaces are not allowed.`,
  );
}

function parseOption<T extends string>(
  option: string,
  value: string,
  schema: {
    options: readonly T[];
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new LegacyInventoryCommandError(
    "legacy/invalid_option",
    `Invalid ${option} '${value}'. Use: ${schema.options.join(" | ")}.`,
  );
}
