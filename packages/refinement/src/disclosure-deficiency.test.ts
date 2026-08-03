import {
  type AirDocument,
  DEFAULT_RESPONSE_BUDGET_TOKENS,
  DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS,
  loadAirDocument,
  type Operation,
  type Pagination,
} from "@anvil/air";
import { describe, expect, it } from "vitest";
import { DEFICIENCY_CATALOG } from "./deficiency.js";
import { runDetectors } from "./detect.js";

/**
 * Context cost as a *detected* property. Every case here turns on one thing:
 * whether the operation was measured. A measured surface over budget is a
 * finding with a number in it; an unmeasured one is silence, because absence of
 * measurement is not evidence of a problem.
 */

interface OpOptions {
  toolTokens?: number;
  responseTokens?: number;
  responseItemTokens?: number;
  /** Omit entirely to model an operation that was never measured. */
  measured?: boolean;
  pagination?: Pagination;
}

/** A minimal, otherwise-clean read operation; only its disclosure facts vary. */
function doc(options: OpOptions): AirDocument {
  const operation: Record<string, unknown> = {
    id: "orders.search",
    canonicalName: "search_orders",
    displayName: "Search orders",
    description: "Searches orders matching a query.",
    sourceRef: { kind: "openapi", path: "/orders/search", method: "get" },
    effect: { kind: "read", action: "search", risk: "none" },
    input: {
      params: [
        {
          name: "status",
          in: "query",
          required: false,
          description: "Order status to filter on.",
          example: "open",
          schema: { type: "string" },
        },
      ],
    },
    idempotency: { mode: "natural" },
    retries: { mode: "safe", basis: "read_safe", maxAttempts: 3, retryOn: ["http_503"] },
    confirmation: { required: false },
    auth: { type: "api_key" },
    cli: { command: "orders search" },
    mcp: { toolName: "orders_search" },
    skill: { intentExamples: ["Find open orders."] },
  };
  if (options.pagination) operation.pagination = options.pagination;
  if (options.measured !== false) {
    operation.disclosureCost = {
      toolTokens: options.toolTokens ?? 400,
      responseTokens: options.responseTokens ?? 0,
      responseItemTokens: options.responseItemTokens ?? 0,
      charsPerToken: 4,
      estimator: "o200k_base",
      seed: 7,
    };
  }
  return loadAirDocument({
    service: {
      id: "orders",
      displayName: "Orders",
      version: "2026-08-01",
      source: { kind: "openapi", uri: "./orders.openapi.yaml" },
    },
    operations: [operation as unknown as Operation],
  });
}

function codesFor(air: AirDocument): string[] {
  return runDetectors(air).map((d) => d.code);
}

function finding(air: AirDocument, code: string) {
  return runDetectors(air).find((d) => d.code === code);
}

describe("schema_too_large_for_disclosure", () => {
  it("is a real constraint on readiness, not an informational aside", () => {
    const def = DEFICIENCY_CATALOG.schema_too_large_for_disclosure;
    expect(def.defaultSeverity).toBe("medium");
    expect(def.readinessDisposition).toBe("refinementRequired");
  });

  it("fires on the measured tool surface, not on a property count", () => {
    const air = doc({ toolTokens: DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS + 800 });
    const d = finding(air, "schema_too_large_for_disclosure");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("medium");
    // Quantitative and arguable: what it cost, what it was allowed to cost.
    expect(d?.message).toContain(String(DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS + 800));
    expect(d?.message).toContain(String(DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS));
    expect(d?.facts.toolTokens).toBe(DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS + 800);
    expect(d?.facts.budgetTokens).toBe(DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS);
    expect(d?.facts.overBudgetTokens).toBe(800);
    expect(d?.facts.estimator).toBe("o200k_base");
  });

  it("does not fire at or under the budget", () => {
    const air = doc({ toolTokens: DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS });
    expect(codesFor(air)).not.toContain("schema_too_large_for_disclosure");
  });
});

