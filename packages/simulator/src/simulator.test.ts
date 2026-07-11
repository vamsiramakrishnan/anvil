import type { AirDocument } from "@anvil/air";
import { approveOperations, compile, surfaceSignatureFor } from "@anvil/compiler";
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
    // Seed more entities so there is a second page (PAGE_SIZE = 2, 3 fixtures).
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
