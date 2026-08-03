import { type AirDocument, Capability, type LadderLane, Operation } from "@anvil/air";
import { describe, expect, it } from "vitest";
import {
  createLaneSurface,
  type DisclosableTool,
  decideLadder,
  laneMember,
  laneMemberLine,
  laneOpenResult,
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
  const air: AirDocument = {
    service: { id: "test", version: "1.0.0" },
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
  };
  return air;
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
    const air = { service: { id: "test", version: "1.0.0" }, operations: [operation({ id: "a" })] };
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
      retries: { mode: "none", maxAttempts: 1, backoff: "exponential", retryOn: [] },
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
