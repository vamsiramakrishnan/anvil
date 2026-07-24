import { airFromYaml, airToYaml, type Capability } from "@anvil/air";
import { describe, expect, it } from "vitest";
import {
  approveCapability,
  BUDGET_BLOCKED_CODE,
  BUDGET_WAIVED_CODE,
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

/** 15 direct tools plus 6 authored workflow dependencies from another grouping. */
function specWithWorkflowClosure(): string {
  const paths = Array.from({ length: 21 }, (_, i) =>
    [
      `  /things${i}:`,
      "    get:",
      `      operationId: getThing${i}`,
      `      tags: [${i < 15 ? "primary" : "support"}]`,
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

  it("applies exact-id capability review decisions from the supplemental manifest", async () => {
    const air = await compile({
      spec: specWithOps(2),
      serviceId: "things",
      manifest: `capabilities:
  things.things:
    state: approved
    note: reviewed with the source and gateway evidence
`,
    });
    expect(air.capabilities).toHaveLength(1);
    expect(air.capabilities[0]).toMatchObject({
      id: "things.things",
      lifecycle: "approved",
      reviewNote: "reviewed with the source and gateway evidence",
    });
  });

  it("applies manifest rejection without changing member operation approval", async () => {
    const air = await compile({
      spec: specWithOps(2),
      serviceId: "things",
      manifest: `operations:
  getThing0:
    state: approved
capabilities:
  things.things:
    state: rejected
    note: This grouping is not the right release unit.
`,
    });
    expect(air.capabilities[0]).toMatchObject({
      lifecycle: "rejected",
      reviewNote: "This grouping is not the right release unit.",
    });
    expect(
      air.operations.find((operation) => operation.sourceRef.operationId === "getThing0")?.state,
    ).toBe("approved");
    expect(
      air.operations.find((operation) => operation.sourceRef.operationId === "getThing1")?.state,
    ).not.toBe("approved");
  });

  it("rejects an unknown manifest capability id with the typed review error", async () => {
    try {
      await compile({
        spec: specWithOps(1),
        serviceId: "things",
        manifest: `capabilities:
  things.nope:
    state: approved
`,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityReviewError);
      expect((err as CapabilityReviewError).code).toBe("capability_not_found");
      expect((err as Error).message).toContain("Known capabilities: things.things");
    }
  });

  it("resolves exact capability ids after service and resource-name overrides", async () => {
    const renamed = `service:
  name: renamed
operations:
  getThing0:
    name:
      resource: records
capabilities:
  renamed.record:
    state: approved
`;
    const untaggedSpec = specWithOps(1).replace("      tags: [things]\n", "");
    const air = await compile({ spec: untaggedSpec, manifest: renamed });
    expect(air.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "renamed.record", lifecycle: "approved" }),
      ]),
    );

    await expect(
      compile({
        spec: untaggedSpec,
        manifest: renamed.replace("renamed.record:", "things.thing:"),
      }),
    ).rejects.toMatchObject({
      name: "CapabilityReviewError",
      code: "capability_not_found",
      message: expect.stringContaining("Known capabilities: renamed.record"),
    });
  });

  it("is invariant to capability decision map order", async () => {
    const spec = specWithWorkflowClosure();
    const first = await compile({
      spec,
      serviceId: "things",
      manifest: `capabilities:
  things.support:
    state: rejected
    note: split support
  things.primary:
    state: approved
    note: primary reviewed
`,
    });
    const reversed = await compile({
      spec,
      serviceId: "things",
      manifest: `capabilities:
  things.primary:
    note: primary reviewed
    state: approved
  things.support:
    note: split support
    state: rejected
`,
    });
    expect(airToYaml(reversed)).toBe(airToYaml(first));
  });

  it("rejects meaningless or unaudited allow_large manifest declarations", async () => {
    await expect(
      compile({
        spec: specWithOps(1),
        serviceId: "things",
        manifest: `capabilities:
  things.things:
    state: rejected
    allow_large: false
`,
      }),
    ).rejects.toThrow("allow_large is valid only for an approved capability review");

    await expect(
      compile({
        spec: specWithOps(21),
        serviceId: "things",
        manifest: `capabilities:
  things.things:
    state: approved
    allow_large: true
`,
      }),
    ).rejects.toThrow("a non-empty review note is required when allow_large is true");
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
    expect(air.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warning",
          code: BUDGET_WARNING_CODE,
          capabilityId: id,
        }),
      ]),
    );

    rejectCapability(air, id, "Do not expose this grouping.");
    expect(air.diagnostics.some((diagnostic) => diagnostic.code === BUDGET_WARNING_CODE)).toBe(
      false,
    );
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
    expect(() => approveCapability(air, id, { allowLarge: true })).toThrowError(
      expect.objectContaining({ code: "capability_budget_waiver_note_required" }),
    );
    const budget = approveCapability(air, id, {
      allowLarge: true,
      note: "Reviewed as one deliberately large disclosure unit.",
    });
    expect(budget.verdict).toBe("warning");
    expect(budget.diagnostic?.code).toBe(BUDGET_WAIVED_CODE);
    expect(air.capabilities[0]?.lifecycle).toBe("approved");
    expect(air.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warning",
          code: BUDGET_WAIVED_CODE,
          capabilityId: id,
        }),
      ]),
    );
  });

  it("enforces the same typed budget gate for manifest approval and requires allow_large", async () => {
    const review = `capabilities:
  things.things:
    state: approved
`;
    try {
      await compile({ spec: specWithOps(21), serviceId: "things", manifest: review });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityReviewError);
      expect((err as CapabilityReviewError).code).toBe("capability_budget_exceeded");
      expect((err as CapabilityReviewError).diagnostic?.code).toBe(BUDGET_BLOCKED_CODE);
    }

    const overridden = await compile({
      spec: specWithOps(21),
      serviceId: "things",
      manifest: `${review}    allow_large: true
    note: Deliberately reviewed as one large disclosure unit.
`,
    });
    expect(overridden.capabilities[0]?.lifecycle).toBe("approved");
    expect(overridden.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warning",
          code: BUDGET_WAIVED_CODE,
          capabilityId: "things.things",
        }),
      ]),
    );
  });

  it("budgets the unique authored-workflow dependency closure before manifest approval", async () => {
    const workflow = `workflows:
  cross_group:
    capability: things.primary
    steps:
${Array.from({ length: 6 }, (_, index) => `      - operation: getThing${index + 15}`).join("\n")}
capabilities:
  things.primary:
    state: approved
`;
    try {
      await compile({
        spec: specWithWorkflowClosure(),
        serviceId: "things",
        manifest: workflow,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityReviewError);
      expect((err as CapabilityReviewError).code).toBe("capability_budget_exceeded");
      expect((err as CapabilityReviewError).diagnostic).toMatchObject({
        capabilityId: "things.primary",
        code: BUDGET_BLOCKED_CODE,
        message: expect.stringContaining("21 tools"),
      });
    }

    const overridden = await compile({
      spec: specWithWorkflowClosure(),
      serviceId: "things",
      manifest: `${workflow}    allow_large: true
    note: Reviewed all 15 direct tools and 6 workflow dependencies.
`,
    });
    expect(overridden.capabilities.find((cap) => cap.id === "things.primary")).toMatchObject({
      lifecycle: "approved",
    });
    expect(overridden.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: BUDGET_WAIVED_CODE,
          capabilityId: "things.primary",
          message: expect.stringContaining("21 tools"),
        }),
      ]),
    );
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
