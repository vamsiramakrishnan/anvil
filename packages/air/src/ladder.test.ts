import { describe, expect, it } from "vitest";
import {
  type AirDocument,
  DEFAULT_SURFACE_DISCLOSURE_BUDGET_TOKENS,
  ladderPlan,
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

const op = (id: string, toolName: string, tokens?: number, state = "approved") => ({
  id,
  canonicalName: toolName,
  displayName: id,
  description: `Operation ${id}.`,
  sourceRef: { kind: "openapi", path: `/${id}`, method: "get" },
  effect: { kind: "read", action: "list", resource: "thing", risk: "none" },
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

  it("produces MCP-safe card names from dotted capability ids", () => {
    expect(laneEntryToolName("payments.refunds")).toBe("open_payments_refunds");
    expect(laneEntryToolName("a/b c")).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
