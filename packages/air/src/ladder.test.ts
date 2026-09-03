import { describe, expect, it } from "vitest";
import {
  type AirDocument,
  DEFAULT_SURFACE_DISCLOSURE_BUDGET_TOKENS,
  ladderPlan,
  laneEntryDescription,
  laneEntryToolName,
  loadAirDocument,
} from "./index.js";

/**
 * The ladder's job is to make a huge surface navigable without changing what is
 * callable, so these tests are weighted toward the ways it could quietly fail
 * open: an operation that falls out of every lane, a lane that advertises an
 * unapproved tool, a plan that restructures a bundle nobody measured. A ladder
 * that merely *looks* cheaper while dropping an approved operation is worse than
 * the flat list it replaced.
 *
 * Documents are built through `loadAirDocument` rather than object literals so
 * every schema default matches what the compiler actually emits.
 */

const op = (
  id: string,
  toolName: string,
  tokens?: number,
  state = "approved",
  action = "list",
  resource = "thing",
) => ({
  id,
  canonicalName: toolName,
  displayName: id,
  description: `Operation ${id}.`,
  sourceRef: { kind: "openapi", path: `/${id}`, method: "get" },
  effect: { kind: "read", action, resource, risk: "none" },
  input: { params: [] },
  idempotency: { mode: "natural", mechanism: "none" },
  retries: { mode: "safe", maxAttempts: 3, backoff: "exponential_jitter", retryOn: ["http_429"] },
  confirmation: { required: false, risk: "none" },
  auth: { type: "none", scopes: [] },
  cli: { command: id },
  mcp: { toolName },
  skill: { intentExamples: [] },
  state,
  ...(tokens === undefined
    ? {}
    : {
        disclosureCost: {
          toolTokens: tokens,
          responseItemTokens: 0,
          responseTokens: 0,
          charsPerToken: 4,
          estimator: "o200k_base",
        },
      }),
});

const doc = (
  operations: ReturnType<typeof op>[],
  capabilities: { id: string; operationIds: string[] }[],
): AirDocument =>
  loadAirDocument({
    anvilVersion: "0.1.0",
    service: {
      id: "svc",
      version: "1.0.0",
      displayName: "Svc",
      source: { kind: "openapi", uri: "spec.yaml" },
      auth: { type: "none", scopes: [] },
      servers: [],
    },
    operations,
    capabilities: capabilities.map((c) => ({
      id: c.id,
      displayName: c.id,
      description: `The ${c.id} capability.`,
      operationIds: c.operationIds,
      intentExamples: [`do something with ${c.id}`],
    })),
    workflows: [],
    schemas: {},
    diagnostics: [],
  });

/** A surface deliberately larger than the at-rest budget, in two capabilities. */
function oversizedDoc(): AirDocument {
  const perOp = 900;
  const count = Math.ceil((DEFAULT_SURFACE_DISCLOSURE_BUDGET_TOKENS * 2) / perOp);
  const ops = Array.from({ length: count }, (_, i) => op(`svc.op${i}`, `tool_${i}`, perOp));
  const half = Math.floor(count / 2);
  return doc(ops, [
    { id: "svc.alpha", operationIds: ops.slice(0, half).map((o) => o.id) },
    { id: "svc.beta", operationIds: ops.slice(half).map((o) => o.id) },
  ]);
}

