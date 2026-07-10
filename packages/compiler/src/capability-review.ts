import type { AirDocument, Capability, Diagnostic, Operation } from "@anvil/air";
import { discoverCapabilities } from "./capabilities.js";

/**
 * Capability review — the lifecycle pass over discovered groupings. Discovery
 * (capabilities.ts) only ever *proposes*; the functions here record the human
 * decision (`approve` / `reject`), enforce the tool-disclosure budget, and
 * compute the drift between a stored capability and a fresh re-discovery so a
 * reviewer approves what the grouping *is now*, not what it once was.
 *
 * Everything is deterministic: the budget check is a pure function of the
 * member count, and diff/propose re-run the same discovery pass the compiler
 * uses (on cloned operations, so review never mutates the loaded model).
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

/** Diagnostic code for a capability over the ideal band (warning, non-blocking). */
export const BUDGET_WARNING_CODE = "capability_tool_budget";
/** Diagnostic code for a capability over the hard limit (blocks approval). */
export const BUDGET_BLOCKED_CODE = "capability_tool_budget_exceeded";

export type CapabilityBudgetVerdict = "ok" | "warning" | "blocked";

/** The deterministic result of the tool-budget check for one capability. */
export interface CapabilityBudgetCheck {
  capabilityId: string;
  toolCount: number;
  verdict: CapabilityBudgetVerdict;
  /** Present unless the verdict is `ok` — the typed, machine-readable finding. */
  diagnostic?: Diagnostic;
}

/**
 * Check one capability against the tool-disclosure budget. Pure and
 * deterministic: the verdict depends only on the member-operation count.
 */
export function capabilityToolBudget(capability: Capability): CapabilityBudgetCheck {
  const toolCount = capability.operationIds.length;
  const base = { capabilityId: capability.id, toolCount };
  if (toolCount > CAPABILITY_TOOL_BUDGET.blockAbove) {
    return {
      ...base,
      verdict: "blocked",
      diagnostic: {
        level: "error",
        code: BUDGET_BLOCKED_CODE,
        capabilityId: capability.id,
        message:
          `Capability '${capability.id}' would disclose ${toolCount} tools ` +
          `(hard limit ${CAPABILITY_TOOL_BUDGET.blockAbove}). Split the grouping, or approve ` +
          `deliberately with --allow-large.`,
      },
    };
  }
  if (toolCount > CAPABILITY_TOOL_BUDGET.idealMax) {
    return {
      ...base,
      verdict: "warning",
      diagnostic: {
        level: "warning",
        code: BUDGET_WARNING_CODE,
        capabilityId: capability.id,
        message:
          `Capability '${capability.id}' discloses ${toolCount} tools; the default ` +
          `disclosure band is ${CAPABILITY_TOOL_BUDGET.idealMin}–${CAPABILITY_TOOL_BUDGET.idealMax}. ` +
          `Consider splitting it.`,
      },
    };
  }
  return { ...base, verdict: "ok" };
}

/** A structured, typed failure from a capability review action. */
export class CapabilityReviewError extends Error {
  readonly code: "capability_not_found" | "capability_budget_exceeded";
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
  const budget = capabilityToolBudget(capability);
  if (budget.verdict === "blocked" && options.allowLarge !== true) {
    throw new CapabilityReviewError(
      "capability_budget_exceeded",
      budget.diagnostic?.message ?? `Capability '${capabilityId}' exceeds the tool budget.`,
      budget.diagnostic,
    );
  }
  capability.lifecycle = "approved";
  if (options.note) capability.reviewNote = options.note;
  return budget;
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
    return { capability, budget: capabilityToolBudget(capability), isNew: !prior };
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
