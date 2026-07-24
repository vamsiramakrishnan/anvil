import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  approveOperations,
  GatewayImportReceiptView,
  gatewayBundleManifest,
  isGatewayLifecycleArtifact,
} from "@anvil/compiler";
import {
  certifyBundle,
  GENERATION_METADATA_FILE,
  generateBundle,
  type ResourceOptions,
  readBundleDir,
  resourceOptionsFromGenerationMetadata,
  writeBundle,
} from "@anvil/generators";
import { GEMINI_ENTERPRISE_PROFILE, verifyTargetKit } from "@anvil/targets";
import type { Command } from "commander";
import type { CliIO } from "../io.js";
import { resolveBundleDir } from "./certify.js";
import type { CommandContext } from "./context.js";
import { annotate } from "./meta.js";
import { loadAir, resolveAirPath } from "./shared.js";

const REQUIRED_BUNDLE_FILES = [
  "air.yaml",
  "air.json",
  "generation.json",
  "catalog.json",
  "cli/air.json",
  "mcp/air.json",
  "mcp/resources.json",
  "runtime/air.json",
  "runtime/operations.manifest.json",
  "skill/SKILL.md",
] as const;

const DERIVED_RECORD_FILES = new Set([
  "certification.json",
  "publication.json",
  "selftest.report.json",
  "conformance.report.json",
  "conformance.live.report.json",
  "simulation.report.json",
]);

/** Filesystem seam for proving rollback after the live bundle has been moved aside. */
export interface ApproveDeps {
  installStagedBundle?: (stageDir: string, bundleDir: string) => void;
}

export interface BundleReprojectionResult {
  bundleDir: string;
  generatedFileCount: number;
  existingFiles: Record<string, string>;
  projectionsChanged: boolean;
  retainedBackup?: string;
}