describe("ladderPlan declines when it cannot help", () => {
  it("serves flat when nothing was measured", () => {
    const ops = [op("svc.a", "tool_a"), op("svc.b", "tool_b")];
    const plan = ladderPlan(doc(ops, [{ id: "svc.things", operationIds: ["svc.a", "svc.b"] }]));
    expect(plan.mode).toBe("flat");
    expect(plan.reason).toBe("unmeasured");
    // Every approved operation still reaches the agent, exactly as before.
    expect(plan.unlanedOperationIds).toEqual(["svc.a", "svc.b"]);
  });

  it("serves flat when the whole surface already fits", () => {
    const ops = [op("svc.a", "tool_a", 100), op("svc.b", "tool_b", 100)];
    const plan = ladderPlan(doc(ops, [{ id: "svc.things", operationIds: ["svc.a", "svc.b"] }]));
    expect(plan.mode).toBe("flat");
    expect(plan.reason).toBe("fits_budget");
  });

  it("serves flat when no capability groups anything", () => {
    const plan = ladderPlan(doc([op("svc.a", "tool_a", 40_000)], []));
    expect(plan.mode).toBe("flat");
    expect(plan.reason).toBe("no_capabilities");
  });

  it("serves flat when every lane would hold one operation", () => {
    // A ladder over singleton lanes collapses nothing and costs a round trip.
    const ops = [op("svc.a", "tool_a", 30_000), op("svc.b", "tool_b", 30_000)];
    const plan = ladderPlan(
      doc(ops, [
        { id: "svc.alpha", operationIds: ["svc.a"] },
        { id: "svc.beta", operationIds: ["svc.b"] },
      ]),
    );
    expect(plan.mode).toBe("flat");
    expect(plan.reason).toBe("no_grouping_benefit");
  });
});

describe("ladderPlan when the surface is genuinely too large", () => {
  it("ladders, and the at-rest surface fits the budget it exists to defend", () => {
    const plan = ladderPlan(oversizedDoc());
    expect(plan.mode).toBe("laddered");
    expect(plan.reason).toBe("over_budget");
    expect(plan.flatTokens).toBeGreaterThan(DEFAULT_SURFACE_DISCLOSURE_BUDGET_TOKENS);
    expect(plan.restTokens).toBeLessThanOrEqual(DEFAULT_SURFACE_DISCLOSURE_BUDGET_TOKENS);
    // The whole claim: reaching the surface is cheaper than reading it flat.
    expect(plan.restTokens).toBeLessThan(plan.flatTokens);
  });

  it("exposes exactly the approved set — nothing gained, nothing lost", () => {
    const air = oversizedDoc();
    const plan = ladderPlan(air);
    const reachable = new Set([
      ...plan.lanes.flatMap((lane) => lane.operationIds),
      ...plan.unlanedOperationIds,
    ]);
    const approved = air.operations.filter((o) => o.state === "approved").map((o) => o.id);
    expect([...reachable].sort()).toEqual([...approved].sort());
  });

  it("declines when the entry cards would cost more than the tools they replace", () => {
    // Many lanes over cheap operations: per-card cost is capped but the lane
    // COUNT is not, so the at-rest surface can end up larger than the flat one.
    // Laddering here would charge an agent a round trip to read more.
    const ops = Array.from({ length: 60 }, (_, i) => op(`svc.op${i}`, `tool_${i}`, 400));
    const capabilities = Array.from({ length: 30 }, (_, i) => ({
      id: `svc.cap${i}`,
      operationIds: [`svc.op${i * 2}`, `svc.op${i * 2 + 1}`],
    }));
    const air = doc(ops, capabilities);
    const verbose = {
      ...air,
      capabilities: air.capabilities.map((capability) => ({
        ...capability,
        description: "x".repeat(20_000),
        intentExamples: Array.from({ length: 5 }, () => "y".repeat(4_000)),
      })),
    } as AirDocument;
    const plan = ladderPlan(verbose);
    expect(plan.flatTokens).toBeGreaterThan(DEFAULT_SURFACE_DISCLOSURE_BUDGET_TOKENS);
    expect(plan.mode).toBe("flat");
    expect(plan.reason).toBe("no_token_benefit");
  });

  it("is a stable projection — same contract, same lanes, same order", () => {
    const air = oversizedDoc();
    expect(JSON.stringify(ladderPlan(air))).toBe(JSON.stringify(ladderPlan(air)));
  });
});

