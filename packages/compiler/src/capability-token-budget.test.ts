import type { AirDocument, Capability } from "@anvil/air";
import { DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS } from "@anvil/air";
import { describe, expect, it } from "vitest";
import {
  approveCapability,
  BUDGET_BLOCKED_CODE,
  BUDGET_TOKEN_BLOCKED_CODE,
  BUDGET_TOKEN_WAIVED_CODE,
  BUDGET_TOKEN_WARNING_CODE,
  BUDGET_WAIVED_CODE,
  CAPABILITY_TOKEN_BUDGET,
  CAPABILITY_TOOL_BUDGET,
  type CapabilityReviewError,
  capabilityDisclosureBudget,
  capabilityToolBudget,
  proposeCapabilities,
} from "./capability-review.js";
import { compile } from "./compile.js";
import { measureAirDisclosure, TOKEN_ESTIMATOR_ID } from "./disclosure-cost.js";

/** `count` operations under one tag — the same fixture shape the count band uses. */
function specWithOps(count: number, description = ""): string {
  const summary = description ? `      description: "${description}"\n` : "";
  const paths = Array.from({ length: count }, (_, i) =>
    [
      `  /things${i}:`,
      "    get:",
      `      operationId: getThing${i}`,
      "      tags: [things]",
      summary.trimEnd(),
      '      responses: { "200": { description: ok } }',
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  ).join("\n");
  return `openapi: 3.0.0\ninfo: { title: things, version: 1.0.0 }\npaths:\n${paths}\n`;
}

/**
 * Stamp a chosen tool-surface cost on the first `measured` operations, and clear
 * it from the rest. Clearing is the load-bearing half: `compile` measures every
 * operation it produces, so a partial-measurement case has to *remove* the real
 * figures it does not want rather than assume they were never there.
 */
function stampCost(air: AirDocument, toolTokens: number, measured = air.operations.length): void {
  air.operations.forEach((operation, index) => {
    if (index >= measured) {
      operation.disclosureCost = undefined;
      return;
    }
    operation.disclosureCost = {
      toolTokens,
      responseTokens: 0,
      responseItemTokens: 0,
      charsPerToken: 4,
      estimator: TOKEN_ESTIMATOR_ID,
    };
  });
}

/**
 * Strip every measurement, standing in for a document that predates disclosure
 * measurement — a bundle compiled by an older Anvil, or AIR loaded from disk.
 * Those documents still have to flow through review untouched.
 */
function clearCosts(air: AirDocument): void {
  for (const operation of air.operations) operation.disclosureCost = undefined;
}

function onlyCapability(air: AirDocument): string {
  const id = air.capabilities[0]?.id;
  if (!id) throw new Error("expected a discovered capability");
  return id;
}

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

describe("the token band is the count band in its true unit", () => {
  it("derives its thresholds from the per-operation disclosure budget", () => {
    expect(CAPABILITY_TOKEN_BUDGET.idealMax).toBe(
      DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS * CAPABILITY_TOOL_BUDGET.idealMax,
    );
    expect(CAPABILITY_TOKEN_BUDGET.blockAbove).toBe(
      DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS * CAPABILITY_TOOL_BUDGET.blockAbove,
    );
  });

  it("agrees with the count band on averagely-sized tools", async () => {
    const air = await compile({ spec: specWithOps(16), serviceId: "things" });
    stampCost(air, DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS / 2);
    const check = capabilityDisclosureBudget(air, onlyCapability(air));
    // 16 tools at half a budget each: over the count band, inside the token
    // band. The dimensions are meant to diverge only on tool *size*.
    expect(check.diagnostic?.code).toBe("capability_tool_budget");
    expect(check.tokenDiagnostic).toBeUndefined();
    expect(check.verdict).toBe("warning");
  });
});

describe("unmeasured capabilities behave exactly as before", () => {
  it("keeps the count verdicts and reports no token figure", () => {
    for (const [n, verdict] of [
      [1, "ok"],
      [5, "ok"],
      [15, "ok"],
      [16, "warning"],
      [20, "warning"],
      [21, "blocked"],
    ] as const) {
      const check = capabilityToolBudget(capWithOps(n));
      expect(check.verdict).toBe(verdict);
      expect(check.toolCount).toBe(n);
      expect(check.disclosureTokens).toBeUndefined();
      expect(check.tokenDiagnostic).toBeUndefined();
    }
  });

  it("never newly blocks a capability nobody has measured", async () => {
    // 15 operations, none measured: absence of evidence is not evidence of a
    // problem, and approval must not depend on whether a measurement pass
    // happened to run over this document. `compile` measures what it produces,
    // so the unmeasured document under test is one that predates it.
    const air = await compile({ spec: specWithOps(15), serviceId: "things" });
    clearCosts(air);
    const id = onlyCapability(air);
    const check = capabilityDisclosureBudget(air, id);
    expect(check.verdict).toBe("ok");
    expect(check.diagnostic).toBeUndefined();
    expect(check.disclosureTokens).toBeUndefined();
    expect(check.measuredOperations).toBe(0);
    expect(() => approveCapability(air, id)).not.toThrow();
    expect(air.diagnostics.some((d) => d.code.startsWith("capability_disclosure_token"))).toBe(
      false,
    );
  });
});

describe("measured tool size, which the count band could not see", () => {
  it("warns on a small capability made of large tools", async () => {
    const air = await compile({ spec: specWithOps(8), serviceId: "things" });
    stampCost(air, 2_500); // 8 tools, 20_000 tokens — well inside the count band
    const check = capabilityDisclosureBudget(air, onlyCapability(air));

    expect(check.toolCount).toBe(8);
    expect(check.disclosureTokens).toBe(20_000);
    expect(check.measuredOperations).toBe(8);
    expect(check.unmeasuredOperations).toBe(0);
    expect(check.verdict).toBe("warning");
    // The count dimension is clean, so the token finding governs.
    expect(check.diagnostic?.code).toBe(BUDGET_TOKEN_WARNING_CODE);
    expect(check.tokenDiagnostic).toBe(check.diagnostic);
    expect(check.diagnostic?.message).toContain("20000");
  });

  it("blocks approval on a measured overrun and records one waiver per dimension", async () => {
    const air = await compile({ spec: specWithOps(8), serviceId: "things" });
    stampCost(air, 4_000); // 32_000 tokens across 8 tools
    const id = onlyCapability(air);
    const check = capabilityDisclosureBudget(air, id);
    expect(check.verdict).toBe("blocked");
    expect(check.diagnostic?.code).toBe(BUDGET_TOKEN_BLOCKED_CODE);
    expect(check.diagnostic?.level).toBe("error");

    try {
      approveCapability(air, id);
      expect.unreachable();
    } catch (err) {
      const e = err as CapabilityReviewError;
      expect(e.code).toBe("capability_budget_exceeded");
      expect(e.diagnostic?.code).toBe(BUDGET_TOKEN_BLOCKED_CODE);
    }
    expect(air.capabilities[0]?.lifecycle).toBe("proposed"); // refusal did not mutate

    expect(() => approveCapability(air, id, { allowLarge: true })).toThrowError(
      expect.objectContaining({ code: "capability_budget_waiver_note_required" }),
    );
    const waived = approveCapability(air, id, {
      allowLarge: true,
      note: "Deliberately one large disclosure unit.",
    });
    expect(waived.verdict).toBe("warning");
    expect(waived.tokenDiagnostic?.code).toBe(BUDGET_TOKEN_WAIVED_CODE);
    expect(air.diagnostics.filter((d) => d.code === BUDGET_TOKEN_WAIVED_CODE)).toHaveLength(1);
  });

  it("treats a partial measurement as a lower bound, and says so", async () => {
    const air = await compile({ spec: specWithOps(20), serviceId: "things" });
    stampCost(air, 3_000, 9); // only 9 of 20 measured — already 27_000 tokens
    const check = capabilityDisclosureBudget(air, onlyCapability(air));

    expect(check.disclosureTokens).toBe(27_000);
    expect(check.measuredOperations).toBe(9);
    expect(check.unmeasuredOperations).toBe(11);
    // A lower bound can only grow, so an overrun on it is sound evidence; the
    // message must not let a reviewer mistake the bound for the whole figure.
    expect(check.verdict).toBe("blocked");
    expect(check.tokenDiagnostic?.message).toContain("measured 9 of 20");
    // 20 tools also trips the count *warning*; the blocking dimension is the one
    // that must explain the verdict.
    expect(check.countDiagnostic?.level).toBe("warning");
    expect(check.diagnostic).toBe(check.tokenDiagnostic);
  });

  it("does not clear a count finding it knows nothing about", async () => {
    const air = await compile({ spec: specWithOps(21), serviceId: "things" });
    stampCost(air, 10); // trivially small tools, but 21 of them
    const check = capabilityDisclosureBudget(air, onlyCapability(air));
    expect(check.disclosureTokens).toBe(210);
    expect(check.verdict).toBe("blocked");
    expect(check.diagnostic?.code).toBe(BUDGET_BLOCKED_CODE);
    expect(check.tokenDiagnostic).toBeUndefined();
  });

  it("keeps the count diagnostic governing when both dimensions blow", async () => {
    const air = await compile({ spec: specWithOps(21), serviceId: "things" });
    stampCost(air, 2_000); // 21 tools and 42_000 tokens
    const id = onlyCapability(air);
    const check = capabilityDisclosureBudget(air, id);
    // Compatibility: every existing consumer of `diagnostic` keeps reading the
    // count finding it read before tokens existed; the token finding is
    // additive, never a replacement.
    expect(check.diagnostic?.code).toBe(BUDGET_BLOCKED_CODE);
    expect(check.tokenDiagnostic?.code).toBe(BUDGET_TOKEN_BLOCKED_CODE);

    const waived = approveCapability(air, id, { allowLarge: true, note: "Reviewed." });
    expect(waived.diagnostic?.code).toBe(BUDGET_WAIVED_CODE);
    expect(waived.tokenDiagnostic?.code).toBe(BUDGET_TOKEN_WAIVED_CODE);
    // Both waivers are auditable: accepting 21 tools is not the same decision
    // as accepting 42_000 tokens of surface.
    const codes = air.diagnostics.map((d) => d.code);
    expect(codes).toContain(BUDGET_WAIVED_CODE);
    expect(codes).toContain(BUDGET_TOKEN_WAIVED_CODE);
  });

  it("a composite workflow tool is an unmeasured entry, never a free one", async () => {
    const air = await compile({
      spec: specWithOps(8),
      serviceId: "things",
      manifest: `workflows:
  pair:
    capability: things.things
    state: approved
    steps:
      - operation: getThing0
      - operation: getThing1
`,
    });
    stampCost(air, 2_500);
    const check = capabilityDisclosureBudget(air, onlyCapability(air));

    // The composite raises the count dimension (+1 tool) AND enters the token
    // dimension as an unmeasured tool: every member is measured, yet the
    // measurement no longer claims completeness, because the workflow tool the
    // wrapping created has a real disclosure cost nothing has priced. Counted
    // at zero it was free context — a capability could wrap its largest
    // operations and report a complete low figure while the served workflow
    // tools pushed the surface over the band.
    expect(check.toolCount).toBe(9);
    expect(check.workflowTools).toBe(1);
    expect(check.measuredOperations).toBe(8);
    expect(check.unmeasuredOperations).toBe(1);
    expect(check.disclosureTokens).toBe(20_000);
    expect(check.verdict).toBe("warning");
    expect(check.tokenDiagnostic?.message).toContain("measured 8 of 9 disclosed tools");
    expect(check.tokenDiagnostic?.message).toContain("the real figure is higher");
  });

  it("annotates proposals with the same measured figure", async () => {
    const air = await compile({ spec: specWithOps(8), serviceId: "things" });
    stampCost(air, 2_500);
    const proposal = proposeCapabilities(air)[0];
    expect(proposal?.budget.disclosureTokens).toBe(20_000);
    expect(proposal?.budget.verdict).toBe("warning");
  });
});

describe("end to end: real measurement drives the verdict", () => {
  it("blocks a capability of genuinely oversized tools", async () => {
    const bloat = "The upstream returns a record with several fields. ".repeat(400);
    const air = measureAirDisclosure(
      await compile({ spec: specWithOps(8, bloat), serviceId: "things" }),
    );
    const check = capabilityDisclosureBudget(air, onlyCapability(air));

    // Eight tools — squarely inside the 5–15 band that has always been called
    // healthy — yet no agent could load them. That gap is the whole point.
    expect(check.toolCount).toBe(8);
    expect(check.disclosureTokens ?? 0).toBeGreaterThan(CAPABILITY_TOKEN_BUDGET.blockAbove);
    expect(check.verdict).toBe("blocked");
    expect(check.diagnostic?.code).toBe(BUDGET_TOKEN_BLOCKED_CODE);
  });

  it("passes an ordinary capability of the same shape", async () => {
    const air = measureAirDisclosure(await compile({ spec: specWithOps(8), serviceId: "things" }));
    const check = capabilityDisclosureBudget(air, onlyCapability(air));
    expect(check.measuredOperations).toBe(8);
    expect(check.disclosureTokens ?? 0).toBeLessThan(CAPABILITY_TOKEN_BUDGET.idealMax);
    expect(check.verdict).toBe("ok");
    expect(check.diagnostic).toBeUndefined();
  });
});