/** `anvil approve` — approve and atomically re-project the complete bundle. */
export function registerApprove(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("approve")
      .summary("Approve operations so they are exposed by the generated artifacts.")
      .description(
        "Only approved operations appear in the MCP server, CLI catalog, compiled runtime, and skill. Approve deliberately after inspecting risk. The AIR and every generated projection are staged, checked for exact bytes and surface agreement, then swapped into place together; existing certification records, reports, and target kits are preserved but become stale when the approval state changes.",
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
export function runApprove(path: string, ids: string[], io: CliIO, deps: ApproveDeps = {}): number {
  const bundleDir = resolve(resolveBundleDir(path));
  const airPath = resolve(resolveAirPath(path));
  assertSafeBundleRoot(bundleDir, airPath);

  const existingFiles = readBundleDir(bundleDir);
  assertCompleteBundle(existingFiles, bundleDir);
  const air = loadAir(path);
  const requested = [...new Set(ids)];
  validateApprovals(air.operations, requested);
  const newlyApproved = requested.filter(
    (id) => air.operations.find((op) => op.id === id)?.state !== "approved",
  );

  approveOperations(air, requested);
  const result = reprojectBundleAtomically(
    path,
    air,
    "Operation approval regenerated executable bundle projections after the immutable gateway import receipt was issued.",
    deps,
  );

  io.out(
    `Approved ${newlyApproved.length} new operation(s) (${requested.length} requested) and atomically regenerated ${result.generatedFileCount} bundle files in ${bundleDir}.`,
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

/**
 * Persist any AIR mutation through the one safe reprojection path. The caller
 * mutates an in-memory AIR document; this function regenerates every
 * compiler-owned projection, verifies exact bytes and surface agreement, then
 * swaps the complete staged directory into place with rollback.
 */
export function reprojectBundleAtomically(
  path: string,
  air: ReturnType<typeof loadAir>,
  gatewayStaleReason: string,
  deps: ApproveDeps = {},
): BundleReprojectionResult {
  const bundleDir = resolve(resolveBundleDir(path));
  const airPath = resolve(resolveAirPath(path));
  assertSafeBundleRoot(bundleDir, airPath);

  const existingFiles = readBundleDir(bundleDir);
  assertCompleteBundle(existingFiles, bundleDir);
  const resourceOptions = readResourceOptions(existingFiles, air.service.id);
  const generated = generateBundle(air, resourceOptions);
  const projectionsChanged = Object.entries(generated.files).some(
    ([rel, contents]) => existingFiles[rel] !== contents,
  );

  const stageDir = makeHiddenSibling(bundleDir, "reproject-stage");
  let retainedBackup: string | undefined;
  try {
    cpSync(bundleDir, stageDir, {
      recursive: true,
      verbatimSymlinks: true,
    });
    resetGeneratedRoots(stageDir, generated.files);
    writeBundle(stageDir, generated);
    const gatewayLineageIntentionallyStale = markGatewayLineageStale(
      stageDir,
      existingFiles,
      generated.files,
      air,
      projectionsChanged,
      gatewayStaleReason,
    );
    verifyStagedBundle(stageDir, generated.files, air, gatewayLineageIntentionallyStale);
    retainedBackup = replaceBundle(bundleDir, stageDir, deps);
  } finally {
    // After a successful install the rename consumed stageDir. After any
    // pre-commit or rolled-back failure, this removes only the candidate copy.
    if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  }

  return {
    bundleDir,
    generatedFileCount: Object.keys(generated.files).length,
    existingFiles,
    projectionsChanged,
    ...(retainedBackup ? { retainedBackup } : {}),
  };
}

function markGatewayLineageStale(
  stageDir: string,
  existingFiles: Record<string, string>,
  generatedFiles: Record<string, string>,
  air: ReturnType<typeof loadAir>,
  projectionsChanged: boolean,
  reason: string,
): boolean {
  if (!projectionsChanged) return false;
  const text = existingFiles["import.receipt.json"];
  if (text === undefined) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return false;
  }
  const parsed = GatewayImportReceiptView.safeParse(raw);
  if (!parsed.success) return false;
  const stagedFiles = readBundleDir(stageDir);
  const targetPaths = Object.keys(stagedFiles).filter((path) => path.startsWith("targets/"));
  if (targetPaths.some((path) => !path.startsWith(`targets/${GEMINI_ENTERPRISE_PROFILE.id}/`))) {
    throw new Error(
      "Gateway approval found an unrecognized target subtree; move or remove it before changing receipt-bound output.",
    );
  }
  const verifiedTarget = verifyTargetKit(air, GEMINI_ENTERPRISE_PROFILE, stagedFiles);
  if (!verifiedTarget.ok) {
    throw new Error(
      `Gateway approval cannot bind an unverified target subtree: ${verifiedTarget.findings.map((finding) => finding.detail).join("; ")}`,
    );
  }
  const generatedPaths = new Set(Object.keys(generatedFiles));
  const verifiedTargetPaths = new Set(verifiedTarget.actualFiles);
  const scopedFiles = Object.fromEntries(
    Object.entries(stagedFiles).filter(
      ([path]) =>
        generatedPaths.has(path) ||
        isGatewayLifecycleArtifact(path) ||
        verifiedTargetPaths.has(path),
    ),
  );
  const currentOutput = gatewayBundleManifest(scopedFiles);
  const stale = GatewayImportReceiptView.parse({
    ...parsed.data,
    lineage: {
      status: "stale",
      reason,
      currentOutputDigest: currentOutput.digest,
      currentOutputFiles: currentOutput.files,
    },
  });
  writeFileSync(
    join(stageDir, "import.receipt.json"),
    `${JSON.stringify(stale, null, 2)}\n`,
    "utf8",
  );
  return true;
}

function assertSafeBundleRoot(bundleDir: string, airPath: string): void {
  const parent = dirname(bundleDir);
  const name = basename(bundleDir);
  if (parent === bundleDir || name === "" || name === "." || name === "..") {
    throw new Error(`Refusing to replace unsafe bundle path: ${bundleDir}`);
  }
  const stat = lstatSync(bundleDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Approval requires a real compiled bundle directory, not a symlink: ${bundleDir}`,
    );
  }
  const canonicalAir = new Set([
    resolve(join(bundleDir, "air.yaml")),
    resolve(join(bundleDir, "air.json")),
  ]);
  if (!canonicalAir.has(airPath)) {
    throw new Error(
      `Approval requires the bundle's canonical air.yaml or air.json, not ${airPath}.`,
    );
  }
}

function assertCompleteBundle(files: Record<string, string>, bundleDir: string): void {
  const missing = REQUIRED_BUNDLE_FILES.filter((rel) => files[rel] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Atomic approval requires a complete compiled bundle in ${bundleDir}; missing ${missing.join(", ")}. Run \`anvil compile\` first.`,
    );
  }
}

function validateApprovals(
  operations: Array<{ id: string; state: string }>,
  requested: string[],
): void {
  const byId = new Map(operations.map((op) => [op.id, op]));
  const unknown = requested.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown operation id(s): ${unknown.join(", ")}. Run \`anvil inspect\` and pass the displayed ids.`,
    );
  }
  const blocked = requested.filter((id) => byId.get(id)?.state === "blocked");
  if (blocked.length > 0) {
    throw new Error(
      `Blocked operation(s) cannot be approved: ${blocked.join(", ")}. Resolve their blocking diagnostics and recompile first.`,
    );
  }
}

