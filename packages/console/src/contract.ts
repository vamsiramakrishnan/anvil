import {
  Capability,
  CapabilityLifecycle,
  Claim,
  Confirmation,
  Diagnostic,
  Idempotency,
  Operation,
  OperationState,
  PathGrammar,
  type RefusedSupersession,
  Service,
  Workflow,
} from "@anvil/air";
import {
  type CapabilityBudgetCheck,
  type CapabilityBudgetVerdict,
  DriftItem,
} from "@anvil/compiler";
import type { BundleReprojectionResult } from "@anvil/generators";
import {
  type GroupRoutingDelta,
  type SemanticChange,
  zBenchmarkReport,
  zRefinementPack,
  zRefinementReviewReceipt,
  zRefinementTask,
} from "@anvil/refinement";
import { z } from "zod";

/**
 * The console's HTTP API contract.
 *
 * Every schema here is derived from the library types it projects — AIR's own
 * zod objects (`Operation`, `Capability`, `Workflow`, `Diagnostic`, `Claim`,
 * `PathGrammar`), the compiler's `DriftItem`, refinement's pack/receipt/task/
 * benchmark schemas — either by reusing the schema outright or, where a
 * library exposes only a TypeScript type, by a zod object that `satisfies
 * z.ZodType<TheLibraryType>` so the compiler refuses a contract that names a
 * field the library does not carry. Nothing here is a hand-copied shape, and
 * nothing here is new truth: the responses are projections of what the
 * `@anvil/*` functions return, and the mutations are the same functions the
 * CLI calls (`approveOperationsInBundle`, `approveCapabilityInBundle`,
 * `rejectCapabilityInBundle`, `recordPackDecision`, `applyPackToBundle`,
 * `exportRefinementTask`, `importRefinementSubmission`).
 *
 * ## SECURITY — the mutation-protection contract the server MUST implement
 *
 * The console runs on the reviewer's machine with the reviewer's filesystem
 * authority, and its POST routes change approval state. A page in another
 * browser tab must not be able to drive them. Lane 2 (`src/server/`) therefore
 * implements all of the following, and nothing here is optional:
 *
 *   1. Bind 127.0.0.1 only. Never 0.0.0.0, never a hostname; refuse to start
 *      if asked to.
 *   2. Mint one random token per process (>= 128 bits, `crypto.randomBytes`).
 *      Inject it into the served page (a meta tag or inline bootstrap, never a
 *      query string) and require it verbatim as the `X-Anvil-Console-Token`
 *      header on EVERY non-GET request. A missing or mismatched token is
 *      `403` with `{ error: { code: "console/forbidden" } }`, before any body
 *      is read.
 *   3. Reject any non-GET request whose `Origin` header is absent or differs
 *      from the server's own origin (`http://127.0.0.1:<port>`). Same `403`.
 *   4. Never emit CORS headers. No `Access-Control-Allow-*`, no preflight
 *      success. A cross-origin caller gets nothing it can read.
 *   5. JSON bodies only: non-GET requests must carry
 *      `Content-Type: application/json` (a `415` otherwise), are parsed with a
 *      size cap, and are validated against the request schema below before
 *      any library function runs (`400` with `issues[]` otherwise).
 *   6. GET routes are read-only projections and must not write, even
 *      incidentally (no report regeneration, no cache files inside a bundle).
 *
 * These are the only defenses between a drive-by page and an approval, so a
 * change to any of them is a safety change and is reviewed as one.
 */

/* -------------------------------------------------------------------------- */
/* Shared building blocks                                                      */
/* -------------------------------------------------------------------------- */

/** How a bundle is addressed in every route: a stable id the workspace assigns. */
export const zBundleId = z.string().min(1);

const zServiceIdentity = z.object({
  id: Service.shape.id,
  version: Service.shape.version,
});

/** Counts by state, absent states omitted. */
const zOperationStateCounts = z.partialRecord(OperationState, z.number().int().nonnegative());
const zCapabilityLifecycleCounts = z.partialRecord(
  CapabilityLifecycle,
  z.number().int().nonnegative(),
);