describe("the safety invariant: laddering never changes what is exposed", () => {
  it("gives an unapproved operation no lane and no tool", () => {
    const ops = [
      op("svc.a", "tool_a", 15_000),
      op("svc.b", "tool_b", 15_000),
      op("svc.secret", "tool_secret", 15_000, "review_required"),
    ];
    const plan = ladderPlan(
      doc(ops, [{ id: "svc.things", operationIds: ["svc.a", "svc.b", "svc.secret"] }]),
    );
    const reachable = [
      ...plan.lanes.flatMap((lane) => lane.operationIds),
      ...plan.unlanedOperationIds,
    ];
    expect(reachable).not.toContain("svc.secret");
    // The lane must not advertise a tool it cannot open, either.
    expect(plan.lanes.every((lane) => !lane.operationIds.includes("svc.secret"))).toBe(true);
  });

  it("keeps an operation no capability claims registered at rest", () => {
    // An operation an agent cannot reach is worse than one that costs tokens.
    const ops = [
      op("svc.a", "tool_a", 15_000),
      op("svc.b", "tool_b", 15_000),
      op("svc.orphan", "tool_orphan", 15_000),
    ];
    const plan = ladderPlan(doc(ops, [{ id: "svc.things", operationIds: ["svc.a", "svc.b"] }]));
    expect(plan.mode).toBe("laddered");
    expect(plan.unlanedOperationIds).toEqual(["svc.orphan"]);
  });
});

