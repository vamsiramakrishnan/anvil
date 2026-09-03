import {
  type AirDocument,
  Capability,
  type LadderLane,
  loadAirDocument,
  Operation,
} from "@anvil/air";
import { describe, expect, it } from "vitest";
import {
  createLaneSurface,
  type DisclosableTool,
  decideLadder,
  laneMember,
  laneMemberLine,
  laneOpenResult,
  MIN_LADDER_TOKEN_SAVINGS_FRACTION,
  MIN_LADDERED_ACCURACY_DELTA_PTS,
} from "./lane.js";

/**
 * Unit checks over the ladder's serving half. Everything here is deliberately
 * server-free: the invariants that matter — a lane opens the same way twice, in
 * any order, and never reaches an unapproved operation — are properties of the
 * disclosure state machine, and pinning them through a transport would only make
 * a failure harder to read.
 */

const measured = {
  toolTokens: 5_000,
  responseItemTokens: 0,
  responseTokens: 0,
  charsPerToken: 4,
  estimator: "o200k_base",
};

function operation(over: Partial<Operation> & { id: string }): Operation {
  return Operation.parse({
    canonicalName: over.id.replace(/\./g, "_"),
    displayName: over.id,
    sourceRef: { kind: "openapi", path: `/${over.id}`, method: "get" },
    effect: { kind: "read", action: "list", resource: "thing", risk: "low", reversible: false },
    input: { params: [] },
    idempotency: {
      mode: "none",
      mechanism: "header",
      key: "Idempotency-Key",
      keyDerivation: "client_supplied",
    },
    retries: { mode: "safe", maxAttempts: 1, backoff: "exponential", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: over.id },
    mcp: { toolName: over.id.replace(/\./g, "_") },
    skill: { intentExamples: [] },
    state: "approved",
    disclosureCost: measured,
    ...over,
  });
}

function capability(id: string, operationIds: string[]): Capability {
  return Capability.parse({
    id,
    displayName: id,
    description: `Everything about ${id}`,
    operationIds,
    intentExamples: [`work with ${id}`],
    lifecycle: "approved",
  });
}

/** Two lanes, five approved operations, all measured — the laddering case. */
function estate(): AirDocument {
  const air: AirDocument = loadAirDocument({
    service: { id: "test", version: "1.0.0", source: { kind: "openapi" } },
    operations: [
      operation({ id: "billing.invoice.list" }),
      operation({ id: "billing.invoice.get" }),
      operation({ id: "billing.invoice.void" }),
      operation({ id: "users.user.list" }),
      operation({ id: "users.user.get" }),
    ],
    capabilities: [
      capability("billing.invoices", [
        "billing.invoice.list",
        "billing.invoice.get",
        "billing.invoice.void",
      ]),
      capability("users.users", ["users.user.list", "users.user.get"]),
    ],
    workflows: [],
  });
  return air;
}

/**
 * Three lanes, seven approved operations, all measured — the fixture the
 * measured-accuracy decision tests below want. `estate()` above stays at two
 * lanes because several existing tests pin its exact lane list; a third
 * capability here keeps those assertions untouched while giving the new
 * tests a shape closer to what a real bundle groups into.
 */
function estateWithThreeLanes(): AirDocument {
  const air: AirDocument = loadAirDocument({
    service: { id: "test", version: "1.0.0", source: { kind: "openapi" } },
    operations: [
      operation({ id: "billing.invoice.list" }),
      operation({ id: "billing.invoice.get" }),
      operation({ id: "billing.invoice.void" }),
      operation({ id: "users.user.list" }),
      operation({ id: "users.user.get" }),
      operation({ id: "reports.report.list" }),
      operation({ id: "reports.report.get" }),
    ],
    capabilities: [
      capability("billing.invoices", [
        "billing.invoice.list",
        "billing.invoice.get",
        "billing.invoice.void",
      ]),
      capability("users.users", ["users.user.list", "users.user.get"]),
      capability("reports.reports", ["reports.report.list", "reports.report.get"]),
    ],
    workflows: [],
  });
  return air;
}