const zRefusedSupersession = z.object({
  operationId: z.string(),
  workflowId: z.string(),
  reason: z.string(),
}) satisfies z.ZodType<RefusedSupersession>;

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

/**
 * What an atomic reprojection reports back, minus the full pre-image of the
 * bundle's files (which the CLI only uses to name preserved stale records —
 * summarised here instead).
 */
export const zReprojection = z.object({
  bundleDir: z.string(),
  generatedFileCount: z.number().int().nonnegative(),
  projectionsChanged: z.boolean(),
  retainedBackup: z.string().optional(),
  /** Preserved-but-stale artifacts the reviewer must regenerate (see `anvil approve`'s notes). */
  stale: z.object({
    targetFiles: z.array(z.string()),
    records: z.array(z.string()),
    gatewayReceipt: z.boolean(),
  }),
}) satisfies z.ZodType<Omit<BundleReprojectionResult, "existingFiles">>;

export const zGroupRoutingDelta = z.object({
  schemaVersion: z.literal(1),
  reportType: z.literal("anvil.group-routing-delta"),
  clusterId: z.string(),
  proposalKind: z.enum(["workflow", "capability"]),
  scope: z.enum(["all_tasks", "member_tasks"]),
  router: z.string(),
  totalTasks: z.number().int().nonnegative(),
  passedBefore: z.number().int().nonnegative(),
  passedAfter: z.number().int().nonnegative(),
  upliftPts: z.number(),
  flippedToPass: z.array(z.object({ operationId: z.string(), intent: z.string() })),
  flippedToFail: z.array(z.object({ operationId: z.string(), intent: z.string() })),
  hypothetical: z.object({
    catalogSize: z.number().int().nonnegative(),
    compositeTool: z.string().optional(),
    supersededOperationIds: z.array(z.string()),
  }),
  simulated: z.literal(false),
  simulationNote: z.string(),
}) satisfies z.ZodType<GroupRoutingDelta>;

/** The pack schema's refinement element — the one zod shape of a refinement and its target. */
const zRefinement = zRefinementPack.shape.refinements.element;

