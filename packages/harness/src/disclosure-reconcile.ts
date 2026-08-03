import {
  type AirDocument,
  DEFAULT_RESPONSE_BUDGET_TOKENS,
  estimateTokens,
  type Operation,
  safePageSize,
} from "@anvil/air";
import type { ExecutionRecord } from "@anvil/runtime";
import { z } from "zod";

/**
 * Reconciling a certified *prediction* against production *reality*.
 *
 * `DisclosureCost.responseTokens` / `responseItemTokens` are, by their own
 * doc comment, a prediction about data: measured by driving the contract-
 * faithful simulator under a recorded seed, which makes them reproducible and
 * not correct. The simulator invents `{id, status}`-shaped entities because the
 * contract is all it has; a tenant whose order objects carry forty fields, a
 * rendered address block and a line-item array produces responses an order of
 * magnitude larger. Every budget the certificate asserts that operation fits
 * inside is then wrong, in the one direction that hurts, and until this pass
 * existed Anvil had no mechanism that could ever notice.
 *
 * The observation side was already there and unused: `ExecutionRecord` is
 * emitted on every call and carries `responseBytes`. This module is the join —
 * a pure fold of those records against the contract that produced the
 * prediction, reporting where the two disagree and by how much.
 *
 * What it deliberately does NOT do is fix anything. It emits a recalibration
 * *proposal* as data. Anvil's entire posture is that evidence is gathered
 * mechanically and a human decides; a pass that quietly rewrote a certified
 * figure from whatever traffic happened to flow last week would invert that,
 * and would do it on the one axis (context cost) where the input is attacker-
 * influenceable — a caller who can make responses fat could walk a certified
 * budget wherever it liked. So: measure, classify, propose, stop.
 *
 * Pure and deterministic: same records and same contract always yield the same
 * report. No clock, no randomness, no I/O.
 */

/* -------------------------------------------------------------------------- */
/* Thresholds                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Minimum successful observations before this pass will render any verdict.
 *
 * The reported statistic is p95, and the bar has to be set by what makes a p95
 * mean anything. Under nearest-rank, a p95 over ten samples IS the tenth
 * sample — the maximum — so below roughly twenty points the tail statistic and
 * the extremum collapse into each other and a single pathological payload
 * decides the classification. At thirty, p95 lands on the 29th of 30: at least
 * one observation sits above it, so the number is at least nominally a tail
 * rather than "the worst thing we saw".
 *
 * It is a deliberately low bar. This pass should be usable after an hour of
 * real traffic, and its output is a proposal for a human to read, not a change
 * that lands on its own — the cost of an under-powered verdict is a reviewer's
 * minute, so the expensive failure is refusing to speak, not speaking early.
 */
export const DISCLOSURE_MIN_SAMPLES = 30;

/**
 * Tolerance band on the observed-p95 ÷ predicted ratio, either side of 1.
 *
 * It has to sit above the systematic error this comparison already carries and
 * below the smallest divergence worth a human's attention. Above: bytes are
 * read as characters (see {@link observedTokens}), `charsPerToken` is a fitted
 * average, and the upstream's JSON serialization — key order, whitespace, null
 * handling — is not the simulator's. Each is a few percent; together they can
 * plausibly reach the mid-teens. Below: a page solved against an 8k budget
 * absorbs a quarter of slack without any decision changing, whereas the
 * fat-tail tenant this pass exists to catch shows up at 2× to 20×.
 *
 * A tighter band would fire on measurement noise, which trains a reviewer to
 * ignore the report — the worst outcome available to a safety signal.
 */
export const DISCLOSURE_TOLERANCE_FRACTION = 0.25;

/* -------------------------------------------------------------------------- */
/* Report shape                                                                */
/* -------------------------------------------------------------------------- */

/**
 * How the prediction fared. The split exists so the output is actionable rather
 * than a number to squint at, and the two failure directions are named
 * separately because they are not the same problem:
 *
 * `understates` is the dangerous one — a certificate says the response fits and
 * it does not, so an agent's context blows in production against a document
 * asserting it would not. `overstates` is merely wasteful: pages are solved
 * smaller than they need to be, so the agent pays extra round trips for a
 * ceiling that was never real.
 */
