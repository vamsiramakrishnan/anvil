import { AirDocument, DEFAULT_RESPONSE_BUDGET_TOKENS } from "@anvil/air";
import type { ExecutionRecord } from "@anvil/runtime";
import { describe, expect, it } from "vitest";
import {
  DISCLOSURE_MIN_SAMPLES,
  DISCLOSURE_TOLERANCE_FRACTION,
  reconcileDisclosure,
} from "./disclosure-reconcile.js";

/**
 * Fixtures go through `AirDocument.parse`, not object literals, so every default
 * the schema applies is the one production code sees. A hand-rolled contract
 * would let these tests pass against a shape the compiler never produces.
 */
function docWith(...operations: Record<string, unknown>[]): AirDocument {
  return AirDocument.parse({
    service: { id: "orders", version: "1.0.0", source: { kind: "openapi" } },
    operations,
  });
}

function op(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    canonicalName: "search_orders",
    displayName: "Search orders",
    description: "Searches orders.",
    sourceRef: { kind: "openapi", path: "/orders", method: "get" },
    effect: { kind: "read", action: "search", resource: "order", risk: "none" },
    input: { params: [] },
    idempotency: { mode: "natural", mechanism: "none" },
    retries: { mode: "safe", maxAttempts: 3, backoff: "exponential_jitter", retryOn: ["http_429"] },
    confirmation: { required: false, risk: "none" },
    auth: { type: "none", scopes: [] },
    cli: { command: "orders search" },
    mcp: { toolName: "orders_search" },
    skill: { intentExamples: [] },
    state: "approved",
    // 300 tokens for a whole response, 100 per item, 4 chars/token — so 1200
    // observed bytes is exactly the prediction and the arithmetic in these
    // tests stays legible.
    disclosureCost: {
      toolTokens: 400,
      responseItemTokens: 100,
      responseTokens: 300,
      charsPerToken: 4,
      estimator: "o200k_base",
      seed: 1,
    },
    ...overrides,
  };
}

function record(
  operationId: string,
  responseBytes: number,
  overrides: Partial<ExecutionRecord> = {},
): ExecutionRecord {
  return {
    traceId: `t-${operationId}-${responseBytes}`,
    operationId,
    effect: "read",
    outcome: "success",
    latencyMs: 12,
    retryCount: 0,
    idempotencyKeyPresent: false,
    requestBytes: 100,
    responseBytes,
    policyDecisions: [],
    confirmationRequired: false,
    confirmed: false,
    principalId: "anonymous",
    ...overrides,
  };
}

function records(operationId: string, bytes: number, count: number): ExecutionRecord[] {
  return Array.from({ length: count }, (_, index) =>
    record(operationId, bytes, { traceId: `t-${operationId}-${bytes}-${index}` }),
  );
}

const only = (report: ReturnType<typeof reconcileDisclosure>) => {
  const entry = report.operations[0];
  if (!entry) throw new Error("expected exactly one reconciled operation");
  return entry;
};

