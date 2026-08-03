import { type DisclosureCost, Operation, type Pagination } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { derivePageSize, detectSilentCap, silentCapNotice } from "./page-budget.js";

function createOperation(over?: {
  pagination?: Pagination;
  disclosureCost?: DisclosureCost;
  sizeParamName?: string;
}): Operation {
  const sizeParam = over?.sizeParamName;
  const op = Operation.parse({
    id: "test.operation.list",
    canonicalName: "test_list",
    displayName: "Test List",
    sourceRef: { kind: "openapi", path: "/test", method: "get" },
    effect: { kind: "read", action: "list", resource: "test", risk: "low", reversible: false },
    input: {
      params: sizeParam
        ? [
            {
              name: sizeParam,
              in: "query",
              required: false,
              schema: { type: "integer" },
              inferred: false,
            },
          ]
        : [],
    },
    idempotency: {
      mode: "none",
      mechanism: "header",
      key: "Idempotency-Key",
      keyDerivation: "client_supplied",
    },
    retries: { mode: "safe", maxAttempts: 3, backoff: "exponential", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "test list" },
    mcp: { toolName: "test_list" },
    skill: { intentExamples: [] },
    state: "approved",
  });
  op.pagination = over?.pagination;
  op.disclosureCost = over?.disclosureCost;
  return op;
}

function cost(responseItemTokens: number): DisclosureCost {
  return {
    toolTokens: 200,
    responseItemTokens,
    responseTokens: 0,
    charsPerToken: 4,
    estimator: "o200k_base",
  };
}

describe("derivePageSize", () => {
  it("solves the page size from the measured per-item cost", () => {
    const op = createOperation({
      pagination: { style: "cursor", pageSizeParam: "per_page" },
      disclosureCost: cost(100),
      sizeParamName: "per_page",
    });
    const injection = derivePageSize(op, {}, 8_000);
    expect(injection).toMatchObject({ param: "per_page", key: "per_page", size: 80 });
    expect(injection?.basis).toBe("budget_derived");
  });

  it("normalizes the injection key the way the executor reads input", () => {
    const op = createOperation({
      pagination: { style: "cursor", pageSizeParam: "maxResults" },
      disclosureCost: cost(100),
      sizeParamName: "maxResults",
    });
    expect(derivePageSize(op, {}, 8_000)?.key).toBe("max_results");
  });

  it("clamps to the upstream maximum", () => {
    const op = createOperation({
      pagination: { style: "cursor", pageSizeParam: "per_page", maxPageSize: 25 },
      disclosureCost: cost(100),
      sizeParamName: "per_page",
    });
    const injection = derivePageSize(op, {}, 8_000);
    expect(injection?.size).toBe(25);
    expect(injection?.basis).toBe("capped_by_upstream");
  });

  it("clamps an upstream default that contradicts the upstream maximum", () => {
    const op = createOperation({
      pagination: {
        style: "cursor",
        pageSizeParam: "per_page",
        maxPageSize: 50,
        defaultPageSize: 200,
      },
      sizeParamName: "per_page",
    });
    expect(derivePageSize(op, {}, 8_000)?.size).toBe(50);
  });

  it("NEVER overrides an explicit caller value", () => {
    const op = createOperation({
      pagination: { style: "cursor", pageSizeParam: "per_page" },
      disclosureCost: cost(100),
      sizeParamName: "per_page",
    });
    expect(derivePageSize(op, { per_page: 5 }, 8_000)).toBeUndefined();
    // Including one that blows the budget: an explicit value is a statement of
    // intent, not a suggestion.
    expect(derivePageSize(op, { per_page: 10_000 }, 8_000)).toBeUndefined();
  });

  it("injects NOTHING when the operation was never measured", () => {
    const op = createOperation({
      pagination: { style: "cursor", pageSizeParam: "per_page" },
      sizeParamName: "per_page",
    });
    expect(derivePageSize(op, {}, 8_000)).toBeUndefined();
  });

  it("injects nothing when the contract names no size knob", () => {
    const op = createOperation({
      pagination: { style: "cursor", cursorParam: "page_token" },
      disclosureCost: cost(100),
    });
    expect(derivePageSize(op, {}, 8_000)).toBeUndefined();
  });

  it("injects nothing for an unpaginated operation", () => {
    expect(
      derivePageSize(createOperation({ disclosureCost: cost(100) }), {}, 8_000),
    ).toBeUndefined();
  });

  it("injects nothing when the named param is not in the input schema", () => {
    // A pageSizeParam with no declared param has no wire location, so a value
    // set for it would be silently dropped by the request builder.
    const op = createOperation({
      pagination: { style: "cursor", pageSizeParam: "per_page" },
      disclosureCost: cost(100),
    });
    expect(derivePageSize(op, {}, 8_000)).toBeUndefined();
  });

  it("reports the upstream's own stated default as a contract fact", () => {
    const op = createOperation({
      pagination: { style: "cursor", pageSizeParam: "per_page", defaultPageSize: 20 },
      sizeParamName: "per_page",
    });
    const injection = derivePageSize(op, {}, 8_000);
    expect(injection).toMatchObject({ size: 20, basis: "upstream_default" });
  });

  it("never asks for less than one row", () => {
    const op = createOperation({
      pagination: { style: "cursor", pageSizeParam: "per_page" },
      disclosureCost: cost(50_000),
      sizeParamName: "per_page",
    });
    expect(derivePageSize(op, {}, 8_000)?.size).toBe(1);
  });

  it("a smaller budget buys fewer rows", () => {
    const op = createOperation({
      pagination: { style: "cursor", pageSizeParam: "per_page" },
      disclosureCost: cost(100),
      sizeParamName: "per_page",
    });
    expect(derivePageSize(op, {}, 1_000)?.size).toBe(10);
    expect(derivePageSize(op, {}, 8_000)?.size).toBe(80);
  });
});

