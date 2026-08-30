import type { AirDocument, Capability, Diagnostic, Operation } from "@anvil/air";
import { DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS } from "@anvil/air";
import { discoverCapabilities } from "./capabilities.js";

/**
 * Capability review — the lifecycle pass over discovered groupings. Discovery
 * (capabilities.ts) only ever *proposes*; the functions here record the human
 * decision (`approve` / `reject`), enforce the tool-disclosure budget, and
 * compute the drift between a stored capability and a fresh re-discovery so a
 * reviewer approves what the grouping *is now*, not what it once was.
 *
 * Everything is deterministic: the budget check is a pure function of the
 * member count and of the members' *recorded* disclosure measurements, and
 * diff/propose re-run the same discovery pass the compiler uses (on cloned
 * operations, so review never mutates the loaded model).
 */

/**
 * The tool-disclosure budget. A capability is the unit an agent loads, so it
 * should disclose a *navigable* number of tools: 5–15 by default. Above 15 the
 * grouping is probably two capabilities wearing one tag (warning); above 20 it
 * is an attention flood, and approval is blocked unless the reviewer explicitly
 * accepts the size (`--allow-large`).
 */
export const CAPABILITY_TOOL_BUDGET = {
  /** Below this the capability is small but fine — no diagnostic. */
  idealMin: 5,
  /** Above this the capability discloses more tools than agents navigate well. */
  idealMax: 15,
  /** Above this approval is blocked without an explicit override. */
  blockAbove: 20,
} as const;

/**
 * The same band, expressed in the unit it was always a proxy for.
 *
 * Counting tools is a stand-in for "how much of the agent's context does loading
 * this capability consume" — and a poor one, because it cannot tell eight small
 * tools from eight monsters. Both score 8; only one of them fits. So once an
 * operation carries a *measured* tool surface (`disclosureCost.toolTokens`, see
 * `disclosure-cost.ts`), the capability is judged on the real quantity as well.
 *
 * The thresholds are derived rather than invented: the count band already
 * encodes a judgement about how many per-operation disclosure budgets an agent
 * will absorb, so the token band is that same band times the per-operation
 * budget. One knob (`DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS`) moves both, and a
 * capability of averagely-sized tools lands on the same verdict either way —
 * the dimensions diverge only when tool *size* is the thing going wrong, which
 * is exactly the case the count band was blind to.
 */
export const CAPABILITY_TOKEN_BUDGET = {
  /** Above this the measured disclosure is larger than agents navigate well. */
  idealMax: DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS * CAPABILITY_TOOL_BUDGET.idealMax,
  /** Above this approval is blocked without an explicit override. */
  blockAbove: DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS * CAPABILITY_TOOL_BUDGET.blockAbove,
} as const;

/** Diagnostic code for a capability over the ideal band (warning, non-blocking). */
export const BUDGET_WARNING_CODE = "capability_tool_budget";
/** Diagnostic code for a capability over the hard limit (blocks approval). */
export const BUDGET_BLOCKED_CODE = "capability_tool_budget_exceeded";
/** Durable audit signal when a reviewer deliberately waives the hard limit. */
export const BUDGET_WAIVED_CODE = "capability_tool_budget_waived";

/** Measured-token counterpart of {@link BUDGET_WARNING_CODE}. */
export const BUDGET_TOKEN_WARNING_CODE = "capability_disclosure_token_budget";
/** Measured-token counterpart of {@link BUDGET_BLOCKED_CODE}. */
export const BUDGET_TOKEN_BLOCKED_CODE = "capability_disclosure_token_budget_exceeded";
/** Measured-token counterpart of {@link BUDGET_WAIVED_CODE}. */
export const BUDGET_TOKEN_WAIVED_CODE = "capability_disclosure_token_budget_waived";

export type CapabilityBudgetVerdict = "ok" | "warning" | "blocked";

