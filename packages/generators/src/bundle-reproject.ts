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
  type ApprovalRecord,
  type ApprovalRecordInput,
  type ApprovalRecordSubject,
  buildApprovalRecord,
  normalizeReviewer,
  stageApprovalRecord,
} from "./approval-record.js";
import {
  GENERATION_METADATA_FILE,
  type GeneratedBundle,
  generateBundle,
  resourceOptionsFromGenerationMetadata,
  writeBundle,
} from "./bundle.js";
import {
  archiveReplacedGeneration,
  excludeHistory,
  type HistoryEntry,
  resolveHistoryLimit,
} from "./bundle-history.js";
import { resolveBundleDir } from "./bundle-io.js";
import { bundleHash, certifyBundle, readBundleDir } from "./certify.js";
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
 *
 * Every successful swap also does two bookkeeping things, in this order:
 * the replaced generation is retained under `<bundle>/.anvil/history/`
 * (bounded; `anvil rollback` restores one), and one line is appended to the
 * approval record (`<bundle>/.anvil/approvals.jsonl`) naming who decided
 * what, the states that moved, and the bundle hash before and after. The
 * `prepare*` functions run every gate without writing, so a dry run and the
 * real decision cannot diverge in what they refuse.
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

/**
 * Seams and knobs of a reprojection. `installStagedBundle` proves rollback
 * after the live bundle has been moved aside; `historyLimit` bounds the
 * retained generations (default 5, or `ANVIL_BUNDLE_HISTORY_LIMIT`); `now`
 * fixes the record's timestamp in tests.
 */
export interface ReprojectionDeps {
  installStagedBundle?: (stageDir: string, bundleDir: string) => void;
  historyLimit?: number;
  now?: () => Date;
}

/** Who is deciding, and what they wrote — recorded, never inferred. */
export interface ReviewIdentity {
  /** Absent records `"unrecorded"`; present must be non-empty. */
  reviewer?: string;
  note?: string;
}

export interface BundleReprojectionResult {
  bundleDir: string;
  generatedFileCount: number;
  existingFiles: Record<string, string>;
  projectionsChanged: boolean;
  retainedBackup?: string;
  /** The line appended to `<bundle>/.anvil/approvals.jsonl` for this swap. */
  record: ApprovalRecord;
  /** The replaced generation, when the history limit retained it. */
  history?: HistoryEntry;
}

export interface OperationApprovalResult {
  /** The distinct operation ids requested. */
  requested: string[];
  /** Those that were not already approved before this call. */
  newlyApproved: string[];
  reprojection: BundleReprojectionResult;
}

/** An operation approval after every gate, before any write. */
export interface PreparedOperationApproval {
  bundleDir: string;
  existingFiles: Record<string, string>;
  /** The AIR with the approvals applied in memory. */
  air: AirDocument;
  requested: string[];
  newlyApproved: string[];
  /** State transitions of the operations that moved. */
  subjects: ApprovalRecordSubject[];
}

/**
 * Run every gate of an operation approval without writing: unknown or
 * blocked ids, in-place approval on a receipt-bound gateway import, and an
 * operation `approveOperations` leaves blocked instead of approved. The real
 * approval and its dry run both start here, so they refuse identically.
 */
export function prepareOperationApproval(
  path: string,
  ids: readonly string[],
): PreparedOperationApproval {
  const bundleDir = resolve(resolveBundleDir(path));
  const airPath = resolve(resolveAirPath(path));
  assertSafeBundleRoot(bundleDir, airPath);

  const existingFiles = readBundleDir(bundleDir);
  assertCompleteBundle(existingFiles, bundleDir);
  const air = loadAir(path);
  const requested = [...new Set(ids)];
  validateApprovals(air.operations, requested);
  const priorState = new Map(air.operations.map((op) => [op.id, op.state]));
  const pendingApproval = requested.filter((id) => priorState.get(id) !== "approved");
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
  const subjects = pendingApproval.map((id) => ({
    kind: "operation" as const,
    id,
    from: priorState.get(id) ?? "unknown",
    to: air.operations.find((op) => op.id === id)?.state ?? "unknown",
  }));
  return { bundleDir, existingFiles, air, requested, newlyApproved: pendingApproval, subjects };
}

/**
 * Approve operations only inside a complete compiled bundle, then re-project
 * every generated artifact atomically. Every refusal of `prepareOperationApproval`
 * applies, before anything is written.
 */
