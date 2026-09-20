import { Capability, Diagnostic, Operation } from "@anvil/air";
import type {
  CapabilityBudgetCheck,
  CapabilityBudgetVerdict,
  ManifestIssue,
} from "@anvil/compiler";
import {
  type ApprovalPreview,
  ApprovalRecord,
  type BundleManifest,
  type BundleReprojectionResult,
  type HistoryEntry,
} from "@anvil/generators";
import { z } from "zod";

/**
 * The review-workflow half of the console contract: the decision routes
 * (`operations/approve`, `capabilities/:capId/{approve|reject}`), what an
 * atomic reprojection reports back, the pre-approval preview, the approval
 * record and retained generations (`history`), and the bundle's manifest
 * (`manifest`, `manifest/validate`). Every schema here is derived from the
 * library type it projects, exactly as in `contract.ts`, which spreads
 * `REVIEW_ROUTES` into the one route table both lanes read.
 *
 * Trust rules these routes carry:
 *   - `reviewer` is recorded verbatim by the library (`<bundle>/.anvil/
 *     approvals.jsonl`); absent records `"unrecorded"`, and an empty string
 *     fails the schema rather than being coerced to either.
 *   - `dryRun: true` calls the library's preview (`previewOperationApproval`,
 *     `previewCapabilityDecision`) — the same gates, no write — and answers
 *     `written: false` with the preview attached and no `reprojection`.
 *   - There is no console write for a rollback: `history` hands back the
 *     `anvil rollback` command instead.
 *   - The manifest routes touch exactly one file, the bundle's own
 *     `<bundle>/.anvil/manifest.yaml`, addressed by the bundle id alone (no
 *     request path, so none to escape with); a write is refused
 *     (`console/manifest_invalid`, 422) unless the compiler's own parser
 *     accepts the text, and nothing is ever recompiled — the response carries
 *     the `anvil compile` command that would.
 */

const zBudgetVerdict = z.enum(["ok", "warning", "blocked"]) satisfies z.ZodType<
  CapabilityBudgetVerdict,
  CapabilityBudgetVerdict
>;

/** The compiler's tool/token budget verdict for one capability, as it computes it. */
export const zCapabilityBudget = z.object({
  capabilityId: z.string(),
  toolCount: z.number().int().nonnegative(),
  disclosureTokens: z.number().int().nonnegative().optional(),
  measuredOperations: z.number().int().nonnegative().optional(),
  unmeasuredOperations: z.number().int().nonnegative().optional(),
  supersededOperations: z.number().int().nonnegative().optional(),
  workflowTools: z.number().int().nonnegative().optional(),
  verdict: zBudgetVerdict,
  diagnostic: Diagnostic.optional(),
}) satisfies z.ZodType<CapabilityBudgetCheck>;

/** The approval record's own zod shape, as `@anvil/generators` writes and reads it. */
export const zApprovalRecord = ApprovalRecord;

/** A retained prior generation under `<bundle>/.anvil/history/`. */
export const zHistoryEntry = z.object({
  id: z.string().min(1),
  path: z.string(),
  recordedAt: z.string(),
  bundleHash: z.string(),
}) satisfies z.ZodType<HistoryEntry>;

/** Preserved-but-stale artifacts the reviewer must regenerate (see `anvil approve`'s notes). */
const zStaleArtifacts = z.object({
  targetFiles: z.array(z.string()),
  records: z.array(z.string()),
  gatewayReceipt: z.boolean(),
});

/**
 * What an atomic reprojection reports back, minus the full pre-image of the
 * bundle's files (which the CLI only uses to name preserved stale records —
 * summarised here instead). `record` is the line the swap appended to the
 * approval record; `history` the generation it retained.
 */
export const zReprojection = z.object({
  bundleDir: z.string(),
  generatedFileCount: z.number().int().nonnegative(),
  projectionsChanged: z.boolean(),
  retainedBackup: z.string().optional(),
  record: zApprovalRecord,
  history: zHistoryEntry.optional(),
  stale: zStaleArtifacts,
}) satisfies z.ZodType<Omit<BundleReprojectionResult, "existingFiles">>;

/**
 * What a decision would change, staged in memory by the library's preview and
 * never swapped in: the states that move, the MCP tools and CLI commands that
 * appear (or disappear), the skill files affected, and every projection that
 * would be regenerated.
 */
export const zApprovalPreview = z.object({
  bundleDir: z.string(),
  subjects: z.array(ApprovalRecord.shape.subjects.element),
  mcpTools: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }),
  cliCommands: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }),
  skillFiles: z.array(z.string()),
  regeneratedFiles: z.array(z.string()),
  generatedFileCount: z.number().int().nonnegative(),
  projectionsChanged: z.boolean(),
  stale: zStaleArtifacts,
}) satisfies z.ZodType<Omit<ApprovalPreview, "existingFiles">>;

/* -------------------------------------------------------------------------- */
/* POST /api/bundles/:id/operations/approve                                    */
/* -------------------------------------------------------------------------- */

/**
 * The fields every decision route shares: who is deciding (recorded verbatim;
 * absent records `"unrecorded"`, empty is refused by the schema), and whether
 * to stop at the preview.
 */
const zDecisionFields = {
  reviewer: z.string().trim().min(1).optional(),
  dryRun: z.boolean().optional(),
};

export const zApproveOperationsRequest = z.object({
  ids: z.array(Operation.shape.id).min(1),
  note: z.string().optional(),
  ...zDecisionFields,
});