/** The deterministic result of the tool-budget check for one capability. */
export interface CapabilityBudgetCheck {
  capabilityId: string;
  toolCount: number;
  /**
   * Summed measured tool-surface tokens over the disclosed operations, or
   * `undefined` when not one of them was measured. When only some were, this is
   * a *lower bound* — see `measuredOperations` / `unmeasuredOperations`. Absent
   * means "not measured", never "free": a capability nobody measured is not
   * evidence of a problem and never produces a token finding.
   */
  disclosureTokens?: number;
  /** How many disclosed operations carried a measurement (0 when unmeasured). */
  measuredOperations?: number;
  /** How many disclosed operations did not — the slack in the lower bound. */
  unmeasuredOperations?: number;
  /**
   * Operation tools an approved workflow REPLACED on the agent-facing surface
   * (`Workflow.supersedes`). They are not disclosed, so they are not counted —
   * this is the number that makes a suddenly-smaller `toolCount` legible rather
   * than mysterious.
   */
  supersededOperations?: number;
  /** Composite workflow tools counted in `toolCount` (approved workflows only). */
  workflowTools?: number;
  verdict: CapabilityBudgetVerdict;
  /**
   * The governing finding: whichever dimension produced the worse verdict, with
   * the count dimension winning ties. Consumers that predate the token
   * dimension keep reading exactly what they read before — an unmeasured
   * capability has no token finding to govern anything — while a `blocked`
   * verdict always carries the diagnostic that explains the block.
   */
  diagnostic?: Diagnostic;
  /** The count-dimension finding on its own, when it has one. */
  countDiagnostic?: Diagnostic;
  /** The token-dimension finding on its own, when the measurement produced one. */
  tokenDiagnostic?: Diagnostic;
}

/**
 * Check one capability against the tool-disclosure budget. Pure and
 * deterministic. `operations` is optional because a caller may hold only the
 * grouping (a proposal, a manifest row) and not the model behind it; without it
 * the check is exactly the count band it has always been.
 */
export function capabilityToolBudget(
  capability: Capability,
  operations: readonly Operation[] = [],
): CapabilityBudgetCheck {
  return budgetForOperationIds(capability, capability.operationIds, operations);
}

/**
 * Budget the actual surface a capability build can disclose — the surface as it
 * is *served*, after composition has taken its bite out of it.
 *
 * Three terms, and the third is the point:
 *  - its direct members, plus every operation an authored workflow it owns
 *    references. Dependencies count regardless of current operation approval, so
 *    approving a dependency later cannot silently expand a grouping beyond what
 *    was reviewed.
 *  - MINUS every operation an **approved** workflow supersedes: those tools are
 *    not listed by `@anvil/mcp-runtime`, so charging the capability for them
 *    would budget a surface nobody is served. Only approved workflows count,
 *    matching the runtime exactly — an unapproved workflow suppresses nothing
 *    there and must therefore discount nothing here.
 *  - PLUS one tool per approved workflow the capability owns, because a
 *    composite IS a tool an agent has to route past.
 *
 * That third term is what makes composition pay. Before it, wrapping three
 * operations in a workflow left the budget at three and added an unbudgeted
 * fourth tool to the served surface: composing *cost* an operator budget and
 * bought them nothing. Now wrapping three and superseding all three scores one.
 * A workflow that supersedes nothing still scores +1 — which is honest, and is
 * the same signal read from the other end: a purely additive composite really
 * does make the surface an agent routes over bigger.
 */
export function capabilityDisclosureBudget(
  air: AirDocument,
  capabilityId: string,
): CapabilityBudgetCheck {
  const capability = requireCapability(air, capabilityId);
  const approvedWorkflows = air.workflows.filter((workflow) => workflow.state === "approved");
  // Supersession is a property of the served MCP surface, which spans the whole
  // document — a workflow in a neighbouring capability that replaces an
  // operation this one also lists has still removed the tool. So the set is
  // gathered document-wide, not per capability.
  const superseded = new Set(approvedWorkflows.flatMap((workflow) => workflow.supersedes ?? []));
  const disclosed = disclosedOperationIds(air, capability).filter((id) => !superseded.has(id));
  const workflowTools = approvedWorkflows.filter(
    (workflow) => workflow.capabilityId === capability.id,
  ).length;
  const supersededOperations = new Set(
    disclosedOperationIds(air, capability).filter((id) => superseded.has(id)),
  ).size;
  return {
    ...budgetForOperationIds(capability, disclosed, air.operations, workflowTools),
    supersededOperations,
    workflowTools,
  };
}