export function approveOperationsInBundle(
  path: string,
  ids: readonly string[],
  deps: ReprojectionDeps = {},
  review: ReviewIdentity = {},
): OperationApprovalResult {
  normalizeReviewer(review.reviewer);
  const prepared = prepareOperationApproval(path, ids);
  const reprojection = reprojectBundleAtomically(path, prepared.air, deps, {
    action: "approve_operations",
    subjects: prepared.subjects,
    ...review,
  });
  return { requested: prepared.requested, newlyApproved: prepared.newlyApproved, reprojection };
}

export interface CapabilityApprovalResult {
  budget: CapabilityBudgetCheck;
  reprojection: BundleReprojectionResult;
}

/** A capability decision after the compiler's review gate, before any write. */
export interface PreparedCapabilityDecision {
  air: AirDocument;
  subjects: ApprovalRecordSubject[];
  /** Present for an approval: the budget verdict that admitted it. */
  budget?: CapabilityBudgetCheck;
}

/**
 * Apply a capability decision in memory: the compiler's typed tool-budget
 * gate decides an approval (a `CapabilityReviewError` propagates untouched),
 * a rejection records why. Nothing is written; the decision and its dry run
 * both start here.
 */
export function prepareCapabilityDecision(
  path: string,
  capabilityId: string,
  decision: "approve" | "reject",
  opts: ApproveCapabilityOptions & { reason?: string } = {},
): PreparedCapabilityDecision {
  const air = loadAir(path);
  const from = air.capabilities.find((cap) => cap.id === capabilityId)?.lifecycle ?? "unknown";
  let budget: CapabilityBudgetCheck | undefined;
  if (decision === "approve") budget = approveCapability(air, capabilityId, opts);
  else rejectCapability(air, capabilityId, opts.reason);
  const to = air.capabilities.find((cap) => cap.id === capabilityId)?.lifecycle ?? "unknown";
  return {
    air,
    subjects: [{ kind: "capability", id: capabilityId, from, to }],
    ...(budget ? { budget } : {}),
  };
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
  review: ReviewIdentity = {},
  deps: ReprojectionDeps = {},
): CapabilityApprovalResult {
  normalizeReviewer(review.reviewer);
  const prepared = prepareCapabilityDecision(path, capabilityId, "approve", opts);
  const reprojection = reprojectBundleAtomically(path, prepared.air, deps, {
    action: "approve_capability",
    subjects: prepared.subjects,
    reviewer: review.reviewer,
    note: review.note ?? opts.note,
  });
  return { budget: prepared.budget as CapabilityBudgetCheck, reprojection };
}

