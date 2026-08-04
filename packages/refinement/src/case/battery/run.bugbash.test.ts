import { describe, expect, it } from "vitest";
import {
  type BatteryReport,
  type BatteryRow,
  outcomeOf,
  renderBatteryReport,
  runBattery,
} from "./index.js";

/**
 * Bugbash tests for battery run sequencing, result aggregation, and error paths.
 * Focus: empty battery, failure isolation, aggregation, and rendering.
 */

describe("runBattery", () => {
  it("handles empty scenarios array", async () => {
    const report = await runBattery([]);
    expect(report.rows).toEqual([]);
    expect(report.byClass).toEqual([]);
    expect(report.totals).toEqual({
      runs: 0,
      baselineClosed: 0,
      investigationClosed: 0,
      investigationOnly: 0,
      conflictsFound: 0,
      declined: 0,
      mismatches: 0,
    });
  });

  it("respects custom root directory from options", async () => {
    // Empty battery should work with custom root option
    const report = await runBattery([], { root: "/tmp/test-battery" });
    expect(report.rows).toEqual([]);
    expect(report.byClass).toEqual([]);
    expect(report.totals.runs).toBe(0);
  });
});

describe("renderBatteryReport", () => {
  it("renders empty report", () => {
    const report: BatteryReport = {
      rows: [],
      byClass: [],
      totals: {
        runs: 0,
        baselineClosed: 0,
        investigationClosed: 0,
        investigationOnly: 0,
        conflictsFound: 0,
        declined: 0,
        mismatches: 0,
      },
    };

    const output = renderBatteryReport(report);
    expect(output).toContain("Investigation battery");
    expect(output).toContain("0 scenarios");
    expect(output).toContain("baseline closed 0");
    expect(output).toContain("investigation closed 0");
    expect(output).toContain("declined 0");
  });

  it("renders report with single row", () => {
    const row: BatteryRow = {
      id: "test-scenario",
      class: "documented",
      skill: "describe-field",
      probes: "test probe",
      baselineProposed: true,
      investigationStatus: "proposal_generated",
      refinementStatus: "approved",
      outcome: "applied",
      approvalTier: "auto",
      contribution: "both",
      verificationDisposition: "verified_grounding",
      matchedExpectation: true,
    };

    const report: BatteryReport = {
      rows: [row],
      byClass: [
        {
          class: "documented",
          runs: 1,
          investigationClosed: 1,
          baselineClosed: 1,
          investigationOnly: 0,
          declined: 0,
        },
      ],
      totals: {
        runs: 1,
        baselineClosed: 1,
        investigationClosed: 1,
        investigationOnly: 0,
        conflictsFound: 0,
        declined: 0,
        mismatches: 0,
      },
    };

    const output = renderBatteryReport(report);
    expect(output).toContain("1 scenarios");
    expect(output).toContain("baseline closed 1");
    expect(output).toContain("test-scenario");
    expect(output).toContain("documented");
    expect(output).toContain("both");
  });

  it("renders report with multiple classes", () => {
    const rows: BatteryRow[] = [
      {
        id: "doc-1",
        class: "documented",
        skill: "describe-field",
        probes: "documented field",
        baselineProposed: true,
        investigationStatus: "proposal_generated",
        refinementStatus: "approved",
        outcome: "applied",
        approvalTier: "auto",
        contribution: "both",
        verificationDisposition: "verified_grounding",
        matchedExpectation: true,
      },
      {
        id: "conflict-1",
        class: "conflicting",
        skill: "describe-field",
        probes: "conflicting field",
        baselineProposed: false,
        investigationStatus: "conflicted",
        refinementStatus: "none",
        outcome: "none",
        approvalTier: "none",
        contribution: "declined",
        verificationDisposition: "not_applicable",
        matchedExpectation: true,
      },
    ];

    const report: BatteryReport = {
      rows,
      byClass: [
        {
          class: "conflicting",
          runs: 1,
          investigationClosed: 0,
          baselineClosed: 0,
          investigationOnly: 0,
          declined: 1,
        },
        {
          class: "documented",
          runs: 1,
          investigationClosed: 1,
          baselineClosed: 1,
          investigationOnly: 0,
          declined: 0,
        },
      ],
      totals: {
        runs: 2,
        baselineClosed: 1,
        investigationClosed: 1,
        investigationOnly: 0,
        conflictsFound: 1,
        declined: 1,
        mismatches: 0,
      },
    };

    const output = renderBatteryReport(report);
    expect(output).toContain("2 scenarios");
    expect(output).toContain("conflicts found 1");
    expect(output).toContain("documented");
    expect(output).toContain("conflicting");
    expect(output).toContain("doc-1");
    expect(output).toContain("conflict-1");
  });

  it("flags mismatches in report", () => {
    const row: BatteryRow = {
      id: "mismatch-scenario",
      class: "documented",
      skill: "describe-field",
      probes: "test",
      baselineProposed: false,
      investigationStatus: "proposal_generated",
      refinementStatus: "approved",
      outcome: "applied",
      approvalTier: "auto",
      contribution: "investigation_only",
      verificationDisposition: "verified_grounding",
      matchedExpectation: false, // Mismatch!
    };

    const report: BatteryReport = {
      rows: [row],
      byClass: [
        {
          class: "documented",
          runs: 1,
          investigationClosed: 1,
          baselineClosed: 0,
          investigationOnly: 1,
          declined: 0,
        },
      ],
      totals: {
        runs: 1,
        baselineClosed: 0,
        investigationClosed: 1,
        investigationOnly: 1,
        conflictsFound: 0,
        declined: 0,
        mismatches: 1,
      },
    };

    const output = renderBatteryReport(report);
    expect(output).toContain("⚠ 1 scenario(s) did not match expectation");
    expect(output).toContain("mismatch-scenario");
  });

  it("renders report with multiple scenarios per class", () => {
    const rows: BatteryRow[] = [
      {
        id: "doc-scenario-1",
        class: "documented",
        skill: "describe-field",
        probes: "first documented",
        baselineProposed: true,
        investigationStatus: "proposal_generated",
        refinementStatus: "approved",
        outcome: "applied",
        approvalTier: "auto",
        contribution: "both",
        verificationDisposition: "verified_grounding",
        matchedExpectation: true,
      },
      {
        id: "doc-scenario-2",
        class: "documented",
        skill: "describe-field",
        probes: "second documented",
        baselineProposed: false,
        investigationStatus: "proposal_generated",
        refinementStatus: "improved",
        outcome: "review",
        approvalTier: "review",
        contribution: "investigation_only",
        verificationDisposition: "unverified_grounding",
        matchedExpectation: true,
      },
      {
        id: "impl-scenario-1",
        class: "implicit_impl",
        skill: "describe-field",
        probes: "implicit field",
        baselineProposed: false,
        investigationStatus: "proposal_generated",
        refinementStatus: "improved",
        outcome: "review",
        approvalTier: "review",
        contribution: "investigation_only",
        verificationDisposition: "unverified_grounding",
        matchedExpectation: true,
      },
    ];

    const report: BatteryReport = {
      rows,
      byClass: [
        {
          class: "documented",
          runs: 2,
          investigationClosed: 2,
          baselineClosed: 1,
          investigationOnly: 1,
          declined: 0,
        },
        {
          class: "implicit_impl",
          runs: 1,
          investigationClosed: 1,
          baselineClosed: 0,
          investigationOnly: 1,
          declined: 0,
        },
      ],
      totals: {
        runs: 3,
        baselineClosed: 1,
        investigationClosed: 3,
        investigationOnly: 2,
        conflictsFound: 0,
        declined: 0,
        mismatches: 0,
      },
    };

    const output = renderBatteryReport(report);
    expect(output).toContain("3 scenarios");
    expect(output).toContain("investigation closed 3");
    expect(output).toContain("investigation-only 2");
    // Verify all scenarios appear in per-scenario section
    expect(output).toContain("doc-scenario-1");
    expect(output).toContain("doc-scenario-2");
    expect(output).toContain("impl-scenario-1");
  });

  it("renders outcome correctly", () => {
    const rows: BatteryRow[] = [
      {
        id: "applied",
        class: "documented",
        skill: "describe-field",
        probes: "test",
        baselineProposed: true,
        investigationStatus: "proposal_generated",
        refinementStatus: "approved",
        outcome: "applied",
        approvalTier: "auto",
        contribution: "both",
        verificationDisposition: "verified_grounding",
        matchedExpectation: true,
      },
      {
        id: "review",
        class: "documented",
        skill: "describe-field",
        probes: "test",
        baselineProposed: false,
        investigationStatus: "proposal_generated",
        refinementStatus: "improved",
        outcome: "review",
        approvalTier: "review",
        contribution: "investigation_only",
        verificationDisposition: "unverified_grounding",
        matchedExpectation: true,
      },
      {
        id: "rejected",
        class: "documented",
        skill: "describe-field",
        probes: "test",
        baselineProposed: false,
        investigationStatus: "proposal_generated",
        refinementStatus: "rejected",
        outcome: "rejected",
        approvalTier: "reject",
        contribution: "declined",
        verificationDisposition: "not_applicable",
        matchedExpectation: true,
      },
      {
        id: "declined",
        class: "documented",
        skill: "describe-field",
        probes: "test",
        baselineProposed: false,
        investigationStatus: "insufficient_evidence",
        refinementStatus: "none",
        outcome: "none",
        approvalTier: "none",
        contribution: "declined",
        verificationDisposition: "not_applicable",
        matchedExpectation: true,
      },
    ];

    const report: BatteryReport = {
      rows,
      byClass: [
        {
          class: "documented",
          runs: 4,
          investigationClosed: 3,
          baselineClosed: 1,
          investigationOnly: 1,
          declined: 1,
        },
      ],
      totals: {
        runs: 4,
        baselineClosed: 1,
        investigationClosed: 3,
        investigationOnly: 1,
        conflictsFound: 0,
        declined: 1,
        mismatches: 0,
      },
    };

    const output = renderBatteryReport(report);
    expect(output).toContain("applied");
    expect(output).toContain("review");
    expect(output).toContain("rejected");
    expect(output).toContain("declined");
  });

  it("renders with various verification dispositions", () => {
    const rows: BatteryRow[] = [
      {
        id: "verified",
        class: "documented",
        skill: "describe-field",
        probes: "verified grounding",
        baselineProposed: false,
        investigationStatus: "proposal_generated",
        refinementStatus: "approved",
        outcome: "applied",
        approvalTier: "auto",
        contribution: "investigation_only",
        verificationDisposition: "verified_grounding",
        matchedExpectation: true,
      },
      {
        id: "unverified",
        class: "documented",
        skill: "describe-field",
        probes: "unverified grounding",
        baselineProposed: false,
        investigationStatus: "proposal_generated",
        refinementStatus: "improved",
        outcome: "review",
        approvalTier: "review",
        contribution: "investigation_only",
        verificationDisposition: "unverified_grounding",
        matchedExpectation: true,
      },
      {
        id: "verification-failed",
        class: "documented",
        skill: "describe-field",
        probes: "verification failed",
        baselineProposed: false,
        investigationStatus: "proposal_generated",
        refinementStatus: "rejected",
        outcome: "rejected",
        approvalTier: "reject",
        contribution: "declined",
        verificationDisposition: "verification_failed",
        matchedExpectation: true,
      },
      {
        id: "not-applicable",
        class: "documented",
        skill: "describe-field",
        probes: "not applicable",
        baselineProposed: false,
        investigationStatus: "insufficient_evidence",
        refinementStatus: "none",
        outcome: "none",
        approvalTier: "none",
        contribution: "declined",
        verificationDisposition: "not_applicable",
        matchedExpectation: true,
      },
    ];

    const report: BatteryReport = {
      rows,
      byClass: [
        {
          class: "documented",
          runs: 4,
          investigationClosed: 3,
          baselineClosed: 0,
          investigationOnly: 3,
          declined: 1,
        },
      ],
      totals: {
        runs: 4,
        baselineClosed: 0,
        investigationClosed: 3,
        investigationOnly: 3,
        conflictsFound: 0,
        declined: 1,
        mismatches: 0,
      },
    };

    const output = renderBatteryReport(report);
    expect(output).toContain("verified");
    expect(output).toContain("unverified");
    expect(output).toContain("declined");
    expect(output).toContain("verif=");
  });

  it("renders contributions correctly", () => {
    const rows: BatteryRow[] = [
      {
        id: "both",
        class: "documented",
        skill: "describe-field",
        probes: "both contributions",
        baselineProposed: true,
        investigationStatus: "proposal_generated",
        refinementStatus: "approved",
        outcome: "applied",
        approvalTier: "auto",
        contribution: "both",
        verificationDisposition: "verified_grounding",
        matchedExpectation: true,
      },
      {
        id: "investigation-only",
        class: "documented",
        skill: "describe-field",
        probes: "investigation only",
        baselineProposed: false,
        investigationStatus: "proposal_generated",
        refinementStatus: "improved",
        outcome: "review",
        approvalTier: "review",
        contribution: "investigation_only",
        verificationDisposition: "unverified_grounding",
        matchedExpectation: true,
      },
      {
        id: "baseline-only",
        class: "documented",
        skill: "describe-field",
        probes: "baseline only",
        baselineProposed: true,
        investigationStatus: "insufficient_evidence",
        refinementStatus: "none",
        outcome: "none",
        approvalTier: "none",
        contribution: "baseline_only",
        verificationDisposition: "not_applicable",
        matchedExpectation: true,
      },
      {
        id: "declined",
        class: "documented",
        skill: "describe-field",
        probes: "both declined",
        baselineProposed: false,
        investigationStatus: "insufficient_evidence",
        refinementStatus: "none",
        outcome: "none",
        approvalTier: "none",
        contribution: "declined",
        verificationDisposition: "not_applicable",
        matchedExpectation: true,
      },
    ];

    const report: BatteryReport = {
      rows,
      byClass: [
        {
          class: "documented",
          runs: 4,
          investigationClosed: 2,
          baselineClosed: 2,
          investigationOnly: 1,
          declined: 1,
        },
      ],
      totals: {
        runs: 4,
        baselineClosed: 2,
        investigationClosed: 2,
        investigationOnly: 1,
        conflictsFound: 0,
        declined: 1,
        mismatches: 0,
      },
    };

    const output = renderBatteryReport(report);
    expect(output).toContain("both");
    expect(output).toContain("investigation_only");
    expect(output).toContain("baseline_only");
    expect(output).toContain("declined");
  });

  it("formats totals row correctly", () => {
    const rows: BatteryRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `scenario-${i}`,
      class: "documented" as const,
      skill: "describe-field" as const,
      probes: `test ${i}`,
      baselineProposed: i % 3 === 0,
      investigationStatus: i % 4 === 0 ? ("conflicted" as const) : ("proposal_generated" as const),
      refinementStatus: "approved" as const,
      outcome: "applied" as const,
      approvalTier: "auto" as const,
      contribution: "both" as const,
      verificationDisposition: "verified_grounding" as const,
      matchedExpectation: true,
    }));

    const report: BatteryReport = {
      rows,
      byClass: [
        {
          class: "documented",
          runs: 10,
          investigationClosed: 8,
          baselineClosed: 4,
          investigationOnly: 0,
          declined: 0,
        },
      ],
      totals: {
        runs: 10,
        baselineClosed: 4,
        investigationClosed: 8,
        investigationOnly: 0,
        conflictsFound: 3,
        declined: 0,
        mismatches: 0,
      },
    };

    const output = renderBatteryReport(report);
    expect(output).toContain("10 scenarios");
    expect(output).toContain("baseline closed 4");
    expect(output).toContain("investigation closed 8");
    expect(output).toContain("conflicts found 3");
  });

  it("includes help text in rendered output", () => {
    const report: BatteryReport = {
      rows: [],
      byClass: [],
      totals: {
        runs: 0,
        baselineClosed: 0,
        investigationClosed: 0,
        investigationOnly: 0,
        conflictsFound: 0,
        declined: 0,
        mismatches: 0,
      },
    };

    const output = renderBatteryReport(report);
    expect(output).toContain("deterministic executor");
    expect(output).toContain("investigation status");
    expect(output).toContain("approval tier");
  });
});

describe("outcomeOf", () => {
  it("maps approved to applied", () => {
    expect(outcomeOf("approved")).toBe("applied");
  });

  it("maps improved and neutral to review", () => {
    expect(outcomeOf("improved")).toBe("review");
    expect(outcomeOf("neutral")).toBe("review");
  });

  it("maps rejected and regressed to rejected", () => {
    expect(outcomeOf("rejected")).toBe("rejected");
    expect(outcomeOf("regressed")).toBe("rejected");
  });

  it("maps none to none", () => {
    expect(outcomeOf("none")).toBe("none");
  });
});
