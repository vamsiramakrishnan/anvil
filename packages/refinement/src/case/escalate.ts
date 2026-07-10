import { HeuristicSkillExecutor, type SkillExecutor } from "../skills/executor.js";
import type {
  InvestigationHarness,
  InvestigationRequest,
  InvestigationResult,
} from "./investigation.js";

/**
 * **Multi-pass escalation.** Not every deficiency deserves a full repository
 * investigation, so the harness climbs a cost ladder and stops at the cheapest tier
 * that closes the gap:
 *   0 deterministic  — copy explicit schema examples, descriptions, enum comments
 *   1 extraction     — cheap search-and-extract of direct facts
 *   2 repository     — trace code, tests, docs, and history (a case investigation)
 *   3 behavioural    — run tests / mocks / characterization probes (experiments)
 *   4 human          — conflicting safety semantics, auth, retry, workflow meaning
 *
 * Tier 0/1 is the deterministic `SkillExecutor`; tiers 2/3 are a case-backed
 * `InvestigationHarness`; tier 4 is a decision to route to a human. We only pay for
 * a deeper tier when the shallower one cannot close the deficiency.
 */
export const ESCALATION_TIERS = {
  deterministic: 0,
  extraction: 1,
  repository: 2,
  behavioral: 3,
  human: 4,
} as const;

export type EscalationTier = (typeof ESCALATION_TIERS)[keyof typeof ESCALATION_TIERS];

const TIER_NAME: Record<EscalationTier, string> = {
  0: "deterministic",
  1: "extraction",
  2: "repository",
  3: "behavioral",
  4: "human",
};

export interface Escalation {
  tier: EscalationTier;
  tierName: string;
  result: InvestigationResult;
}

export interface EscalateOptions {
  /** The Tier 0/1 executor (default the deterministic reference). */
  deterministic?: SkillExecutor;
  /** The Tier 2/3 investigation harness (a case-backed one). */
  deep: InvestigationHarness;
}

/**
 * Investigate a deficiency at the lowest tier that closes it. The deterministic
 * executor runs first; only when it declines do we open a case. A conflicted result
 * — or a safety-category deficiency that the investigation could not ground — is
 * escalated to the human tier rather than forced into a proposal.
 */
export async function escalate(
  request: InvestigationRequest,
  options: EscalateOptions,
): Promise<Escalation> {
  const deterministic = options.deterministic ?? new HeuristicSkillExecutor();
  const proposal = await deterministic.execute(request.skill, request.context);
  if (proposal) {
    return {
      tier: ESCALATION_TIERS.deterministic,
      tierName: TIER_NAME[ESCALATION_TIERS.deterministic],
      result: {
        status: "proposal_generated",
        searchPlan: [],
        artifacts: [],
        claims: proposal.claims,
        conflicts: [],
        experiments: [],
        critique: [],
        proposal,
        summary: "Closed by the deterministic executor; no investigation needed.",
      },
    };
  }

  const result = await options.deep.investigate(request);
  const tier = decideTier(request, result);
  return { tier, tierName: TIER_NAME[tier], result };
}

function decideTier(request: InvestigationRequest, result: InvestigationResult): EscalationTier {
  // A contradiction is a human call; so is a safety deficiency we could not ground.
  if (result.status === "conflicted") return ESCALATION_TIERS.human;
  if (request.deficiency.category === "safety" && result.status !== "proposal_generated") {
    return ESCALATION_TIERS.human;
  }
  return result.experiments.length > 0 ? ESCALATION_TIERS.behavioral : ESCALATION_TIERS.repository;
}