/** Reject a capability, recording why, and re-project the bundle atomically. */
export function rejectCapabilityInBundle(
  path: string,
  capabilityId: string,
  reason?: string,
  review: ReviewIdentity = {},
  deps: ReprojectionDeps = {},
): BundleReprojectionResult {
  normalizeReviewer(review.reviewer);
  const prepared = prepareCapabilityDecision(path, capabilityId, "reject", { reason });
  return reprojectBundleAtomically(path, prepared.air, deps, {
    action: "reject_capability",
    subjects: prepared.subjects,
    reviewer: review.reviewer,
    note: review.note ?? reason,
  });
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

/** A reprojection computed in memory: what the live bundle holds and what it would become. */
export interface StagedReprojection {
  bundleDir: string;
  existingFiles: Record<string, string>;
  generated: GeneratedBundle;
  projectionsChanged: boolean;
}

/**
 * Everything a reprojection decides before it touches the disk: the bundle
 * root is safe and complete, the generator inputs are recoverable, the
 * projections are regenerated from the mutated AIR, and a receipt-bound
 * gateway import refuses any change. A dry run stops here; the real thing
 * continues into the stage.
 */
export function stageReprojection(path: string, air: AirDocument): StagedReprojection {
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
  return { bundleDir, existingFiles, generated, projectionsChanged };
}

/**
 * Persist any AIR mutation through the one safe reprojection path. The caller
 * mutates an in-memory AIR document; this function regenerates every
 * compiler-owned projection, verifies exact bytes and surface agreement, then
 * swaps the complete staged directory into place with rollback, retains the
 * replaced generation, and appends the approval record. `record` names the
 * decision; without one the line says `reproject` with no subjects.
 */
export function reprojectBundleAtomically(
  path: string,
  air: AirDocument,
  deps: ReprojectionDeps = {},
  record: ApprovalRecordInput = { action: "reproject", subjects: [] },
): BundleReprojectionResult {
  normalizeReviewer(record.reviewer);
  const { bundleDir, existingFiles, generated, projectionsChanged } = stageReprojection(path, air);
  const before = bundleHash(existingFiles);

  const stageDir = makeHiddenSibling(bundleDir, "reproject-stage");
  let committed: CommittedStage;
  try {
    cpSync(bundleDir, stageDir, {
      recursive: true,
      verbatimSymlinks: true,
      filter: excludeHistory(bundleDir),
    });
    resetGeneratedRoots(stageDir, generated.files);
    writeBundle(stageDir, generated);
    // No path reaches this point with a receipt-bound bundle whose projections
    // changed: assertImmutableGatewayLineage above unconditionally refuses
    // that case first. Reprojection here is therefore never gateway-lineage
    // stale by intent — verifyStagedBundle enforces the gateway-lineage-current
    // contract check like every other contract check.
    const stagedFiles = verifyStagedBundle(stageDir, generated.files, air, false);
    committed = commitStagedBundle(bundleDir, stageDir, deps, {
      before,
      after: bundleHash(stagedFiles),
      record,
    });
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
    ...committed,
  };
}

/** What committing a stage adds to a result: the record, the retained generation, a stuck backup. */
export interface CommittedStage {
  record: ApprovalRecord;
  history?: HistoryEntry;
  retainedBackup?: string;
}

export interface CommitOptions {
  before: string;
  after: string;
  record: ApprovalRecordInput;
}

/**
 * The commit: write the approval record into the stage, swap the verified
 * stage into place, then retire the replaced generation into history.
 *
 * The record goes in BEFORE the swap on purpose. Appending it afterwards has
 * two failure modes that both break the guarantee it exists to make: an
 * append that throws leaves the new surface live with no line accounting for
 * it, and — because the swap moves the old directory aside — a log written
 * only to the old directory is retired with it, which quietly turned an
 * append-only log into a record of whichever decision came last. Staging it
 * means the rename that installs the new bytes installs the decision that
 * produced them, in the same instant, or neither.
 *
 * History archival is the one genuinely best-effort step, and it runs last:
 * the live bundle is already coherent and audited by then, so a failure there
 * is reported and the replaced generation is RETAINED. Deleting it would turn
 * a bookkeeping problem into the loss of the only copy a rollback could use.
 */
export function commitStagedBundle(
  bundleDir: string,
  stageDir: string,
  deps: ReprojectionDeps,
  options: CommitOptions,
): CommittedStage {
  const now = (deps.now ?? (() => new Date()))();
  const historyLimit = resolveHistoryLimit(deps.historyLimit);
  const record = buildApprovalRecord(options.record, {
    bundleHash: { before: options.before, after: options.after },
    now: () => now,
  });
  // Carries the existing log forward and adds this decision, so the swap
  // installs both together. A throw here happens while the live bundle is
  // still the old one, which is the safe moment to fail.
  stageApprovalRecord(bundleDir, stageDir, record);
  const backupDir = replaceBundle(bundleDir, stageDir, deps);
  let history: HistoryEntry | undefined;
  let retainedBackup: string | undefined;
  try {
    history = archiveReplacedGeneration(bundleDir, backupDir, {
      hash: options.before,
      recordedAt: now,
      historyLimit,
    });
  } catch {
    // The live bundle is coherent, installed and audited. The replaced
    // generation stays exactly where it is: it is the only intact copy, and
    // a caller is told where to find it rather than losing it to a failure
    // in the bookkeeping that was meant to preserve it.
    retainedBackup = backupDir;
  }
  return {
    record,
    ...(history ? { history } : {}),
    ...(retainedBackup ? { retainedBackup } : {}),
  };
}

export function assertSafeBundleRoot(bundleDir: string, airPath: string): void {
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

export function assertCompleteBundle(files: Record<string, string>, bundleDir: string): void {
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
export function readResourceOptions(
  files: Record<string, string>,
  serviceId: string,
): ResourceOptions {
  const options = resourceOptionsFromGenerationMetadata(files[GENERATION_METADATA_FILE]);
  if (!options) {
    throw new Error(
      `${GENERATION_METADATA_FILE} is missing or invalid for ${serviceId}; refusing to infer generator inputs from derived resources. Recompile the bundle first.`,
    );
  }
  return options;
}

export function makeHiddenSibling(bundleDir: string, purpose: string): string {
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

/** Byte and surface verification of a stage; returns the staged files for hashing. */
export function verifyStagedBundle(
  stageDir: string,
  expected: Record<string, string>,
  air: AirDocument,
  gatewayLineageIntentionallyStale: boolean,
): Record<string, string> {
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
  return stagedFiles;
}

/**
 * Two same-filesystem renames form the commit. If installing the stage fails,
 * restore the original immediately; never expose a directory containing a mix
 * of old and new projection files. Returns the moved-aside original, which
 * the caller retires into history (or removes).
 */
function replaceBundle(bundleDir: string, stageDir: string, deps: ReprojectionDeps): string {
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
  return backupDir;
}