export const DisclosureVerdict = z.enum([
  "holds",
  "understates",
  "overstates",
  "insufficient_evidence",
  "no_prediction",
]);
export type DisclosureVerdict = z.infer<typeof DisclosureVerdict>;

/**
 * The predicted figure this operation is being judged against, and where it
 * came from.
 *
 * `projected_page` mirrors `responseFitsBudget`: a paginated operation is
 * judged on the page the deployed server would actually serve, because that is
 * the payload the execution records observed. Judging it on the whole
 * simulator response would compare against a payload no caller ever receives.
 */
export const PredictedResponseCost = z.object({
  tokens: z.number().int().nonnegative(),
  basis: z.enum(["whole_response", "projected_page"]),
  /** The solved page size behind a `projected_page` figure. */
  pageSize: z.number().int().positive().optional(),
  responseItemTokens: z.number().int().nonnegative(),
  charsPerToken: z.number().positive(),
  /** Tokenizer identity behind the prediction — figures from two are not comparable. */
  estimator: z.string(),
  /** Simulator seed behind the prediction; its presence is the "this is synthetic" marker. */
  seed: z.number().int().optional(),
});
export type PredictedResponseCost = z.infer<typeof PredictedResponseCost>;

/**
 * The observed distribution, reported as a spread rather than an average.
 *
 * One 400-line order among a thousand small ones is exactly the case this whole
 * feature exists for, and a mean buries it: the mean of that population is
 * indistinguishable from the mean of a healthy one. A budget is broken by its
 * tail, so the tail is what gets reported. `max` rides alongside p95 so a
 * reviewer can see whether the tail is a slope or a cliff.
 */
export const ObservedResponseSpread = z.object({
  /** Successful records folded in — the denominator behind every figure here. */
  samples: z.number().int().nonnegative(),
  p50Bytes: z.number().int().nonnegative(),
  p95Bytes: z.number().int().nonnegative(),
  maxBytes: z.number().int().nonnegative(),
  p50Tokens: z.number().int().nonnegative(),
  p95Tokens: z.number().int().nonnegative(),
  maxTokens: z.number().int().nonnegative(),
});
export type ObservedResponseSpread = z.infer<typeof ObservedResponseSpread>;

/**
 * What a rebuild WOULD write, emitted as data and never applied.
 *
 * Present only when the prediction materially disagreed with reality, because a
 * proposal to change nothing is noise a reviewer has to read past.
 */
export const DisclosureRecalibration = z.object({
  /** Proposed `DisclosureCost.responseTokens`. */
  responseTokens: z.number().int().nonnegative(),
  /** Proposed `DisclosureCost.responseItemTokens`. */
  responseItemTokens: z.number().int().nonnegative(),
  /**
   * Proposed `DisclosureCost.charsPerToken` — always the CURRENT value.
   *
   * An `ExecutionRecord` carries bytes, never tokens, so production traffic
   * contains no tokenization ground truth whatsoever: nothing observable here
   * bears on the chars↔tokens ratio, and moving it because payloads got bigger
   * would be laundering a data-shape finding into a fabricated tokenizer
   * measurement. The field is carried so the proposal is a complete
   * `DisclosureCost` delta a rebuild can apply verbatim, and it is carried
   * unchanged so that completeness costs no honesty.
   */
  charsPerToken: z.number().positive(),
  /** Fixed marker: nothing in an execution record can recalibrate the ratio. */
  charsPerTokenEvidence: z.literal("none_available_from_execution_records"),
  /** Every assumption the proposed numbers rest on, spelled out for the reviewer. */
  assumptions: z.array(z.string()),
});
export type DisclosureRecalibration = z.infer<typeof DisclosureRecalibration>;

