import { approveOperationsInBundle, type ReprojectionDeps } from "@anvil/generators";
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

/** `anvil approve` — approve and atomically re-project the complete bundle. */
export function registerApprove(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("approve")
      .summary("Approve operations so they are exposed by the generated artifacts.")
      .description(
        "Only approved operations appear in the MCP server, CLI catalog, compiled runtime, and skill. Approve deliberately after inspecting risk. The AIR and every generated projection are staged, checked for exact bytes and surface agreement, then swapped into place together. Receipt-bound gateway imports refuse in-place approval and provide the exact manifest re-import command so import-to-approval lineage stays immutable.",
      )
      .argument("<path>", "generated bundle directory or air.yaml")
      .argument("<operation-ids...>", "operation ids to approve")
      .action((path: string, ids: string[]) => {
        ctx.code = runApprove(path, ids, ctx.io);
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
): number {
  const {
    requested,
    newlyApproved,
    reprojection: result,
  } = approveOperationsInBundle(path, ids, deps);

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
  if (result.retainedBackup) {
    io.out(
      `  The replaced bundle backup could not be removed; it remains at ${result.retainedBackup}.`,
    );
  }
  return 0;
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
