import { describe, expect, it } from "vitest";
import { type EffectivenessRow, effectivenessMetrics } from "./effectiveness.js";

/**
 * CI-safe unit coverage for the effectiveness *metrics* — the scoring logic, exercised
 * on synthetic rows without invoking a real driver. The battery that produces real
 * rows is opt-in (see effectiveness.test.ts) and excluded from unit CI.
 */
function row(over: Partial<EffectivenessRow>): EffectivenessRow {
  return {
    id: "x",
    category: "explicit_evidence",
    expected: "proposal_generated",
    observed: "proposal_generated",
    outcomeCorrect: true,
    grounded: true,
    unsupportedClaims: 0,
    evidenceRecall: 1,
    conflictExpected: false,
    conflictFound: false,
    ...over,
  };
}

describe("effectivenessMetrics", () => {
  it("computes grounded-proposal precision over proposals only", () => {
    const m = effectivenessMetrics([
      row({ observed: "proposal_generated", outcomeCorrect: true, grounded: true }),
      row({ observed: "proposal_generated", outcomeCorrect: true, grounded: false }),
      row({ expected: "insufficient_evidence", observed: "insufficient_evidence" }),
    ]);
    expect(m.groundedProposalPrecision).toBe(0.5);
  });

  it("computes correct-decline rate over cases that should decline", () => {
    const m = effectivenessMetrics([
      row({ expected: "insufficient_evidence", observed: "insufficient_evidence" }),
      row({ expected: "conflicted", observed: "proposal_generated" }),
      row({ expected: "proposal_generated", observed: "proposal_generated" }),
    ]);
    expect(m.correctDeclineRate).toBe(0.5);
  });

  it("computes conflict-detection recall and unsupported-claim rate", () => {
    const m = effectivenessMetrics([
      row({ expected: "conflicted", conflictExpected: true, conflictFound: true }),
      row({ expected: "conflicted", conflictExpected: true, conflictFound: false }),
      row({ unsupportedClaims: 2 }),
    ]);
    expect(m.conflictDetectionRecall).toBe(0.5);
    expect(m.unsupportedClaimRate).toBeCloseTo(1 / 3, 5);
  });
});
