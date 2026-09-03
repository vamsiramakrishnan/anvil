import { type AirDocument, loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { benchmarkOperations, lexicalRouter } from "./routing.js";
import { ladderedCatalog, stagedRoute } from "./routing-ladder.js";

/**
 * The staged half of the benchmark, tested pure over a document big enough to
 * ladder — the router contract (`TaskRouter`) is untouched, so these tests
 * pin the SCOPING stage 2 depends on rather than routing behavior itself:
 * `routing.test.ts` already covers the router.
 */

const op = (id: string, toolName: string, capability: string, tokens = 4000) => ({
  id,
  canonicalName: toolName,
  displayName: id.replace(/\./g, " "),
  description: `${capability} operation: ${id}.`,
  sourceRef: { kind: "openapi" as const, path: `/${id}`, method: "get" as const },
  effect: {
    kind: "read" as const,
    action: "list" as const,
    resource: capability,
    risk: "none" as const,
  },
  input: { params: [] },
  idempotency: { mode: "natural" as const, mechanism: "none" as const },
  retries: {
    mode: "safe" as const,
    maxAttempts: 3,
    backoff: "exponential_jitter" as const,
    retryOn: ["http_429" as const],
  },
  confirmation: { required: false, risk: "none" as const },
  auth: { type: "none" as const, scopes: [] },
  cli: { command: id },
  mcp: { toolName },
  skill: { intentExamples: [`${toolName.replace(/_/g, " ")}`] },
  state: "approved" as const,
  disclosureCost: {
    toolTokens: tokens,
    responseItemTokens: 0,
    responseTokens: 0,
    charsPerToken: 4,
    estimator: "o200k_base" as const,
  },
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

/** Three lanes, each with two members, well over the at-rest budget — the
 *  shape `ladderPlan` actually ladders. */
function threeLaneDoc(): AirDocument {
  const ops = [
    op("billing.invoice.list", "billing_list_invoices", "billing"),
    op("billing.invoice.get", "billing_get_invoice", "billing"),
    op("shipping.order.list", "shipping_list_orders", "shipping"),
    op("shipping.order.get", "shipping_get_order", "shipping"),
    op("support.ticket.list", "support_list_tickets", "support"),
    op("support.ticket.get", "support_get_ticket", "support"),
  ];
  return doc(ops, [
    { id: "svc.billing", operationIds: ["billing.invoice.list", "billing.invoice.get"] },
    { id: "svc.shipping", operationIds: ["shipping.order.list", "shipping.order.get"] },
    { id: "svc.support", operationIds: ["support.ticket.list", "support.ticket.get"] },
  ]);
}

describe("ladderedCatalog", () => {
  it("builds one entry card per lane and scopes stage 2 to that lane's own members", () => {
    const air = threeLaneDoc();
    const ladder = ladderedCatalog(air);
    expect(ladder.plan.mode).toBe("laddered");

    const entryNames = ladder.stage1.map((t) => t.name).sort();
    expect(entryNames).toEqual(["open_svc_billing", "open_svc_shipping", "open_svc_support"]);
    // Stage 1 never carries a stage-2 tool's own name or schema — that is the
    // whole point of a card.
    expect(ladder.stage1.some((t) => t.name === "billing_get_invoice")).toBe(false);

    const billing = ladder.stage2.get("open_svc_billing");
    expect(billing?.map((t) => t.name).sort()).toEqual([
      "billing_get_invoice",
      "billing_list_invoices",
    ]);
    // Cross-lane leakage would defeat the whole measurement.
    expect(billing?.some((t) => t.name.startsWith("shipping_"))).toBe(false);
    expect(billing?.some((t) => t.name.startsWith("support_"))).toBe(false);
  });

  it("falls back to the flat curated catalog when ladderPlan declines", () => {
    // A single unmeasured operation: ladderPlan declines with reason
    // "unmeasured", so there is no ladder to stage.
    const air = doc(
      [
        {
          ...op("svc.a", "tool_a", "svc"),
          disclosureCost: undefined,
        } as unknown as ReturnType<typeof op>,
      ],
      [{ id: "svc.things", operationIds: ["svc.a"] }],
    );
    const ladder = ladderedCatalog(air);
    expect(ladder.plan.mode).toBe("flat");
    expect(ladder.stage2.size).toBe(0);
    expect(ladder.stage1.map((t) => t.name)).toEqual(["tool_a"]);
  });
});

describe("stagedRoute", () => {
  it("routes stage 1 into a lane, then scores stage 2 within it", async () => {
    const air = threeLaneDoc();
    const ladder = ladderedCatalog(air);
    const router = lexicalRouter();

    const outcome = await stagedRoute(
      router,
      "list invoices for billing",
      ladder,
      "billing.invoice.list",
    );
    expect(outcome.pass).toBe(true);
    expect(outcome.routed).toBe("billing_list_invoices");
    expect(outcome.enteredLane).toBe("open_svc_billing");
  });

  it("fails a task whose target sits in a lane the router never entered", async () => {
    const air = threeLaneDoc();
    const ladder = ladderedCatalog(air);
    const router = lexicalRouter();

    // "billing" tokens route stage 1 into the billing lane; scored against the
    // shipping operation, this must fail — the shipping tools were never
    // disclosed, so no staged server could have reached one.
    const outcome = await stagedRoute(
      router,
      "list invoices for billing",
      ladder,
      "shipping.order.list",
    );
    expect(outcome.pass).toBe(false);
  });

  it("never lets a stronger match in an unentered lane leak into a pass", async () => {
    // A direct reproduction of what mutant benchmark-ladder/stage-two-scoped-to-lane
    // deletes: stage 1 is steered into "alpha" by vocabulary that exists ONLY on
    // alpha's own entry card, while the intent also carries several tokens that
    // exist ONLY on beta's tool name — strong enough that scoring the FULL
    // catalog at stage 2 (the mutant) would pick beta's tool over alpha's, even
    // though beta's lane was never opened. A real staged server has beta's tool
    // closed at this point, so the correct answer is a routed miss, not a pass.
    const alpha = {
      ...op("alpha.op", "alpha_op_tool", "widget", 6_000),
      skill: { intentExamples: ["route to alpha please"] },
    };
    const beta = {
      ...op("beta.op", "zzz_marker_special_case_tool", "widget", 6_000),
      skill: { intentExamples: ["handle beta requests"] },
    };
    // A filler lane with more than one member, purely so the projection does
    // not decline the whole document as "no_grouping_benefit" (every OTHER
    // lane here is deliberately singleton, to keep the two lanes under test
    // as small and legible as possible).
    const filler = [
      op("filler.a", "filler_tool_a", "filler", 6_000),
      op("filler.b", "filler_tool_b", "filler", 6_000),
    ];
    const air = loadAirDocument({
      anvilVersion: "0.1.0",
      service: {
        id: "svc",
        version: "1.0.0",
        displayName: "Svc",
        source: { kind: "openapi", uri: "spec.yaml" },
        auth: { type: "none", scopes: [] },
        servers: [],
      },
      operations: [alpha, beta, ...filler],
      capabilities: [
        {
          id: "svc.alpha",
          displayName: "Alpha",
          description: "Alpha capability.",
          operationIds: ["alpha.op"],
          intentExamples: ["route to alpha please"],
        },
        {
          id: "svc.beta",
          displayName: "Beta",
          description: "Beta capability.",
          operationIds: ["beta.op"],
          intentExamples: ["handle beta requests"],
        },
        {
          id: "svc.filler",
          displayName: "Filler",
          description: "Filler capability.",
          operationIds: ["filler.a", "filler.b"],
          intentExamples: ["do filler things"],
        },
      ],
      workflows: [],
      schemas: {},
      diagnostics: [],
    });
    const ladder = ladderedCatalog(air);
    expect(ladder.plan.mode).toBe("laddered");

    const router = lexicalRouter();
    const intent = "route to alpha please zzz marker special case";

    // Confirms the premise: stage 1 genuinely enters alpha's lane, not beta's.
    const stage1Routed = await router.route(intent, ladder.stage1);
    expect(stage1Routed).toBe("open_svc_alpha");

    const outcome = await stagedRoute(router, intent, ladder, "beta.op");
    expect(outcome.enteredLane).toBe("open_svc_alpha");
    expect(outcome.pass).toBe(false);
  });

  it("falls back to flat scoring when the plan declined", async () => {
    const air = doc(
      [
        { ...op("svc.a", "tool_a", "svc"), disclosureCost: undefined } as unknown as ReturnType<
          typeof op
        >,
      ],
      [{ id: "svc.things", operationIds: ["svc.a"] }],
    );
    const ladder = ladderedCatalog(air);
    const outcome = await stagedRoute(lexicalRouter(), "tool a", ladder, "svc.a");
    expect(outcome.pass).toBe(true);
    expect(outcome.enteredLane).toBeUndefined();
  });

  it("agrees with benchmarkOperations on which operations are in play", () => {
    const air = threeLaneDoc();
    const ladder = ladderedCatalog(air);
    const routableIds = new Set([...ladder.stage2.values()].flat().map((t) => t.operationId));
    expect(routableIds).toEqual(new Set(benchmarkOperations(air).map((o) => o.id)));
  });
});
