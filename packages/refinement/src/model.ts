import type { Claim } from "@anvil/air";
import type { DeficiencyCode } from "./deficiency.js";
import type { SemanticPatch } from "./skills/contract.js";
import type { ValidationOutcome } from "./skills/validate.js";
import type { SemanticTarget } from "./target.js";

/**
 * The reconciliation model: the shared types the back half of the flywheel is
 * built from. A `Refinement` is the atomic unit of the quality loop — a proposed
 * semantic patch carried together with the evidence behind it, the artifacts it
 * touches, its validation outcomes, the measured eval delta, and the approval
 * decision. Nothing here mutates AIR; these types describe a *decision about* a
 * change, which the deterministic core then applies.
 */

/* -------------------------------------------------------------------------- */
/* Artifacts affected                                                         */
/* -------------------------------------------------------------------------- */

/** A projection a semantic patch re-derives. One patch, many aligned surfaces. */
export type ArtifactKind =
  | "json_schema"
  | "cli_help"
  | "mcp_tool"
  | "skill_reference"
  | "mock"
  | "eval";

export interface ArtifactRef {
  kind: ArtifactKind;
  /** A human-readable pointer to the projection, e.g. `mcp:payments_create_refund`. */
  ref: string;
}

/* -------------------------------------------------------------------------- */
/* Approval policy                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The approval tier a refinement lands in. `auto` may be applied without a human
 * (grounded, low-risk, non-safety-loosening); `review` needs a human; `reject`
 * is never applied. Safety is asymmetric: loosening always needs strong evidence.
 */
export type ApprovalTier = "auto" | "review" | "reject";

export interface ApprovalDecision {
  tier: ApprovalTier;
  reason: string;
}

/* -------------------------------------------------------------------------- */
/* Targeted eval delta                                                        */
/* -------------------------------------------------------------------------- */

/** A behaviour family an eval measures. Only the families a refinement affects run. */
export type EvalFamily =
  | "operation_routing"
  | "argument_mapping"
  | "field_interpretation"
  | "error_recovery"
  | "unsafe_operation_refusal";

export type EvalVerdict = "improved" | "neutral" | "regressed";

/** A family's score over one AIR document: `score` is a 0..1 fraction of `total`. */
export interface EvalScore {
  family: EvalFamily;
  score: number;
  total: number;
}

/** The before/after of one family across a candidate patch, with the verdict. */
export interface EvalDelta {
  family: EvalFamily;
  before: number;
  after: number;
  verdict: EvalVerdict;
}

/* -------------------------------------------------------------------------- */
/* Refinement                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The lifecycle of a refinement:
 *   proposed  — an executor produced it
 *   validated — it passed the skill's deterministic validators
 *   improved  — an affected eval family rose and none regressed
 *   neutral   — no affected family changed and none regressed
 *   regressed — an affected family (or the safety guard) fell — never applied
 *   approved  — cleared the approval policy and is safe to apply
 *   rejected  — failed validation or approval
 */
export type RefinementStatus =
  | "proposed"
  | "validated"
  | "improved"
  | "neutral"
  | "regressed"
  | "approved"
  | "rejected";

export interface Refinement {
  /** Deterministic, stable id — `${skill}:${targetKey(target)}` (no timestamps). */
  id: string;
  skill: string;
  deficiency: DeficiencyCode;
  target: SemanticTarget;
  /** The evidence the proposal is grounded in. */
  evidence: Claim[];
  proposal: SemanticPatch;
  affectedArtifacts: ArtifactRef[];
  validation: ValidationOutcome[];
  /** Empty when the refinement was rejected before measurement. */
  evalDelta: EvalDelta[];
  approval: ApprovalDecision;
  status: RefinementStatus;
}