function budgetForOperationIds(
  capability: Capability,
  operationIds: readonly string[],
  operations: readonly Operation[] = [],
  extraTools = 0,
): CapabilityBudgetCheck {
  const unique = new Set(operationIds);
  const toolCount = unique.size + extraTools;
  const count = countBand(capability.id, toolCount);
  const tokens = tokenBand(capability.id, unique, operations);
  return {
    capabilityId: capability.id,
    toolCount,
    ...tokens.measurement,
    // The worse of the two dimensions governs: a capability that is fine on one
    // and blocked on the other is blocked. Tokens can only ever be *worse* than
    // the count verdict, never better — a measured overrun is evidence, an
    // absent measurement is not, so the token dimension never clears a count
    // finding it knows nothing about.
    verdict: worst(count.verdict, tokens.verdict),
    // The worse dimension explains the verdict — a block must never be reported
    // through a warning-level message about the other dimension. Ties go to the
    // count band, which keeps the field byte-identical for every document that
    // predates measurement.
    diagnostic:
      VERDICT_SEVERITY[count.verdict] >= VERDICT_SEVERITY[tokens.verdict]
        ? (count.diagnostic ?? tokens.diagnostic)
        : tokens.diagnostic,
    countDiagnostic: count.diagnostic,
    tokenDiagnostic: tokens.diagnostic,
  };
}

interface BandResult {
  verdict: CapabilityBudgetVerdict;
  diagnostic?: Diagnostic;
}

const VERDICT_SEVERITY: Record<CapabilityBudgetVerdict, number> = {
  ok: 0,
  warning: 1,
  blocked: 2,
};

function worst(a: CapabilityBudgetVerdict, b: CapabilityBudgetVerdict): CapabilityBudgetVerdict {
  return VERDICT_SEVERITY[a] >= VERDICT_SEVERITY[b] ? a : b;
}

/** The original count band, unchanged — tokens are an addition, not a rewrite. */
function countBand(capabilityId: string, toolCount: number): BandResult {
  if (toolCount > CAPABILITY_TOOL_BUDGET.blockAbove) {
    return {
      verdict: "blocked",
      diagnostic: {
        level: "error",
        code: BUDGET_BLOCKED_CODE,
        capabilityId,
        message:
          `Capability '${capabilityId}' would disclose ${toolCount} tools ` +
          `(hard limit ${CAPABILITY_TOOL_BUDGET.blockAbove}). Split the grouping, or approve ` +
          `deliberately with --allow-large.`,
      },
    };
  }
  if (toolCount > CAPABILITY_TOOL_BUDGET.idealMax) {
    return {
      verdict: "warning",
      diagnostic: {
        level: "warning",
        code: BUDGET_WARNING_CODE,
        capabilityId,
        message:
          `Capability '${capabilityId}' discloses ${toolCount} tools; the default ` +
          `disclosure band is ${CAPABILITY_TOOL_BUDGET.idealMin}–${CAPABILITY_TOOL_BUDGET.idealMax}. ` +
          `Consider splitting it.`,
      },
    };
  }
  return { verdict: "ok" };
}

interface TokenBandResult extends BandResult {
  measurement: Pick<
    CapabilityBudgetCheck,
    "disclosureTokens" | "measuredOperations" | "unmeasuredOperations"
  >;
}

/**
 * The measured dimension. Sums whatever tool surfaces were measured and judges
 * that sum, which is a *lower bound* on the true disclosure whenever some
 * members are unmeasured. Judging a lower bound is sound in one direction only,
 * and that is the direction we use it: a sum that already exceeds a threshold
 * can only grow once the rest is measured, so the finding stands. The converse
 * — concluding a partly-measured capability is fine — is not claimed; silence
 * from this band means "no evidence of an overrun", never "verified small".
 */
