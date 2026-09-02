import { cpSync, existsSync, lstatSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AirDocument } from "@anvil/air";
import {
  type ApproveCapabilityOptions,
  approveCapability,
  approveOperations,
  type CapabilityBudgetCheck,
  GatewayImportReceiptView,
  rejectCapability,
} from "@anvil/compiler";
import { loadAir, resolveAirPath } from "@anvil/refinement";
import {
  GENERATION_METADATA_FILE,
  generateBundle,
  resourceOptionsFromGenerationMetadata,
  writeBundle,
} from "./bundle.js";
import { resolveBundleDir } from "./bundle-io.js";
import { certifyBundle, readBundleDir } from "./certify.js";
import { locateGatewayWorkspace } from "./gateway-workspace.js";
import type { ResourceOptions } from "./resources.js";

/**
 * Persisting an AIR decision into a compiled bundle, atomically. Approval —
 * of an operation, of a capability — is a change to the canonical model, and
 * only approved operations are exposed by generated artifacts, so the decision
 * and every projection of it must land together or not at all. The shape is
 * stage-then-swap: a sibling staging copy is regenerated from the mutated AIR,
 * verified for exact bytes and surface agreement (the contract gate of
 * `certifyBundle`), then swapped into place with two same-filesystem renames
 * and rollback. Nothing under the live path changes until the stage has
 * passed.
 *
 * `anvil approve` and `anvil capability approve|reject` are thin callers of
 * the functions here; a console or any other reviewer surface calls the same
 * functions and therefore honours the same gates and refusals, including the
 * receipt-bound gateway lineage refusal below.
 */

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

/** Filesystem seam for proving rollback after the live bundle has been moved aside. */
export interface ReprojectionDeps {
  installStagedBundle?: (stageDir: string, bundleDir: string) => void;
}

export interface BundleReprojectionResult {
  bundleDir: string;
  generatedFileCount: number;
  existingFiles: Record<string, string>;
  projectionsChanged: boolean;
  retainedBackup?: string;
}

export interface OperationApprovalResult {
  /** The distinct operation ids requested. */
  requested: string[];
  /** Those that were not already approved before this call. */
  newlyApproved: string[];
  reprojection: BundleReprojectionResult;
}

/**
 * Approve operations only inside a complete compiled bundle, then re-project
 * every generated artifact atomically. Refuses unknown or blocked ids, refuses
 * in-place approval on a receipt-bound gateway import, and refuses — before
 * anything is written — when `approveOperations` leaves a requested operation
 * blocked instead of approved.
 */
export function approveOperationsInBundle(
  path: string,
  ids: readonly string[],
  deps: ReprojectionDeps = {},
): OperationApprovalResult {
  const bundleDir = resolve(resolveBundleDir(path));
  const airPath = resolve(resolveAirPath(path));
  assertSafeBundleRoot(bundleDir, airPath);

  const existingFiles = readBundleDir(bundleDir);
  assertCompleteBundle(existingFiles, bundleDir);
  const air = loadAir(path);
  const requested = [...new Set(ids)];
  validateApprovals(air.operations, requested);
  const pendingApproval = requested.filter(
    (id) => air.operations.find((op) => op.id === id)?.state !== "approved",
  );
  if (pendingApproval.length > 0) {
    assertImmutableGatewayLineage(existingFiles, bundleDir, "Operation approval", pendingApproval);
  }

  approveOperations(air, requested);

  // approveOperations() re-validates each requested operation's idempotency
  // carrier and can leave it "blocked" instead of transitioning it to
  // "approved" (e.g. an unresolvable carrier). Only approved operations are
  // exposed by generated artifacts, so a request that actually ends in
  // "blocked" must never be reported as success — refuse before reprojecting
  // the bundle so no blocked state is ever written to disk as if it were a
  // clean approval.
  const stillBlocked = requested.filter(
    (id) => air.operations.find((op) => op.id === id)?.state === "blocked",
  );
  if (stillBlocked.length > 0) {
    throw new Error(
      `Approval refused: ${stillBlocked.length} of ${requested.length} requested operation(s) remain blocked and were not approved: ${stillBlocked.join(", ")}. Resolve their blocking diagnostics (see reviewNotes) and recompile before approving again.`,
    );
  }

  const reprojection = reprojectBundleAtomically(path, air, deps);
  return { requested, newlyApproved: pendingApproval, reprojection };
}

export interface CapabilityApprovalResult {
  budget: CapabilityBudgetCheck;
  reprojection: BundleReprojectionResult;
}

/**
 * Approve a capability (the compiler's typed tool-budget gate decides; a
 * `CapabilityReviewError` propagates untouched) and re-project the bundle
 * atomically.
 */
export function approveCapabilityInBundle(
  path: string,
  capabilityId: string,
  opts: ApproveCapabilityOptions = {},
): CapabilityApprovalResult {
  const air = loadAir(path);
  const budget = approveCapability(air, capabilityId, opts);
  const reprojection = reprojectBundleAtomically(path, air);
  return { budget, reprojection };
}

