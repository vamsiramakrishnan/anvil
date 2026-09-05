import { type EvalTerm, evalTerm, isConceptToken } from "@anvil/air";

/**
 * Grading Anvil's emitted behaviour checks.
 *
 * Every skill and every generated bundle ships `evals/*.yaml` describing how a
 * harness must behave: which commands it must call, what its answer must
 * contain, what it must never do. Those files were emitted for years and graded
 * by nothing — the only tests that touched them compared their text against the
 * generator, which catches drift and says nothing about behaviour.
 *
 * This module closes that half. It takes one case and one harness answer and
 * decides, per expectation, whether the answer shows the behaviour. What it will
 * NOT do is guess: an expectation whose vocabulary offers no honest textual
 * signal is reported `ungraded`, and `passRate` counts it against the total. A
 * runner that scored its own unjudged checks as green would be the same defect
 * it exists to catch, one level up.
 */

/** How an expectation relates to the answer. */
export type ExpectationKind = "must_call" | "must_include" | "must_not" | "must_refuse_without";

/** One case from an emitted suite. */
export interface EvalCase {
  case: string;
  prompt?: string;
  /** `error_recovery` cases name an upstream condition instead of a prompt. */
  upstream?: string;
  expected: Partial<Record<ExpectationKind | "allow", readonly string[]>>;
}

/** One parsed suite file. */
export interface EvalSuite {
  suite: string;
  description?: string;
  cases: readonly EvalCase[];
}

export type ExpectationOutcome = "passed" | "failed" | "ungraded";

export interface ExpectationResult {
  kind: ExpectationKind;
  /** The entry as written in the suite. */
  entry: string;
  outcome: ExpectationOutcome;
  /** Why it landed that way, in one line a reader can act on. */
  reason: string;
  /** How the decision was reached, so a report never overstates its own rigour. */
  method: "literal" | "signal" | "judge_required";
}

export interface CaseResult {
  case: string;
  expectations: readonly ExpectationResult[];
  passed: number;
  failed: number;
  ungraded: number;
}

export interface SuiteReport {
  schemaVersion: 1;
  reportType: "anvil.eval-run";
  suite: string;
  cases: readonly CaseResult[];
  totals: { passed: number; failed: number; ungraded: number; total: number };
  /**
   * passed / total, with ungraded counted in the denominator. An ungraded check
   * is not a passed one, and a rate that hid them would climb by adding checks
   * nobody can decide.
   */
  passRate: number;
}

/**
 * A judge settles the expectations no wording decides. It is handed the term's
 * own `check`/`satisfiedBy`/`violatedBy` and the answer, and returns whether the
 * behaviour is present — or `undefined` to leave it ungraded, which is what a
 * judge that is unsure should do.
 */
export type EvalJudge = (input: {
  entry: string;
  kind: ExpectationKind;
  term: EvalTerm;
  answer: string;
}) => boolean | undefined;

/** Case-insensitive, multiline: an answer is prose across many lines. */
function matches(answer: string, pattern: string): boolean {
  return new RegExp(pattern, "i").test(answer);
}

/**
 * A literal entry — a command (`anvil inspect`), a flag (`--confirm`), or a value
 * the document supplied (an operation's CLI command, its idempotency key) — is
 * checked as a plain substring. It carries its own meaning, so no definition is
 * needed and no judgement is involved.
 */
function gradeLiteral(entry: string, kind: ExpectationKind, answer: string): ExpectationResult {
  const present = answer.toLowerCase().includes(entry.toLowerCase());
  const wanted = kind !== "must_not";
  return {
    kind,
    entry,
    method: "literal",
    outcome: present === wanted ? "passed" : "failed",
    reason: present ? `the answer contains '${entry}'` : `the answer never mentions '${entry}'`,
  };
}

/**
 * A concept token is decided by its definition. Signals are necessary evidence,
 * not sufficient: their ABSENCE under `must_include` and their PRESENCE under
 * `must_not` are both sound refusals, because each demonstrates the behaviour is
 * respectively missing or present. The other two directions are a pass — exact
 * for `must_not` (nothing incriminating appeared) and provisional for
 * `must_include`, which the `method` field records rather than papers over.
 */