describe("reconcileDisclosure", () => {
  /**
   * The case the whole feature exists for. A thousand executions whose median
   * matches the certified figure exactly, and a 6% tail of 400-line orders. A
   * mean would be dragged only mildly and could plausibly still read as "close
   * enough"; the p95 is the number that tells the truth, and the budget the
   * certificate asserts is broken by the tail, not the middle.
   */
  it("catches a fat-tail tenant whose median is fine and whose p95 is catastrophic", () => {
    const report = reconcileDisclosure(docWith(op("orders.search")), [
      ...records("orders.search", 1_200, 940),
      ...records("orders.search", 200_000, 60),
    ]);
    const entry = only(report);

    expect(entry.verdict).toBe("understates");
    expect(entry.observed?.p50Tokens).toBe(300);
    expect(entry.observed?.p95Tokens).toBe(50_000);
    expect(entry.observed?.samples).toBe(1_000);
    // The sharpest form of the honesty gap: the certificate says it fits the
    // response budget, and in production it does not.
    expect(entry.budgetBreached).toBe(true);
    expect(entry.budgetTokens).toBe(DEFAULT_RESPONSE_BUDGET_TOKENS);
    expect(report.summary.budgetBreaches).toBe(1);
    expect(entry.detail).toContain("UNDERSTATES");
  });

  /**
   * A mean over that same population is ~12k tokens — alarming, but only 40× the
   * prediction where the p95 is 166×, and a *median*-anchored report would have
   * called it clean. Pinning both statistics is what proves the distribution is
   * really being reported rather than a single number with extra fields.
   */
  it("reports a spread, so the median cannot vouch for the tail", () => {
    const entry = only(
      reconcileDisclosure(docWith(op("orders.search")), [
        ...records("orders.search", 1_200, 940),
        ...records("orders.search", 200_000, 60),
      ]),
    );
    expect(entry.observed?.p50Tokens).toBe(300);
    expect(entry.observed?.maxTokens).toBe(50_000);
    expect(entry.observed?.p50Tokens).toBeLessThan(entry.observed?.p95Tokens ?? 0);
  });

  it("proposes a recalibration and never applies one", () => {
    const contract = docWith(op("orders.search"));
    const report = reconcileDisclosure(contract, [
      ...records("orders.search", 1_200, 940),
      ...records("orders.search", 200_000, 60),
    ]);
    const proposal = only(report).proposal;

    expect(proposal?.responseTokens).toBe(50_000);
    // No page size to divide by, so the per-item figure is scaled by the same
    // factor the whole response was wrong by: 100 × (50000/300).
    expect(proposal?.responseItemTokens).toBe(Math.round(100 * (50_000 / 300)));
    // Nothing in an execution record bears on the chars↔token ratio, so the
    // proposal carries the current value and says why.
    expect(proposal?.charsPerToken).toBe(4);
    expect(proposal?.charsPerTokenEvidence).toBe("none_available_from_execution_records");
    expect(proposal?.assumptions.length).toBeGreaterThan(0);

    // The contract itself is untouched — the proposal is data for a human.
    expect(contract.operations[0]?.disclosureCost?.responseTokens).toBe(300);
    expect(contract.operations[0]?.disclosureCost?.responseItemTokens).toBe(100);
  });

  /**
   * The clean recalibration: when the operation pages and a page size was
   * solved, the observed payload IS a page of known size, so the per-item cost
   * divides out with nothing assumed about item counts.
   */
  it("divides the per-item proposal out of a solved page size", () => {
    const contract = docWith(
      op("orders.search", {
        pagination: { style: "page", pageSizeParam: "limit", maxPageSize: 50 },
      }),
    );
    // 80_000 bytes ⇒ 20_000 tokens at 4 chars/token, against a projected page of
    // 50 × 100 = 5_000 tokens.
    const entry = only(reconcileDisclosure(contract, records("orders.search", 80_000, 100)));

    expect(entry.predicted?.basis).toBe("projected_page");
    expect(entry.predicted?.pageSize).toBe(50);
    expect(entry.predicted?.tokens).toBe(5_000);
    expect(entry.verdict).toBe("understates");
    expect(entry.proposal?.responseItemTokens).toBe(20_000 / 50);
  });

  it("classifies a prediction that holds", () => {
    const entry = only(
      reconcileDisclosure(docWith(op("orders.search")), records("orders.search", 1_200, 40)),
    );
    expect(entry.verdict).toBe("holds");
    expect(entry.p95Ratio).toBe(1);
    expect(entry.proposal).toBeNull();
    expect(entry.budgetBreached).toBe(false);
  });

  it("keeps a prediction inside the tolerance band on the wasteful side too", () => {
    // 10% under the prediction — real, but inside the band that the bytes→chars
    // approximation and a fitted charsPerToken can account for on their own.
    const entry = only(
      reconcileDisclosure(docWith(op("orders.search")), records("orders.search", 1_080, 40)),
    );
    expect(entry.verdict).toBe("holds");
    expect(entry.p95Ratio).toBeLessThan(1);
    expect(entry.p95Ratio).toBeGreaterThan(1 - DISCLOSURE_TOLERANCE_FRACTION);
  });

  /**
   * The merely wasteful direction: pages are solved smaller than they need to
   * be, so the agent pays round trips for a ceiling that was never real.
   */
  it("classifies a prediction that overstates reality", () => {
    const entry = only(
      reconcileDisclosure(docWith(op("orders.search")), records("orders.search", 200, 40)),
    );
    expect(entry.verdict).toBe("overstates");
    expect(entry.observed?.p95Tokens).toBe(50);
    expect(entry.proposal?.responseTokens).toBe(50);
    // Overstating is not a budget breach: a smaller-than-certified response
    // never breaks the budget the certificate asserts.
    expect(entry.budgetBreached).toBe(false);
  });

  it("refuses a verdict below the minimum sample count, but still shows what it saw", () => {
    const entry = only(
      reconcileDisclosure(
        docWith(op("orders.search")),
        records("orders.search", 200_000, DISCLOSURE_MIN_SAMPLES - 1),
      ),
    );
    expect(entry.verdict).toBe("insufficient_evidence");
    expect(entry.observed?.samples).toBe(DISCLOSURE_MIN_SAMPLES - 1);
    expect(entry.p95Ratio).toBeNull();
    expect(entry.proposal).toBeNull();
    // Even a wildly divergent under-powered sample does not get to breach a
    // budget: a p95 over 29 points is the largest sample wearing a costume.
    expect(entry.budgetBreached).toBe(false);
  });

  it("renders a verdict at exactly the minimum sample count", () => {
    const entry = only(
      reconcileDisclosure(
        docWith(op("orders.search")),
        records("orders.search", 1_200, DISCLOSURE_MIN_SAMPLES),
      ),
    );
    expect(entry.verdict).toBe("holds");
  });

  /**
   * An unobserved operation still appears. Omitting it would let a report full
   * of holes read as a report full of passes.
   */
  it("reports an operation with no records as insufficient evidence", () => {
    const report = reconcileDisclosure(docWith(op("orders.search")), []);
    const entry = only(report);
    expect(entry.verdict).toBe("insufficient_evidence");
    expect(entry.observed).toBeNull();
    expect(entry.detail).toContain("no successful executions observed");
    expect(report.summary.insufficientEvidence).toBe(1);
  });

  /**
   * No prediction beats any amount of traffic: a thousand records cannot
   * contradict a figure that was never measured. That is a gap for the
   * refinement layer to raise, not a disagreement for this pass to classify.
   */
  it("reports an operation with no prediction, regardless of how much traffic it saw", () => {
    const report = reconcileDisclosure(
      docWith(op("orders.search", { disclosureCost: undefined })),
      records("orders.search", 200_000, 500),
    );
    const entry = only(report);
    expect(entry.verdict).toBe("no_prediction");
    expect(entry.predicted).toBeNull();
    expect(entry.observed).toBeNull();
    expect(entry.proposal).toBeNull();
    expect(report.summary.noPrediction).toBe(1);
  });

  /** `responseTokens: 0` means "not measured", never "free" — as AIR documents. */
  it("treats a zero response figure as unmeasured, not as a free response", () => {
    const entry = only(
      reconcileDisclosure(
        docWith(
          op("orders.search", {
            disclosureCost: {
              toolTokens: 400,
              responseItemTokens: 0,
              responseTokens: 0,
              charsPerToken: 4,
              estimator: "o200k_base",
            },
          }),
        ),
        records("orders.search", 1_200, 100),
      ),
    );
    expect(entry.verdict).toBe("no_prediction");
  });

  /**
   * An error envelope's `responseBytes` describes a refusal and a dry run never
   * called the upstream. Folding either in would drag the distribution toward
   * the cheap payloads and hide the understatement this pass hunts for — here,
   * a hundred enormous error records must not rescue (or wreck) the verdict.
   */
  it("folds in successful executions only", () => {
    const report = reconcileDisclosure(docWith(op("orders.search")), [
      ...records("orders.search", 1_200, 40),
      ...records("orders.search", 500_000, 100).map((r) => ({
        ...r,
        outcome: "error" as const,
        errorCode: "not_found" as const,
      })),
      ...records("orders.search", 500_000, 100).map((r) => ({
        ...r,
        outcome: "dry_run" as const,
      })),
    ]);
    const entry = only(report);
    expect(entry.verdict).toBe("holds");
    expect(entry.observed?.samples).toBe(40);
    expect(report.consideredOutcomes).toEqual(["success"]);
  });

  /**
   * A trace set aimed at the wrong bundle otherwise reads as "no evidence
   * anywhere", which looks like a quiet system rather than a mismatched input.
   */
  it("surfaces record ids the reconciled surface does not cover", () => {
    const report = reconcileDisclosure(
      docWith(op("orders.search"), op("orders.draft", { state: "generated" })),
      [
        ...records("orders.search", 1_200, 40),
        ...records("orders.draft", 1_200, 5),
        ...records("orders.unknown", 1_200, 5),
      ],
    );
    expect(report.unmatchedOperationIds).toEqual(["orders.draft", "orders.unknown"]);
    // Only the approved surface is reconciled — that is the surface a
    // certificate covers.
    expect(report.operations.map((entry) => entry.operationId)).toEqual(["orders.search"]);
  });

  /**
   * Determinism is what lets this report be diffed across days and attached to
   * evidence. Record arrival order is an accident of traffic and must not show
   * up in any figure.
   */
  it("is deterministic and order-independent", () => {
    const contract = docWith(op("orders.search"), op("payments.refund"));
    const traffic = [
      ...records("orders.search", 1_200, 940),
      ...records("orders.search", 200_000, 60),
      ...records("payments.refund", 900, 50),
    ];
    const first = reconcileDisclosure(contract, traffic);
    const second = reconcileDisclosure(contract, [...traffic].reverse());
    expect(second).toEqual(first);
    // Operations are emitted in a stable id order, not in whatever order the
    // contract or the traffic happened to list them.
    expect(first.operations.map((entry) => entry.operationId)).toEqual([
      "orders.search",
      "payments.refund",
    ]);
  });

  /**
   * The bytes→characters step can only over-state observed tokens (UTF-8
   * multibyte inflates bytes relative to characters), so this pass errs toward
   * alarm and never toward false comfort. Pinning the conversion keeps that
   * asymmetry from being quietly "corrected" into a symmetric one later.
   */
  it("converts observed bytes through the operation's own chars-per-token calibration", () => {
    const entry = only(
      reconcileDisclosure(
        docWith(
          op("orders.search", {
            disclosureCost: {
              toolTokens: 400,
              responseItemTokens: 100,
              responseTokens: 300,
              charsPerToken: 2,
              estimator: "o200k_base",
            },
          }),
        ),
        records("orders.search", 1_200, 40),
      ),
    );
    // Same 1200 bytes as the "holds" case, but a denser calibration: 600 tokens
    // against a predicted 300, so the same traffic now understates.
    expect(entry.observed?.p95Tokens).toBe(600);
    expect(entry.verdict).toBe("understates");
  });

  it("carries the report envelope the other harness reports use", () => {
    const report = reconcileDisclosure(docWith(op("orders.search")), []);
    expect(report.schemaVersion).toBe(1);
    expect(report.service).toBe("orders");
    expect(report.minSamples).toBe(DISCLOSURE_MIN_SAMPLES);
    expect(report.toleranceFraction).toBe(DISCLOSURE_TOLERANCE_FRACTION);
  });

  it("honours overridden thresholds and budget", () => {
    const entry = only(
      reconcileDisclosure(docWith(op("orders.search")), records("orders.search", 1_200, 5), {
        minSamples: 5,
        toleranceFraction: 0.01,
        budgetTokens: 100,
      }),
    );
    expect(entry.verdict).toBe("holds");
    expect(entry.budgetTokens).toBe(100);
    // Predicted 300 already exceeds the tightened budget, so reality agreeing
    // with the prediction is not a *breach* — the certificate never claimed it
    // fit. Only a prediction that fit and an observation that does not is.
    expect(entry.budgetBreached).toBe(false);
  });
});