/**
 * `approveOperationsInBundle` is all-or-nothing: an unknown or blocked id, a
 * receipt-bound gateway lineage, or an operation that stays blocked after
 * re-validation refuses the whole request as an error envelope, before any
 * file changes. `refusals` is therefore empty on success today and is kept
 * for the day a partial admission is deliberately designed — never inferred.
 * A dry run answers `written: false` with `preview` and no `reprojection`.
 */
export const zApproveOperationsResponse = z.object({
  approved: z.array(Operation.shape.id),
  alreadyApproved: z.array(Operation.shape.id),
  regeneratedFiles: z.number().int().nonnegative(),
  written: z.boolean(),
  reprojection: zReprojection.optional(),
  preview: zApprovalPreview.optional(),
  refusals: z.array(z.object({ id: Operation.shape.id, reason: z.string() })),
});

/* -------------------------------------------------------------------------- */
/* POST /api/bundles/:id/capabilities/:capId/{approve|reject}                  */
/* -------------------------------------------------------------------------- */

/**
 * Exactly the CLI's flags: `--allow-large`, `--note`, `--reviewer`, and
 * `--dry-run` for approve; `--reason`, `--reviewer`, and `--dry-run` for
 * reject. The reviewer lands in the approval record the library writes
 * (`<bundle>/.anvil/approvals.jsonl`), which is why the contract can ask for
 * it now: it has a home.
 */
export const zApproveCapabilityRequest = z.object({
  allowLarge: z.boolean().optional(),
  note: z.string().optional(),
  ...zDecisionFields,
});
export const zRejectCapabilityRequest = z.object({
  reason: z.string().optional(),
  ...zDecisionFields,
});

export const zApproveCapabilityResponse = z.object({
  capabilityId: Capability.shape.id,
  budget: zCapabilityBudget,
  written: z.boolean(),
  reprojection: zReprojection.optional(),
  preview: zApprovalPreview.optional(),
});
export const zRejectCapabilityResponse = z.object({
  capabilityId: Capability.shape.id,
  written: z.boolean(),
  reprojection: zReprojection.optional(),
  preview: zApprovalPreview.optional(),
});

/* -------------------------------------------------------------------------- */
/* GET /api/bundles/:id/history — the approval record and retained generations */
/* -------------------------------------------------------------------------- */

/**
 * `readApprovalRecords` and `listBundleHistory`, verbatim. There is no
 * console write for a rollback by design: `rollbackCommand` is the
 * `anvil rollback` invocation that restores the newest retained generation.
 */
export const zBundleHistory = z.object({
  bundleId: z.string().min(1),
  /** Oldest first, as the log is appended. */
  records: z.array(zApprovalRecord),
  /** Newest first. */
  generations: z.array(zHistoryEntry),
  rollbackCommand: z.string(),
});
export type BundleHistory = z.infer<typeof zBundleHistory>;

/* -------------------------------------------------------------------------- */
/* The bundle's manifest: GET, POST .../validate, POST (write)                */
/* -------------------------------------------------------------------------- */

/** One positioned issue from `parseManifestDetailed`, as the compiler reports it. */
export const zManifestIssue = z.object({
  path: z.string(),
  message: z.string(),
  line: z.number().int().positive().optional(),
  col: z.number().int().positive().optional(),
  suggestion: z.string().optional(),
}) satisfies z.ZodType<ManifestIssue>;

/** `readBundleManifest`, plus the compile command that would apply an edit. */
export const zManifestView = z.object({
  path: z.string(),
  exists: z.boolean(),
  text: z.string(),
  recompileCommand: z.string(),
}) satisfies z.ZodType<BundleManifest & { recompileCommand: string }>;

export const zManifestTextRequest = z.object({ text: z.string() });

export const zManifestValidation = z.object({
  ok: z.boolean(),
  issues: z.array(zManifestIssue),
});

/** The write happened (atomically) and nothing was recompiled. */
export const zManifestWriteResponse = z.object({
  path: z.string(),
  written: z.literal(true),
  recompileCommand: z.string(),
});

/* -------------------------------------------------------------------------- */
/* The routes, spread into CONSOLE_ROUTES                                      */
/* -------------------------------------------------------------------------- */

export const REVIEW_ROUTES = {
  approveOperations: {
    method: "POST",
    path: "/api/bundles/:id/operations/approve",
    mutates: true,
    request: zApproveOperationsRequest,
    response: zApproveOperationsResponse,
  },
  approveCapability: {
    method: "POST",
    path: "/api/bundles/:id/capabilities/:capId/approve",
    mutates: true,
    request: zApproveCapabilityRequest,
    response: zApproveCapabilityResponse,
  },
  rejectCapability: {
    method: "POST",
    path: "/api/bundles/:id/capabilities/:capId/reject",
    mutates: true,
    request: zRejectCapabilityRequest,
    response: zRejectCapabilityResponse,
  },
  history: {
    method: "GET",
    path: "/api/bundles/:id/history",
    mutates: false,
    response: zBundleHistory,
  },
  manifest: {
    method: "GET",
    path: "/api/bundles/:id/manifest",
    mutates: false,
    response: zManifestView,
  },
  validateManifest: {
    method: "POST",
    path: "/api/bundles/:id/manifest/validate",
    mutates: true,
    request: zManifestTextRequest,
    response: zManifestValidation,
  },
  writeManifest: {
    method: "POST",
    path: "/api/bundles/:id/manifest",
    mutates: true,
    request: zManifestTextRequest,
    response: zManifestWriteResponse,
  },
} as const;