describe("detectSilentCap", () => {
  const capped: Pagination = {
    style: "cursor",
    cursorParam: "page_token",
    itemsField: "items",
    nextField: "next_page_token",
    maxPageSize: 3,
  };

  it("flags a full page with no continuation marker", () => {
    const op = createOperation({ pagination: capped });
    const signal = detectSilentCap(op, { items: [1, 2, 3] });
    expect(signal).toMatchObject({ returned: 3, maxPageSize: 3, cursorParam: "page_token" });
  });

  it("stays quiet when the response says it is capped", () => {
    const op = createOperation({ pagination: capped });
    expect(detectSilentCap(op, { items: [1, 2, 3], next_page_token: "tok" })).toBeUndefined();
  });

  it("treats an empty-string continuation as no continuation", () => {
    const op = createOperation({ pagination: capped });
    expect(detectSilentCap(op, { items: [1, 2, 3], next_page_token: "" })).toBeDefined();
  });

  it("stays quiet for a short page", () => {
    const op = createOperation({ pagination: capped });
    expect(detectSilentCap(op, { items: [1, 2] })).toBeUndefined();
  });

  it("reads a bare array response when no items field is modeled", () => {
    const op = createOperation({ pagination: { style: "page", maxPageSize: 2 } });
    expect(detectSilentCap(op, [1, 2])).toMatchObject({ returned: 2, maxPageSize: 2 });
  });

  it("records that completeness was unobservable when no next field is modeled", () => {
    const op = createOperation({ pagination: { style: "page", maxPageSize: 2 } });
    expect(detectSilentCap(op, [1, 2])?.continuationUnobservable).toBe(true);
  });

  it("stays quiet when the contract states no maximum", () => {
    const op = createOperation({ pagination: { style: "cursor", itemsField: "items" } });
    expect(detectSilentCap(op, { items: [1, 2, 3] })).toBeUndefined();
  });

  it("stays quiet for an unpaginated operation", () => {
    expect(detectSilentCap(createOperation(), [1, 2, 3])).toBeUndefined();
  });

  it("stays quiet when the modeled items field is not an array", () => {
    const op = createOperation({ pagination: capped });
    expect(detectSilentCap(op, { items: "nope" })).toBeUndefined();
  });
});

describe("silentCapNotice", () => {
  it("tells the reader not to report a capped read as complete", () => {
    const notice = silentCapNotice({
      returned: 100,
      maxPageSize: 100,
      cursorParam: "page_token",
      continuationUnobservable: false,
    });
    expect(notice).toContain("returned 100 items");
    expect(notice).toContain("indistinguishable from a complete one");
    expect(notice).toContain("'page_token'");
  });

  it("does not invent a continuation parameter it was not given", () => {
    const notice = silentCapNotice({
      returned: 2,
      maxPageSize: 2,
      continuationUnobservable: true,
    });
    expect(notice).not.toContain("'");
    expect(notice).toContain("confirm completeness another way");
  });
});
