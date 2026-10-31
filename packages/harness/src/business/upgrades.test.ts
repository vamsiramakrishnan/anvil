import { type BusinessAction, BusinessDefinition, hashCanonical } from "@anvil/air";
import { compileBusiness } from "@anvil/compiler";
import { executeBusiness } from "@anvil/runtime";
import { describe, expect, it } from "vitest";
import { businessFixtureContract, OwnedBusinessBackend, ownedBusinessHost } from "./fixture.js";
import { proposeBusinessUpgrade } from "./proposal.js";

const object = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
function loopFixture() {
  const { definition, sources } = businessFixtureContract();
  const action: BusinessAction = {
    id: "lookup_batch",
    state: "approved",
    description: "Look up a bounded list of orders",
    humanApproval: false,
    requiredScopes: [],
    guidance: {
      intents: ["Look up orders"],
      counterIntents: [],
      clarify: [],
      escalate: ["Lookup failed"],
    },
    input: object({
      refs: { type: "array", items: { type: "string" } },
      enabled: { type: "boolean" },
    }),
    output: object({
      results: { type: ["array", "null"], items: sources.orders.operations[0].output.schema },
    }),
    steps: [
      {
        ...definition.actions[0].steps[0],
        forEach: { items: { from: "input", pointer: "/refs" }, maxItems: 2 },
        when: {
          value: { from: "input", pointer: "/enabled" },
          equals: { from: "literal", value: true },
        },
        input: { opaque_order_ref: { from: "item", pointer: "" } },
      },
    ],
    result: { results: { from: "step", step: "order", pointer: "" } },
  };
  return { definition: BusinessDefinition.parse({ ...definition, actions: [action] }), sources };
}