describe("entry cards share a namespace with operation tools", () => {
  it("drops a lane whose card name would collide with a real tool", () => {
    const colliding = laneEntryToolName("svc.things");
    const ops = [
      op("svc.a", "tool_a", 15_000),
      op("svc.b", "tool_b", 15_000),
      // A real operation already occupying the generated card name.
      op("svc.c", colliding, 15_000),
    ];
    const plan = ladderPlan(
      doc(ops, [{ id: "svc.things", operationIds: ["svc.a", "svc.b", "svc.c"] }]),
    );
    expect(plan.lanes.map((lane) => lane.capabilityId)).not.toContain("svc.things");
    // Losing the lane costs tokens; losing the tool would cost a capability.
    expect(plan.unlanedOperationIds).toEqual(["svc.a", "svc.b", "svc.c"]);
  });

  it("demotes a second capability whose id sanitizes onto the same card name", () => {
    // `svc.pay` and `svc_pay` both mint `open_svc_pay`. Shipping both would let
    // one shadow the other at registration while the shadowed lane's operations
    // still counted as laned — reachable through nothing at all.
    const ops = [
      op("a1", "tool_a1", 15_000),
      op("a2", "tool_a2", 15_000),
      op("b1", "tool_b1", 15_000),
      op("b2", "tool_b2", 15_000),
    ];
    const plan = ladderPlan(
      doc(ops, [
        { id: "svc.pay", operationIds: ["a1", "a2"] },
        { id: "svc_pay", operationIds: ["b1", "b2"] },
      ]),
    );
    expect(plan.lanes).toHaveLength(1);
    // The demoted lane's operations must come back to the flat surface, not
    // vanish between the two.
    const reachable = new Set([
      ...plan.lanes.flatMap((lane) => lane.operationIds),
      ...plan.unlanedOperationIds,
    ]);
    expect([...reachable].sort()).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("produces MCP-safe card names from dotted capability ids", () => {
    expect(laneEntryToolName("payments.refunds")).toBe("open_payments_refunds");
    expect(laneEntryToolName("a/b c")).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("member vocabulary in entry cards", () => {
  // Measured on a 640-operation estate (docs/backtesting/routing-at-scale.md):
  // a discovered capability's own description/intentExamples are frequently a
  // template ("Views capability for zendesk.", "work with views") that shares
  // no vocabulary with how an agent actually phrases a request ("list the
  // views"). Folding each member operation's own action/resource into the
  // card measurably closed most of that gap.
  it("folds each member's own verb/resource into the card, deduplicated", () => {
    // buildLane iterates member operations in sorted-id order, so the ids
    // themselves (not push order) fix the expected vocabulary order below.
    const ops = [
      op("svc.a_list", "tool_list", 15_000, "approved", "list", "widget"),
      op("svc.b_get", "tool_get", 15_000, "approved", "get", "widget"),
      // Same action+resource as svc.a_list — must count once, not twice.
      op("svc.c_list2", "tool_list2", 15_000, "approved", "list", "widget"),
    ];
    const plan = ladderPlan(doc(ops, [{ id: "svc.widgets", operationIds: ops.map((o) => o.id) }]));
    const lane = plan.lanes.find((l) => l.capabilityId === "svc.widgets");
    expect(lane?.memberVocabulary).toEqual(["list widget", "get widget"]);
    expect(lane?.summary).toBeDefined();
  });

  it("caps member vocabulary at a small, bounded sample", () => {
    // A real, bounded enum of distinct actions — memberVocabulary is capped
    // well short of it, so cycling through covers plenty of distinct pairs.
    const actions = [
      "list",
      "get",
      "search",
      "export",
      "simulate",
      "validate",
      "poll",
      "create",
      "update",
      "replace",
      "delete",
      "send",
      "execute",
      "approve",
      "cancel",
      "reserve",
    ];
    const ops = actions.map((action, i) =>
      op(`svc.op${i}`, `tool_${i}`, 15_000, "approved", action, "widget"),
    );
    const plan = ladderPlan(doc(ops, [{ id: "svc.things", operationIds: ops.map((o) => o.id) }]));
    const lane = plan.lanes.find((l) => l.capabilityId === "svc.things");
    // 16 distinct member operations, all with distinct verb/resource pairs —
    // the card stays a routing aid, not a full member listing.
    expect(lane?.memberVocabulary.length).toBeLessThan(actions.length);
    expect(lane?.memberVocabulary.length).toBeGreaterThan(0);
    expect(new Set(lane?.memberVocabulary).size).toBe(lane?.memberVocabulary.length);
  });

  it("puts the member vocabulary on the served entry-card description", () => {
    const ops = [
      op("svc.a_list", "tool_list", 15_000, "approved", "list", "widget"),
      op("svc.b_get", "tool_get", 15_000, "approved", "get", "widget"),
    ];
    const plan = ladderPlan(doc(ops, [{ id: "svc.widgets", operationIds: ops.map((o) => o.id) }]));
    const lane = plan.lanes.find((l) => l.capabilityId === "svc.widgets");
    expect(lane).toBeDefined();
    if (!lane) throw new Error("expected a lane");
    // laneEntryDescription is exercised through the serving path (lane.ts) and
    // the benchmark's ladderedCatalog; here it is called directly so the
    // dependency on `memberVocabulary` — not just `routingPhrases` — is pinned
    // at the source rather than only through a downstream consumer.
    const description = laneEntryDescription(lane);
    expect(description).toContain("Covers: list widget, get widget.");
  });
});

describe("member intent examples in entry cards", () => {
  // The second stage-1 lever measured in docs/backtesting/routing-at-scale.md
  // ("A second lever" section): memberVocabulary gives a router two-word
  // stems, but the member operations' own authored intent examples are the
  // full phrase an agent would actually type. Folded in the same
  // dedup-and-cap shape, over three lanes so a per-lane cap can be pinned
  // independently of the other lanes' own membership.
  const opWithIntents = (
    id: string,
    toolName: string,
    tokens: number,
    intentExamples: string[],
  ) => ({ ...op(id, toolName, tokens), skill: { intentExamples } });

  it("folds each member's own intent examples into the card, deduplicated, across three lanes", () => {
    const widgetOps = [
      opWithIntents("svc.w_list", "tool_w_list", 15_000, [
        "list the widgets",
        "show me all widgets",
      ]),
      // Same first phrase as svc.w_list — must count once, not twice.
      opWithIntents("svc.w_get", "tool_w_get", 15_000, ["list the widgets", "get a widget by id"]),
    ];
    const gadgetOps = [
      opWithIntents("svc.g_list", "tool_g_list", 15_000, ["list the gadgets"]),
    ];
    const partOps = [opWithIntents("svc.p_list", "tool_p_list", 15_000, [])];
    const plan = ladderPlan(
      doc([...widgetOps, ...gadgetOps, ...partOps], [
        { id: "svc.widgets", operationIds: widgetOps.map((o) => o.id) },
        { id: "svc.gadgets", operationIds: gadgetOps.map((o) => o.id) },
        { id: "svc.parts", operationIds: partOps.map((o) => o.id) },
      ]),
    );
    expect(plan.lanes).toHaveLength(3);
    const widgets = plan.lanes.find((l) => l.capabilityId === "svc.widgets");
    // buildLane iterates member operations in sorted-id order (svc.w_get
    // before svc.w_list), so the walk visits svc.w_get's two examples first,
    // then svc.w_list's — with its first phrase ("list the widgets") already
    // seen and skipped as a duplicate.
    expect(widgets?.memberIntentExamples).toEqual([
      "list the widgets",
      "get a widget by id",
      "show me all widgets",
    ]);
    const gadgets = plan.lanes.find((l) => l.capabilityId === "svc.gadgets");
    expect(gadgets?.memberIntentExamples).toEqual(["list the gadgets"]);
    // A lane whose members carry no intent examples at all folds none in —
    // absence stays absence, never a fabricated placeholder.
    const parts = plan.lanes.find((l) => l.capabilityId === "svc.parts");
    expect(parts?.memberIntentExamples).toEqual([]);
  });

  it("caps member intent examples at a small, bounded sample even with many verbose members", () => {
    const ops = Array.from({ length: 20 }, (_, i) =>
      opWithIntents(`svc.op${i}`, `tool_${i}`, 15_000, [
        `distinct intent phrase number ${i} a`,
        `distinct intent phrase number ${i} b`,
        `distinct intent phrase number ${i} c`,
      ]),
    );
    const plan = ladderPlan(doc(ops, [{ id: "svc.things", operationIds: ops.map((o) => o.id) }]));
    const lane = plan.lanes.find((l) => l.capabilityId === "svc.things");
    // 20 members with 3 distinct phrases each is 60 candidates — the card
    // stays a routing aid, not a full member listing. Mutant
    // `ladder/intent-examples-stay-within-card-budget` deletes this cap.
    expect(lane?.memberIntentExamples.length).toBeLessThan(10);
    expect(lane?.memberIntentExamples.length).toBeGreaterThan(0);
    expect(new Set(lane?.memberIntentExamples).size).toBe(lane?.memberIntentExamples.length);
  });

  it("puts the member intent examples on the served entry-card description", () => {
    // Two members, not one: a single-operation lane collapses nothing and the
    // projection refuses to build it at all (`no_grouping_benefit`).
    const ops = [
      opWithIntents("svc.a_list", "tool_list", 15_000, ["list the widgets"]),
      opWithIntents("svc.b_get", "tool_get", 15_000, []),
    ];
    const plan = ladderPlan(doc(ops, [{ id: "svc.widgets", operationIds: ops.map((o) => o.id) }]));
    const lane = plan.lanes.find((l) => l.capabilityId === "svc.widgets");
    expect(lane).toBeDefined();
    if (!lane) throw new Error("expected a lane");
    const description = laneEntryDescription(lane);
    expect(description).toContain('Examples: "list the widgets".');
  });

  it("stays within the existing entry-card token budget alongside every other field", () => {
    // The card's overall cost is still capped at the per-operation budget
    // (`entryCardTokens`) exactly as it was before this field existed — a
    // lane cannot cost more than the tools it is standing in for just
    // because its members carry a lot of authored intent text.
    const ops = Array.from({ length: 8 }, (_, i) =>
      opWithIntents(`svc.op${i}`, `tool_${i}`, 100, [
        "x".repeat(200),
        "y".repeat(200),
        "z".repeat(200),
      ]),
    );
    const plan = ladderPlan(
      doc(ops, [{ id: "svc.things", operationIds: ops.map((o) => o.id) }]),
      { surfaceBudgetTokens: 1 },
    );
    expect(plan.mode).toBe("laddered");
    const lane = plan.lanes.find((l) => l.capabilityId === "svc.things");
    expect(lane).toBeDefined();
    // restTokens is the measured served cost, and it must never exceed what
    // the operations it replaces would have cost flat.
    expect(plan.restTokens).toBeLessThan(plan.flatTokens);
  });
});
