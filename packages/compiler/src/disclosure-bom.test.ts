import type { AirDocument } from "@anvil/air";
import { DEFAULT_RESPONSE_BUDGET_TOKENS, DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";
import {
  disclosureBom,
  group,
  percent,
  responseProjectionsFromSimulationReport,
} from "./disclosure-bom.js";
import { countTokens, TOKEN_ESTIMATOR_ID, toolSurfaceJson } from "./disclosure-cost.js";

/**
 * One cheap read, one deliberately pathological search whose cost lives almost
 * entirely in a single query parameter, and one irreversible mutation. The
 * pathological one is the case the whole module exists for: a big surface whose
 * blame belongs to one nameable field.
 */
const FAT_ENUM = Array.from({ length: 400 }, (_, i) => `market_segment_${i}`);
const SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "orders", version: "1.0.0" },
  paths: {
    "/orders": {
      get: {
        operationId: "listOrders",
        summary: "List orders",
        tags: ["orders"],
        parameters: [
          { name: "cursor", in: "query", schema: { type: "string" } },
          { name: "per_page", in: "query", schema: { type: "integer" } },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
    "/orders/search": {
      get: {
        operationId: "searchOrders",
        summary: "Search orders",
        tags: ["orders"],
        parameters: [
          {
            name: "segments",
            in: "query",
            description: "Restrict the search to these market segments.",
            schema: { type: "string", enum: FAT_ENUM },
          },
          { name: "q", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
    "/orders/{id}": {
      delete: {
        operationId: "deleteOrder",
        summary: "Delete an order",
        tags: ["orders"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "204": { description: "gone" } },
      },
    },
  },
});

async function air(): Promise<AirDocument> {
  return await compile({ spec: SPEC, serviceId: "orders" });
}

function row(bom: ReturnType<typeof disclosureBom>, fragment: string) {
  const found = bom.operations.find((candidate) => candidate.operationId.includes(fragment));
  if (!found) throw new Error(`no operation matching '${fragment}'`);
  return found;
}

describe("ranking", () => {
  it("ranks operations by measured tool tokens, most expensive first", async () => {
    const bom = disclosureBom(await air());
    const tokens = bom.operations.map((operation) => operation.toolTokens);
    expect(tokens).toEqual([...tokens].sort((a, b) => b - a));
    // The pathological operation is the expensive one; that is the fixture's job.
    expect(bom.operations[0]?.operationId).toContain("search");
  });

  it("is deterministic — same document, same bill of materials", async () => {
    const document = await air();
    expect(JSON.stringify(disclosureBom(document))).toBe(JSON.stringify(disclosureBom(document)));
  });
});

describe("attribution", () => {
  it("blames the one field responsible rather than reporting only a total", async () => {
    const bom = disclosureBom(await air());
    const search = row(bom, "search");
    const top = search.contributors[0];
    expect(top?.kind).toBe("input_property");
    expect(top?.label).toBe("segments");
    // Naming the field is only half of it — the note is what lets a reader agree
    // with the number without opening the spec.
    expect(top?.note).toContain("enum with 400 values");
    expect(top?.share).toBeGreaterThan(0.5);
  });

  it("reconciles exactly: contributors + envelope === the measured total", async () => {
    const bom = disclosureBom(await air());
    for (const operation of bom.operations) {
      const attributed = operation.contributors.reduce((sum, part) => sum + part.tokens, 0);
      expect(attributed + operation.envelopeTokens, operation.operationId).toBe(
        operation.toolTokens,
      );
    }
  });

  it("attributes over the same bytes measureToolSurface counts, not a re-model", async () => {
    const document = await air();
    const bom = disclosureBom(document);
    for (const operation of document.operations) {
      const measured = countTokens(toolSurfaceJson(operation));
      expect(row(bom, operation.id).toolTokens).toBe(measured);
    }
  });

  it("decomposes the surface into the seams an owner can act on", async () => {
    const bom = disclosureBom(await air());
    const kinds = new Set(row(bom, "search").contributors.map((part) => part.kind));
    expect(kinds).toContain("description");
    expect(kinds).toContain("input_property");
    expect(kinds).toContain("safety_meta");
    expect(kinds).toContain("annotations");
  });

  it("counts the reserved dry-run control the runtime publishes", async () => {
    const bom = disclosureBom(await air());
    // It is real context the agent holds; omitting it would under-report by a
    // constant and make the shares add to less than the measured whole.
    const labels = row(bom, "delete").contributors.map((part) => part.label);
    expect(labels).toContain("anvil_dry_run");
  });
});

describe("rollups", () => {
  it("rolls up per capability with shares that account for the whole document", async () => {
    const bom = disclosureBom(await air());
    const summed = bom.capabilities.reduce((sum, entry) => sum + entry.toolTokens, 0);
    expect(summed).toBe(bom.service.toolTokens);
    expect(bom.capabilities[0]?.topOperationId).toBe(bom.operations[0]?.operationId);
  });

  it("rolls up per service and separates served cost from total cost", async () => {
    const document = await air();
    const bom = disclosureBom(document);
    expect(bom.service.serviceId).toBe("orders");
    expect(bom.service.operations).toBe(document.operations.length);
    // Nothing is approved out of the box, so no cost is served yet — and the
    // report must not present the whole surface as if it already were.
    expect(bom.service.servedOperations).toBe(0);
    expect(bom.service.servedToolTokens).toBe(0);
    expect(bom.service.toolTokens).toBeGreaterThan(0);
  });

  it("carries the ladder verdict, including what laddering did not solve", async () => {
    const bom = disclosureBom(await air());
    expect(bom.ladder.mode).toBe("flat");
    // Served flat, so rest === flat and there is no saving to advertise.
    expect(bom.ladder.savedTokens).toBe(0);
    expect(bom.ladder.restTokens).toBe(bom.ladder.flatTokens);
    expect(bom.ladder.remainingOverBudgetTokens).toBe(0);
  });

  it("keeps capability-less operations in the ranking instead of dropping them", async () => {
    const document = await air();
    const stripped: AirDocument = {
      ...document,
      operations: document.operations.map((operation) => ({
        ...operation,
        capabilityId: undefined,
      })),
    };
    const bom = disclosureBom(stripped);
    expect(bom.capabilities).toHaveLength(1);
    expect(bom.capabilities[0]?.capabilityId).toBeNull();
    expect(bom.capabilities[0]?.toolTokens).toBe(bom.service.toolTokens);
  });
});

describe("findings", () => {
  it("raises the over-budget tool surface as a measured fact naming the field", async () => {
    const bom = disclosureBom(await air());
    const finding = bom.findings.find((f) => f.kind === "tool_surface_over_budget");
    expect(finding?.operationId).toContain("search");
    expect(finding?.basis).toBe("measured");
    expect(finding?.budgetTokens).toBe(DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS);
    expect(finding?.detail).toContain("'segments'");
    expect(finding?.detail).toContain("enum with 400 values");
    expect(finding?.seed).toBeUndefined();
  });

  it("raises a large unpaginated response as a projection, carrying its seed", async () => {
    const document = await air();
    const measured: AirDocument = {
      ...document,
      operations: document.operations.map((operation) => {
        const cost = operation.disclosureCost;
        if (cost === undefined || !operation.id.includes("search")) return operation;
        return {
          ...operation,
          disclosureCost: {
            ...cost,
            responseTokens: DEFAULT_RESPONSE_BUDGET_TOKENS + 12_000,
            responseItemTokens: 40,
            seed: 7,
          },
        };
      }),
    };
    const finding = disclosureBom(measured).findings.find(
      (f) => f.kind === "unpaginated_large_response",
    );
    expect(finding?.basis).toBe("projected");
    expect(finding?.seed).toBe(7);
    expect(finding?.overBudgetTokens).toBe(12_000);
    expect(finding?.detail).toContain("no page-size parameter");
  });

  it("stays silent about a large response the caller can actually shrink", async () => {
    const document = await air();
    // listOrders declares per_page, so an agent can ask for less — over-budget on
    // a full page is a page-size choice, not a contract deficiency.
    const measured: AirDocument = {
      ...document,
      operations: document.operations.map((operation) => {
        const cost = operation.disclosureCost;
        if (cost === undefined || !operation.id.includes("list")) return operation;
        return {
          ...operation,
          pagination: {
            style: "cursor" as const,
            cursorParam: "cursor",
            pageSizeParam: "per_page",
          },
          disclosureCost: { ...cost, responseTokens: 90_000, responseItemTokens: 40, seed: 1 },
        };
      }),
    };
    const bom = disclosureBom(measured);
    expect(bom.findings.filter((f) => f.kind === "unpaginated_large_response")).toHaveLength(0);
    expect(row(bom, "list").response.hasPageSizeParam).toBe(true);
  });

  it("flags a recorded figure that no longer describes the published surface", async () => {
    const document = await air();
    const drifted: AirDocument = {
      ...document,
      operations: document.operations.map((operation) => {
        const cost = operation.disclosureCost;
        if (cost === undefined || !operation.id.includes("delete")) return operation;
        return { ...operation, disclosureCost: { ...cost, toolTokens: cost.toolTokens + 500 } };
      }),
    };
    const finding = disclosureBom(drifted).findings.find((f) => f.kind === "stale_measurement");
    expect(finding?.operationId).toContain("delete");
    expect(finding?.overBudgetTokens).toBe(500);
    expect(row(disclosureBom(drifted), "delete").toolTokensBasis).toBe("recorded");
  });
});

describe("measured facts vs projected predictions", () => {
  it("omits response figures rather than zeroing them when nothing was measured", async () => {
    const bom = disclosureBom(await air());
    expect(bom.measurement.projectedOperations).toBe(0);
    expect(bom.measurement.seeds).toEqual([]);
    for (const operation of bom.operations) {
      expect(operation.response.projected).toBe(false);
      // A zero here would render as "free", which is the opposite of "unknown".
      expect(operation.response.responseTokens).toBeUndefined();
      expect(operation.response.responseItemTokens).toBeUndefined();
      expect(operation.response.overBudgetTokens).toBe(0);
    }
  });

  it("derives the tool half even for a document that was never measured", async () => {
    const document = await air();
    const unmeasured: AirDocument = {
      ...document,
      operations: document.operations.map((operation) => ({
        ...operation,
        disclosureCost: undefined,
      })),
    };
    const bom = disclosureBom(unmeasured);
    expect(bom.measurement.recordedOperations).toBe(0);
    // The tool surface is a pure function of the contract, so absence of a
    // recorded figure is not absence of a knowable one — but the provenance says
    // where it came from, and no stale-measurement finding is invented.
    for (const operation of bom.operations) {
      expect(operation.toolTokens).toBeGreaterThan(0);
      expect(operation.toolTokensBasis).toBe("derived");
    }
    expect(bom.findings.filter((f) => f.kind === "stale_measurement")).toHaveLength(0);
  });

  it("stamps the estimator on the bill, so the figures carry a unit", async () => {
    const bom = disclosureBom(await air());
    expect(bom.estimator).toBe(TOKEN_ESTIMATOR_ID);
    expect(bom.measurement.recordedEstimators).toEqual([TOKEN_ESTIMATOR_ID]);
  });
});

/**
 * The shape `anvil simulate` writes, reduced to the parts this module reads. A
 * hand-written fixture rather than a live simulator run: the contract under test
 * is "what does the BOM do with a report that says X", and driving the simulator
 * to produce X would make the test depend on the simulator's fixtures for a
 * question that has nothing to do with them.
 */
function simulationReport(cells: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
  return { schemaVersion: 1, bundleHash: "0".repeat(64), coverage: { seed: 5, cells } };
}

function responseCell(
  operationId: string,
  tokens: number,
  figure: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    operationId,
    dimension: "disclosure",
    variant: "response-page",
    basis: "simulated-data",
    ok: true,
    figure: {
      tokens,
      budgetTokens: DEFAULT_RESPONSE_BUDGET_TOKENS,
      estimator: "o200k_base",
      seed: 5,
      ...figure,
    },
  };
}

describe("projections supplied from a simulation report", () => {
  it("takes response figures the contract never carried, and says where they came from", async () => {
    const document = await air();
    const search = document.operations.find((operation) => operation.id.includes("search"));
    const bom = disclosureBom(document, {
      responseProjections: responseProjectionsFromSimulationReport(
        simulationReport([responseCell(search?.id ?? "", 41_000)]),
      ),
    });
    const row = bom.operations.find((candidate) => candidate.operationId === search?.id);
    expect(row?.response.projected).toBe(true);
    expect(row?.response.responseTokens).toBe(41_000);
    expect(row?.response.seed).toBe(5);
    expect(row?.response.source).toBe("simulation-report");
    // A report publishes the served page, not the item behind it. Dividing one
    // out would put an invented figure beside measured ones.
    expect(row?.response.responseItemTokens).toBeUndefined();
    expect(bom.measurement.projectedOperations).toBe(1);
    expect(bom.measurement.seeds).toEqual([5]);
    expect(bom.measurement.projectionSources).toEqual(["simulation-report"]);
    expect(bom.measurement.projectedEstimators).toEqual([TOKEN_ESTIMATOR_ID]);
  });

  it("raises the same deficiency from a supplied projection as from a recorded one", async () => {
    const document = await air();
    const search = document.operations.find((operation) => operation.id.includes("search"));
    const finding = disclosureBom(document, {
      responseProjections: responseProjectionsFromSimulationReport(
        simulationReport([responseCell(search?.id ?? "", DEFAULT_RESPONSE_BUDGET_TOKENS + 12_000)]),
      ),
    }).findings.find((f) => f.kind === "unpaginated_large_response");
    // Where the projection was read from must not change what it means: the
    // finding stays projected, carries its seed, and never becomes measured.
    expect(finding?.basis).toBe("projected");
    expect(finding?.seed).toBe(5);
    expect(finding?.overBudgetTokens).toBe(12_000);
  });

  it("prefers the bundle's own recorded figure over an external report", async () => {
    const document = await air();
    const search = document.operations.find((operation) => operation.id.includes("search"));
    const recorded: AirDocument = {
      ...document,
      operations: document.operations.map((operation) => {
        const cost = operation.disclosureCost;
        if (cost === undefined || operation.id !== search?.id) return operation;
        return { ...operation, disclosureCost: { ...cost, responseTokens: 900, seed: 1 } };
      }),
    };
    const bom = disclosureBom(recorded, {
      responseProjections: responseProjectionsFromSimulationReport(
        simulationReport([responseCell(search?.id ?? "", 41_000)]),
      ),
    });
    const row = bom.operations.find((candidate) => candidate.operationId === search?.id);
    // AIR is what the served surface was shaped by; a report that disagrees does
    // not get to describe a page the runtime does not serve.
    expect(row?.response.responseTokens).toBe(900);
    expect(row?.response.source).toBe("recorded");
    expect(bom.measurement.projectionSources).toEqual(["recorded"]);
  });

  it("keeps figures counted under another tokenizer visible as a different unit", async () => {
    const document = await air();
    const search = document.operations.find((operation) => operation.id.includes("search"));
    const bom = disclosureBom(document, {
      responseProjections: responseProjectionsFromSimulationReport(
        simulationReport([responseCell(search?.id ?? "", 41_000, { estimator: "cl100k_base" })]),
      ),
    });
    // Reported rather than silently discarded or silently mixed: a renderer can
    // then refuse to compare it with the tool figures counted under o200k_base.
    expect(bom.measurement.projectedEstimators).toEqual(["cl100k_base"]);
    expect(bom.estimator).toBe(TOKEN_ESTIMATOR_ID);
  });

  it("drops cells it cannot fully vouch for rather than coercing them", () => {
    const projections = responseProjectionsFromSimulationReport(
      simulationReport([
        responseCell("orders.a", 100),
        // The tool-surface sibling: real tokens, wrong question. The tool half is
        // re-derived from the published bytes, so importing an older copy would
        // give one number two answers.
        {
          operationId: "orders.a",
          dimension: "disclosure",
          variant: "tool-surface",
          figure: { tokens: 191, budgetTokens: 1200, estimator: "o200k_base" },
        },
        // A number without a unit, an empty page reported as cheap, and a cell
        // from another dimension entirely.
        responseCell("orders.b", 100, { estimator: undefined }),
        responseCell("orders.c", 0),
        { operationId: "orders.d", dimension: "auth", variant: "missing-scope" },
      ]),
    );
    expect(projections.map((projection) => projection.operationId)).toEqual(["orders.a"]);
    expect(projections[0]?.responseTokens).toBe(100);
  });

  it("returns nothing for a report it cannot read, instead of throwing at a reader", () => {
    expect(responseProjectionsFromSimulationReport(undefined)).toEqual([]);
    expect(responseProjectionsFromSimulationReport("not a report")).toEqual([]);
    expect(responseProjectionsFromSimulationReport({ coverage: { cells: "nope" } })).toEqual([]);
  });

  it("is a function of the report's content, not of the order it listed cells in", () => {
    const cells = [responseCell("orders.z", 10), responseCell("orders.a", 20)];
    expect(responseProjectionsFromSimulationReport(simulationReport(cells))).toEqual(
      responseProjectionsFromSimulationReport(simulationReport([...cells].reverse())),
    );
  });
});

describe("reach", () => {
  it("carries tokens-to-reach on the bill, with the round trips it costs", async () => {
    const document = await air();
    const approved: AirDocument = {
      ...document,
      operations: document.operations.map((operation) => ({
        ...operation,
        state: "approved" as const,
      })),
    };
    const bom = disclosureBom(approved);
    expect(bom.reach.operations).toBe(approved.operations.length);
    expect(bom.reach.measured).toBe(approved.operations.length);
    // The trade is never reported half-way: a token figure without its round
    // trips is the saving with the cost edited out.
    expect(bom.reach.hops).toEqual({ min: 1, max: 1 });
    expect(bom.reach.flatBaseline).toBe(bom.ladder.flatTokens);
    expect(bom.reach.improvementRatio).toBe(1);
  });

  it("takes reach over the same plan the ladder verdict was taken over", async () => {
    const document = await air();
    const approved: AirDocument = {
      ...document,
      operations: document.operations.map((operation) => ({
        ...operation,
        state: "approved" as const,
      })),
    };
    // A surface budget low enough to force the ladder, threaded into both — if
    // reach re-projected its own plan the two halves of one report could
    // describe two different serving shapes.
    const bom = disclosureBom(approved, { surfaceBudgetTokens: 200 });
    expect(bom.ladder.mode).toBe("laddered");
    expect(bom.reach.mode).toBe("laddered");
    expect(bom.reach.reason).toBe(bom.ladder.reason);
    // Laddered means a second round trip, and the profile says so rather than
    // reporting only the tokens the lane saved.
    expect(bom.reach.hops.max).toBe(2);
    expect(bom.reach.flatBaseline).toBe(bom.ladder.flatTokens);
  });

  it("reports no reach figure for a surface with nothing approved", async () => {
    const bom = disclosureBom(await air());
    expect(bom.reach.operations).toBe(0);
    // A confident zero here would read as a free surface.
    expect(bom.reach.median).toBeUndefined();
    expect(bom.reach.improvementRatio).toBeUndefined();
  });
});

describe("number formatting", () => {
  it("groups thousands without depending on the host's ICU data", () => {
    expect(group(0)).toBe("0");
    expect(group(999)).toBe("999");
    expect(group(1000)).toBe("1,000");
    expect(group(41_237)).toBe("41,237");
    expect(group(-1234)).toBe("-1,234");
    expect(percent(0.6712)).toBe("67%");
  });
});
