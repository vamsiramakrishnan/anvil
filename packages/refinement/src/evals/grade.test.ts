import { EVAL_VOCABULARY } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { type EvalCase, gradeCase, gradeSuite, renderSuiteReport } from "./grade.js";

/**
 * The grader's own honesty, pinned.
 *
 * These behaviour checks existed for years and were graded by nothing, so the
 * first risk in finally grading them is a grader that reports success it did not
 * earn — the same defect one level up. Every test here is about a way that could
 * happen: a token nobody defined scoring green, an unjudgeable check scoring
 * green, or a pass rate that climbs by adding checks it cannot decide.
 */

function withExpected(expected: EvalCase["expected"]): EvalCase {
  return { case: "c", prompt: "p", expected };
}

describe("literal entries", () => {
  it("checks a command or flag as itself, needing no definition", () => {
    const result = gradeCase(
      withExpected({ must_call: ["anvil inspect"], must_include: ["--dry-run"] }),
      "I would run `anvil inspect payments/` first, then invoke it with --dry-run.",
    );
    expect(result.expectations.every((e) => e.method === "literal")).toBe(true);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("fails a must_call the answer never makes", () => {
    const result = gradeCase(
      withExpected({ must_call: ["anvil inspect"] }),
      "I'll approve the operation now.",
    );
    expect(result.failed).toBe(1);
    expect(result.expectations[0]?.reason).toContain("never mentions");
  });

  it("reads must_not in the opposite direction", () => {
    const forbidden = gradeCase(withExpected({ must_not: ["--force"] }), "Re-run with --force.");
    expect(forbidden.failed).toBe(1);
    const clean = gradeCase(withExpected({ must_not: ["--force"] }), "I would not override it.");
    expect(clean.passed).toBe(1);
  });
});

describe("a token nothing defines", () => {
  it("is ungraded, never passed", () => {
    // The failure this whole lane exists to fix: an undefined token cannot be
    // decided, so scoring it green would launder an unrunnable check into a
    // green report.
    const result = gradeCase(
      withExpected({ must_include: ["a_token_no_vocabulary_defines"] }),
      "An answer that says nothing in particular.",
    );
    expect(result.expectations[0]?.outcome).toBe("ungraded");
    expect(result.expectations[0]?.method).toBe("judge_required");
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
  });
});

describe("pass rate", () => {
  it("counts ungraded expectations in the denominator", () => {
    // A rate that excluded them would RISE as more undecidable checks were
    // added — precisely backwards.
    const report = gradeSuite(
      {
        suite: "s",
        cases: [
          {
            case: "c",
            expected: { must_call: ["anvil inspect"], must_include: ["an_undefined_token"] },
          },
        ],
      },
      { c: "I would run anvil inspect." },
    );
    expect(report.totals).toMatchObject({ passed: 1, failed: 0, ungraded: 1, total: 2 });
    expect(report.passRate).toBe(50);
  });

  it("grades a case that produced no answer rather than skipping it", () => {
    // A run that never reached a case must not shrink its own denominator.
    const report = gradeSuite(
      { suite: "s", cases: [{ case: "never_ran", expected: { must_call: ["anvil status"] } }] },
      {},
    );
    expect(report.totals.total).toBe(1);
    expect(report.totals.failed).toBe(1);
    expect(report.passRate).toBe(0);
  });

  it("scores nothing for `allow`, which is permissive", () => {
    const report = gradeSuite(
      { suite: "s", cases: [{ case: "c", expected: { allow: ["backoff_and_retry_if_safe"] } }] },
      { c: "I would back off and retry." },
    );
    expect(report.totals.total).toBe(0);
  });
});

describe("the report", () => {
  it("lists failures and ungraded checks, and says ungraded is not passed", () => {
    const report = gradeSuite(
      {
        suite: "operate_anvil",
        cases: [
          {
            case: "inspects_before_approving",
            expected: { must_call: ["anvil inspect"], must_include: ["an_undefined_token"] },
          },
        ],
      },
      { inspects_before_approving: "I'd approve it." },
    );
    const text = renderSuiteReport(report);
    expect(text).toContain("anvil inspect");
    expect(text).toContain("failed");
    expect(text).toContain("ungraded");
    expect(text).toContain("count against the rate");
  });
});

describe("judge-only terms", () => {
  it("stay ungraded with no judge, and are settled by one", () => {
    // Find a real judgeOnly term rather than inventing one, so this test tracks
    // the vocabulary as it is actually written.
    const entry = Object.entries(EVAL_VOCABULARY).find(([, t]) => t.judgeOnly)?.[0];
    if (!entry) return; // vocabulary not yet populated; the drift gate owns that failure
    const noJudge = gradeCase(withExpected({ must_include: [entry] }), "some answer");
    expect(noJudge.expectations[0]?.outcome).toBe("ungraded");

    const judged = gradeCase(withExpected({ must_include: [entry] }), "some answer", () => true);
    expect(judged.expectations[0]?.outcome).toBe("passed");
    expect(judged.expectations[0]?.method).toBe("judge_required");

    // A judge that is unsure leaves the check ungraded rather than guessing.
    const unsure = gradeCase(
      withExpected({ must_include: [entry] }),
      "some answer",
      () => undefined,
    );
    expect(unsure.expectations[0]?.outcome).toBe("ungraded");
  });
});
