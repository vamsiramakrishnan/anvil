import { existsSync, readFileSync } from "node:fs";
import {
  approveCapabilityInBundle,
  approveOperationsInBundle,
  type BundleReprojectionResult,
  loadBundleAir,
  readBundleDir,
  rejectCapabilityInBundle,
} from "@anvil/generators";
import {
  applyPackToBundle,
  exportRefinementTask,
  importRefinementSubmission,
  recordPackDecision,
  selectTaskDeficiency,
} from "@anvil/refinement";
import type { z } from "zod";
import type { CONSOLE_ROUTES, ConsoleResponse, zReprojection } from "../contract.js";
import { invalidRequest } from "./errors.js";
import {
  consoleScratchPath,
  findBundle,
  findPack,
  resolveInsideRoot,
  safeSegment,
} from "./workspace.js";

/**
 * The POST routes. Each one is a thin caller of the library function the CLI
 * command calls — the table in packages/console/README.md — with exactly the
 * CLI's arguments, so the receipt or reprojection it returns is the one the
 * command line would have produced. Nothing here decides anything: the
 * compiler's review gate, the atomic reprojection, the receipt binding, and
 * the benchmark-scored admission all run inside the functions called.
 */

export type Request<R extends keyof typeof CONSOLE_ROUTES> = (typeof CONSOLE_ROUTES)[R] extends {
  request: infer S extends z.ZodType;
}
  ? z.infer<S>
  : never;

/** The records `anvil approve` names as preserved-but-stale after a reprojection. */
const DERIVED_RECORD_FILES = new Set([
  "certification.json",
  "publication.json",
  "selftest.report.json",
  "conformance.report.json",
  "conformance.live.report.json",
  "simulation.report.json",
]);

function summarizeReprojection(result: BundleReprojectionResult): z.infer<typeof zReprojection> {
  const files = Object.keys(result.existingFiles);
  return {
    bundleDir: result.bundleDir,
    generatedFileCount: result.generatedFileCount,
    projectionsChanged: result.projectionsChanged,
    ...(result.retainedBackup ? { retainedBackup: result.retainedBackup } : {}),
    stale: {
      targetFiles: files.filter((rel) => rel.startsWith("targets/")),
      records: files.filter((rel) => DERIVED_RECORD_FILES.has(rel) || rel.endsWith(".report.json")),
      gatewayReceipt: result.existingFiles["import.receipt.json"] !== undefined,
    },
  };
}

export function approveOperations(
  root: string,
  id: string,
  body: Request<"approveOperations">,
): ConsoleResponse<"approveOperations"> {
  const bundle = findBundle(root, id);
  const result = approveOperationsInBundle(bundle.dir, body.ids);
  return {
    approved: result.newlyApproved,
    alreadyApproved: result.requested.filter((op) => !result.newlyApproved.includes(op)),
    regeneratedFiles: result.reprojection.generatedFileCount,
    reprojection: summarizeReprojection(result.reprojection),
    refusals: [],
  };
}

export function approveCapability(
  root: string,
  id: string,
  capabilityId: string,
  body: Request<"approveCapability">,
): ConsoleResponse<"approveCapability"> {
  const bundle = findBundle(root, id);
  const { budget, reprojection } = approveCapabilityInBundle(bundle.dir, capabilityId, {
    allowLarge: body.allowLarge === true,
    ...(body.note !== undefined ? { note: body.note } : {}),
  });
  return { capabilityId, budget, reprojection: summarizeReprojection(reprojection) };
}

export function rejectCapability(
  root: string,
  id: string,
  capabilityId: string,
  body: Request<"rejectCapability">,
): ConsoleResponse<"rejectCapability"> {
  const bundle = findBundle(root, id);
  const reprojection = rejectCapabilityInBundle(bundle.dir, capabilityId, body.reason);
  return { capabilityId, reprojection: summarizeReprojection(reprojection) };
}

export function packDecision(
  root: string,
  id: string,
  hash: string,
  body: Request<"packDecision">,
): ConsoleResponse<"packDecision"> {
  const bundle = findBundle(root, id);
  const air = loadBundleAir(bundle.dir, readBundleDir(bundle.dir));
  const pack = findPack(root, air.service.id, hash);
  const receipts = recordPackDecision(
    pack.dir,
    body.decision === "approve" ? "approved" : "rejected",
    body.refinementIds,
    body.reviewer,
    body.reason,
  );
  return { receipts };
}

