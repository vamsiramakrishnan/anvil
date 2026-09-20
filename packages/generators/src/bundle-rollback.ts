import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveAirPath } from "@anvil/refinement";
import { APPROVAL_RECORD_FILE, type ApprovalRecordSubject } from "./approval-record.js";
import { generateBundle } from "./bundle.js";
import { excludeHistory, type HistoryEntry, selectHistoryEntry } from "./bundle-history.js";
import { loadBundleAir, resolveBundleDir } from "./bundle-io.js";
import {
  assertCompleteBundle,
  assertSafeBundleRoot,
  type BundleReprojectionResult,
  type CommittedStage,
  commitStagedBundle,
  makeHiddenSibling,
  type ReprojectionDeps,
  type ReviewIdentity,
  readResourceOptions,
  verifyStagedBundle,
} from "./bundle-reproject.js";
import { bundleHash, readBundleDir } from "./certify.js";

/**
 * `anvil rollback`: restore a retained generation as the live bundle, through
 * the same stage-verify-swap the approval used to replace it. The retained
 * directory is copied into a sibling stage, proven to be exactly what this
 * toolchain generates from its own AIR (a generation the generator can no
 * longer reproduce is refused — recompile instead, do not resurrect bytes
 * nobody can regenerate), checked by the contract gate, then swapped in.
 * The generation it replaces is retained in turn, so a rollback is itself
 * rolled back the same way, and the approval record gains a `rollback` line
 * naming every operation and capability whose state moved.
 *
 * Only the approval record continues from the live bundle: everything else
 * in the restored generation — AIR, projections, preserved reports — is the
 * retained bytes, because a rollback that regenerated would not be a rollback.
 */
export interface RollbackOptions extends ReviewIdentity {
  /** A bundle hash or hex prefix naming the generation; the newest when absent. */
  to?: string;
  deps?: ReprojectionDeps;
}

export interface RollbackResult {
  bundleDir: string;
  restored: HistoryEntry;
  subjects: ApprovalRecordSubject[];
  reprojection: BundleReprojectionResult;
}

/** The state moves a restore would make: operations and capabilities, live → retained. */
export function rollbackSubjects(
  live: ReturnType<typeof loadBundleAir>,
  restored: ReturnType<typeof loadBundleAir>,
): ApprovalRecordSubject[] {
  const subjects: ApprovalRecordSubject[] = [];
  const restoredOps = new Map(restored.operations.map((op) => [op.id, op.state]));
  for (const op of live.operations) {
    const to = restoredOps.get(op.id);
    if (to !== undefined && to !== op.state) {
      subjects.push({ kind: "operation", id: op.id, from: op.state, to });
    }
  }
  const restoredCaps = new Map(restored.capabilities.map((cap) => [cap.id, cap.lifecycle]));
  for (const cap of live.capabilities) {
    const to = restoredCaps.get(cap.id);
    if (to !== undefined && to !== cap.lifecycle) {
      subjects.push({ kind: "capability", id: cap.id, from: cap.lifecycle, to });
    }
  }
  return subjects;
}

/** Everything a rollback decides before it writes; `anvil rollback --dry-run` stops here. */
export function prepareRollback(path: string, to?: string) {
  const bundleDir = resolve(resolveBundleDir(path));
  const airPath = resolve(resolveAirPath(path));
  assertSafeBundleRoot(bundleDir, airPath);
  const liveFiles = readBundleDir(bundleDir);
  assertCompleteBundle(liveFiles, bundleDir);
  const live = loadBundleAir(bundleDir, liveFiles);
  const restored = selectHistoryEntry(bundleDir, to);
  const restoredFiles = readBundleDir(restored.path);
  assertCompleteBundle(restoredFiles, restored.path);
  const restoredAir = loadBundleAir(restored.path, restoredFiles);
  const generated = generateBundle(
    restoredAir,
    readResourceOptions(restoredFiles, restoredAir.service.id),
  );
  const drift = Object.entries(generated.files)
    .filter(([rel, contents]) => restoredFiles[rel] !== contents)
    .map(([rel]) => rel);
  if (drift.length > 0) {
    throw new Error(
      `Rollback refused: retained generation ${restored.id} is not what this toolchain generates from its AIR (${drift.slice(0, 8).join(", ")}${drift.length > 8 ? ", …" : ""} differ). Recompile the bundle instead of restoring bytes that cannot be reproduced.`,
    );
  }
  const subjects: ApprovalRecordSubject[] = [
    {
      kind: "generation",
      id: restored.id,
      from: bundleHash(liveFiles),
      to: restored.bundleHash,
    },
    ...rollbackSubjects(live, restoredAir),
  ];
  return { bundleDir, liveFiles, restored, restoredFiles, restoredAir, generated, subjects };
}

export function rollbackBundle(path: string, options: RollbackOptions = {}): RollbackResult {
  const deps = options.deps ?? {};
  const prepared = prepareRollback(path, options.to);
  const { bundleDir, liveFiles, restored, restoredAir, generated, subjects } = prepared;
  const before = bundleHash(liveFiles);

  const stageDir = makeHiddenSibling(bundleDir, "rollback-stage");
  let committed: CommittedStage;
  try {
    rmSync(stageDir, { recursive: true, force: true });
    cpSync(restored.path, stageDir, {
      recursive: true,
      verbatimSymlinks: true,
      filter: excludeHistory(restored.path),
    });
    // The approval record is the bundle's, not the generation's: it continues.
    const liveRecord = join(bundleDir, ...APPROVAL_RECORD_FILE.split("/"));
    const stagedRecord = join(stageDir, ...APPROVAL_RECORD_FILE.split("/"));
    rmSync(stagedRecord, { force: true });
    if (existsSync(liveRecord)) {
      mkdirSync(dirname(stagedRecord), { recursive: true });
      copyFileSync(liveRecord, stagedRecord);
    }
    const stagedFiles = verifyStagedBundle(stageDir, generated.files, restoredAir, false);
    committed = commitStagedBundle(bundleDir, stageDir, deps, {
      before,
      after: bundleHash(stagedFiles),
      record: {
        action: "rollback",
        subjects,
        reviewer: options.reviewer,
        note: options.note,
      },
    });
  } finally {
    if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  }

  return {
    bundleDir,
    restored,
    subjects,
    reprojection: {
      bundleDir,
      generatedFileCount: Object.keys(generated.files).length,
      existingFiles: liveFiles,
      projectionsChanged: Object.entries(generated.files).some(
        ([rel, contents]) => liveFiles[rel] !== contents,
      ),
      ...committed,
    },
  };
}
