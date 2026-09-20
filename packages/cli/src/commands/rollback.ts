import {
  listBundleHistory,
  prepareRollback,
  resolveBundleDir,
  rollbackBundle,
} from "@anvil/generators";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import { reportDecisionRecord, reportPreservedStaleArtifacts } from "./approve.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";

/**
 * `anvil rollback <bundle> [--to <hash>]` — restore a retained generation.
 * The restore goes through the same stage-verify-swap an approval does
 * (`rollbackBundle` in `@anvil/generators`), so it refuses what an approval
 * refuses, retains the generation it replaces, and is recorded in the
 * approval record as a `rollback` naming every state that moved back.
 */
export function registerRollback(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("rollback")
      .summary("Restore a retained prior generation of a bundle, atomically.")
      .description(
        "Every approval, capability decision, and regeneration retains the generation it replaced under <bundle>/.anvil/history (bounded, default 5; ANVIL_BUNDLE_HISTORY_LIMIT overrides). This restores one of them — the newest by default, or the one `--to` names by bundle hash or hex prefix — through the same staged, byte-verified, surface-checked swap the approval used, records a `rollback` line in .anvil/approvals.jsonl with the reviewer and every operation or capability state that moved back, and retains the generation it replaced so the rollback can itself be undone. A retained generation this toolchain cannot reproduce from its own AIR is refused; recompile instead.",
      )
      .argument("<path>", "generated bundle directory or air.yaml")
      .option("--to <hash>", "the retained generation's bundle hash (or a hex prefix)")
      .option("--list", "print the retained generations and exit")
      .option(
        "--reviewer <id>",
        "who is restoring, recorded verbatim (absent records 'unrecorded')",
      )
      .option("--note <note>", "why, persisted with the record")
      .option("--dry-run", "run every gate and print what would move back; write nothing")
      .action((path: string, opts: RollbackOptions) => {
        ctx.code = runRollback(path, opts, ctx.io);
      }),
    { mutates: true },
  );
}

interface RollbackOptions {
  to?: string;
  list?: boolean;
  reviewer?: string;
  note?: string;
  dryRun?: boolean;
}

export function runRollback(path: string, opts: RollbackOptions, io: CliIO): number {
  if (opts.list === true) {
    const entries = listBundleHistory(resolveBundleDir(path));
    if (entries.length === 0) {
      io.out(
        "No retained generations. A decision or regeneration retains the generation it replaces.",
      );
      return 0;
    }
    io.out(`${entries.length} retained generation(s), newest first:`);
    for (const entry of entries) {
      io.out(`  ${entry.bundleHash.slice(0, 12)}  ${entry.recordedAt}  ${entry.path}`);
    }
    io.out(`Restore one with \`anvil rollback ${path} --to <hash>\`.`);
    return 0;
  }
  if (opts.dryRun === true) {
    const prepared = prepareRollback(path, opts.to);
    io.out(`Dry run — nothing was written to ${prepared.bundleDir}.`);
    io.out(
      `  would restore ${prepared.restored.id} (bundle ${prepared.restored.bundleHash.slice(0, 12)})`,
    );
    for (const subject of prepared.subjects) {
      if (subject.kind === "generation") continue;
      io.out(`  ${subject.kind} ${subject.id}: ${subject.from} → ${subject.to}`);
    }
    if (prepared.subjects.length === 1) io.out("  state changes: none (projections only)");
    return 0;
  }
  const result = rollbackBundle(path, {
    to: opts.to,
    reviewer: opts.reviewer,
    note: opts.note,
  });
  io.out(
    `Restored generation ${result.restored.id} (bundle ${result.restored.bundleHash.slice(0, 12)}) into ${result.bundleDir}.`,
  );
  for (const subject of result.subjects) {
    if (subject.kind === "generation") continue;
    io.out(`  ${subject.kind} ${subject.id}: ${subject.from} → ${subject.to}`);
  }
  reportPreservedStaleArtifacts(
    io,
    result.reprojection.existingFiles,
    result.reprojection.projectionsChanged,
    result.bundleDir,
  );
  reportDecisionRecord(io, result.reprojection.record, result.reprojection.history);
  if (result.reprojection.retainedBackup) {
    io.out(
      `  The replaced bundle backup could not be removed; it remains at ${result.reprojection.retainedBackup}.`,
    );
  }
  return 0;
}
