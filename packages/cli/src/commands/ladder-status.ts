import type { AirDocument } from "@anvil/air";
import {
  bundleHash,
  decideLadder,
  type LadderDecision,
  type LadderDecisionReason,
  type LadderMeasuredAccuracy,
  MIN_LADDER_TOKEN_SAVINGS_FRACTION,
  MIN_LADDERED_ACCURACY_DELTA_PTS,
} from "@anvil/generators";
import { readBenchmarkReport } from "@anvil/refinement";

/**
 * The measured accuracy delta `decideLadder`'s `auto` mode consults, read
 * from `benchmark.report.json` when one exists AND its recorded `bundleHash`
 * matches this bundle's current content — the same freshness discipline
 * `@anvil/generators`' `benchmarkEvidenceStatus` applies to the benchmark
 * evidence lane, so a report describing yesterday's surface can never steer
 * today's serving decision. `undefined` — no report, a stale one, or one
 * written under `--catalog flat` (no `catalogs.laddered` to compare) —
 * reproduces `decideLadder`'s pre-measurement `auto` behavior exactly, which
 * is the fallback this function is built to produce by construction rather
 * than by a separate default kept in sync with it.
 *
 * Shared by `anvil serve mcp` (which acts on the decision) and
 * `ladderStatusSummary` (which only reports it) so the two can never derive
 * different numbers from the same bundle.
 */
export function measuredAccuracyFromReport(
  bundleDir: string,
  files: Record<string, string>,
): LadderMeasuredAccuracy | undefined {
  const report = readBenchmarkReport(bundleDir);
  if (report === undefined || report.bundleHash !== bundleHash(files)) return undefined;
  const { flat, laddered } = report.catalogs ?? {};
  if (!flat || !laddered) return undefined;
  return { ladderedMinusFlatPts: Math.round((laddered.accuracy - flat.accuracy) * 1000) / 10 };
}

/**
 * The `auto` ladder decision, rendered as one line for `anvil status` and
 * `anvil inspect` — the operator-facing half of `decideLadder`'s accuracy-aware
 * `auto` mode (`@anvil/mcp-runtime`'s `lane.ts`).
 *
 * This is a READ of the same evidence the deployed server would consult, not a
 * second implementation of the decision: it calls `decideLadder` with the exact
 * `measuredAccuracy` a real `anvil serve mcp` run would derive from a fresh
 * `benchmark.report.json`, so what this command reports and what the server
 * would do can never quietly disagree. A stale or missing report reproduces
 * `auto`'s pre-measurement behavior — the same fallback `decideLadder` itself
 * applies when `measuredAccuracy` is omitted.
 */
export interface LadderStatusSummary {
  decision: LadderDecision;
  /** Whether a fresh (bundle-hash-matching) benchmark report supplied the
   *  accuracy delta `decision` was computed from. */
  measuredAccuracyFresh: boolean;
  /** The laddered-minus-flat accuracy delta consulted, when one was fresh. */
  ladderedMinusFlatPts: number | null;
  /** One line summarizing why this bundle serves the surface it does. */
  line: string;
}

export function ladderStatusSummary(
  bundleDir: string,
  files: Record<string, string>,
  air: AirDocument,
): LadderStatusSummary {
  const measuredAccuracy = measuredAccuracyFromReport(bundleDir, files);
  const decision = decideLadder(air, { measuredAccuracy });
  const ladderedMinusFlatPts = measuredAccuracy?.ladderedMinusFlatPts ?? null;
  return {
    decision,
    measuredAccuracyFresh: measuredAccuracy !== undefined,
    ladderedMinusFlatPts,
    line: renderLadderDecisionLine(decision, ladderedMinusFlatPts),
  };
}

function renderLadderDecisionLine(
  decision: LadderDecision,
  ladderedMinusFlatPts: number | null,
): string {
  const served = decision.laddered ? "laddered" : "flat";
  if (decision.decisionReason === "plan") {
    const evidence =
      ladderedMinusFlatPts === null
        ? "no fresh benchmark report"
        : `measured delta ${signed(ladderedMinusFlatPts)} pts clears the floors`;
    return `Disclosure ladder: serving ${served} — plan says ${decision.plan.reason} (${evidence}).`;
  }
  return `Disclosure ladder: serving ${served} — plan says ${decision.plan.mode} (${decision.plan.reason}), but ${floorReason(decision.decisionReason, ladderedMinusFlatPts)}.`;
}

function floorReason(reason: LadderDecisionReason, ladderedMinusFlatPts: number | null): string {
  if (reason === "accuracy_below_floor") {
    return (
      `measured laddered accuracy (${ladderedMinusFlatPts === null ? "unknown" : `${signed(ladderedMinusFlatPts)} pts`}) ` +
      `falls below the ${MIN_LADDERED_ACCURACY_DELTA_PTS} pt floor`
    );
  }
  return `measured token savings fall below the ${Math.round(MIN_LADDER_TOKEN_SAVINGS_FRACTION * 100)}% floor`;
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}