/**
 * `anvil refine apply-pack` writes AIR only and tells the reviewer to
 * regenerate the bundle; the console does exactly that, so the two never
 * leave a bundle in different states. `reprojection` is therefore absent.
 */
export function applyPack(
  root: string,
  id: string,
  hash: string,
  body: Request<"applyPack">,
): ConsoleResponse<"applyPack"> {
  const bundle = findBundle(root, id);
  const air = loadBundleAir(bundle.dir, readBundleDir(bundle.dir));
  const pack = findPack(root, air.service.id, hash);
  const result = applyPackToBundle(bundle.dir, pack.dir, {
    receiptFiles: (body.receiptFiles ?? []).map((file) => resolveInsideRoot(root, file)),
    dryRun: body.dryRun === true,
  });
  return {
    airPath: result.airPath,
    applied: result.applied.map((refinement) => refinement.id),
    // A semantic change that adds (or removes) a node has no `before` (or
    // `after`); JSON cannot carry `undefined`, so the absent side is `null`.
    changes: result.changes.map((change) => ({
      ...change,
      before: change.before ?? null,
      after: change.after ?? null,
    })),
    written: result.written,
  };
}

export function exportTask(
  root: string,
  id: string,
  clusterId: string,
  body: Request<"exportTask">,
): ConsoleResponse<"exportTask"> {
  const bundle = findBundle(root, id);
  // Every path the body names is checked against the root before anything is
  // read or chosen, so a path escape is refused ahead of any other outcome.
  const trafficReportPath =
    body.trafficReportPath !== undefined
      ? resolveInsideRoot(root, body.trafficReportPath)
      : undefined;
  const taskPath =
    body.outFile !== undefined
      ? resolveInsideRoot(root, body.outFile)
      : consoleScratchPath(root, "tasks", safeSegment(id), `${safeSegment(clusterId)}.task.json`);
  const repositoryRoot =
    body.repositoryRoot !== undefined ? resolveInsideRoot(root, body.repositoryRoot) : root;
  const air = loadBundleAir(bundle.dir, readBundleDir(bundle.dir));
  const deficiency = selectTaskDeficiency(air, bundle.dir, `group:${clusterId}`, {
    ...(trafficReportPath !== undefined ? { trafficReportPath } : {}),
    displayPath: bundle.dir,
  });
  const task = exportRefinementTask(air, deficiency, taskPath, {
    repositoryRoot,
    ...(body.inspectScopes !== undefined ? { inspectScopes: body.inspectScopes } : {}),
  });
  return { taskPath, task };
}

function readJsonInsideRoot(root: string, path: string, what: string): unknown {
  const resolved = resolveInsideRoot(root, path);
  if (!existsSync(resolved)) {
    throw invalidRequest(`The ${what} file does not exist.`, [`${what}: no such file '${path}'`]);
  }
  try {
    return JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    throw invalidRequest(`The ${what} file is not valid JSON.`, [
      `${what}: ${(error as Error).message}`,
    ]);
  }
}

export async function importTask(
  root: string,
  id: string,
  body: Request<"importTask">,
): Promise<ConsoleResponse<"importTask">> {
  const bundle = findBundle(root, id);
  const air = loadBundleAir(bundle.dir, readBundleDir(bundle.dir));
  const task = readJsonInsideRoot(root, body.taskPath, "task");
  const submission = readJsonInsideRoot(root, body.submissionPath, "submission");
  const taskId =
    typeof task === "object" &&
    task !== null &&
    typeof (task as { taskId?: unknown }).taskId === "string"
      ? (task as { taskId: string }).taskId
      : "task";
  const packDir =
    body.outDir !== undefined
      ? resolveInsideRoot(root, body.outDir)
      : consoleScratchPath(root, "packs", safeSegment(taskId));
  const { pack, delta } = await importRefinementSubmission(air, task, submission, packDir, {
    repositoryRoot:
      body.repositoryRoot !== undefined ? resolveInsideRoot(root, body.repositoryRoot) : root,
  });
  const record = pack.harnessImports?.[0];
  if (!record) throw new Error("Imported pack is missing its harness provenance record.");
  const refinement = pack.refinements[0];
  return {
    taskId: record.task.taskId,
    packDir,
    summary: pack.summary,
    ...(refinement
      ? {
          refinement: {
            id: refinement.id,
            status: refinement.status,
            tier: refinement.approval.tier,
          },
        }
      : {}),
    ...(delta !== undefined ? { delta } : {}),
  };
}
