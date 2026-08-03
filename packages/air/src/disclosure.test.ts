import { describe, expect, it } from "vitest";
import {
  charsForTokenBudget,
  DEFAULT_RESPONSE_BUDGET_TOKENS,
  estimateTokens,
  FALLBACK_CHARS_PER_TOKEN,
  Operation,
  responseFitsBudget,
  safePageSize,
  toolSurfaceFitsBudget,
} from "./index.js";

/**
 * A minimal approved read. Built through `Operation.parse` rather than an object
 * literal so every default the schema applies is the same one production code
 * sees — a hand-rolled fixture would let a test pass against a shape the
 * compiler never actually produces.
 */
const listOp = (overrides: Record<string, unknown> = {}) =>
  Operation.parse({
    id: "orders.search",
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
    ...overrides,
  });

const cost = (over: Record<string, unknown> = {}) => ({
  toolTokens: 400,
  responseItemTokens: 100,
  responseTokens: 300,
  charsPerToken: 4,
  estimator: "o200k_base",
  ...over,
});

describe("safePageSize", () => {
  it("reports an operation that does not paginate", () => {
    expect(safePageSize(listOp()).basis).toBe("not_paginated");
  });

  /**
   * The case that makes the whole feature honest. A cursor with no size knob can
   * be walked but never narrowed, so solving a budget against it would name a
   * page size no caller can request — a number that reads as a guarantee while
   * no serving path can honor it.
   */
  it("declines to size a paginated operation that exposes no size control", () => {
    const op = listOp({
      pagination: { style: "cursor", cursorParam: "cursor" },
      disclosureCost: cost(),
    });
    const result = safePageSize(op, 8_000);
    expect(result.basis).toBe("no_size_control");
    expect(result.size).toBeUndefined();
    expect(result.projectedTokens).toBeUndefined();
  });

  it("reports unmeasured rather than inventing a page size", () => {
    const op = listOp({
      pagination: { style: "cursor", cursorParam: "cursor", pageSizeParam: "limit" },
    });
    const result = safePageSize(op, 8_000);
    expect(result.basis).toBe("unmeasured");
    expect(result.size).toBeUndefined();
  });

  it("prefers the upstream's stated default over guessing when unmeasured", () => {
    const op = listOp({
      pagination: {
        style: "cursor",
        cursorParam: "cursor",
        pageSizeParam: "limit",
        defaultPageSize: 25,
      },
    });
    expect(safePageSize(op, 8_000)).toMatchObject({ size: 25, basis: "upstream_default" });
  });

  it("solves the largest page that fits the budget", () => {
    const op = listOp({
      pagination: { style: "cursor", cursorParam: "cursor", pageSizeParam: "limit" },
      disclosureCost: cost({ responseItemTokens: 184 }),
    });
    const result = safePageSize(op, 8_000);
    expect(result.basis).toBe("budget_derived");
    expect(result.size).toBe(Math.floor(8_000 / 184));
    expect(result.projectedTokens).toBeLessThanOrEqual(8_000);
  });

  it("clamps to the upstream cap and says the cap was the binding constraint", () => {
    const op = listOp({
      pagination: {
        style: "cursor",
        cursorParam: "cursor",
        pageSizeParam: "limit",
        maxPageSize: 10,
      },
      disclosureCost: cost({ responseItemTokens: 1 }),
    });
    const result = safePageSize(op, 8_000);
    expect(result).toMatchObject({ size: 10, basis: "capped_by_upstream" });
  });

  it("honors a caller's measured per-item cost, so a projection buys more rows", () => {
    const op = listOp({
      pagination: { style: "cursor", cursorParam: "cursor", pageSizeParam: "limit" },
      disclosureCost: cost({ responseItemTokens: 184 }),
    });
    const wide = safePageSize(op, 8_000).size ?? 0;
    const projected = safePageSize(op, 8_000, 22).size ?? 0;
    expect(projected).toBeGreaterThan(wide);
  });

  it("never returns a page of zero, even when one item exceeds the whole budget", () => {
    const op = listOp({
      pagination: { style: "cursor", cursorParam: "cursor", pageSizeParam: "limit" },
      disclosureCost: cost({ responseItemTokens: 99_999 }),
    });
    expect(safePageSize(op, 8_000).size).toBe(1);
  });
});

describe("responseFitsBudget", () => {
  it("judges a sizable operation on the page it would actually serve", () => {
    const op = listOp({
      pagination: { style: "cursor", cursorParam: "cursor", pageSizeParam: "limit" },
      disclosureCost: cost({ responseItemTokens: 100, responseTokens: 500_000 }),
    });
    // The whole result set is enormous, but a budget-derived page is not.
    expect(responseFitsBudget(op, 8_000)).toBe(true);
  });

  /**
   * The optimism this guards against: before `no_size_control` existed, an
   * operation with a cursor but no size knob was judged on a page it could never
   * request, and a 500k-token response certified as fitting.
   */
  it("judges a size-controlless operation on its whole response", () => {
    const op = listOp({
      pagination: { style: "cursor", cursorParam: "cursor" },
      disclosureCost: cost({ responseItemTokens: 100, responseTokens: 500_000 }),
    });
    expect(responseFitsBudget(op, 8_000)).toBe(false);
  });

  it("judges an unpaginated operation on its whole response", () => {
    const op = listOp({
      disclosureCost: cost({ responseTokens: DEFAULT_RESPONSE_BUDGET_TOKENS + 1 }),
    });
    expect(responseFitsBudget(op)).toBe(false);
  });

  it("does not fail an operation that was never measured", () => {
    expect(responseFitsBudget(listOp())).toBe(true);
  });
});

describe("toolSurfaceFitsBudget", () => {
  it("fails a measured surface over budget and passes one under it", () => {
    expect(
      toolSurfaceFitsBudget(listOp({ disclosureCost: cost({ toolTokens: 5_000 }) }), 1_200),
    ).toBe(false);
    expect(
      toolSurfaceFitsBudget(listOp({ disclosureCost: cost({ toolTokens: 900 }) }), 1_200),
    ).toBe(true);
  });

  it("treats unmeasured as unjudged, not as a failure", () => {
    expect(toolSurfaceFitsBudget(listOp(), 1)).toBe(true);
  });
});

describe("token estimation", () => {
  it("round-trips a budget through the calibration", () => {
    expect(estimateTokens(charsForTokenBudget(100, 3.5), 3.5)).toBeLessThanOrEqual(100);
  });

  it("falls back to the conventional ratio when calibration is missing or absurd", () => {
    expect(estimateTokens(40)).toBe(40 / FALLBACK_CHARS_PER_TOKEN);
    expect(estimateTokens(40, 0)).toBe(40 / FALLBACK_CHARS_PER_TOKEN);
    expect(estimateTokens(40, -3)).toBe(40 / FALLBACK_CHARS_PER_TOKEN);
  });

  it("never reports a partial token as free", () => {
    expect(estimateTokens(1, 4)).toBe(1);
  });
});
