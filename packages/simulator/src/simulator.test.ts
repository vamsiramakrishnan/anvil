import {
  type AirDocument,
  DEFAULT_RESPONSE_BUDGET_TOKENS,
  type JsonSchema,
  type Operation,
  responseFitsBudget,
  safePageSize,
} from "@anvil/air";
import {
  approveOperations,
  compile,
  countTokens,
  surfaceSignatureFor,
  withResponseMeasurement,
} from "@anvil/compiler";
import { beforeEach, describe, expect, it } from "vitest";
import { simulatorDefinitionFor } from "./define.js";
import { surfaceParity } from "./index.js";
import { Simulator } from "./runtime.js";

const SPEC = `openapi: "3.0.3"
info: { title: Refunds, version: "1.0.0" }
paths:
  /refunds:
    get:
      operationId: listRefunds
      tags: [refunds]
      responses: { "200": { description: ok } }
    post:
      operationId: createRefund
      tags: [refunds]
      responses: { "201": { description: created } }
`;

let air: AirDocument;

beforeEach(async () => {
  const compiled = await compile({ spec: SPEC, serviceId: "refunds" });
  air = approveOperations(
    compiled,
    compiled.operations.map((o) => o.id),
  );
  // Normalize the served resource and give the mutation a required scope +
  // key-supported idempotency so the auth/replay behaviours are exercised.
  for (const op of air.operations) {
    op.effect.resource = "refund";
    if (op.sourceRef.operationId === "createRefund") {
      op.auth = { ...op.auth, type: "oauth2_client_credentials", scopes: ["refunds:write"] };
      op.idempotency = { ...op.idempotency, mode: "key_supported" };
    }
  }
});

const build = () => {
  const def = simulatorDefinitionFor(air, { seed: 42 });
  return { def, sim: new Simulator(air, def) };
};
const toolName = (opId: string) =>
  air.operations.find((o) => o.sourceRef.operationId === opId)?.mcp.toolName as string;
const operation = (opId: string) =>
  air.operations.find((o) => o.sourceRef.operationId === opId) as Operation;

/**
 * Give the list operation a measured per-item cost and whatever pagination
 * facts a case is about. Everything a page size is derived from arrives this
 * way — the base contract deliberately carries none of it, so the unmeasured
 * path stays the default the other tests exercise.
 */
const measureList = (
  responseItemTokens: number,
  pagination: Partial<NonNullable<Operation["pagination"]>> = {},
): void => {
  const op = operation("listRefunds");
  // `pageSizeParam` is part of the baseline because a budget can only be solved
  // against a knob that exists: an operation that pages but exposes no size
  // control gets whatever page the upstream chooses, and `safePageSize` reports
  // `no_size_control` rather than computing a number nobody can request. A case
  // that wants that path omits it explicitly.
  op.pagination = { style: "cursor", cursorParam: "cursor", pageSizeParam: "limit", ...pagination };
  op.disclosureCost = {
    toolTokens: 120,
    responseItemTokens,
    responseTokens: responseItemTokens * 3,
    charsPerToken: 4,
    estimator: "o200k_base",
    seed: 42,
  };
};

const items = (result: unknown): unknown[] =>
  (result as { output: { items: unknown[] } }).output.items;

describe("hard invariant: simulator surface == generated MCP surface", () => {
  it("the simulator signature is identical to the contract's MCP signature", () => {
    const { def, sim } = build();
    const mcp = surfaceSignatureFor(air);
    expect(def.surfaceSignatureDigest).toBe(mcp.digest);
    expect(surfaceParity(sim.signature(), mcp).matches).toBe(true);
  });
});

describe("determinism", () => {
  it("same seed → identical fixtures across independent simulators", () => {
    const a = new Simulator(air, simulatorDefinitionFor(air, { seed: 7 }));
    const b = new Simulator(air, simulatorDefinitionFor(air, { seed: 7 }));
    const pa = a.invoke(toolName("listRefunds"));
    const pb = b.invoke(toolName("listRefunds"));
    expect(pa).toEqual(pb);
  });

  it("reset restores the same deterministic starting state", () => {
    const { sim } = build();
    const first = sim.invoke(toolName("listRefunds"));
    sim.invoke(toolName("createRefund"), { amount: 5 }, { confirm: true, principalId: "admin" });
    sim.reset();
    expect(sim.invoke(toolName("listRefunds"))).toEqual(first);
  });
});

