import type { Claim } from "@anvil/air";
import type { ApprovalDecision } from "./model.js";
import type { SkillProposal } from "./skills/contract.js";
import { meetsStrength, strengthOf } from "./skills/validate.js";

export interface ApprovalInput {
  skill: string;
  proposal: SkillProposal;
  evidence: Claim[];
}

/**
 * The auto-approval policy: decides `auto` vs `review`, never `reject` — a
 * proposal that fails validation or regresses an eval never reaches this
 * function to begin with, so there is nothing left here to reject.
 *
 * Safety is asymmetric by design: tightening a safety semantic (refusing more,
 * retrying less) is always cheap to approve, because the worst case is an
 * unnecessary human review. Loosening one (enabling retries) is exactly
 * backwards — the worst case is a non-idempotent mutation firing twice — so it
 * demands the strongest evidence bar (`authoritative`) regardless of which
 * skill proposed it. That guard runs first and wins over every other rule.
 */
export function classifyApproval(input: ApprovalInput): ApprovalDecision {
  const strength = strengthOf(input.evidence);
  const set = input.proposal.patch.set;

  // Rule 1 — safety loosening guard: enabling retries reduces safety, so it is
  // never auto-approved on anything less than authoritative evidence.
  if (set.retryable === true && strength !== "authoritative") {
    return {
      tier: "review",
      reason: "loosening retry (retryable=true) requires authoritative evidence",
    };
  }

  // Rule 2 — plain descriptions: corroborated+ evidence is enough to trust a
  // human-readable summary that carries no safety weight.
  if (input.skill === "describe-field" || input.skill === "describe-operation") {
    return meetsStrength(strength, "corroborated")
      ? { tier: "auto", reason: "description grounded by corroborated+ evidence" }
      : { tier: "review", reason: "description needs corroborating evidence for auto-approval" };
  }

  // Rule 3 — example values: low-risk documentation of shape, not behavior, so
  // any grounding evidence at all is sufficient.
  if (input.skill === "generate-examples") {
    return input.evidence.length > 0
      ? { tier: "auto", reason: "example values grounded by evidence/schema" }
      : { tier: "review", reason: "example lacks grounding" };
  }

  // Rule 4 — error enrichment: a grounded message is auto at corroborated+
  // strength; tightening retryability to `false` is always safe to auto-apply
  // (loosening was already routed to review by rule 1, above).
  if (input.skill === "enrich-errors") {
    if (typeof set.message === "string" && meetsStrength(strength, "corroborated")) {
      return { tier: "auto", reason: "error message grounded by corroborated+ evidence" };
    }
    if (set.retryable === false) {
      return { tier: "auto", reason: "tightening retryability is always safe" };
    }
    return { tier: "review", reason: "error enrichment needs corroborating evidence" };
  }

  // Rule 5 — default: no rule above matched, so a human decides.
  return { tier: "review", reason: "no auto-approval rule matched; human review required" };
}