function tokenBand(
  capabilityId: string,
  operationIds: ReadonlySet<string>,
  operations: readonly Operation[],
): TokenBandResult {
  let disclosureTokens = 0;
  let measuredOperations = 0;
  let unmeasuredOperations = 0;
  for (const id of operationIds) {
    const operation = operations.find((candidate) => candidate.id === id);
    const cost = operation?.disclosureCost;
    // A dependency the document does not contain is counted as unmeasured
    // rather than as absent: it is still disclosed, we simply cannot price it.
    if (!cost) {
      unmeasuredOperations += 1;
      continue;
    }
    disclosureTokens += cost.toolTokens;
    measuredOperations += 1;
  }

  // Nothing measured: behave precisely as before this dimension existed. An
  // unmeasured capability is not a suspicious one — it is a capability nobody
  // has run `measureAirDisclosure` over — and inferring a problem from missing
  // evidence would make approval depend on whether a build step happened to run.
  if (measuredOperations === 0) {
    return { verdict: "ok", measurement: { measuredOperations: 0, unmeasuredOperations } };
  }

  const measurement = { disclosureTokens, measuredOperations, unmeasuredOperations };
  const partial =
    unmeasuredOperations > 0
      ? ` (measured ${measuredOperations} of ${measuredOperations + unmeasuredOperations} disclosed operations, so the real figure is higher)`
      : "";

  if (disclosureTokens > CAPABILITY_TOKEN_BUDGET.blockAbove) {
    return {
      verdict: "blocked",
      measurement,
      diagnostic: {
        level: "error",
        code: BUDGET_TOKEN_BLOCKED_CODE,
        capabilityId,
        message:
          `Capability '${capabilityId}' would disclose ${disclosureTokens} measured tool-surface ` +
          `tokens${partial} (hard limit ${CAPABILITY_TOKEN_BUDGET.blockAbove}). The tool count is ` +
          `not the binding constraint here — the tools themselves are large. Split the grouping, ` +
          `trim descriptions and input schemas, or approve deliberately with --allow-large.`,
      },
    };
  }
  if (disclosureTokens > CAPABILITY_TOKEN_BUDGET.idealMax) {
    return {
      verdict: "warning",
      measurement,
      diagnostic: {
        level: "warning",
        code: BUDGET_TOKEN_WARNING_CODE,
        capabilityId,
        message:
          `Capability '${capabilityId}' discloses ${disclosureTokens} measured tool-surface ` +
          `tokens${partial}; the default band is ${CAPABILITY_TOKEN_BUDGET.idealMax} ` +
          `(${CAPABILITY_TOOL_BUDGET.idealMax} tools x ${DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS} ` +
          `tokens). Consider splitting it, or trimming oversized descriptions and input schemas.`,
      },
    };
  }
  return { verdict: "ok", measurement };
}

/** A structured, typed failure from a capability review action. */
export class CapabilityReviewError extends Error {
  readonly code:
    | "capability_not_found"
    | "capability_budget_exceeded"
    | "capability_budget_waiver_note_required";
  /** The budget diagnostic, when the failure is budget-driven. */
  readonly diagnostic?: Diagnostic;