/**
 * One lane whose entry card costs nearly as much as the flat surface it
 * would replace: three cheap (100-token) operations under one capability
 * with a deliberately long description, so the card's own text — capped at
 * the per-operation budget but otherwise unconstrained — approaches the
 * total it is meant to be replacing. Measured directly (see the module's own
 * `MIN_LADDER_TOKEN_SAVINGS_FRACTION` doc): flatTokens 300, restTokens 245,
 * an 18% reduction — comfortably under the 50% floor.
 */
function tinySavingsEstate(): AirDocument {
  const ops = [operation({ id: "svc.a" }), operation({ id: "svc.b" }), operation({ id: "svc.c" })];
  for (const op of ops) op.disclosureCost = { ...measured, toolTokens: 100 };
  return loadAirDocument({
    service: { id: "test", version: "1.0.0", source: { kind: "openapi" } },
    operations: ops,
    capabilities: [
      Capability.parse({
        id: "svc.things",
        displayName: "svc.things",
        description: "x".repeat(900),
        operationIds: ops.map((op) => op.id),
        intentExamples: [],
        lifecycle: "approved",
      }),
    ],
    workflows: [],
  });
}

interface FakeTool extends DisclosableTool {
  enabled: boolean;
  enableCalls: number;
  disableCalls: number;
}

function fakeTool(): FakeTool {
  return {
    enabled: true,
    enableCalls: 0,
    disableCalls: 0,
    enable() {
      this.enabled = true;
      this.enableCalls += 1;
    },
    disable() {
      this.enabled = false;
      this.disableCalls += 1;
    },
  };
}

function surfaceOver(air: AirDocument, lanes: readonly LadderLane[], reserved?: Set<string>) {
  const operations = new Map(air.operations.map((op) => [op.id, op]));
  const tools = new Map<string, FakeTool>(air.operations.map((op) => [op.id, fakeTool()]));
  const surface = createLaneSurface({
    lanes,
    operations,
    tools,
    ...(reserved ? { reservedToolNames: reserved } : {}),
  });
  const enabledIds = () =>
    [...tools.entries()].filter(([, tool]) => tool.enabled).map(([id]) => id);
  return { surface, tools, enabledIds };
}

describe("decideLadder", () => {
  it("ladders when the flat surface exceeds the at-rest budget", () => {
    const decision = decideLadder(estate(), { surfaceBudgetTokens: 100 });
    expect(decision.laddered).toBe(true);
    expect(decision.plan.reason).toBe("over_budget");
    expect(decision.lanes.map((lane) => lane.entryToolName)).toEqual([
      "open_billing_invoices",
      "open_users_users",
    ]);
  });

  it("serves flat when the flat surface already fits", () => {
    const decision = decideLadder(estate(), { surfaceBudgetTokens: 1_000_000 });
    expect(decision.laddered).toBe(false);
    expect(decision.plan.reason).toBe("fits_budget");
    expect(decision.lanes).toEqual([]);
  });

  it("serves flat when nothing was measured, whatever the budget", () => {
    const air = estate();
    for (const op of air.operations) op.disclosureCost = undefined;
    const decision = decideLadder(air, { surfaceBudgetTokens: 1 });
    expect(decision.laddered).toBe(false);
    expect(decision.plan.reason).toBe("unmeasured");
  });

  it("honors disclosure: 'flat' even when the projection wants to ladder", () => {
    const decision = decideLadder(estate(), { disclosure: "flat", surfaceBudgetTokens: 100 });
    expect(decision.laddered).toBe(false);
    expect(decision.lanes).toEqual([]);
    // The projection's own verdict survives the override, so a report can still
    // say what the surface costs and why an operator chose otherwise.
    expect(decision.plan.mode).toBe("laddered");
  });

  it("honors disclosure: 'laddered' on a surface that fits", () => {
    const decision = decideLadder(estate(), {
      disclosure: "laddered",
      surfaceBudgetTokens: 1_000_000,
    });
    expect(decision.laddered).toBe(true);
    expect(decision.lanes.map((lane) => lane.capabilityId)).toEqual([
      "billing.invoices",
      "users.users",
    ]);
  });

  it("cannot force a ladder over a document with no capabilities", () => {
    const air = estate();
    air.capabilities = [];
    const decision = decideLadder(air, { disclosure: "laddered", surfaceBudgetTokens: 1 });
    expect(decision.laddered).toBe(false);
    expect(decision.plan.reason).toBe("no_capabilities");
  });

  it("survives a document whose optional collections were never defaulted in", () => {
    const air = {
      service: { id: "test", version: "1.0.0", source: { kind: "openapi" } },
      operations: [operation({ id: "a" })],
    };
    expect(() => decideLadder(air as AirDocument, { surfaceBudgetTokens: 1 })).not.toThrow();
  });

  it("gives an unapproved operation no lane", () => {
    const air = estate();
    // Approved-in-the-capability but not approved as an operation: the lane must
    // shrink, never advertise a tool the server will not register.
    const [voided] = air.operations.filter((op) => op.id === "billing.invoice.void");
    if (voided) voided.state = "generated";
    const decision = decideLadder(air, { surfaceBudgetTokens: 100 });
    const billing = decision.lanes.find((lane) => lane.capabilityId === "billing.invoices");
    expect(billing?.operationIds).toEqual(["billing.invoice.get", "billing.invoice.list"]);
    expect(billing?.operationIds).not.toContain("billing.invoice.void");
  });

  it("is deterministic — the same document yields the same lanes", () => {
    const a = decideLadder(estate(), { surfaceBudgetTokens: 100 });
    const b = decideLadder(estate(), { surfaceBudgetTokens: 100 });
    expect(JSON.stringify(a.lanes)).toBe(JSON.stringify(b.lanes));
  });
});

