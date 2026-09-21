import type { AirDocument } from "@anvil/air";
import type { ApproveCapabilityOptions, CapabilityBudgetCheck } from "@anvil/compiler";
import { loadAir } from "@anvil/refinement";
import type { ApprovalRecordSubject } from "./approval-record.js";
import {
  prepareCapabilityDecision,
  prepareOperationApproval,
  stageReprojection,
} from "./bundle-reproject.js";
import { servedSurface } from "./served-surface.js";

/**
 * The pre-approval preview: what a decision would change across every
 * surface, computed by staging the reprojection in memory and never swapping
 * it in. It runs the same gates the real decision runs (`prepare*`,
 * `stageReprojection`), so a refusal here is the refusal the decision would
 * hit, and a preview that shows nothing changing is a decision that would
 * write nothing new. `anvil approve --dry-run` and the console's Preview
 * action are both thin callers of this.
 */
export interface ApprovalPreview {
  bundleDir: string;
  /** Operations or capabilities whose state would move, with both states. */
  subjects: ApprovalRecordSubject[];
  /** MCP tool names that would start (or stop) being served, after workflow supersession. */
  mcpTools: { added: string[]; removed: string[] };
  /** CLI commands that would start (or stop) being exposed. */
  cliCommands: { added: string[]; removed: string[] };
  /** Skill files whose bytes would change — the sections an agent reads. */
  skillFiles: string[];
  /** Every projection whose bytes would be regenerated. */
  regeneratedFiles: string[];
  generatedFileCount: number;
  projectionsChanged: boolean;
  /** The live bundle's files, for naming preserved-but-stale records. */
  existingFiles: Record<string, string>;
}

function difference(before: readonly string[], after: readonly string[]) {
  const was = new Set(before);
  const is = new Set(after);
  return {
    added: after.filter((name) => !was.has(name)),
    removed: before.filter((name) => !is.has(name)),
  };
}

/** Stage `after` over the live bundle and describe the difference; writes nothing. */
export function previewReprojection(
  path: string,
  before: AirDocument,
  after: AirDocument,
  subjects: ApprovalRecordSubject[],
): ApprovalPreview {
  const staged = stageReprojection(path, after);
  const was = servedSurface(before);
  const is = servedSurface(after);
  const regeneratedFiles = Object.entries(staged.generated.files)
    .filter(([rel, contents]) => staged.existingFiles[rel] !== contents)
    .map(([rel]) => rel)
    .sort();
  return {
    bundleDir: staged.bundleDir,
    subjects,
    mcpTools: difference(was.after, is.after),
    cliCommands: difference(was.cliCommands, is.cliCommands),
    skillFiles: regeneratedFiles.filter((rel) => rel.startsWith("skill/")),
    regeneratedFiles,
    generatedFileCount: Object.keys(staged.generated.files).length,
    projectionsChanged: staged.projectionsChanged,
    existingFiles: staged.existingFiles,
  };
}

/** What `anvil approve <path> <ids>` would do. Same refusals, no write. */
export function previewOperationApproval(path: string, ids: readonly string[]): ApprovalPreview {
  const before = loadAir(path);
  const prepared = prepareOperationApproval(path, ids);
  return previewReprojection(path, before, prepared.air, prepared.subjects);
}

/** What `anvil capability approve|reject` would do. Same review gate, no write. */
export interface CapabilityDecisionPreview extends ApprovalPreview {
  /**
   * The budget the admission path PREPARED, not a fresh reading of the
   * unchanged AIR. They differ exactly where it matters: an explicit
   * `allowLarge` waiver turns a blocked budget into an accepted one with a
   * warning, and a preview that recomputed would tell a reviewer the decision
   * is blocked while the approval it is previewing would record it accepted.
   */
  budget?: CapabilityBudgetCheck;
}

export function previewCapabilityDecision(
  path: string,
  capabilityId: string,
  decision: "approve" | "reject",
  opts: ApproveCapabilityOptions & { reason?: string } = {},
): CapabilityDecisionPreview {
  const before = loadAir(path);
  const prepared = prepareCapabilityDecision(path, capabilityId, decision, opts);
  const preview = previewReprojection(path, before, prepared.air, prepared.subjects);
  return { ...preview, ...(prepared.budget ? { budget: prepared.budget } : {}) };
}

/** The preview as the CLI prints it: one line per surface that would change. */
export function renderApprovalPreview(preview: ApprovalPreview): string[] {
  const lines: string[] = [];
  const list = (values: readonly string[]) => (values.length > 0 ? values.join(", ") : "none");
  lines.push(`Dry run — nothing was written to ${preview.bundleDir}.`);
  if (preview.subjects.length === 0)
    lines.push("  state changes: none (already in the requested state)");
  for (const subject of preview.subjects) {
    lines.push(`  ${subject.kind} ${subject.id}: ${subject.from} → ${subject.to}`);
  }
  lines.push(`  MCP tools added: ${list(preview.mcpTools.added)}`);
  if (preview.mcpTools.removed.length > 0)
    lines.push(`  MCP tools removed: ${list(preview.mcpTools.removed)}`);
  lines.push(`  CLI commands added: ${list(preview.cliCommands.added)}`);
  if (preview.cliCommands.removed.length > 0)
    lines.push(`  CLI commands removed: ${list(preview.cliCommands.removed)}`);
  lines.push(`  skill files affected: ${list(preview.skillFiles)}`);
  lines.push(
    `  projections regenerated: ${preview.regeneratedFiles.length} of ${preview.generatedFileCount}${
      preview.regeneratedFiles.length > 0
        ? ` (${preview.regeneratedFiles.slice(0, 8).join(", ")}${preview.regeneratedFiles.length > 8 ? ", …" : ""})`
        : ""
    }`,
  );
  return lines;
}