export const OperationDisclosureReconciliation = z.object({
  operationId: z.string(),
  verdict: DisclosureVerdict,
  predicted: PredictedResponseCost.nullable(),
  observed: ObservedResponseSpread.nullable(),
  /** observed p95 ÷ predicted, rounded to 3dp so the report diffs cleanly. */
  p95Ratio: z.number().nullable(),
  budgetTokens: z.number().int().positive(),
  /**
   * The certificate said this fits the response budget and the observed p95
   * does not. The sharpest form of the honesty gap, so it gets its own boolean
   * rather than being left for a reader to derive from two other numbers.
   */
  budgetBreached: z.boolean(),
  proposal: DisclosureRecalibration.nullable(),
  detail: z.string(),
});
export type OperationDisclosureReconciliation = z.infer<typeof OperationDisclosureReconciliation>;

export const DisclosureReconciliationReport = z.object({
  schemaVersion: z.literal(1),
  service: z.string(),
  budgetTokens: z.number().int().positive(),
  minSamples: z.number().int().positive(),
  toleranceFraction: z.number().positive(),
  /**
   * Which record outcomes were folded in. Fixed at `success` and reported
   * anyway: an error envelope's `responseBytes` describes a refusal, not a
   * page, and a dry run never called the upstream at all. Letting either in
   * would drag the distribution toward the cheap payloads and hide precisely
   * the understatement this pass hunts for.
   */
  consideredOutcomes: z.array(z.literal("success")),
  operations: z.array(OperationDisclosureReconciliation),
  /**
   * Record operation ids no reconciled operation covers — unknown to the
   * contract, or known but not approved. Surfaced rather than dropped because
   * a trace set aimed at the wrong bundle otherwise reads as "no evidence
   * anywhere", which looks like a quiet system rather than a mismatched input.
   */
  unmatchedOperationIds: z.array(z.string()),
  summary: z.object({
    holds: z.number().int().nonnegative(),
    understates: z.number().int().nonnegative(),
    overstates: z.number().int().nonnegative(),
    insufficientEvidence: z.number().int().nonnegative(),
    noPrediction: z.number().int().nonnegative(),
    budgetBreaches: z.number().int().nonnegative(),
  }),
});
export type DisclosureReconciliationReport = z.infer<typeof DisclosureReconciliationReport>;

export interface DisclosureReconcileOptions {
  /** Response budget the prediction was certified against (default 8k tokens). */
  budgetTokens?: number;
  /** Override {@link DISCLOSURE_MIN_SAMPLES}; useful for a deliberately narrow probe. */
  minSamples?: number;
  /** Override {@link DISCLOSURE_TOLERANCE_FRACTION}. */
  toleranceFraction?: number;
}

/* -------------------------------------------------------------------------- */
/* The pass                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Fold observed execution records against the contract's predicted response
 * cost, one verdict per approved operation.
 *
 * Approved operations only, matching every other live-evidence path in this
 * package: the certificate covers the approved surface, so that is the surface
 * whose figures can be right or wrong. Operations with no records still appear,
 * carrying `insufficient_evidence` — an unobserved operation is an unverified
 * claim, and omitting it would let a report full of holes read as full of
 * passes.
 */