describe("createLaneSurface", () => {
  it("closes exactly the laned tools and leaves the rest alone", () => {
    const air = estate();
    air.capabilities = [air.capabilities[0] as Capability];
    const { lanes } = decideLadder(air, { disclosure: "laddered", surfaceBudgetTokens: 1 });
    const { surface, enabledIds } = surfaceOver(air, lanes);
    surface.closeLanes();
    expect(enabledIds()).toEqual(["users.user.list", "users.user.get"]);
  });

  it("opens a lane by enabling its tools and nothing else", () => {
    const air = estate();
    const { lanes } = decideLadder(air, { surfaceBudgetTokens: 100 });
    const { surface, enabledIds } = surfaceOver(air, lanes);
    surface.closeLanes();
    expect(enabledIds()).toEqual([]);

    surface.cards[0]?.open();
    expect(enabledIds()).toEqual([
      "billing.invoice.list",
      "billing.invoice.get",
      "billing.invoice.void",
    ]);
  });

  it("is idempotent: opening the same lane twice converges", () => {
    const air = estate();
    const { lanes } = decideLadder(air, { surfaceBudgetTokens: 100 });
    const { surface, enabledIds } = surfaceOver(air, lanes);
    surface.closeLanes();

    const first = surface.cards[0]?.open();
    const after = enabledIds();
    const second = surface.cards[0]?.open();
    expect(enabledIds()).toEqual(after);
    // A retry after a dropped notification must not read as a different answer.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("is order-independent: A then B serves what B then A serves", () => {
    const forward = (() => {
      const air = estate();
      const { lanes } = decideLadder(air, { surfaceBudgetTokens: 100 });
      const { surface, enabledIds } = surfaceOver(air, lanes);
      surface.closeLanes();
      surface.cards[0]?.open();
      surface.cards[1]?.open();
      return enabledIds().sort();
    })();
    const backward = (() => {
      const air = estate();
      const { lanes } = decideLadder(air, { surfaceBudgetTokens: 100 });
      const { surface, enabledIds } = surfaceOver(air, lanes);
      surface.closeLanes();
      surface.cards[1]?.open();
      surface.cards[0]?.open();
      return enabledIds().sort();
    })();
    expect(forward).toEqual(backward);
    expect(forward.length).toBe(5);
  });

  it("opens a shared operation from either lane that claims it", () => {
    const air = estate();
    air.capabilities = [
      capability("billing.invoices", ["billing.invoice.list", "billing.invoice.get"]),
      capability("reporting.reads", ["billing.invoice.list", "users.user.list"]),
    ];
    const { lanes } = decideLadder(air, { surfaceBudgetTokens: 100 });
    const { surface, enabledIds } = surfaceOver(air, lanes);
    surface.closeLanes();
    const reporting = surface.cards.find((card) => card.lane.capabilityId === "reporting.reads");
    reporting?.open();
    expect(enabledIds()).toContain("billing.invoice.list");
    expect(enabledIds()).not.toContain("billing.invoice.get");
  });

  it("drops a lane whose card name is already taken, leaving its tools listed", () => {
    const air = estate();
    const { lanes } = decideLadder(air, { surfaceBudgetTokens: 100 });
    const { surface, enabledIds } = surfaceOver(air, lanes, new Set(["open_billing_invoices"]));
    surface.closeLanes();
    expect(surface.cards.map((card) => card.toolName)).toEqual(["open_users_users"]);
    // Losing the lane costs tokens; losing the tools would cost the agent three
    // capabilities it was approved to call, so they stay listed.
    expect(enabledIds()).toEqual([
      "billing.invoice.list",
      "billing.invoice.get",
      "billing.invoice.void",
    ]);
  });

  it("drops a lane whose operations this server never registered", () => {
    const air = estate();
    const { lanes } = decideLadder(air, { surfaceBudgetTokens: 100 });
    const surface = createLaneSurface({
      lanes,
      operations: new Map(air.operations.map((op) => [op.id, op])),
      tools: new Map<string, DisclosableTool>(),
    });
    expect(surface.cards).toEqual([]);
  });

  it("never enables a tool it was not handed", () => {
    const air = estate();
    const { lanes } = decideLadder(air, { surfaceBudgetTokens: 100 });
    const withheld = new Map<string, FakeTool>(
      air.operations
        .filter((op) => op.id !== "billing.invoice.void")
        .map((op) => [op.id, fakeTool()]),
    );
    const surface = createLaneSurface({
      lanes,
      operations: new Map(air.operations.map((op) => [op.id, op])),
      tools: withheld,
    });
    surface.closeLanes();
    const billing = surface.cards.find((card) => card.lane.capabilityId === "billing.invoices");
    const opened = billing?.open();
    expect(JSON.stringify(opened)).not.toContain("billing_invoice_void");
  });
});

