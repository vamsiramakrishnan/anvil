import {
  type ApprovalRecord,
  approveOperationsInBundle,
  type HistoryEntry,
  previewOperationApproval,
  profileApprovalCandidates,
  type ReprojectionDeps,
  type ReviewIdentity,
  renderApprovalPreview,
} from "@anvil/generators";
import { loadAir } from "@anvil/refinement";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * Derived records a reprojection preserves but does not regenerate. Naming
 * them in the output is the CLI's job; the atomic approval itself lives in
 * `@anvil/generators` (`approveOperationsInBundle`, `reprojectBundleAtomically`)
 * so every reviewer surface approves through the same gates.
 */
const DERIVED_RECORD_FILES = new Set([
  "certification.json",
  "publication.json",
  "selftest.report.json",
  "conformance.report.json",
  "conformance.live.report.json",
  "simulation.report.json",
]);

export interface ApproveOptions extends ReviewIdentity {
  /** Stage the approval in memory and print what would change; write nothing. */
  dryRun?: boolean;
  /** Approve every pending operation of the bundle's exposure profile. */
  profile?: boolean;
}

/** `anvil approve` — approve and atomically re-project the complete bundle. */
export function registerApprove(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("approve")
      .summary("Approve operations so they are exposed by the generated artifacts.")
      .description(
        "Only approved operations appear in the MCP server, CLI catalog, compiled runtime, and skill. Approve deliberately after inspecting risk. The AIR and every generated projection are staged, checked for exact bytes and surface agreement, then swapped into place together; the replaced generation is retained under .anvil/history (see `anvil rollback`) and the decision is appended to .anvil/approvals.jsonl with the reviewer, the states that moved, and the bundle hash before and after. Receipt-bound gateway imports refuse in-place approval and provide the exact manifest re-import command so import-to-approval lineage stays immutable.",
      )
      .argument("<path>", "generated bundle directory or air.yaml")
      .argument("[operation-ids...]", "operation ids to approve (or pass --profile)")
      .option(
        "--profile",
        "approve every exposed, unblocked operation of the bundle's exposure profile; requires --reviewer and records the profile digest",
      )
      .option(
        "--reviewer <id>",
        "who is approving, recorded verbatim in the approval record (absent records 'unrecorded')",
      )
      .option("--note <note>", "review note persisted with the decision")
      .option(
        "--dry-run",
        "run every gate and print what would change across the MCP, CLI, and skill surfaces; write nothing",
      )
      .action((path: string, ids: string[], opts: ApproveOptions) => {
        ctx.code = runApprove(path, ids, ctx.io, {}, opts);
      }),
    { mutates: true },
  );
}

/**
 * Approve only inside a complete compiled bundle. Nothing under the live path
 * changes until a sibling staging copy has been regenerated and verified.
 */
export function runApprove(
  path: string,
  ids: string[],
  io: CliIO,
  deps: ReprojectionDeps = {},
  opts: ApproveOptions = {},
): number {
  if (opts.profile === true) {
    const resolved = profileApproval(path, ids, io, opts);
    if (resolved === undefined) return 1;
    if (resolved.ids.length === 0) {
      io.out("Every exposed operation of the profile is already approved or blocked.");
      return 0;
    }
    ids = resolved.ids;
    opts = { ...opts, note: resolved.note };
  } else if (ids.length === 0) {
    io.err("anvil: pass operation ids to approve, or --profile to approve the exposure profile.");
    return 1;
  }
  if (opts.dryRun === true) {
    for (const line of renderApprovalPreview(previewOperationApproval(path, ids))) io.out(line);
    return 0;
  }
  const {
    requested,
    newlyApproved,
    reprojection: result,
  } = approveOperationsInBundle(path, ids, deps, { reviewer: opts.reviewer, note: opts.note });

  io.out(
    `Approved ${newlyApproved.length} new operation(s) (${requested.length} requested) and atomically regenerated ${result.generatedFileCount} bundle files in ${result.bundleDir}.`,
  );
  if (requested.length > newlyApproved.length) {
    io.out(`  ${requested.length - newlyApproved.length} operation(s) were already approved.`);
  }
  reportPreservedStaleArtifacts(
    io,
    result.existingFiles,
    result.projectionsChanged,
    result.bundleDir,
  );
  reportDecisionRecord(io, result.record, result.history);
  if (result.retainedBackup) {
    io.out(
      `  The replaced bundle backup could not be removed; it remains at ${result.retainedBackup}.`,
    );
  }
  return 0;
}

/**
 * Resolve `--profile` into explicit ids. The reviewer must be named and the
 * record's note carries the profile id and digest, so the decision in
 * .anvil/approvals.jsonl says which reviewed selection it approved. Blocked
 * operations are named, never approved.
 */
function profileApproval(
  path: string,
  ids: string[],
  io: CliIO,
  opts: ApproveOptions,
): { ids: string[]; note: string } | undefined {
  if (ids.length > 0) {
    io.err("anvil: pass either operation ids or --profile, not both.");
    return undefined;
  }
  if (!opts.reviewer?.trim()) {
    io.err("anvil: --profile approves in bulk and needs --reviewer <id> for the approval record.");
    return undefined;
  }
  let candidates: ReturnType<typeof profileApprovalCandidates>;
  try {
    candidates = profileApprovalCandidates(loadAir(path));
  } catch (err) {
    io.err(`anvil: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  if (candidates.blocked.length > 0) {
    io.err(
      `  ${candidates.blocked.length} exposed operation(s) are blocked and were not approved: ${candidates.blocked.join(", ")}.`,
    );
  }
  const base = `Exposure profile ${candidates.profileId} (${candidates.digest}): ${candidates.pending.length} operation(s).`;
  return { ids: candidates.pending, note: opts.note ? `${base} ${opts.note}` : base };
}

/** The record line every decision prints: who, when, and which generation was retained. */
export function reportDecisionRecord(
  io: CliIO,
  record: ApprovalRecord,
  history: HistoryEntry | undefined,
): void {
  io.out(
    `  Recorded by ${record.reviewer} at ${record.recordedAt} (bundle ${record.bundleHash.before.slice(0, 12)} → ${record.bundleHash.after.slice(0, 12)}) in .anvil/approvals.jsonl.`,
  );
  if (history) {
    io.out(`  Retained the replaced generation as ${history.id}; \`anvil rollback\` restores it.`);
  }
}

export function reportPreservedStaleArtifacts(
  io: CliIO,
  existingFiles: Record<string, string>,
  projectionsChanged: boolean,
  bundleDir: string,
): void {
  if (!projectionsChanged) return;
  const targets = Object.keys(existingFiles).filter((rel) => rel.startsWith("targets/"));
  if (targets.length > 0) {
    io.out(
      `  Preserved ${targets.length} target artifact file(s) under targets/; they were not regenerated and are now stale. Re-run \`anvil target\` with the original target options before registration.`,
    );
  }
  if (existingFiles["import.receipt.json"] !== undefined) {
    io.out(
      "  Preserved the immutable gateway import id and marked its bundled output lineage stale; re-run `anvil estate verify <import-id> --bundle <bundle>` to inspect the derived-state mismatch.",
    );
  }
  const records = Object.keys(existingFiles).filter(
    (rel) => DERIVED_RECORD_FILES.has(rel) || rel.endsWith(".report.json"),
  );
  if (records.length > 0) {
    io.out(
      `  Preserved ${records.length} certification/publication/test record(s); they were not regenerated and no longer attest to ${bundleDir}. Re-run the relevant gates before release.`,
    );
  }
}
