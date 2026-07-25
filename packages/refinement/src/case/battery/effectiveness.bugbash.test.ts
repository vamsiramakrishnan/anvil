import { describe, expect, it } from "vitest";
import { type EffectivenessRow, effectivenessMetrics } from "./effectiveness.js";

/**
 * Bugbash: comprehensive test coverage for effectivenessMetrics scoring logic.
 * Focuses on outcome mixes (all-pass, all-fail, mixed), empty battery,
 * boundary values, and comprehensive metric computation.
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

describe("effectivenessMetrics - empty battery", () => {
  it("returns 1.0 for all metrics when given empty array", () => {
    const m = effectivenessMetrics([]);
    expect(m.cases).toBe(0);
    expect(m.groundedProposalPrecision).toBe(1);
    expect(m.correctDeclineRate).toBe(1);
    expect(m.conflictDetectionRecall).toBe(1);
    expect(m.unsupportedClaimRate).toBe(0);
    expect(m.meanEvidenceRecall).toBe(0);
    expect(m.outcomeAccuracy).toBe(0);
  });
});

describe("effectivenessMetrics - all-pass scenarios", () => {
  it("computes 1.0 for all metrics when all rows are perfect", () => {
    const m = effectivenessMetrics([
      row({ observed: "proposal_generated", outcomeCorrect: true, grounded: true }),
      row({ observed: "proposal_generated", outcomeCorrect: true, grounded: true }),
      row({ observed: "proposal_generated", outcomeCorrect: true, grounded: true }),
    ]);
    expect(m.cases).toBe(3);
    expect(m.groundedProposalPrecision).toBe(1);
    expect(m.outcomeAccuracy).toBe(1);
    expect(m.unsupportedClaimRate).toBe(0);
    expect(m.meanEvidenceRecall).toBe(1);
  });

  it("handles all-correct declines with 1.0 correctDeclineRate", () => {
    const m = effectivenessMetrics([
      row({ expected: "insufficient_evidence", observed: "insufficient_evidence" }),
      row({ expected: "conflicted", observed: "conflicted" }),
      row({ expected: "blocked_by_missing_source", observed: "blocked_by_missing_source" }),
      row({ expected: "supported", observed: "supported" }),
    ]);
    expect(m.correctDeclineRate).toBe(1);
    expect(m.outcomeAccuracy).toBe(1);
  });

  it("handles all-correct conflicts with 1.0 conflictDetectionRecall", () => {
    const m = effectivenessMetrics([
      row({ expected: "conflicted", conflictExpected: true, conflictFound: true }),
      row({ expected: "conflicted", conflictExpected: true, conflictFound: true }),
    ]);
    expect(m.conflictDetectionRecall).toBe(1);
    expect(m.outcomeAccuracy).toBe(1);
  });

  it("returns 1.0 for all metrics when single perfect row", () => {
    const m = effectivenessMetrics([
      row({
        observed: "proposal_generated",
        outcomeCorrect: true,
        grounded: true,
        unsupportedClaims: 0,
        evidenceRecall: 1,
      }),
    ]);
    expect(m.cases).toBe(1);
    expect(m.groundedProposalPrecision).toBe(1);
    expect(m.correctDeclineRate).toBe(1);
    expect(m.outcomeAccuracy).toBe(1);
    expect(m.unsupportedClaimRate).toBe(0);
    expect(m.meanEvidenceRecall).toBe(1);
  });
});

describe("effectivenessMetrics - all-fail scenarios", () => {
  it("computes 0.0 for groundedProposalPrecision when all proposals are wrong", () => {
    const m = effectivenessMetrics([
      row({ observed: "proposal_generated", outcomeCorrect: false, grounded: false }),
      row({ observed: "proposal_generated", outcomeCorrect: false, grounded: false }),
    ]);
    expect(m.groundedProposalPrecision).toBe(0);
    expect(m.outcomeAccuracy).toBe(0);
  });

  it("computes 0.0 correctDeclineRate when no correct declines", () => {
    const m = effectivenessMetrics([
      row({ expected: "insufficient_evidence", observed: "proposal_generated" }),
      row({ expected: "conflicted", observed: "proposal_generated" }),
    ]);
    expect(m.correctDeclineRate).toBe(0);
  });

  it("computes 0.0 conflictDetectionRecall when conflicts not found", () => {
    const m = effectivenessMetrics([
      row({ expected: "conflicted", conflictExpected: true, conflictFound: false }),
      row({ expected: "conflicted", conflictExpected: true, conflictFound: false }),
    ]);
    expect(m.conflictDetectionRecall).toBe(0);
  });

  it("computes 1.0 unsupportedClaimRate when all rows have claims", () => {
    const m = effectivenessMetrics([
      row({ unsupportedClaims: 1 }),
      row({ unsupportedClaims: 2 }),
      row({ unsupportedClaims: 3 }),
    ]);
    expect(m.unsupportedClaimRate).toBe(1);
  });

  it("returns 0.0 outcomeAccuracy when no outcomes correct", () => {
    const m = effectivenessMetrics([
      row({ outcomeCorrect: false }),
      row({ outcomeCorrect: false }),
      row({ outcomeCorrect: false }),
    ]);
    expect(m.outcomeAccuracy).toBe(0);
  });

  it("returns 0.0 meanEvidenceRecall when all evidence recall is 0", () => {
    const m = effectivenessMetrics([row({ evidenceRecall: 0 }), row({ evidenceRecall: 0 })]);
    expect(m.meanEvidenceRecall).toBe(0);
  });
});

describe("effectivenessMetrics - mixed outcomes", () => {
  it("computes correct precision for mixed proposal outcomes", () => {
    const m = effectivenessMetrics([
      row({ observed: "proposal_generated", outcomeCorrect: true, grounded: true }),
      row({ observed: "proposal_generated", outcomeCorrect: true, grounded: false }),
      row({ observed: "proposal_generated", outcomeCorrect: false, grounded: true }),
      row({ observed: "proposal_generated", outcomeCorrect: false, grounded: false }),
    ]);
    // Only first row is (correct AND grounded): 1/4 = 0.25
    expect(m.groundedProposalPrecision).toBe(0.25);
    expect(m.outcomeAccuracy).toBe(0.5);
  });

  it("computes correctDeclineRate for mixed decline cases", () => {
    const m = effectivenessMetrics([
      row({ expected: "insufficient_evidence", observed: "insufficient_evidence" }),
      row({ expected: "insufficient_evidence", observed: "proposal_generated" }),
      row({ expected: "proposal_generated", observed: "proposal_generated" }),
    ]);
    // shouldDecline: 2 cases, declined: 1 case -> 1/2 = 0.5
    expect(m.correctDeclineRate).toBe(0.5);
  });

  it("handles mixed unsupported-claims scenarios", () => {
    const m = effectivenessMetrics([
      row({ unsupportedClaims: 0 }),
      row({ unsupportedClaims: 1 }),
      row({ unsupportedClaims: 0 }),
      row({ unsupportedClaims: 5 }),
    ]);
    // 2 rows with claims / 4 total = 0.5
    expect(m.unsupportedClaimRate).toBe(0.5);
  });

  it("computes meanEvidenceRecall across mixed recall values", () => {
    const m = effectivenessMetrics([
      row({ evidenceRecall: 0 }),
      row({ evidenceRecall: 0.5 }),
      row({ evidenceRecall: 1 }),
    ]);
    // (0 + 0.5 + 1) / 3 = 0.5
    expect(m.meanEvidenceRecall).toBeCloseTo(0.5, 5);
  });

  it("computes outcomeAccuracy for partially correct outcomes", () => {
    const m = effectivenessMetrics([
      row({ outcomeCorrect: true }),
      row({ outcomeCorrect: true }),
      row({ outcomeCorrect: false }),
      row({ outcomeCorrect: false }),
    ]);
    // 2 correct / 4 total = 0.5
    expect(m.outcomeAccuracy).toBe(0.5);
  });

  it("handles complex mixed scenario with all metrics", () => {
    const m = effectivenessMetrics([
      // Row 0: proposal, correct, grounded (counts toward precision)
      row({
        observed: "proposal_generated",
        outcomeCorrect: true,
        grounded: true,
        unsupportedClaims: 0,
        evidenceRecall: 1,
      }),
      // Row 1: proposal, correct, not grounded (not toward precision)
      row({
        observed: "proposal_generated",
        outcomeCorrect: true,
        grounded: false,
        unsupportedClaims: 1,
        evidenceRecall: 0.5,
      }),
      // Row 2: decline (insufficient_evidence), correct (counts toward correctDeclineRate)
      row({
        expected: "insufficient_evidence",
        observed: "insufficient_evidence",
        outcomeCorrect: true,
        grounded: true,
        evidenceRecall: 0.75,
      }),
      // Row 3: decline (insufficient_evidence), incorrect
      row({
        expected: "insufficient_evidence",
        observed: "proposal_generated",
        outcomeCorrect: false,
        grounded: true,
        evidenceRecall: 0,
      }),
    ]);
    expect(m.cases).toBe(4);
    // Proposals: rows 0, 1, and 3 all have observed "proposal_generated" (row 3's
    // observed is "proposal_generated" even though expected is "insufficient_evidence"),
    // so there are 3 proposals, not 2. Only row 0 is correct AND grounded: 1/3.
    expect(m.groundedProposalPrecision).toBeCloseTo(1 / 3, 5);
    // Should decline: 2, declined: 1 -> 1/2 = 0.5
    expect(m.correctDeclineRate).toBe(0.5);
    // Outcomes: 3 correct / 4 = 0.75
    expect(m.outcomeAccuracy).toBe(0.75);
    // Unsupported: 1 / 4 = 0.25
    expect(m.unsupportedClaimRate).toBe(0.25);
    // Evidence recall: (1 + 0.5 + 0.75 + 0) / 4 = 0.5625
    expect(m.meanEvidenceRecall).toBeCloseTo(0.5625, 5);
  });
});

describe("effectivenessMetrics - boundary values", () => {
  it("handles fractional precision (2/3)", () => {
    const m = effectivenessMetrics([
      row({ observed: "proposal_generated", outcomeCorrect: true, grounded: true }),
      row({ observed: "proposal_generated", outcomeCorrect: true, grounded: true }),
      row({ observed: "proposal_generated", outcomeCorrect: false, grounded: false }),
    ]);
    expect(m.groundedProposalPrecision).toBeCloseTo(2 / 3, 5);
  });

  it("handles fractional recall (1/3)", () => {
    const m = effectivenessMetrics([
      row({ evidenceRecall: 0 }),
      row({ evidenceRecall: 0 }),
      row({ evidenceRecall: 1 }),
    ]);
    expect(m.meanEvidenceRecall).toBeCloseTo(1 / 3, 5);
  });

  it("handles single proposal (1/1 = 1.0 or 0/1 = 0)", () => {
    const m1 = effectivenessMetrics([
      row({ observed: "proposal_generated", outcomeCorrect: true, grounded: true }),
    ]);
    expect(m1.groundedProposalPrecision).toBe(1);

    const m2 = effectivenessMetrics([
      row({ observed: "proposal_generated", outcomeCorrect: false, grounded: false }),
    ]);
    expect(m2.groundedProposalPrecision).toBe(0);
  });

  it("handles single decline case (1/1 = 1.0 or 0/1 = 0)", () => {
    const m1 = effectivenessMetrics([
      row({ expected: "insufficient_evidence", observed: "insufficient_evidence" }),
    ]);
    expect(m1.correctDeclineRate).toBe(1);

    const m2 = effectivenessMetrics([
      row({ expected: "insufficient_evidence", observed: "proposal_generated" }),
    ]);
    expect(m2.correctDeclineRate).toBe(0);
  });

  it("handles single conflict case (1/1 = 1.0 or 0/1 = 0)", () => {
    const m1 = effectivenessMetrics([
      row({ expected: "conflicted", conflictExpected: true, conflictFound: true }),
    ]);
    expect(m1.conflictDetectionRecall).toBe(1);

    const m2 = effectivenessMetrics([
      row({ expected: "conflicted", conflictExpected: true, conflictFound: false }),
    ]);
    expect(m2.conflictDetectionRecall).toBe(0);
  });

  it("handles 0 unsupported claims in single row", () => {
    const m = effectivenessMetrics([row({ unsupportedClaims: 0 })]);
    expect(m.unsupportedClaimRate).toBe(0);
  });

  it("handles high unsupported claim counts", () => {
    const m = effectivenessMetrics([
      row({ unsupportedClaims: 100 }),
      row({ unsupportedClaims: 200 }),
    ]);
    expect(m.unsupportedClaimRate).toBe(1);
  });

  it("handles partial evidence recall (0.25, 0.5, 0.75)", () => {
    const m = effectivenessMetrics([
      row({ evidenceRecall: 0.25 }),
      row({ evidenceRecall: 0.5 }),
      row({ evidenceRecall: 0.75 }),
    ]);
    // (0.25 + 0.5 + 0.75) / 3 = 0.5
    expect(m.meanEvidenceRecall).toBeCloseTo(0.5, 5);
  });
});

describe("effectivenessMetrics - edge cases and state combinations", () => {
  it("ignores grounded flag for non-proposals when computing precision", () => {
    const m = effectivenessMetrics([
      row({ observed: "insufficient_evidence", grounded: false }),
      row({ observed: "proposal_generated", outcomeCorrect: true, grounded: true }),
    ]);
    // Only proposals count: 1 grounded-correct proposal
    expect(m.groundedProposalPrecision).toBe(1);
  });

  it("handles case where only non-proposals exist (no proposals)", () => {
    const m = effectivenessMetrics([
      row({ observed: "insufficient_evidence" }),
      row({ observed: "conflicted" }),
      row({ observed: "blocked_by_missing_source" }),
    ]);
    // No proposals: precision defaults to 1
    expect(m.groundedProposalPrecision).toBe(1);
  });

  it("handles case where only proposals exist (no declines)", () => {
    const m = effectivenessMetrics([
      row({ expected: "proposal_generated", observed: "proposal_generated" }),
      row({ expected: "proposal_generated", observed: "proposal_generated" }),
    ]);
    // No decline-expected cases: correctDeclineRate defaults to 1
    expect(m.correctDeclineRate).toBe(1);
  });

  it("handles case where no conflicts expected", () => {
    const m = effectivenessMetrics([
      row({ conflictExpected: false, conflictFound: false }),
      row({ conflictExpected: false, conflictFound: false }),
    ]);
    // No conflict-expected cases: recall defaults to 1
    expect(m.conflictDetectionRecall).toBe(1);
  });

  it("distinguishes between ungrounded proposals and non-proposals", () => {
    const m = effectivenessMetrics([
      // Ungrounded proposal that is correct: counts toward proposal precision
      row({
        observed: "proposal_generated",
        outcomeCorrect: true,
        grounded: false,
      }),
      // Non-proposal that should decline: can be correct but doesn't affect proposal precision
      row({
        expected: "insufficient_evidence",
        observed: "insufficient_evidence",
        outcomeCorrect: true,
        grounded: false,
      }),
    ]);
    // 0/1 proposals are grounded (even though correct)
    expect(m.groundedProposalPrecision).toBe(0);
    // 1/1 decline cases are correct
    expect(m.correctDeclineRate).toBe(1);
  });

  it("handles conflict detection when conflict expected but not found", () => {
    const m = effectivenessMetrics([
      row({
        expected: "conflicted",
        conflictExpected: true,
        conflictFound: false,
        // outcomeCorrect is an independent field, not derived from expected/observed by
        // effectivenessMetrics itself, so it must be set explicitly to reflect the mismatch
        // (observed defaults to "proposal_generated", which isn't "conflicted").
        outcomeCorrect: false,
      }),
    ]);
    // 0/1 conflicts detected
    expect(m.conflictDetectionRecall).toBe(0);
    // outcomeCorrect was explicitly set to false above
    expect(m.outcomeAccuracy).toBe(0);
  });

  it("tallies unsupported claims across all rows regardless of outcome", () => {
    const m = effectivenessMetrics([
      row({
        observed: "proposal_generated",
        outcomeCorrect: true,
        unsupportedClaims: 1,
      }),
      row({
        expected: "insufficient_evidence",
        observed: "insufficient_evidence",
        outcomeCorrect: true,
        unsupportedClaims: 0,
      }),
      row({
        observed: "conflicted",
        outcomeCorrect: true,
        unsupportedClaims: 3,
      }),
    ]);
    // 2 rows with unsupported claims / 3 total
    expect(m.unsupportedClaimRate).toBeCloseTo(2 / 3, 5);
  });

  it("averages evidence recall across all rows regardless of outcome", () => {
    const m = effectivenessMetrics([
      row({ observed: "proposal_generated", evidenceRecall: 0.2 }),
      row({ observed: "insufficient_evidence", evidenceRecall: 0.4 }),
      row({ observed: "conflicted", evidenceRecall: 0.6 }),
    ]);
    // (0.2 + 0.4 + 0.6) / 3 = 0.4
    expect(m.meanEvidenceRecall).toBeCloseTo(0.4, 5);
  });

  it("correctly identifies which statuses count as 'should decline'", () => {
    // DECLINE_STATUSES = ["conflicted", "insufficient_evidence", "blocked_by_missing_source", "supported"]
    const m = effectivenessMetrics([
      // These should decline:
      row({ expected: "conflicted", observed: "conflicted" }),
      row({ expected: "insufficient_evidence", observed: "insufficient_evidence" }),
      row({ expected: "blocked_by_missing_source", observed: "blocked_by_missing_source" }),
      row({ expected: "supported", observed: "supported" }),
      // This should NOT decline:
      row({ expected: "proposal_generated", observed: "proposal_generated" }),
    ]);
    // 4/4 decline cases are correct
    expect(m.correctDeclineRate).toBe(1);
    // 5/5 outcomes correct
    expect(m.outcomeAccuracy).toBe(1);
  });

  it("computes all metrics together in realistic scenario", () => {
    const m = effectivenessMetrics([
      row({
        id: "case1",
        observed: "proposal_generated",
        outcomeCorrect: true,
        grounded: true,
        unsupportedClaims: 0,
        evidenceRecall: 1,
      }),
      row({
        id: "case2",
        observed: "proposal_generated",
        outcomeCorrect: false,
        grounded: false,
        unsupportedClaims: 2,
        evidenceRecall: 0,
      }),
      row({
        id: "case3",
        expected: "insufficient_evidence",
        observed: "insufficient_evidence",
        outcomeCorrect: true,
        grounded: true,
        unsupportedClaims: 0,
        evidenceRecall: 0.8,
      }),
      row({
        id: "case4",
        expected: "conflicted",
        observed: "conflicted",
        conflictExpected: true,
        conflictFound: true,
        outcomeCorrect: true,
        grounded: true,
        unsupportedClaims: 1,
        evidenceRecall: 0.6,
      }),
    ]);

    expect(m.cases).toBe(4);
    // Proposals: 2, correct+grounded: 1 -> 0.5
    expect(m.groundedProposalPrecision).toBe(0.5);
    // Should decline: 2, declined: 2 -> 1.0
    expect(m.correctDeclineRate).toBe(1);
    // Conflicts: 1, found: 1 -> 1.0
    expect(m.conflictDetectionRecall).toBe(1);
    // Unsupported: 2 / 4 = 0.5
    expect(m.unsupportedClaimRate).toBe(0.5);
    // Evidence: (1 + 0 + 0.8 + 0.6) / 4 = 0.6
    expect(m.meanEvidenceRecall).toBeCloseTo(0.6, 5);
    // Outcomes: 3 / 4 = 0.75
    expect(m.outcomeAccuracy).toBe(0.75);
  });
});

describe("effectivenessMetrics - metric independence", () => {
  it("groundedProposalPrecision only depends on proposals", () => {
    const m1 = effectivenessMetrics([
      row({ observed: "proposal_generated", outcomeCorrect: true, grounded: true }),
    ]);
    const m2 = effectivenessMetrics([
      row({ observed: "proposal_generated", outcomeCorrect: true, grounded: true }),
      row({ expected: "insufficient_evidence", observed: "proposal_generated" }),
      row({ expected: "conflicted", observed: "proposal_generated" }),
    ]);
    // Non-proposals don't affect this metric
    expect(m1.groundedProposalPrecision).toBe(m2.groundedProposalPrecision);
  });

  it("correctDeclineRate only depends on decline-expected cases", () => {
    const m1 = effectivenessMetrics([
      row({ expected: "insufficient_evidence", observed: "insufficient_evidence" }),
    ]);
    const m2 = effectivenessMetrics([
      row({ expected: "insufficient_evidence", observed: "insufficient_evidence" }),
      row({ observed: "proposal_generated", outcomeCorrect: true, grounded: false }),
      row({ observed: "proposal_generated", outcomeCorrect: false, grounded: true }),
    ]);
    // Extra proposals don't affect this metric
    expect(m1.correctDeclineRate).toBe(m2.correctDeclineRate);
  });

  it("conflictDetectionRecall only depends on conflict-expected cases", () => {
    const m1 = effectivenessMetrics([
      row({ expected: "conflicted", conflictExpected: true, conflictFound: true }),
    ]);
    const m2 = effectivenessMetrics([
      row({ expected: "conflicted", conflictExpected: true, conflictFound: true }),
      row({ observed: "proposal_generated" }),
      row({ observed: "insufficient_evidence" }),
    ]);
    // Other cases don't affect this metric
    expect(m1.conflictDetectionRecall).toBe(m2.conflictDetectionRecall);
  });
});