describe("entry card content", () => {
  it("carries the safety posture an agent routes on", () => {
    const refund = operation({
      id: "billing.refund.create",
      displayName: "Create Refund",
      description: "Refund a captured payment.",
      effect: {
        kind: "mutation",
        action: "create",
        resource: "refund",
        risk: "high",
        reversible: false,
      },
      idempotency: {
        mode: "required",
        mechanism: "header",
        key: "Idempotency-Key",
        keyDerivation: "client_supplied",
      },
      retries: {
        mode: "none",
        basis: "unproven",
        maxAttempts: 1,
        backoff: "exponential",
        baseDelayMs: 0,
        maxDelayMs: 0,
        retryOn: [],
      },
      confirmation: { required: true },
    });
    const line = laneMemberLine(laneMember(refund));
    expect(line).toContain("billing_refund_create");
    expect(line).toContain("Refund a captured payment.");
    expect(line).toContain("mutation/create");
    expect(line).toContain("risk=high");
    expect(line).toContain("irreversible");
    expect(line).toContain("not retry-safe");
    expect(line).toContain("idempotency=required");
    expect(line).toContain("requires confirm=true");
  });

  it("bounds a pathological description to one line", () => {
    const chatty = operation({
      id: "a.b.c",
      description: `${"very ".repeat(200)}long\n\ndescription`,
    });
    const summary = laneMember(chatty).summary;
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary).not.toContain("\n");
  });

  it("names every tool it opens, so choosing costs no second round trip", () => {
    const air = estate();
    const { lanes } = decideLadder(air, { surfaceBudgetTokens: 100 });
    const billing = lanes[0] as LadderLane;
    const members = billing.operationIds.map((id) =>
      laneMember(air.operations.find((op) => op.id === id) as Operation),
    );
    const result = laneOpenResult(billing, members);
    const text = result.content[0]?.text ?? "";
    for (const member of members) expect(text).toContain(member.toolName);
    expect(result.structuredContent.capabilityId).toBe("billing.invoices");
    expect((result.structuredContent.tools as unknown[]).length).toBe(3);
  });
});