/** Reject a capability, recording why, and re-project the bundle atomically. */
export function rejectCapabilityInBundle(
  path: string,
  capabilityId: string,
  reason?: string,
): BundleReprojectionResult {
  const air = loadAir(path);
  rejectCapability(air, capabilityId, reason);
  return reprojectBundleAtomically(path, air);
}

/**
 * A gateway receipt is an immutable compile input/output proof. Approval is a
 * compile input, so it must arrive through the manifest and produce a new
 * receipt; mutating receipt-bound output would turn provenance into a stale
 * after-the-fact annotation.
 */
function assertImmutableGatewayLineage(
  files: Record<string, string>,
  bundleDir: string,
  action: string,
  operationIds: readonly string[] = [],
): void {
  const text = files["import.receipt.json"];
  if (text === undefined) return;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(
      `${action} refused: gateway import.receipt.json is not valid JSON. Verify or re-import the bundle before changing approval state.`,
    );
  }
  const parsed = GatewayImportReceiptView.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${action} refused: gateway import.receipt.json is not a valid receipt view. Verify or re-import the bundle before changing approval state.`,
    );
  }

  const view = parsed.data;
  const identity = view.selection.identity;
  const quote = (value: string): string => JSON.stringify(value);
  const workspaceRoot = locateGatewayWorkspace(bundleDir, view.importId);
  const root = workspaceRoot ?? "<workspace-root>";
  const rawExport = join(root, ".anvil", "imports", view.importId, "raw", "export.bin");
  const flags = [
    `--vendor ${quote(view.selection.vendor)}`,
    `--api ${quote(view.selection.apiId)}`,
    ...(identity && identity.gatewayIdSource !== "unscoped"
      ? [`--gateway-id ${quote(identity.gatewayId)}`, "--strict-identity"]
      : []),
    ...(identity ? [`--revision ${quote(identity.revision)}`] : []),
    ...(identity ? [`--environment ${quote(identity.environment)}`] : []),
    ...(identity ? [`--service ${quote(identity.serviceId)}`] : []),
    ...(view.selection.archiveEntry ? [`--entry ${quote(view.selection.archiveEntry)}`] : []),
    ...(view.lockedSource
      ? [
          `--spec ${quote(
            join(
              root,
              ".anvil",
              "sources",
              view.lockedSource.snapshotId,
              "raw",
              view.contract.compilerSource.entrypoint,
            ),
          )}`,
        ]
      : []),
    ...(view.runtime ? [`--gateway-url ${quote(view.runtime.gatewayUrl)}`] : []),
    "--manifest <review.yaml>",
    `--root ${quote(root)}`,
    `--out ${quote(identity ? bundleDir : `${bundleDir}.reviewed`)}`,
  ];
  const operations =
    operationIds.length > 0 ? ` Requested operation(s): ${operationIds.join(", ")}.` : "";
  throw new Error(
    `${action} refused: ${bundleDir} is bound to immutable gateway receipt ${view.importId}; in-place approval would sever its import-to-approval lineage.${operations}\n` +
      "Record the reviewed operation/capability state and any required confirmation, idempotency, and auth semantics in a supplemental manifest, then re-import the preserved export so those decisions are receipt-bound:\n" +
      `  anvil estate import ${quote(rawExport)} ${flags.join(" ")}\n` +
      (workspaceRoot
        ? `Anvil located the receipt workspace at ${quote(workspaceRoot)}.\n`
        : "Anvil could not locate the private receipt workspace from this bundle; replace <workspace-root> with the root originally passed to estate import.\n") +
      (identity
        ? "The verified bundle at the same stable gateway coordinate can then transition atomically."
        : "This is a legacy receipt without first-class identity, so use the new output directory shown above."),
  );
}

/**
 * Persist any AIR mutation through the one safe reprojection path. The caller
 * mutates an in-memory AIR document; this function regenerates every
 * compiler-owned projection, verifies exact bytes and surface agreement, then
 * swaps the complete staged directory into place with rollback.
 */
export function reprojectBundleAtomically(
  path: string,
  air: AirDocument,
  deps: ReprojectionDeps = {},
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
  if (projectionsChanged) {
    assertImmutableGatewayLineage(existingFiles, bundleDir, "Bundle reprojection");
  }

  const stageDir = makeHiddenSibling(bundleDir, "reproject-stage");
  let retainedBackup: string | undefined;
  try {
    cpSync(bundleDir, stageDir, {
      recursive: true,
      verbatimSymlinks: true,
    });
    resetGeneratedRoots(stageDir, generated.files);
    writeBundle(stageDir, generated);
    // No path reaches this point with a receipt-bound bundle whose projections
    // changed: assertImmutableGatewayLineage above unconditionally refuses
    // that case first. Reprojection here is therefore never gateway-lineage
    // stale by intent — verifyStagedBundle enforces the gateway-lineage-current
    // contract check like every other contract check.
    verifyStagedBundle(stageDir, generated.files, air, false);
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
  air: AirDocument,
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
function replaceBundle(
  bundleDir: string,
  stageDir: string,
  deps: ReprojectionDeps,
): string | undefined {
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