export function reconcileDisclosure(
  air: AirDocument,
  records: readonly ExecutionRecord[],
  options: DisclosureReconcileOptions = {},
): DisclosureReconciliationReport {
  const budgetTokens = options.budgetTokens ?? DEFAULT_RESPONSE_BUDGET_TOKENS;
  const minSamples = options.minSamples ?? DISCLOSURE_MIN_SAMPLES;
  const tolerance = options.toleranceFraction ?? DISCLOSURE_TOLERANCE_FRACTION;

  const approved = [...air.operations]
    .filter((op) => op.state === "approved")
    .sort((left, right) => left.id.localeCompare(right.id));
  const approvedIds = new Set(approved.map((op) => op.id));

  // Bucket once, in record order. Insertion order does not survive into any
  // figure — everything downstream sorts — but keeping the fold single-pass
  // means a million-record trace set costs one traversal.
  const byOperation = new Map<string, number[]>();
  const unmatched = new Set<string>();
  for (const record of records) {
    if (!approvedIds.has(record.operationId)) {
      unmatched.add(record.operationId);
      continue;
    }
    if (record.outcome !== "success") continue;
    const bucket = byOperation.get(record.operationId);
    if (bucket) bucket.push(record.responseBytes);
    else byOperation.set(record.operationId, [record.responseBytes]);
  }

  const operations = approved.map((op) =>
    reconcileOperation(op, byOperation.get(op.id) ?? [], budgetTokens, minSamples, tolerance),
  );

  const count = (verdict: DisclosureVerdict): number =>
    operations.filter((entry) => entry.verdict === verdict).length;

  return DisclosureReconciliationReport.parse({
    schemaVersion: 1,
    service: air.service.id,
    budgetTokens,
    minSamples,
    toleranceFraction: tolerance,
    consideredOutcomes: ["success"],
    operations,
    unmatchedOperationIds: [...unmatched].sort(),
    summary: {
      holds: count("holds"),
      understates: count("understates"),
      overstates: count("overstates"),
      insufficientEvidence: count("insufficient_evidence"),
      noPrediction: count("no_prediction"),
      budgetBreaches: operations.filter((entry) => entry.budgetBreached).length,
    },
  });
}

function reconcileOperation(
  op: Operation,
  responseBytes: readonly number[],
  budgetTokens: number,
  minSamples: number,
  tolerance: number,
): OperationDisclosureReconciliation {
  const predicted = predictionFor(op, budgetTokens);

  // Nothing to reconcile against takes precedence over how much traffic we saw:
  // a thousand records still cannot contradict a figure that was never
  // measured. This is a gap for the refinement layer to raise (measure the
  // operation), not a disagreement for this one to classify.
  if (!predicted) {
    return {
      operationId: op.id,
      verdict: "no_prediction",
      predicted: null,
      observed: null,
      p95Ratio: null,
      budgetTokens,
      budgetBreached: false,
      proposal: null,
      detail:
        "no measured response prediction on this operation, so production traffic has nothing " +
        "to contradict; measure it before a budget claim can mean anything",
    };
  }

  if (responseBytes.length < minSamples) {
    return {
      operationId: op.id,
      verdict: "insufficient_evidence",
      predicted,
      observed: responseBytes.length > 0 ? spreadFor(responseBytes, predicted.charsPerToken) : null,
      p95Ratio: null,
      budgetTokens,
      budgetBreached: false,
      proposal: null,
      detail:
        responseBytes.length === 0
          ? `no successful executions observed; ${minSamples} are needed before a p95 means anything`
          : `only ${responseBytes.length} successful execution(s) observed; ${minSamples} are needed ` +
            "before a p95 is a tail rather than the largest sample",
    };
  }

  const observed = spreadFor(responseBytes, predicted.charsPerToken);
  const ratio = observed.p95Tokens / predicted.tokens;
  const budgetBreached = predicted.tokens <= budgetTokens && observed.p95Tokens > budgetTokens;

  if (ratio > 1 + tolerance) {
    return {
      operationId: op.id,
      verdict: "understates",
      predicted,
      observed,
      p95Ratio: round3(ratio),
      budgetTokens,
      budgetBreached,
      proposal: proposalFor(op, predicted, observed, ratio),
      detail:
        `observed p95 ≈ ${observed.p95Tokens} tokens against a predicted ${predicted.tokens} ` +
        `(×${round3(ratio)}); the certified figure UNDERSTATES this tenant's payloads` +
        (budgetBreached
          ? `, and the p95 exceeds the ${budgetTokens}-token response budget the certificate ` +
            "asserts this operation fits inside"
          : "") +
        `. Tail: max ≈ ${observed.maxTokens} tokens, median ≈ ${observed.p50Tokens}`,
    };
  }

  if (ratio < 1 - tolerance) {
    return {
      operationId: op.id,
      verdict: "overstates",
      predicted,
      observed,
      p95Ratio: round3(ratio),
      budgetTokens,
      budgetBreached: false,
      proposal: proposalFor(op, predicted, observed, ratio),
      detail:
        `observed p95 ≈ ${observed.p95Tokens} tokens against a predicted ${predicted.tokens} ` +
        `(×${round3(ratio)}); the certified figure overstates reality, so pages are solved ` +
        "smaller than they need to be and the agent pays round trips for a ceiling that is not real",
    };
  }

  return {
    operationId: op.id,
    verdict: "holds",
    predicted,
    observed,
    p95Ratio: round3(ratio),
    budgetTokens,
    budgetBreached,
    proposal: null,
    detail:
      `observed p95 ≈ ${observed.p95Tokens} tokens against a predicted ${predicted.tokens} ` +
      `(×${round3(ratio)}), inside the ±${Math.round(tolerance * 100)}% band across ` +
      `${observed.samples} executions; the prediction holds for this tenant`,
  };
}