/** Preserve the resource-generation inputs encoded in the existing bundle. */
function readResourceOptions(files: Record<string, string>, serviceId: string): ResourceOptions {
  const options = resourceOptionsFromGenerationMetadata(files[GENERATION_METADATA_FILE]);
  if (!options) {
    throw new Error(
      `${GENERATION_METADATA_FILE} is missing or invalid for ${serviceId}; refusing to infer generator inputs from derived resources. Recompile the bundle first.`,
    );
  }
  return options;
}

function makeHiddenSibling(bundleDir: string, purpose: string): string {
  const parent = dirname(bundleDir);
  const prefix = `.${basename(bundleDir)}.${purpose}-`;
  const candidate = mkdtempSync(join(parent, prefix));
  if (dirname(candidate) !== parent || !basename(candidate).startsWith(prefix)) {
    rmSync(candidate, { recursive: true, force: true });
    throw new Error(`Refusing unsafe non-sibling transaction path: ${candidate}`);
  }
  return candidate;
}

/**
 * Generated directories are compiler-owned projections. Replace their whole
 * trees so files emitted by an older generator cannot survive as ghost CLI,
 * MCP, runtime, or skill surface; unrelated top-level artifacts stay intact.
 */
function resetGeneratedRoots(stageDir: string, expected: Record<string, string>): void {
  const roots = new Set<string>();
  for (const rel of Object.keys(expected)) {
    const slash = rel.indexOf("/");
    if (slash === -1) {
      if (rel === "" || rel === "." || rel === ".." || rel.includes("\\")) {
        throw new Error(`Generator returned an unsafe bundle path: ${rel}`);
      }
      rmSync(join(stageDir, rel), { force: true });
      continue;
    }
    const root = rel.slice(0, slash);
    if (root === "" || root === "." || root === ".." || root.includes("\\")) {
      throw new Error(`Generator returned an unsafe bundle path: ${rel}`);
    }
    roots.add(root);
  }
  for (const root of roots) {
    rmSync(join(stageDir, root), { recursive: true, force: true });
  }
}

function verifyStagedBundle(
  stageDir: string,
  expected: Record<string, string>,
  air: ReturnType<typeof loadAir>,
  gatewayLineageIntentionallyStale: boolean,
): void {
  const stagedFiles = readBundleDir(stageDir);
  const byteDrift = Object.entries(expected)
    .filter(([rel, contents]) => stagedFiles[rel] !== contents)
    .map(([rel]) => rel);
  if (byteDrift.length > 0) {
    throw new Error(
      `Staged approval failed byte verification for ${byteDrift.slice(0, 8).join(", ")}${byteDrift.length > 8 ? ", …" : ""}.`,
    );
  }

  const contractFailures = certifyBundle(stagedFiles, air).checks.filter(
    (check) =>
      check.gate === "contract" &&
      check.status === "failed" &&
      !(gatewayLineageIntentionallyStale && check.id === "contract.gateway-lineage-current"),
  );
  if (contractFailures.length > 0) {
    throw new Error(
      `Staged approval failed surface agreement: ${contractFailures.map((check) => `${check.id}: ${check.detail}`).join("; ")}`,
    );
  }
}

/**
 * Two same-filesystem renames form the commit. If installing the stage fails,
 * restore the original immediately; never expose a directory containing a mix
 * of old and new projection files.
 */
function replaceBundle(bundleDir: string, stageDir: string, deps: ApproveDeps): string | undefined {
  const backupDir = makeHiddenSibling(bundleDir, "reproject-backup");
  rmSync(backupDir, { recursive: true, force: true });
  renameSync(bundleDir, backupDir);
  try {
    (deps.installStagedBundle ?? renameSync)(stageDir, bundleDir);
  } catch (installError) {
    try {
      renameSync(backupDir, bundleDir);
    } catch (rollbackError) {
      throw new Error(
        `Atomic approval install failed and rollback also failed. The original bundle remains at ${backupDir}. Rollback error: ${(rollbackError as Error).message}`,
      );
    }
    throw installError;
  }

  try {
    rmSync(backupDir, { recursive: true, force: true });
    return undefined;
  } catch {
    // The live bundle is already coherent and installed. Retaining the old
    // sibling is safer than turning a cleanup problem into a false rollback.
    return backupDir;
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