  constructor(code: CapabilityReviewError["code"], message: string, diagnostic?: Diagnostic) {
    super(message);
    this.name = "CapabilityReviewError";
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

function requireCapability(air: AirDocument, capabilityId: string): Capability {
  const capability = air.capabilities.find((c) => c.id === capabilityId);
  if (!capability) {
    const known = air.capabilities.map((c) => c.id).join(", ") || "(none)";
    throw new CapabilityReviewError(
      "capability_not_found",
      `No capability '${capabilityId}'. Known capabilities: ${known}.`,
    );
  }
  return capability;
}

export interface ApproveCapabilityOptions {
  /** Accept a blocked (>hard-limit) disclosure deliberately. */
  allowLarge?: boolean;
  /** Reviewer note recorded on the capability. */
  note?: string;
}

/**
 * Approve one capability grouping, enforcing the tool budget: a `blocked`
 * verdict refuses without `allowLarge` (structured error carrying the typed
 * diagnostic). Mutates the capability in place — mirror of `approveOperations`;
 * the caller persists AIR. Returns the budget check so the CLI can surface a
 * non-blocking warning verdict alongside the approval.
 */
export function approveCapability(
  air: AirDocument,
  capabilityId: string,
  options: ApproveCapabilityOptions = {},
): CapabilityBudgetCheck {
  const capability = requireCapability(air, capabilityId);
  const budget = capabilityDisclosureBudget(air, capabilityId);
  if (budget.verdict === "blocked" && options.allowLarge !== true) {
    throw new CapabilityReviewError(
      "capability_budget_exceeded",
      budget.diagnostic?.message ?? `Capability '${capabilityId}' exceeds the tool budget.`,
      budget.diagnostic,
    );
  }
  if (budget.verdict === "blocked" && !options.note?.trim()) {
    throw new CapabilityReviewError(
      "capability_budget_waiver_note_required",
      `Capability '${capabilityId}' exceeds the hard tool budget; --allow-large requires a non-empty review note so the waiver is auditable.`,
    );
  }
  capability.lifecycle = "approved";
  if (options.note) capability.reviewNote = options.note;
  const acceptedBudget = budget.verdict === "blocked" ? waive(budget, options.note) : budget;
  recordBudgetDiagnostics(air, capabilityId, acceptedBudget);
  return acceptedBudget;
}

/**
 * Turn a blocked verdict into the durable audit record of a deliberate waiver.
 * Each dimension is waived in its own voice: a reviewer who accepted 24 tools
 * has not thereby accepted 60,000 tokens of surface, so a token overrun keeps
 * its own code and its own number in the record rather than being folded into
 * a message about tool counts.
 */
function waive(budget: CapabilityBudgetCheck, note: string | undefined): CapabilityBudgetCheck {
  const suffix = note ? `: ${note}` : ".";
  const capabilityId = budget.capabilityId;
  // Only a *blocked* dimension is waived. A dimension that merely warned keeps
  // its warning: the reviewer accepted a hard limit, not everything the check
  // had to say.
  const countDiagnostic: Diagnostic | undefined =
    budget.countDiagnostic?.code === BUDGET_BLOCKED_CODE
      ? {
          level: "warning",
          code: BUDGET_WAIVED_CODE,
          capabilityId,
          message:
            `Capability '${capabilityId}' discloses ${budget.toolCount} tools, above the hard ` +
            `limit ${CAPABILITY_TOOL_BUDGET.blockAbove}; the reviewer explicitly waived the limit` +
            suffix,
        }
      : budget.countDiagnostic;
  const tokenDiagnostic: Diagnostic | undefined =
    budget.tokenDiagnostic?.code === BUDGET_TOKEN_BLOCKED_CODE
      ? {
          level: "warning",
          code: BUDGET_TOKEN_WAIVED_CODE,
          capabilityId,
          message:
            `Capability '${capabilityId}' discloses ${budget.disclosureTokens} measured ` +
            `tool-surface tokens, above the hard limit ${CAPABILITY_TOKEN_BUDGET.blockAbove}; ` +
            `the reviewer explicitly waived the limit${suffix}`,
        }
      : budget.tokenDiagnostic;
  return {
    ...budget,
    verdict: "warning",
    // Both dimensions are now at most a warning, so the tie rule applies again.
    diagnostic: countDiagnostic ?? tokenDiagnostic,
    countDiagnostic,
    tokenDiagnostic,
  };
}

/**
 * Reject one capability grouping, recording why. Mutates in place; the caller
 * persists AIR. Rejection is about the *grouping* — member operations keep
 * their own approval lifecycle untouched.
 */
export function rejectCapability(
  air: AirDocument,
  capabilityId: string,
  reason?: string,
): Capability {
  const capability = requireCapability(air, capabilityId);
  capability.lifecycle = "rejected";
  if (reason) capability.reviewNote = reason;
  recordBudgetDiagnostics(air, capabilityId, undefined);
  return capability;
}

/** One freshly discovered grouping, annotated for review. */
export interface CapabilityProposal {
  /** The fresh discovery, with any stored review decision carried over by id. */
  capability: Capability;
  budget: CapabilityBudgetCheck;
  /** True when no stored capability has this id (a genuinely new grouping). */
  isNew: boolean;
}

/**
 * Re-run capability discovery over the document's operations and annotate each
 * grouping with its budget verdict. Stored review decisions (lifecycle + note)
 * survive by capability id, so re-proposing never silently un-approves. Pure:
 * operations are cloned before discovery (which stamps `capabilityId`), so the
 * loaded document is never mutated.
 */
export function proposeCapabilities(air: AirDocument): CapabilityProposal[] {
  const stored = new Map(air.capabilities.map((c) => [c.id, c]));
  return rediscover(air).map((capability) => {
    const prior = stored.get(capability.id);
    if (prior) {
      capability.lifecycle = prior.lifecycle;
      capability.reviewNote = prior.reviewNote;
    }
    return {
      capability,
      budget: budgetForOperationIds(
        capability,
        disclosedOperationIds(air, capability),
        air.operations,
      ),
      isNew: !prior,
    };
  });
}

/** What changed between the stored capability and a fresh re-discovery. */
export interface CapabilityDiff {
  capabilityId: string;
  /** False when fresh discovery no longer produces this grouping at all. */
  present: boolean;
  addedOperations: string[];
  removedOperations: string[];
  sourceChanged?: { from: Capability["source"]; to: Capability["source"] };
  addedResources: string[];
  removedResources: string[];
  unchanged: boolean;
}

/**
 * Diff one stored capability against what discovery would propose today.
 * The review question this answers: "is the thing I approved still the thing
 * that exists?" Deterministic; never mutates the loaded document.
 */
export function diffCapability(air: AirDocument, capabilityId: string): CapabilityDiff {
  const stored = requireCapability(air, capabilityId);
  const fresh = rediscover(air).find((c) => c.id === capabilityId);
  if (!fresh) {
    return {
      capabilityId,
      present: false,
      addedOperations: [],
      removedOperations: [...stored.operationIds].sort(),
      addedResources: [],
      removedResources: [...stored.resources].sort(),
      unchanged: false,
    };
  }
  const added = fresh.operationIds.filter((id) => !stored.operationIds.includes(id)).sort();
  const removed = stored.operationIds.filter((id) => !fresh.operationIds.includes(id)).sort();
  const addedResources = fresh.resources.filter((r) => !stored.resources.includes(r)).sort();
  const removedResources = stored.resources.filter((r) => !fresh.resources.includes(r)).sort();
  const sourceChanged =
    fresh.source === stored.source ? undefined : { from: stored.source, to: fresh.source };
  return {
    capabilityId,
    present: true,
    addedOperations: added,
    removedOperations: removed,
    sourceChanged,
    addedResources,
    removedResources,
    unchanged:
      added.length === 0 &&
      removed.length === 0 &&
      !sourceChanged &&
      addedResources.length === 0 &&
      removedResources.length === 0,
  };
}

/** Fresh discovery on cloned operations (discovery stamps `capabilityId` in place). */
function rediscover(air: AirDocument): Capability[] {
  const clones = structuredClone(air.operations) as Operation[];
  return discoverCapabilities(air.service.id, clones);
}

function disclosedOperationIds(air: AirDocument, capability: Capability): string[] {
  return [
    ...capability.operationIds,
    ...air.workflows
      .filter((workflow) => workflow.capabilityId === capability.id)
      .flatMap((workflow) => workflow.steps.map((step) => step.operationId)),
  ];
}

/**
 * Every budget code this module is allowed to leave behind on the document. The
 * recorded set is replaced wholesale on each decision, so a grouping that was
 * re-reviewed never accumulates two generations of contradictory findings.
 * Blocked codes are absent by construction: a blocked verdict refuses approval,
 * so it is carried in the thrown error, never persisted as an accepted state.
 */
const RECORDED_BUDGET_CODES = new Set<string>([
  BUDGET_WARNING_CODE,
  BUDGET_WAIVED_CODE,
  BUDGET_TOKEN_WARNING_CODE,
  BUDGET_TOKEN_WAIVED_CODE,
]);

function recordBudgetDiagnostics(
  air: AirDocument,
  capabilityId: string,
  budget: CapabilityBudgetCheck | undefined,
): void {
  air.diagnostics = air.diagnostics.filter(
    (candidate) =>
      !(candidate.capabilityId === capabilityId && RECORDED_BUDGET_CODES.has(candidate.code)),
  );
  // The two dimensions can report the same finding object (a token-only
  // finding governs `diagnostic` when the count band is clean), so dedupe by
  // code rather than pushing both blindly.
  const seen = new Set<string>();
  for (const diagnostic of [budget?.diagnostic, budget?.tokenDiagnostic]) {
    if (!diagnostic || !RECORDED_BUDGET_CODES.has(diagnostic.code)) continue;
    if (seen.has(diagnostic.code)) continue;
    seen.add(diagnostic.code);
    air.diagnostics.push(diagnostic);
  }
}