/**
 * The figure to judge against, and honesty about which one it is.
 *
 * A paginated operation is judged on the page the deployed server would
 * actually serve — the same figure `responseFitsBudget` uses — because that is
 * what the execution records observed. Falling back to the whole simulator
 * response for an operation that pages would compare production against a
 * payload no caller ever receives.
 *
 * Zero is treated as absent throughout, exactly as `DisclosureCost` documents:
 * `responseTokens: 0` means "not measured", never "free".
 */
function predictionFor(op: Operation, budgetTokens: number): PredictedResponseCost | null {
  const cost = op.disclosureCost;
  if (!cost) return null;

  const base = {
    responseItemTokens: cost.responseItemTokens,
    charsPerToken: cost.charsPerToken,
    estimator: cost.estimator,
    ...(cost.seed !== undefined ? { seed: cost.seed } : {}),
  };

  if (op.pagination) {
    const page = safePageSize(op, budgetTokens);
    if (page.projectedTokens !== undefined && page.projectedTokens > 0 && page.size !== undefined) {
      return {
        tokens: page.projectedTokens,
        basis: "projected_page",
        pageSize: page.size,
        ...base,
      };
    }
    // No projection: the operation exposes no size control, was never measured,
    // or is sized by an upstream default we cannot cost. In every one of those
    // the caller receives whatever the upstream sends, so the measured whole
    // response is the honest comparand rather than a fallback.
  }

  if (cost.responseTokens <= 0) return null;
  return { tokens: cost.responseTokens, basis: "whole_response", ...base };
}

/**
 * Observed bytes → the reported spread.
 *
 * Percentiles are nearest-rank, never interpolated. Every figure this report
 * prints is then a payload that genuinely occurred, which is the difference
 * between "a response this big was served" and "a response this big is what the
 * arithmetic between two real ones works out to" — only the first is evidence.
 */
function spreadFor(
  responseBytes: readonly number[],
  charsPerToken: number,
): ObservedResponseSpread {
  const sorted = [...responseBytes].sort((left, right) => left - right);
  const p50Bytes = nearestRank(sorted, 0.5);
  const p95Bytes = nearestRank(sorted, 0.95);
  const maxBytes = sorted[sorted.length - 1] ?? 0;
  return {
    samples: sorted.length,
    p50Bytes,
    p95Bytes,
    maxBytes,
    p50Tokens: observedTokens(p50Bytes, charsPerToken),
    p95Tokens: observedTokens(p95Bytes, charsPerToken),
    maxTokens: observedTokens(maxBytes, charsPerToken),
  };
}

function nearestRank(sortedAscending: readonly number[], quantile: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.min(
    sortedAscending.length,
    Math.max(1, Math.ceil(quantile * sortedAscending.length)),
  );
  return sortedAscending[rank - 1] ?? 0;
}