function gradeConcept(
  entry: string,
  kind: ExpectationKind,
  answer: string,
  judge?: EvalJudge,
): ExpectationResult {
  const term = evalTerm(entry);
  if (!term) {
    // The drift gate keeps this unreachable in-tree; a hand-written suite can
    // still reach it, and an unknown token must never be silently green.
    return {
      kind,
      entry,
      method: "judge_required",
      outcome: "ungraded",
      reason: `'${entry}' is not defined in the eval vocabulary, so nothing can decide it`,
    };
  }

  if (term.judgeOnly || !term.signals?.length) {
    const verdict = judge?.({ entry, kind, term, answer });
    if (verdict === undefined) {
      return {
        kind,
        entry,
        method: "judge_required",
        outcome: "ungraded",
        reason: `no wording separates this behaviour from its absence — ${term.check}`,
      };
    }
    const wanted = kind !== "must_not";
    return {
      kind,
      entry,
      method: "judge_required",
      outcome: verdict === wanted ? "passed" : "failed",
      reason: verdict
        ? `a judge found the behaviour present: ${term.check}`
        : `a judge found the behaviour absent: ${term.check}`,
    };
  }

  const hit = term.signals.find((pattern) => matches(answer, pattern));
  if (kind === "must_not") {
    return {
      kind,
      entry,
      method: "signal",
      outcome: hit ? "failed" : "passed",
      reason: hit
        ? `the answer shows the forbidden behaviour (matched /${hit}/) — ${term.violatedBy}`
        : `nothing in the answer shows this behaviour — ${term.check}`,
    };
  }
  return {
    kind,
    entry,
    method: "signal",
    outcome: hit ? "passed" : "failed",
    reason: hit
      ? `matched /${hit}/ — ${term.satisfiedBy}`
      : `the answer never shows this behaviour — ${term.check}`,
  };
}

/** The expectation kinds this grader decides. `allow` is permissive and scores nothing. */
const GRADED_KINDS: readonly ExpectationKind[] = [
  "must_call",
  "must_include",
  "must_not",
  "must_refuse_without",
];

/**
 * Grade one case against one harness answer.
 *
 * `must_refuse_without` is graded like `must_include`: the case asserts the
 * harness names the guard it would refuse without, and an answer that never
 * mentions it has not shown the refusal.
 */
export function gradeCase(testCase: EvalCase, answer: string, judge?: EvalJudge): CaseResult {
  const expectations: ExpectationResult[] = [];
  for (const kind of GRADED_KINDS) {
    for (const entry of testCase.expected[kind] ?? []) {
      expectations.push(
        isConceptToken(entry)
          ? gradeConcept(entry, kind, answer, judge)
          : gradeLiteral(entry, kind, answer),
      );
    }
  }
  const count = (o: ExpectationOutcome) => expectations.filter((e) => e.outcome === o).length;
  return {
    case: testCase.case,
    expectations,
    passed: count("passed"),
    failed: count("failed"),
    ungraded: count("ungraded"),
  };
}

/**
 * Grade a whole suite. `answers` maps a case name to the harness's answer; a case
 * with no answer is reported with every expectation ungraded rather than skipped,
 * so a run that never reached a case cannot quietly shrink the denominator.
 */
export function gradeSuite(
  suite: EvalSuite,
  answers: Readonly<Record<string, string>>,
  judge?: EvalJudge,
): SuiteReport {
  const cases = suite.cases.map((c) => gradeCase(c, answers[c.case] ?? "", judge));
  const totals = cases.reduce(
    (acc, c) => ({
      passed: acc.passed + c.passed,
      failed: acc.failed + c.failed,
      ungraded: acc.ungraded + c.ungraded,
      total: acc.total + c.expectations.length,
    }),
    { passed: 0, failed: 0, ungraded: 0, total: 0 },
  );
  return {
    schemaVersion: 1,
    reportType: "anvil.eval-run",
    suite: suite.suite,
    cases,
    totals,
    passRate: totals.total === 0 ? 0 : Math.round((totals.passed / totals.total) * 1000) / 10,
  };
}

/** A one-line-per-expectation rendering, failures first because those are the work. */
export function renderSuiteReport(report: SuiteReport): string {
  const lines = [
    `${report.suite} — ${report.totals.passed}/${report.totals.total} passed ` +
      `(${report.passRate}%), ${report.totals.failed} failed, ${report.totals.ungraded} ungraded`,
  ];
  for (const c of report.cases) {
    const ordered = [...c.expectations].sort(
      (a, b) => rank(a.outcome) - rank(b.outcome) || a.entry.localeCompare(b.entry),
    );
    for (const e of ordered) {
      if (e.outcome === "passed") continue;
      lines.push(`  ${c.case} · ${e.kind} '${e.entry}' — ${e.outcome}: ${e.reason}`);
    }
  }
  if (report.totals.ungraded > 0) {
    lines.push(
      `  note: ${report.totals.ungraded} expectation(s) have no deterministic signal. ` +
        `They count against the rate; supply a judge to settle them.`,
    );
  }
  return lines.join("\n");
}

function rank(outcome: ExpectationOutcome): number {
  return outcome === "failed" ? 0 : outcome === "ungraded" ? 1 : 2;
}