describe("compiled bounded composition", () => {
  it("assigns distinct iteration intent keys and replays the whole batch without repeating effects", async () => {
    const { definition, sources } = businessFixtureContract();
    const step = definition.actions[0].steps[1];
    step.input = { txn: { from: "item", pointer: "" }, minor: { from: "literal", value: 4200 } };
    step.preconditions = [];
    step.forEach = { items: { from: "input", pointer: "/refs" }, maxItems: 2 };
    definition.actions = [
      {
        ...definition.actions[0],
        input: object({ refs: { type: "array", items: { type: "string" } } }),
        output: object({
          refunds: { type: "array", items: sources.billing.operations[0].output.schema },
        }),
        steps: [step],
        result: { refunds: { from: "step", step: "refund", pointer: "" } },
      },
    ];
    const { plan } = compileBusiness(definition, sources);
    const backend = new OwnedBusinessBackend(),
      host = ownedBusinessHost(backend),
      input = { refs: ["payment-order-1", "payment-order-1"] };
    const first = await executeBusiness(plan, "complete_return", input, host, "batch");
    expect(first.status).toBe("completed");
    expect(backend.state.refunds).toBe(2);
    expect(new Set(backend.calls.map((call) => call.headers["X-Request-Token"])).size).toBe(2);
    expect(await executeBusiness(plan, "complete_return", input, host, "batch")).toEqual(first);
    expect(backend.state.refunds).toBe(2);
    const failedBackend = new OwnedBusinessBackend(),
      send = failedBackend.send.bind(failedBackend);
    let attempts = 0;
    failedBackend.send = async (request) => {
      if (++attempts === 2) failedBackend.fault = "lost-refund-response";
      return send(request);
    };
    const failedHost = ownedBusinessHost(failedBackend);
    const uncertain = await executeBusiness(
      plan,
      "complete_return",
      input,
      failedHost,
      "uncertain-batch",
    );
    expect(uncertain).toMatchObject({
      status: "reconciliation_required",
      completed_effects: [step.effect],
    });
    expect(
      await executeBusiness(plan, "complete_return", input, failedHost, "uncertain-batch"),
    ).toEqual(uncertain);
    expect(failedBackend.state.refunds).toBe(2);
    expect(attempts).toBe(2);
  });
  it("keeps harness suggestions review-only and preserves unchanged approvals", () => {
    const { plan } = businessFixtureContract();
    const project = {
      schemaVersion: 1 as const,
      definition: plan.definition,
      sources: plan.sources,
      tasks: [],
    };
    const definition = structuredClone(plan.definition);
    definition.actions[0]!.description = "Revised business outcome";
    const proposal = proposeBusinessUpgrade(
      { project, digest: hashCanonical(project) },
      definition,
    );
    expect(proposal.proposalOnly).toBe(true);
    expect(proposal.project.definition.actions.map((a) => a.state)).toEqual([
      "proposed",
      "approved",
      "approved",
    ]);
    expect(project.definition.actions[0]!.state).toBe("approved");
    expect(() => proposeBusinessUpgrade({ project, digest: "stale" }, definition)).toThrow();
  });
  it("executes each selected item and exposes a typed nullable result when skipped", async () => {
    const { definition, sources } = loopFixture();
    const { plan } = compileBusiness(definition, sources);
    const backend = new OwnedBusinessBackend(),
      host = ownedBusinessHost(backend);
    const result = await executeBusiness(
      plan,
      "lookup_batch",
      { refs: ["order-1", "order-2"], enabled: true },
      host,
    );
    expect(result.status).toBe("completed");
    expect(result.result?.results as unknown[]).toHaveLength(2);
    expect(backend.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/internal/orders/order-1",
      "/internal/orders/order-2",
    ]);
    expect(
      await executeBusiness(plan, "lookup_batch", { refs: ["order-1"], enabled: false }, host),
    ).toMatchObject({ status: "completed", result: { results: null } });
    expect(backend.calls).toHaveLength(2);
  });
  it("refuses an oversized batch before its first dispatch", async () => {
    const f = loopFixture(),
      { plan } = compileBusiness(f.definition, f.sources);
    const backend = new OwnedBusinessBackend();
    expect(
      (
        await executeBusiness(
          plan,
          "lookup_batch",
          { refs: ["a", "b", "c"], enabled: true },
          ownedBusinessHost(backend),
        )
      ).status,
    ).toBe("rejected");
    expect(backend.calls).toHaveLength(0);
    delete f.definition.actions[0]!.steps[0]!.forEach;
    expect(() => compileBusiness(f.definition, f.sources)).toThrow(/unavailable step/);
  });

  it("rejects a declared action that would exceed its durable journal budget", () => {
    const f = loopFixture(),
      action = f.definition.actions[0]!;
    action.steps = Array.from({ length: 5 }, (_, index) => ({
      ...action.steps[0]!,
      id: `step_${index}`,
      forEach: { items: { from: "input" as const, pointer: "/refs" }, maxItems: 100 },
    }));
    expect(() => compileBusiness(f.definition, f.sources)).toThrow(/at most 400/);
  });
  it("executes a reviewed currency conversion and rejects cross-system ID confusion", async () => {
    const { definition, sources } = businessFixtureContract();
    definition.actions = [definition.actions[0]];
    const action = definition.actions[0];
    const conversion = [
      { kind: "scale", numerator: 100, denominator: 1, fromUnit: "dollars", toUnit: "cents" },
    ];
    action.input.properties.refund_amount["x-anvil-semantic"] = {
      unit: "dollars",
      currency: "USD",
    };
    action.steps[1].input.minor.transforms = conversion;
    action.steps[1].preconditions[2].equals.transforms = conversion;
    sources.billing.operations[0].input.body.fields.find(
      (f: { name: string }) => f.name === "minor",
    ).schema["x-anvil-semantic"] = { unit: "cents", currency: "USD" };
    const { plan } = compileBusiness(definition, sources);
    const backend = new OwnedBusinessBackend();
    expect(
      (
        await executeBusiness(
          plan,
          "complete_return",
          { order_ref: "order-1", refund_amount: 42 },
          ownedBusinessHost(backend),
          "converted",
        )
      ).status,
    ).toBe("completed");
    expect(backend.state.refunds).toBe(1);
    sources.orders.operations[0].output.schema.properties.pay_txn["x-anvil-semantic"] = {
      entity: "order_id",
    };
    sources.billing.operations[0].input.body.fields.find(
      (f: { name: string }) => f.name === "txn",
    ).schema["x-anvil-semantic"] = { entity: "payment_id" };
    expect(() => compileBusiness(definition, sources)).toThrow(/Semantic/);
  });
  it("refuses a conditional output used as an unconditional value", () => {
    const f = loopFixture();
    (f.definition.actions[0]!.output.properties as Record<string, Record<string, unknown>>)
      .results!.type = "array";
    expect(() => compileBusiness(f.definition, f.sources)).toThrow(/types do not match/);
  });
});