/**
 * Convert an observed response BYTE count into a token estimate.
 *
 * Two approximations stack here and both are named rather than laundered,
 * because a precise-looking number is worse than an admittedly rough one:
 *
 *  1. bytes → characters. `ExecutionRecord.responseBytes` counts octets on the
 *     wire; `charsPerToken` was calibrated against JavaScript string length.
 *     Under UTF-8 those agree only on ASCII — every multibyte codepoint (a
 *     Cyrillic customer name, an emoji in a description field) contributes more
 *     bytes than characters. So the byte count is an upper bound on characters,
 *     always.
 *  2. characters → tokens is `estimateTokens`, the same cheap serve-time
 *     calibration the deployed runtime uses, which is itself a fitted average
 *     and explicitly not certification-grade.
 *
 * The first error has a KNOWN SIGN, which is what makes it acceptable here:
 * reading bytes as characters can only over-state observed tokens, never
 * under-state them. This pass therefore errs toward flagging a prediction as
 * too small — toward alarm, never toward false comfort. That asymmetry is
 * deliberate: a false flag costs a reviewer a minute, a missed one is a
 * certified budget that breaks silently in production.
 */
function observedTokens(responseBytes: number, charsPerToken: number): number {
  return estimateTokens(responseBytes, charsPerToken);
}

/**
 * The recalibration a rebuild would apply — computed, reported, not applied.
 *
 * Anchored on p95 rather than max. Recalibrating to the maximum sizes every
 * future page against the single worst payload ever recorded, which is how one
 * pathological record becomes a permanently tiny page for everybody; p95 is the
 * level a budget should actually hold at. The max is reported alongside so a
 * reviewer can decide for themselves whether that tail deserves its own
 * treatment (a projection, a hard cap) rather than a bigger number.
 */
function proposalFor(
  op: Operation,
  predicted: PredictedResponseCost,
  observed: ObservedResponseSpread,
  ratio: number,
): DisclosureRecalibration {
  const assumptions: string[] = [
    "observed response BYTES are read as characters; UTF-8 multibyte inflates bytes relative " +
      "to characters, so these figures are an upper bound on observed tokens",
    "anchored on observed p95, not max: recalibrating to the worst single payload would size " +
      "every future page for one outlier",
    `derived from ${observed.samples} successful executions only; errors and dry runs carry ` +
      "response byte counts that describe a refusal, not a page",
  ];

  let responseItemTokens: number;
  if (predicted.basis === "projected_page" && predicted.pageSize !== undefined) {
    // The clean case: the observed payload IS a page of a known size, so the
    // per-item cost divides out directly with nothing assumed about item counts.
    responseItemTokens = Math.max(1, Math.ceil(observed.p95Tokens / predicted.pageSize));
    assumptions.push(
      `per-item cost divided out of the observed page against the solved page size of ` +
        `${predicted.pageSize} items`,
    );
  } else if (predicted.responseItemTokens > 0) {
    // No page size to divide by — an `ExecutionRecord` records bytes, not item
    // counts — so the only defensible move is to scale the per-item figure by
    // the same factor the whole response was wrong by. That assumes observed
    // responses carry roughly the item count the measured one did, which is an
    // assumption and is recorded as one rather than buried in the arithmetic.
    responseItemTokens = Math.max(1, Math.round(predicted.responseItemTokens * ratio));
    assumptions.push(
      "no solved page size available, so the per-item figure is scaled by the whole-response " +
        "error factor; this assumes observed responses carry roughly the item count the " +
        "simulator measured",
    );
  } else {
    // The contract yields no item shape. Zero here is a fact about the
    // operation, not a missing measurement, so inventing a per-item cost would
    // manufacture a figure the contract cannot support.
    responseItemTokens = 0;
    assumptions.push(
      "this operation has no measured per-item cost (the contract yields no item shape), so " +
        "only the whole-response figure is proposed",
    );
  }

  if (op.pagination && predicted.basis === "whole_response") {
    assumptions.push(
      "the operation paginates but no page size could be solved, so the whole response is the " +
        "comparand — the caller receives whatever the upstream sends",
    );
  }

  return {
    responseTokens: observed.p95Tokens,
    responseItemTokens,
    charsPerToken: predicted.charsPerToken,
    charsPerTokenEvidence: "none_available_from_execution_records",
    assumptions,
  };
}

/** Fixed precision keeps a report byte-stable across runs and diffable across days. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
