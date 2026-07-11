import { airFromYaml, airToYaml, type Capability } from "@anvil/air";
import { describe, expect, it } from "vitest";
import {
  approveCapability,
  BUDGET_BLOCKED_CODE,
  BUDGET_WARNING_CODE,
  CapabilityReviewError,
  capabilityToolBudget,
  diffCapability,
  proposeCapabilities,
  rejectCapability,
} from "./capability-review.js";
import { compile } from "./compile.js";

/** A spec with `count` operations under one tag, to exercise the tool budget. */
function specWithOps(count: number): string {
  const paths = Array.from({ length: count }, (_, i) =>
    [
      `  /things${i}:`,
      "    get:",
      `      operationId: getThing${i}`,
      "      tags: [things]",
      '      responses: { "200": { description: ok } }',
    ].join("\n"),
  ).join("\n");
  return `openapi: 3.0.0\ninfo: { title: things, version: 1.0.0 }\npaths:\n${paths}\n`;
}

describe("capability review lifecycle", () => {
  it("discovery proposes; the lifecycle defaults to 'proposed'", async () => {
    const air = await compile({ spec: specWithOps(3), serviceId: "things" });
    expect(air.capabilities.length).toBeGreaterThan(0);
    for (const cap of air.capabilities) expect(cap.lifecycle).toBe("proposed");
    // The derived member-state summary is still present alongside the lifecycle.
    for (const cap of air.capabilities) expect(cap.state).toBeDefined();
  });

  it("loads pre-lifecycle AIR files unchanged (backward compatible defaults)", async () => {
    const air = await compile({ spec: specWithOps(2), serviceId: "things" });
    // Simulate an AIR file written before the lifecycle existed.
    const yaml = airToYaml(air)
      .split("\n")
      .filter((line) => !line.includes("lifecycle:"))
      .join("\n");
    expect(yaml).not.toContain("lifecycle:");
    const reloaded = airFromYaml(yaml);
    for (const cap of reloaded.capabilities) {
      expect(cap.lifecycle).toBe("proposed");
      expect(cap.reviewNote).toBeUndefined();
    }
  });

  it("approve and reject persist through the AIR round-trip", async () => {
    const air = await compile({ spec: specWithOps(2), serviceId: "things" });
    const id = air.capabilities[0]?.id as string;
    approveCapability(air, id, { note: "reviewed" });
    const reloaded = airFromYaml(airToYaml(air));
    const cap = reloaded.capabilities.find((c) => c.id === id) as Capability;
    expect(cap.lifecycle).toBe("approved");
    expect(cap.reviewNote).toBe("reviewed");

    rejectCapability(reloaded, id, "wrong grouping");
    const again = airFromYaml(airToYaml(reloaded));
    expect(again.capabilities[0]?.lifecycle).toBe("rejected");
    expect(again.capabilities[0]?.reviewNote).toBe("wrong grouping");
  });

  it("rejects an unknown capability with a typed error", async () => {
    const air = await compile({ spec: specWithOps(1), serviceId: "things" });
    expect(() => approveCapability(air, "things.nope")).toThrowError(CapabilityReviewError);
    try {
      rejectCapability(air, "things.nope");
      expect.unreachable();
    } catch (err) {
      expect((err as CapabilityReviewError).code).toBe("capability_not_found");
    }
  });
});

describe("tool budget (deterministic, typed diagnostic)", () => {
  const capWithOps = (n: number): Capability => ({
    id: "svc.big",
    displayName: "Big",
    description: "",
    source: "tag",
    resources: [],
    operationIds: Array.from({ length: n }, (_, i) => `svc.big.op${i}`),
    workflowIds: [],
    intentExamples: [],
    state: "generated",
    lifecycle: "proposed",
    evidence: { claims: [] },
  });

  it("is ok within the default 5–15 disclosure band (and below it)", () => {
    for (const n of [1, 5, 15]) {
      const check = capabilityToolBudget(capWithOps(n));
      expect(check.verdict).toBe("ok");
      expect(check.diagnostic).toBeUndefined();
      expect(check.toolCount).toBe(n);
    }
  });

  it("warns above 15 without blocking approval", async () => {
    const check = capabilityToolBudget(capWithOps(16));
    expect(check.verdict).toBe("warning");
    expect(check.diagnostic?.level).toBe("warning");
    expect(check.diagnostic?.code).toBe(BUDGET_WARNING_CODE);
    expect(check.diagnostic?.capabilityId).toBe("svc.big");

    const air = await compile({ spec: specWithOps(16), serviceId: "things" });
    const id = air.capabilities[0]?.id as string;
    const budget = approveCapability(air, id);
    expect(budget.verdict).toBe("warning");
    expect(air.capabilities[0]?.lifecycle).toBe("approved");
  });

  it("blocks approval above 20 without --allow-large (structured diagnostic)", async () => {
    expect(capabilityToolBudget(capWithOps(20)).verdict).toBe("warning");
    expect(capabilityToolBudget(capWithOps(21)).verdict).toBe("blocked");

    const air = await compile({ spec: specWithOps(21), serviceId: "things" });
    const id = air.capabilities[0]?.id as string;
    try {
      approveCapability(air, id);
      expect.unreachable();
    } catch (err) {
      const e = err as CapabilityReviewError;
      expect(e).toBeInstanceOf(CapabilityReviewError);
      expect(e.code).toBe("capability_budget_exceeded");
      expect(e.diagnostic?.level).toBe("error");
      expect(e.diagnostic?.code).toBe(BUDGET_BLOCKED_CODE);
      expect(e.diagnostic?.capabilityId).toBe(id);
    }
    expect(air.capabilities[0]?.lifecycle).toBe("proposed"); // refusal did not mutate

    // The deliberate override records the approval.
    const budget = approveCapability(air, id, { allowLarge: true });
    expect(budget.verdict).toBe("blocked");
    expect(air.capabilities[0]?.lifecycle).toBe("approved");
  });
});

describe("propose + diff (re-discovery without mutation)", () => {
  it("carries stored review decisions into fresh proposals by id", async () => {
    const air = await compile({ spec: specWithOps(3), serviceId: "things" });
    const id = air.capabilities[0]?.id as string;
    approveCapability(air, id, { note: "keep" });
    const proposals = proposeCapabilities(air);
    const match = proposals.find((p) => p.capability.id === id);
    expect(match?.capability.lifecycle).toBe("approved");
    expect(match?.capability.reviewNote).toBe("keep");
    expect(match?.isNew).toBe(false);
    // Proposing never mutates the loaded document's operations.
    expect(air.operations.every((op) => op.capabilityId === id)).toBe(true);
  });

  it("reports no drift when the stored grouping matches discovery", async () => {
    const air = await compile({ spec: specWithOps(3), serviceId: "things" });
    const id = air.capabilities[0]?.id as string;
    const diff = diffCapability(air, id);
    expect(diff.unchanged).toBe(true);
    expect(diff.present).toBe(true);
  });

  it("reports added and removed operations against fresh discovery", async () => {
    const air = await compile({ spec: specWithOps(3), serviceId: "things" });
    const cap = air.capabilities[0] as Capability;
    const dropped = cap.operationIds.pop() as string; // stored no longer lists it
    cap.operationIds.push("things.things.phantom"); // stored lists a ghost
    const diff = diffCapability(air, cap.id);
    expect(diff.unchanged).toBe(false);
    expect(diff.addedOperations).toContain(dropped);
    expect(diff.removedOperations).toContain("things.things.phantom");
  });
});