describe("decideLadder — measured accuracy in 'auto' mode", () => {
  // Every case here reuses the exact scenario a real `anvil benchmark
  // --catalog both` + `anvil serve mcp` pairing would produce: a plan that
  // would ladder on token grounds alone, plus a measured accuracy delta the
  // CLI/serve path derived from a fresh report and passed in through options.

  it("is byte-identical to pre-measurement 'auto' when no report exists", () => {
    const withoutOption = decideLadder(estateWithThreeLanes(), { surfaceBudgetTokens: 100 });
    const withUndefinedAccuracy = decideLadder(estateWithThreeLanes(), {
      surfaceBudgetTokens: 100,
      measuredAccuracy: undefined,
    });
    expect(withUndefinedAccuracy.laddered).toBe(true);
    expect(withUndefinedAccuracy.laddered).toBe(withoutOption.laddered);
    expect(withUndefinedAccuracy.decisionReason).toBe("plan");
    expect(JSON.stringify(withUndefinedAccuracy.lanes)).toBe(JSON.stringify(withoutOption.lanes));
  });

  it("ladders when the measured accuracy delta clears the floor", () => {
    const decision = decideLadder(estateWithThreeLanes(), {
      surfaceBudgetTokens: 100,
      measuredAccuracy: { ladderedMinusFlatPts: -2 },
    });
    expect(decision.laddered).toBe(true);
    expect(decision.decisionReason).toBe("plan");
    expect(decision.lanes.length).toBe(3);
  });

  it("serves flat when the measured accuracy delta falls below the floor", () => {
    // Pins the documented floor value itself, and uses a fixed literal delta
    // (not one computed from the constant under test) so a weakened floor —
    // mutant `ladder/auto-never-ladders-past-accuracy-floor` — cannot pass by
    // moving both sides of the comparison together.
    expect(MIN_LADDERED_ACCURACY_DELTA_PTS).toBe(-8);
    const decision = decideLadder(estateWithThreeLanes(), {
      surfaceBudgetTokens: 100,
      measuredAccuracy: { ladderedMinusFlatPts: -20 },
    });
    expect(decision.laddered).toBe(false);
    expect(decision.decisionReason).toBe("accuracy_below_floor");
    expect(decision.lanes).toEqual([]);
    // What was decided and what was served stay separately readable: the
    // projection itself still says it would ladder.
    expect(decision.plan.mode).toBe("laddered");
    expect(decision.plan.reason).toBe("over_budget");
  });

  it("serves flat when measured token savings miss the floor, even with a perfect accuracy delta", () => {
    expect(MIN_LADDER_TOKEN_SAVINGS_FRACTION).toBeGreaterThan(0.18);
    const decision = decideLadder(tinySavingsEstate(), {
      surfaceBudgetTokens: 10,
      measuredAccuracy: { ladderedMinusFlatPts: 0 },
    });
    expect(decision.plan.mode).toBe("laddered");
    expect(decision.laddered).toBe(false);
    expect(decision.decisionReason).toBe("token_savings_below_floor");
  });

  it("never weighs measured accuracy for a forced 'laddered' override", () => {
    // An operator's forced choice is not conditioned on measurement — see
    // DisclosureMode's own doc. A catastrophic accuracy delta must not
    // override it.
    const decision = decideLadder(estateWithThreeLanes(), {
      disclosure: "laddered",
      surfaceBudgetTokens: 1_000_000,
      measuredAccuracy: { ladderedMinusFlatPts: -1000 },
    });
    expect(decision.laddered).toBe(true);
    expect(decision.decisionReason).toBe("plan");
  });

  it("never weighs measured accuracy when the plan itself declines to ladder", () => {
    const decision = decideLadder(estateWithThreeLanes(), {
      surfaceBudgetTokens: 1_000_000, // fits the budget flat
      measuredAccuracy: { ladderedMinusFlatPts: 1000 },
    });
    expect(decision.plan.reason).toBe("fits_budget");
    expect(decision.laddered).toBe(false);
    expect(decision.decisionReason).toBe("plan");
  });
});
