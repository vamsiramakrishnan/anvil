import type { Claim } from "@anvil/air";
import type { Deficiency } from "../deficiency.js";
import type { RefinementSkill, SkillContext, SkillProposal } from "../skills/contract.js";
import type { SkillExecutor } from "../skills/executor.js";
import type { CaseProposal, EvidenceArtifact } from "./model.js";

/**
 * The **investigation harness** — the abstraction the design argues for. Where a
 * `SkillExecutor` collapses a whole investigation into one `execute(skill, context)
 * → proposal | null` call (which reduces a coding agent to a summariser), an
 * `InvestigationHarness` runs a *bounded research job* and returns a structured
 * result: the retrieval plan it drew up, the evidence it found, the atomic claims
 * it extracted, the contradictions it surfaced, the experiments it ran, its
 * self-critique, and — only when the evidence supports one — a proposal.
 *
 * Crucially it can decline. A harness that knows when *not* to refine is worth more
 * than one with a high completion rate, so "no proposal" is a first-class outcome
 * (`insufficient_evidence`, `conflicted`, `blocked_by_missing_source`), not a null.
 *
 * `SkillExecutor` is kept as the smaller deterministic fallback; an
 * `InvestigationHarness` adapts *down* to it (`asSkillExecutor`) so the existing
 * pack/validate/reconcile pipeline consumes either without change.
 */

/** The honest outcomes of an investigation. Only `proposal_generated` carries a patch. */
export type InvestigationStatus =
  | "proposal_generated"
  | "supported"
  | "conflicted"
  | "insufficient_evidence"
  | "blocked_by_missing_source";

/** A step in the executor's retrieval plan — how it decided to investigate. */
export interface SearchStep {
  query: string;
  scope: string;
  rationale?: string;
}

/** A surfaced contradiction: two claims about one semantic that disagree. */
export interface Conflict {
  predicate: string;
  claims: Claim[];
  note?: string;
}

/**
 * The record of a behavioural experiment the harness ran to *create* evidence —
 * the `observed_behavior` class (execute a test, replay a request twice, trigger a
 * documented error path). Experiments run only in the case's isolated workspace and
 * never touch production source; the full command/inputs/outputs are recorded so a
 * reviewer can reproduce the observation.
 */
export interface ExperimentResult {
  hypothesis: string;
  command: string;
  revision?: string;
  inputs?: unknown;
  output?: string;
  exitCode?: number;
  /** Source of any characterization test the harness generated to run this. */
  generatedTestSource?: string;
  /** What the observation lets the harness claim, if anything. */
  conclusion?: string;
}

/** One clause of the drafted value the critic examined. */
export interface CritiqueFinding {
  clause: string;
  supported: boolean;
  reason: string;
}

/** What the harness is asked to investigate: the routed deficiency, its skill, and context. */
export interface InvestigationRequest {
  skill: RefinementSkill;
  deficiency: Deficiency;
  context: SkillContext;
}

/**
 * The full structured result of one investigation. `proposal` is present only when
 * `status === "proposal_generated"`; every other status is an honest decline that
 * still returns everything learned (plan, artifacts, claims, conflicts, experiments)
 * so the finding is auditable and a later tier can build on it.
 */
export interface InvestigationResult {
  status: InvestigationStatus;
  searchPlan: SearchStep[];
  artifacts: EvidenceArtifact[];
  claims: Claim[];
  conflicts: Conflict[];
  experiments: ExperimentResult[];
  critique: CritiqueFinding[];
  proposal?: SkillProposal;
  /** A one-line, human-facing summary of the outcome and why. */
  summary: string;
}

export interface InvestigationHarness {
  name: string;
  investigate(request: InvestigationRequest): Promise<InvestigationResult>;
}

/** Coerce a case's `output/proposal.json` shape to a `SkillProposal` (same fields). */
export function proposalFromCase(p: CaseProposal): SkillProposal {
  return {
    skill: p.skill,
    skillVersion: p.skillVersion,
    deficiency: p.deficiency,
    target: p.target,
    claims: p.claims,
    patch: p.patch,
  };
}

/**
 * Adapt an `InvestigationHarness` down to the narrower `SkillExecutor` seam, so the
 * existing `runRefinements` loop can drive it unchanged: a `proposal_generated`
 * result yields its proposal; every other (honest-decline) status yields `null`.
 * The richer result is available to callers that use `investigate` directly.
 */
export function asSkillExecutor(harness: InvestigationHarness): SkillExecutor {
  return {
    name: harness.name,
    async execute(skill: RefinementSkill, context: SkillContext): Promise<SkillProposal | null> {
      const result = await harness.investigate({ skill, deficiency: context.deficiency, context });
      return result.status === "proposal_generated" ? (result.proposal ?? null) : null;
    },
  };
}