const zSemanticChange = z.object({
  target: zRefinement.shape.target,
  key: z.string(),
  before: z.unknown(),
  after: z.unknown(),
}) satisfies z.ZodType<SemanticChange>;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every non-2xx response. `code` reuses the CLI's machine-readable codes where
 * one exists (the vocabulary is docs/architecture/error-code-registry.json —
 * `refinement/*` harness rejections, `capability_*` review errors, the
 * console's own `console/*`); `issues` carries the line items a CLI would
 * print under the message; `delta` rides along on a group admission refusal
 * so the reviewer sees the routing numbers structured, not only in prose.
 */
export const zErrorEnvelope = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    issues: z.array(z.string()).optional(),
    delta: zGroupRoutingDelta.optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof zErrorEnvelope>;

/* -------------------------------------------------------------------------- */
/* GET /api/workspace                                                          */
/* -------------------------------------------------------------------------- */

export const zWorkspaceBundle = z.object({
  id: zBundleId,
  /** Absolute bundle directory. */
  path: z.string(),
  service: zServiceIdentity,
  sourceKind: Service.shape.source.shape.kind,
  pathGrammar: PathGrammar.shape.classification.optional(),
  counts: z.object({
    operations: zOperationStateCounts,
    capabilities: zCapabilityLifecycleCounts,
    workflows: zOperationStateCounts,
  }),
  hasBenchmark: z.boolean(),
  /** Refinement pack directories found for this bundle. */
  packs: z.number().int().nonnegative(),
});

export const zWorkspace = z.object({
  root: z.string(),
  bundles: z.array(zWorkspaceBundle),
});
export type Workspace = z.infer<typeof zWorkspace>;

/* -------------------------------------------------------------------------- */
/* GET /api/bundles/:id — the inspector                                        */
/* -------------------------------------------------------------------------- */

export const zOperationRow = z.object({
  id: Operation.shape.id,
  canonicalName: Operation.shape.canonicalName,
  displayName: Operation.shape.displayName,
  mcp: z.object({ toolName: Operation.shape.mcp.shape.toolName }),
  cli: z.object({ command: Operation.shape.cli.shape.command }),
  effect: Operation.shape.effect,
  state: Operation.shape.state,
  idempotency: z.object({ mode: Idempotency.shape.mode }),
  confirmation: z.object({ required: Confirmation.shape.required }),
  diagnosticCount: z.number().int().nonnegative(),
  /** `reviewNotes` — why a non-approved operation is where it is. */
  blockerNotes: Operation.shape.reviewNotes,
});

export const zCapabilityRow = z.object({
  id: Capability.shape.id,
  lifecycle: Capability.shape.lifecycle,
  source: Capability.shape.source,
  displayName: Capability.shape.displayName,
  members: Capability.shape.operationIds,
  budget: zCapabilityBudget,
});

export const zWorkflowRow = z.object({
  id: Workflow.shape.id,
  state: Workflow.shape.state,
  steps: Workflow.shape.steps,
  supersedes: Workflow.shape.supersedes,
  /** The shared planner's verdict (`planWorkflowSurface`): registrable, or why not. */
  plan: z.object({
    registrable: z.boolean(),
    skipReason: z.string().optional(),
  }),
  refusals: z.array(zRefusedSupersession),
});

export const zBundleInspector = z.object({
  id: zBundleId,
  path: z.string(),
  service: Service,
  source: Service.shape.source,
  pathGrammar: PathGrammar.optional(),
  diagnostics: z.array(Diagnostic),
  operations: z.array(zOperationRow),
  capabilities: z.array(zCapabilityRow),
  workflows: z.array(zWorkflowRow),
  /** Served MCP tool names before and after workflow planning (supersedes applied). */
  servedSurface: z.object({
    before: z.array(z.string()),
    after: z.array(z.string()),
  }),
});
export type BundleInspector = z.infer<typeof zBundleInspector>;

/* -------------------------------------------------------------------------- */
/* GET /api/bundles/:id/queue — the decision queue                             */
/* -------------------------------------------------------------------------- */

export const zDecisionKind = z.enum(["operation", "capability", "workflow", "refinement"]);

export const zDecisionItem = z.object({
  kind: zDecisionKind,
  id: z.string().min(1),
  title: z.string(),
  reasons: z.array(z.string()),
  /** AIR claims (source, confidence, note) — the evidence a reviewer weighs. */
  evidence: z.array(Claim),
  suggestedAction: z.string(),
  blocking: z.boolean(),
});

export const zDecisionQueue = z.object({
  bundleId: zBundleId,
  items: z.array(zDecisionItem),
});
export type DecisionQueue = z.infer<typeof zDecisionQueue>;

/* -------------------------------------------------------------------------- */
/* GET /api/bundles/:id/packs                                                  */
/* -------------------------------------------------------------------------- */

export const zPackItem = z.object({
  refinementId: zRefinement.shape.id,
  skill: zRefinement.shape.skill,
  target: zRefinement.shape.target,
  status: zRefinement.shape.status,
  tier: zRefinement.shape.approval.shape.tier,
  /** `key=value` per patched field — what `anvil refine run` prints. */
  patchSummary: z.string(),
  claims: zRefinement.shape.evidence,
  delta: zGroupRoutingDelta.optional(),
});

export const zPackView = z.object({
  dir: z.string(),
  hash: zRefinementReviewReceipt.shape.packHash,
  service: zRefinementPack.shape.service,
  summary: zRefinementPack.shape.summary,
  items: z.array(zPackItem),
  receipts: z.array(zRefinementReviewReceipt),
});

export const zPackList = z.array(zPackView);
export type PackList = z.infer<typeof zPackList>;

/* -------------------------------------------------------------------------- */
/* GET /api/bundles/:id/benchmark                                              */
/* -------------------------------------------------------------------------- */

export const zBenchmarkView = z
  .object({
    router: zBenchmarkReport.shape.router,
    catalogSize: zBenchmarkReport.shape.catalogSize,
    bundleHash: zBenchmarkReport.shape.bundleHash,
    /** Whether the report was measured against the bundle's current digest. */
    fresh: z.boolean(),
    summary: zBenchmarkReport.shape.summary,
    confusion: zBenchmarkReport.shape.confusion,
  })
  .nullable();
export type BenchmarkView = z.infer<typeof zBenchmarkView>;

/* -------------------------------------------------------------------------- */
/* GET /api/bundles/:id/drift?against=<bundleId>                               */
/* -------------------------------------------------------------------------- */

export const zDriftQuery = z.object({ against: zBundleId });

export const zDriftView = z.object({
  bundleId: zBundleId,
  against: zBundleId,
  items: z.array(DriftItem),
});
export type DriftView = z.infer<typeof zDriftView>;

/* -------------------------------------------------------------------------- */
/* POST /api/bundles/:id/operations/approve                                    */
/* -------------------------------------------------------------------------- */

export const zApproveOperationsRequest = z.object({
  ids: z.array(Operation.shape.id).min(1),
});

/**
 * `approveOperationsInBundle` is all-or-nothing: an unknown or blocked id, a
 * receipt-bound gateway lineage, or an operation that stays blocked after
 * re-validation refuses the whole request as an error envelope, before any
 * file changes. `refusals` is therefore empty on success today and is kept
 * for the day a partial admission is deliberately designed — never inferred.
 */
export const zApproveOperationsResponse = z.object({
  approved: z.array(Operation.shape.id),
  alreadyApproved: z.array(Operation.shape.id),
  regeneratedFiles: z.number().int().nonnegative(),
  reprojection: zReprojection,
  refusals: z.array(z.object({ id: Operation.shape.id, reason: z.string() })),
});

/* -------------------------------------------------------------------------- */
/* POST /api/bundles/:id/capabilities/:capId/{approve|reject}                  */
/* -------------------------------------------------------------------------- */

/**
 * Exactly the CLI's flags: `--allow-large` and `--note` for approve, `--reason`
 * for reject. The library records no reviewer identity for a capability
 * decision, so the contract does not ask for one — a field the projection
 * would have to invent a home for is a field it does not have.
 */
export const zApproveCapabilityRequest = z.object({
  allowLarge: z.boolean().optional(),
  note: z.string().optional(),
});
export const zRejectCapabilityRequest = z.object({
  reason: z.string().optional(),
});

export const zApproveCapabilityResponse = z.object({
  capabilityId: Capability.shape.id,
  budget: zCapabilityBudget,
  reprojection: zReprojection,
});
export const zRejectCapabilityResponse = z.object({
  capabilityId: Capability.shape.id,
  reprojection: zReprojection,
});

/* -------------------------------------------------------------------------- */
/* POST /api/bundles/:id/packs/:hash/decisions                                 */
/* -------------------------------------------------------------------------- */

export const zPackDecisionRequest = z.object({
  decision: z.enum(["approve", "reject"]),
  refinementIds: z.array(zRefinement.shape.id).min(1),
  reviewer: z.string().min(1),
  reason: z.string().min(1),
});

export const zPackDecisionResponse = z.object({
  receipts: z.array(
    z.object({
      refinementId: zRefinement.shape.id,
      path: z.string(),
      receipt: zRefinementReviewReceipt,
    }),
  ),
});

/* -------------------------------------------------------------------------- */
/* POST /api/bundles/:id/packs/:hash/apply                                     */
/* -------------------------------------------------------------------------- */

export const zApplyPackRequest = z.object({
  receiptFiles: z.array(z.string()).optional(),
  dryRun: z.boolean().optional(),
});

/**
 * `applyPackToBundle` writes AIR only; the projections are regenerated by a
 * following reprojection, reported here when the server performed one.
 */
export const zApplyPackResponse = z.object({
  airPath: z.string(),
  applied: z.array(zRefinement.shape.id),
  changes: z.array(zSemanticChange),
  written: z.boolean(),
  reprojection: zReprojection.optional(),
});

/* -------------------------------------------------------------------------- */
/* POST /api/bundles/:id/clusters/:clusterId/export-task                       */
/* -------------------------------------------------------------------------- */

export const zExportTaskRequest = z.object({
  /** Git repository the harness may inspect (`--repo-root`); defaults to the workspace root. */
  repositoryRoot: z.string().optional(),
  inspectScopes: z.array(z.string()).optional(),
  trafficReportPath: z.string().optional(),
  /** Where to write the task; the server chooses a path under the workspace when omitted. */
  outFile: z.string().optional(),
});

export const zExportTaskResponse = z.object({
  taskPath: z.string(),
  task: zRefinementTask,
});

/* -------------------------------------------------------------------------- */
/* POST /api/bundles/:id/tasks/import                                          */
/* -------------------------------------------------------------------------- */

export const zImportTaskRequest = z.object({
  taskPath: z.string().min(1),
  submissionPath: z.string().min(1),
  /** Pack directory to write; the server chooses one under the workspace when omitted. */
  outDir: z.string().optional(),
  repositoryRoot: z.string().optional(),
});

/**
 * Admission. A refusal — a protocol rejection or a negative routing delta —
 * is an error envelope whose `code` is the harness rejection code and whose
 * `delta` carries the numbers; it is never a 2xx.
 */
export const zImportTaskResponse = z.object({
  taskId: zRefinementTask.shape.taskId,
  packDir: z.string(),
  summary: zRefinementPack.shape.summary,
  refinement: z
    .object({
      id: zRefinement.shape.id,
      status: zRefinement.shape.status,
      tier: zRefinement.shape.approval.shape.tier,
    })
    .optional(),
  delta: zGroupRoutingDelta.optional(),
});

/* -------------------------------------------------------------------------- */
/* The route table                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One table both lanes read: the server registers exactly these routes and
 * the UI calls exactly these routes. `mutates` marks the routes the security
 * contract above guards (token + origin + JSON body); every other route is a
 * read-only projection.
 */
export const CONSOLE_ROUTES = {
  workspace: { method: "GET", path: "/api/workspace", mutates: false, response: zWorkspace },
  bundle: {
    method: "GET",
    path: "/api/bundles/:id",
    mutates: false,
    response: zBundleInspector,
  },
  queue: {
    method: "GET",
    path: "/api/bundles/:id/queue",
    mutates: false,
    response: zDecisionQueue,
  },
  packs: { method: "GET", path: "/api/bundles/:id/packs", mutates: false, response: zPackList },
  benchmark: {
    method: "GET",
    path: "/api/bundles/:id/benchmark",
    mutates: false,
    response: zBenchmarkView,
  },
  drift: {
    method: "GET",
    path: "/api/bundles/:id/drift",
    mutates: false,
    query: zDriftQuery,
    response: zDriftView,
  },
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
  packDecision: {
    method: "POST",
    path: "/api/bundles/:id/packs/:hash/decisions",
    mutates: true,
    request: zPackDecisionRequest,
    response: zPackDecisionResponse,
  },
  applyPack: {
    method: "POST",
    path: "/api/bundles/:id/packs/:hash/apply",
    mutates: true,
    request: zApplyPackRequest,
    response: zApplyPackResponse,
  },
  exportTask: {
    method: "POST",
    path: "/api/bundles/:id/clusters/:clusterId/export-task",
    mutates: true,
    request: zExportTaskRequest,
    response: zExportTaskResponse,
  },
  importTask: {
    method: "POST",
    path: "/api/bundles/:id/tasks/import",
    mutates: true,
    request: zImportTaskRequest,
    response: zImportTaskResponse,
  },
} as const;

export type ConsoleRoute = keyof typeof CONSOLE_ROUTES;
export type ConsoleResponse<R extends ConsoleRoute> = z.infer<
  (typeof CONSOLE_ROUTES)[R]["response"]
>;