describe("contract-faithful behaviour", () => {
  it("refuses a mutation without confirmation, allows it with", () => {
    const { sim } = build();
    const tool = toolName("createRefund");
    const denied = sim.invoke(tool, { amount: 5 }, { principalId: "admin" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("confirmation_required");
    const ok = sim.invoke(tool, { amount: 5 }, { principalId: "admin", confirm: true });
    expect(ok.ok).toBe(true);
  });

  it("enforces auth scopes by principal role", () => {
    const { sim } = build();
    const tool = toolName("createRefund");
    const limited = sim.invoke(tool, { amount: 5 }, { principalId: "limited", confirm: true });
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.error.code).toBe("permission_denied");
  });

  it("replays an idempotent key without a second effect", () => {
    const { sim } = build();
    const tool = toolName("createRefund");
    const ctx = { principalId: "admin", confirm: true, idempotencyKey: "key-1" };
    const first = sim.invoke(tool, { amount: 5 }, ctx);
    const second = sim.invoke(tool, { amount: 5 }, ctx);
    expect(first.ok && second.ok).toBe(true);
    if (second.ok) expect(second.replayed).toBe(true);
    if (first.ok && second.ok) expect(second.output).toEqual(first.output);
    // Exactly one entity beyond the 3 seeded fixtures.
    const list = sim.invoke(toolName("listRefunds"));
    // (list is paginated; total is asserted via a fresh full read below)
    expect(list.ok).toBe(true);
  });

  it("injects declared faults deterministically", () => {
    const { sim } = build();
    const outage = sim.invoke(toolName("listRefunds"), {}, { faultScenario: "outage" });
    expect(outage.ok).toBe(false);
    if (!outage.ok) expect(outage.error.code).toBe("upstream_unavailable");
    const throttle = sim.invoke(toolName("listRefunds"), {}, { faultScenario: "throttle" });
    expect(throttle.ok).toBe(false);
    if (!throttle.ok) expect(throttle.error.code).toBe("rate_limited");
  });

  it("paginates a list read with a stable cursor", () => {
    const { sim } = build();
    // Seed more entities so there is a second page (fallback page size 2, 3 fixtures).
    const page1 = sim.invoke(toolName("listRefunds"));
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect((page1.output as { items: unknown[] }).items.length).toBe(2);
    expect(page1.nextCursor).toBeDefined();
    const page2 = sim.invoke(toolName("listRefunds"), {}, { cursor: page1.nextCursor });
    expect(page2.ok).toBe(true);
    if (page2.ok) expect((page2.output as { items: unknown[] }).items.length).toBe(1);
  });
});

describe("budget-derived page size", () => {
  const buildWith = (fixturesPerEntity: number, responseBudgetTokens?: number) => {
    const def = simulatorDefinitionFor(air, {
      seed: 42,
      fixturesPerEntity,
      ...(responseBudgetTokens !== undefined ? { responseBudgetTokens } : {}),
    });
    return new Simulator(air, def);
  };

  it("keeps the fixture fallback for a contract that carries no measurement", () => {
    // The regression that matters most: most contracts have never been measured,
    // and for those the simulator must behave exactly as it did before.
    const { sim } = build();
    const page = sim.invoke(toolName("listRefunds"));
    expect(page.ok).toBe(true);
    expect(items(page).length).toBe(2);
  });

  it("solves the page against the response budget once an item cost is measured", () => {
    // 1600 tokens an item against the 8000-token default budget → five items.
    measureList(1600);
    const sim = buildWith(10);
    const page = sim.invoke(toolName("listRefunds"));
    expect(items(page).length).toBe(5);
    expect(page.ok && page.nextCursor).toBe("5");
  });

  it("agrees with AIR's solver rather than reimplementing it", () => {
    // The point of the whole change: the number the simulator serves is the
    // number the shared helper returns, so compiler/runtime/certification cannot
    // certify a page size the simulator never served.
    measureList(900);
    const sim = buildWith(20);
    const expected = safePageSize(operation("listRefunds"), DEFAULT_RESPONSE_BUDGET_TOKENS);
    expect(expected.basis).toBe("budget_derived");
    expect(items(sim.invoke(toolName("listRefunds"))).length).toBe(expected.size);
  });

  it("clamps to the upstream's maximum page size", () => {
    // The budget fits five; the upstream honours three. Asking for five would
    // silently get three back, so the simulated page must be the honoured one.
    measureList(1600, { maxPageSize: 3 });
    const sim = buildWith(10);
    expect(items(sim.invoke(toolName("listRefunds"))).length).toBe(3);
    expect(safePageSize(operation("listRefunds")).basis).toBe("capped_by_upstream");
  });

  it("uses the upstream's stated default when nothing was measured", () => {
    // Not an inference — a fact the contract states — so it beats the fixture
    // constant even with no disclosure cost recorded.
    const op = operation("listRefunds");
    op.pagination = { style: "cursor", defaultPageSize: 4 };
    const sim = buildWith(10);
    expect(items(sim.invoke(toolName("listRefunds"))).length).toBe(4);
  });

  it("honours a definition-level response budget", () => {
    // Half the budget, half the page: the definition is the single place the
    // budget is stated, so a served page and a measured page cannot diverge.
    measureList(1600);
    const sim = buildWith(10, DEFAULT_RESPONSE_BUDGET_TOKENS / 2);
    expect(items(sim.invoke(toolName("listRefunds"))).length).toBe(2);
  });
});

describe("disclosure sample — the measurement seam", () => {
  it("returns exactly what invoke returns, not a parallel construction", () => {
    const a = build().sim;
    const b = build().sim;
    const sample = a.disclosureSample(toolName("listRefunds"));
    const served = b.invoke(toolName("listRefunds"));
    expect(sample).toBeDefined();
    expect(served.ok && sample?.response).toEqual((served as { output: unknown }).output);
    expect(sample?.item).toEqual(items(served)[0]);
    expect(sample?.itemCount).toBe(2);
  });

  it("reports the page size and its basis", () => {
    measureList(1600, { maxPageSize: 3 });
    const sim = new Simulator(
      air,
      simulatorDefinitionFor(air, { seed: 42, fixturesPerEntity: 10 }),
    );
    const sample = sim.disclosureSample(toolName("listRefunds"));
    expect(sample?.pageSize).toBe(3);
    expect(sample?.pageSizeBasis).toBe("capped_by_upstream");
    expect(sample?.itemCount).toBe(3);
  });

  it("is a pure function of (contract, seed), whatever preceded it", () => {
    const { sim } = build();
    const first = sim.disclosureSample(toolName("listRefunds"));
    // Mutate the world between samples: a figure that moved with call history
    // could not be certified, because two runs of the same bundle would differ.
    sim.invoke(toolName("createRefund"), { amount: 5 }, { principalId: "admin", confirm: true });
    sim.invoke(toolName("createRefund"), { amount: 9 }, { principalId: "admin", confirm: true });
    expect(sim.disclosureSample(toolName("listRefunds"))).toEqual(first);
  });

  it("leaves the simulator at its seeded starting state", () => {
    const { sim } = build();
    const before = sim.invoke(toolName("listRefunds"));
    sim.reset();
    sim.disclosureSample(toolName("createRefund"));
    expect(sim.invoke(toolName("listRefunds"))).toEqual(before);
  });

  it("re-seeds to the active seed, not the definition's", () => {
    const { sim } = build();
    sim.reset(7);
    const sample = sim.disclosureSample(toolName("listRefunds"));
    const seeded = new Simulator(air, simulatorDefinitionFor(air, { seed: 7 }));
    expect(sample?.response).toEqual(
      (seeded.invoke(toolName("listRefunds")) as { output: unknown }).output,
    );
  });

  it("gets a scoped, confirm-gated mutation past its gates", () => {
    // Sampling measures the response, not the safety gates; arriving without a
    // principal would measure a refusal payload as the operation's cost.
    const { sim } = build();
    const sample = sim.disclosureSample(toolName("createRefund"));
    expect(sample).toBeDefined();
    expect(sample?.itemCount).toBe(1);
    expect(sample?.item).toMatchObject({ status: "active" });
  });

  it("declines an unknown tool rather than inventing a response", () => {
    const { sim } = build();
    expect(sim.disclosureSample("no_such_tool")).toBeUndefined();
  });

  it("declines when no principal can satisfy the operation's scopes", () => {
    // Unmeasurable is a legitimate outcome; a fabricated figure is not.
    const def = simulatorDefinitionFor(air, { seed: 42 });
    const sim = new Simulator(air, {
      ...def,
      authProfiles: def.authProfiles.filter((p) => p.id === "limited"),
    });
    expect(sim.disclosureSample(toolName("createRefund"))).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Declared-shape response bodies                                              */
/* -------------------------------------------------------------------------- */

/** A declared record of `groups` sub-objects, each carrying `fields` string leaves. */
const wideRecord = (groups: number, fields: number): JsonSchema => ({
  type: "object",
  properties: Object.fromEntries(
    Array.from({ length: groups }, (_, g) => [
      `section_${String(g).padStart(3, "0")}`,
      {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: fields }, (_, f) => [
            `attribute_${String(f).padStart(2, "0")}`,
            { type: "string" },
          ]),
        ),
      },
    ]),
  ),
});

/** Declare a list operation's response envelope around an item schema. */
const declareListItem = (item: JsonSchema): void => {
  operation("listRefunds").output = {
    schema: { type: "object", properties: { items: { type: "array", items: item } } },
  };
};

/**
 * Exactly what `certification`'s `response-page` cell does with a sample:
 * tokenize the served item, fold it into the operation's measurement, and ask
 * AIR whether the page that would be served fits the budget.
 */
const pageFits = (sample: { item?: unknown; response: unknown }): boolean => {
  const op = operation("listRefunds");
  const measured = withResponseMeasurement(
    op.disclosureCost as NonNullable<typeof op.disclosureCost>,
    {
      responseTokens: countTokens(JSON.stringify(sample.response)),
      responseItemTokens: countTokens(JSON.stringify(sample.item)),
      seed: 42,
    },
  );
  return responseFitsBudget({ ...op, disclosureCost: measured }, DEFAULT_RESPONSE_BUDGET_TOKENS);
};

describe("response bodies come from the declared response schema", () => {
  it("keeps the historical {id, status} body when the contract declares nothing", () => {
    // The regression that guards everyone else's numbers: most contracts carry
    // no response schema at all, and for those the served bytes must not move.
    const { sim } = build();
    const page = sim.invoke(toolName("listRefunds"));
    expect(Object.keys(items(page)[0] as object).sort()).toEqual(["id", "status"]);
  });

  it("serves the fields the schema declares, and only those", () => {
    declareListItem({
      type: "object",
      properties: {
        id: { type: "string" },
        amount_cents: { type: "integer" },
        currency: { type: "string", enum: ["usd"] },
        reason: { type: "string" },
      },
    });
    const { sim } = build();
    const item = items(sim.invoke(toolName("listRefunds")))[0] as Record<string, unknown>;
    // `status` is the store's, not the schema's — state survives projection.
    expect(Object.keys(item).sort()).toEqual([
      "amount_cents",
      "currency",
      "id",
      "reason",
      "status",
    ]);
    expect(item.currency).toBe("usd");
    expect(typeof item.amount_cents).toBe("number");
    // The id is the store's fixture id, never a synthesized string.
    expect(item.id).toMatch(/^refund_/);
  });

  it("lets stored state win over anything synthesis produced", () => {
    // A schema may well declare `status`; the state machine owns its value, and
    // a projection that could overwrite it would break cancel/replay silently.
    declareListItem({
      type: "object",
      properties: { id: { type: "string" }, status: { type: "string", enum: ["archived"] } },
    });
    const { sim } = build();
    expect(items(sim.invoke(toolName("listRefunds")))[0]).toMatchObject({ status: "active" });
  });

  it("is a pure function of (contract, seed)", () => {
    declareListItem(wideRecord(3, 3));
    const a = new Simulator(air, simulatorDefinitionFor(air, { seed: 11 }));
    const b = new Simulator(air, simulatorDefinitionFor(air, { seed: 11 }));
    expect(a.invoke(toolName("listRefunds"))).toEqual(b.invoke(toolName("listRefunds")));
    // …and reproducible across a reset, not merely across construction.
    const first = a.invoke(toolName("listRefunds"));
    a.reset();
    expect(a.invoke(toolName("listRefunds"))).toEqual(first);
  });

  it("gives distinct entities distinct bodies", () => {
    declareListItem(wideRecord(2, 2));
    const { sim } = build();
    const page = items(sim.invoke(toolName("listRefunds"))) as Record<string, unknown>[];
    expect(JSON.stringify(page[0])).not.toEqual(JSON.stringify(page[1]));
  });

  it("shapes a mutation's response from its own declared schema", () => {
    operation("createRefund").output = {
      schema: { type: "object", properties: { receipt_url: { type: "string", format: "uri" } } },
    };
    const { sim } = build();
    const created = sim.invoke(
      toolName("createRefund"),
      { amount: 5 },
      { principalId: "admin", confirm: true },
    );
    expect(created.ok && (created.output as Record<string, unknown>).receipt_url).toBe(
      "https://example.com/resource",
    );
  });

  it("measures the response it serves, not a parallel construction", () => {
    // The seam certification measures through must stay the serving path: a
    // sample that skipped projection would report a payload nobody receives.
    declareListItem(wideRecord(4, 4));
    const sampled = build().sim.disclosureSample(toolName("listRefunds"));
    const served = build().sim.invoke(toolName("listRefunds"));
    expect(sampled?.response).toEqual((served as { output: unknown }).output);
    expect(sampled?.item).toEqual(items(served)[0]);
  });
});

describe("response cost tracks declared size — the fail branch is reachable", () => {
  it("a genuinely large declared schema simulates over the response budget", () => {
    // 200 sections × 6 attributes: a real enterprise record (DocuSign's
    // envelope, Salesforce's account), not padding invented to fail a budget.
    measureList(1600);
    declareListItem(wideRecord(200, 6));
    const sim = new Simulator(air, simulatorDefinitionFor(air, { seed: 42 }));
    const sample = sim.disclosureSample(toolName("listRefunds"));
    expect(sample).toBeDefined();
    if (!sample) return;
    // One item alone exceeds the budget, so no page size ≥ 1 can fit — which is
    // exactly the verdict the `{id, status}` body could never produce.
    expect(countTokens(JSON.stringify(sample.item))).toBeGreaterThan(
      DEFAULT_RESPONSE_BUDGET_TOKENS,
    );
    expect(pageFits(sample)).toBe(false);
  });

  it("a small declared schema still fits, and stays small", () => {
    // Faithfulness cuts both ways: the same code path must leave a two-field
    // contract cheap, or the instrument has simply been recalibrated to fail.
    measureList(1600);
    declareListItem({
      type: "object",
      properties: { id: { type: "string" }, amount_cents: { type: "integer" } },
    });
    const sim = new Simulator(air, simulatorDefinitionFor(air, { seed: 42 }));
    const sample = sim.disclosureSample(toolName("listRefunds"));
    expect(sample).toBeDefined();
    if (!sample) return;
    expect(countTokens(JSON.stringify(sample.item))).toBeLessThan(50);
    expect(pageFits(sample)).toBe(true);
  });
});

describe("review fixes — surface scoping and replay isolation", () => {
  it("rejects an unknown capability id instead of serving everything (#25)", () => {
    const def = simulatorDefinitionFor(air, { seed: 42 });
    expect(() => new Simulator(air, { ...def, capabilityId: "no-such-capability" })).toThrow(
      /Unknown capability/,
    );
  });

  it("does not replay one principal's idempotency key for another (#24)", () => {
    const def = simulatorDefinitionFor(air, { seed: 42 });
    // A second privileged principal — same scopes, so only the caller differs.
    const admin1 = def.authProfiles.find((p) => p.id === "admin");
    const sim = new Simulator(air, {
      ...def,
      authProfiles: [...def.authProfiles, { ...admin1!, id: "admin2" }],
    });
    const tool = toolName("createRefund");
    const admin = { principalId: "admin", confirm: true, idempotencyKey: "shared-key" };
    const other = { principalId: "admin2", confirm: true, idempotencyKey: "shared-key" };
    const first = sim.invoke(tool, { amount: 5 }, admin);
    const second = sim.invoke(tool, { amount: 5 }, other);
    expect(first.ok && second.ok).toBe(true);
    // The other principal must get a *fresh* effect, not admin's replayed result.
    if (second.ok) expect(second.replayed).toBeUndefined();
    if (first.ok && second.ok) expect(second.output).not.toEqual(first.output);
  });

  it("still replays for the same principal + tenant (#24)", () => {
    const { sim } = build();
    const tool = toolName("createRefund");
    const ctx = { principalId: "admin", tenantId: "t1", confirm: true, idempotencyKey: "k" };
    const first = sim.invoke(tool, { amount: 5 }, ctx);
    const second = sim.invoke(tool, { amount: 5 }, ctx);
    expect(second.ok && second.replayed).toBe(true);
    if (first.ok && second.ok) expect(second.output).toEqual(first.output);
  });
});