describe("unpaginated_large_response", () => {
  it("is catalogued as an actionable usability constraint", () => {
    const def = DEFICIENCY_CATALOG.unpaginated_large_response;
    expect(def.category).toBe("usability");
    expect(def.defaultSeverity).toBe("medium");
    expect(def.readinessDisposition).toBe("refinementRequired");
    expect(def.agentImpact).toContain("no way to ask for less");
  });

  it("names the measured cost and the budget it exceeded", () => {
    const air = doc({ responseTokens: 18_400 });
    const d = finding(air, "unpaginated_large_response");
    expect(d).toBeDefined();
    // The whole point: a ticket an API owner can act on, not "be agent-friendly".
    expect(d?.message).toContain("orders.search");
    expect(d?.message).toContain("18400");
    expect(d?.message).toContain(String(DEFAULT_RESPONSE_BUDGET_TOKENS));
    expect(d?.facts.responseTokens).toBe(18_400);
    expect(d?.facts.budgetTokens).toBe(DEFAULT_RESPONSE_BUDGET_TOKENS);
    expect(d?.facts.overBudgetTokens).toBe(18_400 - DEFAULT_RESPONSE_BUDGET_TOKENS);
    expect(d?.facts.hasPageSizeParam).toBe(false);
    // A response figure is a prediction about data; the seed keeps it reproducible.
    expect(d?.facts.seed).toBe(7);
  });

  it("stays quiet when a page-size parameter exists — the agent can ask for less", () => {
    const air = doc({
      responseTokens: 18_400,
      responseItemTokens: 200,
      pagination: { style: "cursor", cursorParam: "cursor", pageSizeParam: "limit" },
    });
    expect(codesFor(air)).not.toContain("unpaginated_large_response");
  });

  it("still fires when pagination exists but only controls continuation", () => {
    // A cursor moves through pages; it does not make any one page smaller. With
    // no size knob the first page is whatever the upstream decides to send.
    const air = doc({
      responseTokens: 18_400,
      pagination: { style: "cursor", cursorParam: "cursor", nextField: "next" },
    });
    const d = finding(air, "unpaginated_large_response");
    expect(d).toBeDefined();
    expect(d?.facts.paginationStyle).toBe("cursor");
  });

  it("does not fire at or under the response budget", () => {
    const air = doc({ responseTokens: DEFAULT_RESPONSE_BUDGET_TOKENS });
    expect(codesFor(air)).not.toContain("unpaginated_large_response");
  });

  it("does not fire on a paginated-but-uncapped operation by itself", () => {
    // A `pageSizeParam` with no `maxPageSize` is deliberately not a finding: AIR
    // cannot distinguish "the upstream states no cap" from "the spec never said",
    // and the agent can still ask for less either way.
    const air = doc({
      responseTokens: 18_400,
      responseItemTokens: 200,
      pagination: { style: "page", pageSizeParam: "per_page" },
    });
    expect(codesFor(air)).not.toContain("unpaginated_large_response");
  });
});

describe("unmeasured operations", () => {
  it("fire neither disclosure detector", () => {
    // A bundle compiled before disclosure measurement existed must not sprout
    // findings the moment these detectors ship. Absence of a measurement is not
    // evidence of a problem — it is the absence of evidence.
    const air = doc({ measured: false });
    const codes = codesFor(air);
    expect(codes).not.toContain("schema_too_large_for_disclosure");
    expect(codes).not.toContain("unpaginated_large_response");
    expect(air.operations[0]?.disclosureCost).toBeUndefined();
  });

  it("stay silent even with a surface that the old property-count proxy would flag", () => {
    const params = Array.from({ length: 40 }, (_, i) => ({
      name: `filter_${i}`,
      in: "query",
      required: false,
      description: `Filter ${i}.`,
      example: "x",
      schema: { type: "string" },
    }));
    const air = doc({ measured: false });
    const wide = loadAirDocument({
      service: air.service,
      operations: [
        {
          ...air.operations[0],
          input: { params },
        } as unknown as Operation,
      ],
    });
    expect(codesFor(wide)).not.toContain("schema_too_large_for_disclosure");
  });

  it("measured only at the tool surface raises no response finding", () => {
    // `responseTokens: 0` means "not measured", never "free".
    const air = doc({ toolTokens: 300, responseTokens: 0 });
    expect(codesFor(air)).not.toContain("unpaginated_large_response");
  });
});
