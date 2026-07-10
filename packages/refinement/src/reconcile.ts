import type { AirDocument } from "@anvil/air";
import { applyPatch } from "./apply.js";
import { classifyApproval } from "./approval.js";
import { affectedArtifacts } from "./artifacts.js";
import { evalDelta, familiesFor } from "./evals/index.js";
import type { Refinement, RefinementStatus } from "./model.js";
import type { SkillContext } from "./skills/contract.js";
import type { ValidatedProposal } from "./skills/validate.js";
import { targetKey } from "./target.js";

export interface ReconcileInput {
  air: AirDocument;
  context: SkillContext;
  validated: ValidatedProposal;
}

/**
 * Reconcile a validated proposal into a `Refinement` with a final status. This is
 * the deterministic core's decision, and it enforces the loop's whole reason for
 * being: a change is accepted only when it is *demonstrated* better and safe.
 *
 *   1. A proposal that failed validation is `rejected` outright.
 *   2. Otherwise we apply the patch to a throwaway clone and measure the eval
 *      families it affects (the safety guard is always among them). A regression
 *      in any affected family — including the guard — makes it `regressed` and it
 *      is never applied, however strong its evidence.
 *   3. A clean measurement is routed by the approval policy: `auto` becomes
 *      `approved`; `review` keeps its measured status (`improved`/`neutral`) and
 *      waits for a human. The policy never loosens safety on weak evidence.
 */
export function reconcile(input: ReconcileInput): Refinement {
  const { air, context, validated } = input;
  const proposal = validated.proposal;
  const artifacts = affectedArtifacts(proposal.target, context.operation);

  const base = {
    id: `${proposal.skill}:${targetKey(proposal.target)}`,
    skill: proposal.skill,
    deficiency: proposal.deficiency,
    target: proposal.target,
    evidence: proposal.claims,
    proposal: proposal.patch,
    affectedArtifacts: artifacts,
    validation: validated.outcomes,
  };

  if (validated.status === "rejected") {
    return {
      ...base,
      evalDelta: [],
      approval: { tier: "reject", reason: "failed deterministic validation" },
      status: "rejected",
    };
  }

  const families = familiesFor(proposal.deficiency);
  const after = applyPatch(air, proposal.patch).air;
  const deltas = evalDelta(air, after, families);
  const regressed = deltas.some((d) => d.verdict === "regressed");
  const improved = deltas.some((d) => d.verdict === "improved");
  const approval = classifyApproval({
    skill: proposal.skill,
    proposal,
    evidence: proposal.claims,
  });

  let status: RefinementStatus;
  if (regressed) {
    // A measured regression (or safety-guard drop) is disqualifying regardless of
    // how the approval policy would otherwise route it.
    status = "regressed";
  } else if (approval.tier === "auto") {
    status = "approved";
  } else {
    // Review tier: surface what we measured; a human decides from here.
    status = improved ? "improved" : "neutral";
  }

  return { ...base, evalDelta: deltas, approval, status };
}
