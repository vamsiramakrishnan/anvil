import { planLegacyBridge } from "@anvil/compiler/legacy";
import { describe, expect, it } from "vitest";
import { runLegacyBridgeConformance } from "./conformance.js";
import { fixtureLegacyCapabilityBinding } from "./test-fixtures.js";

describe("runLegacyBridgeConformance", () => {
  it("passes every required case and the three fixed invariants, and promotes the binding", async () => {
    const binding = fixtureLegacyCapabilityBinding();
    const plan = planLegacyBridge(binding);

    const { report, promotedBinding } = await runLegacyBridgeConformance(binding, plan);

    expect(report.planId).toBe(plan.planId);
    expect(report.bindingId).toBe(binding.bindingId);
    expect(report.brokerDouble).toBe("in_process_double");
    // Every required plan case is present as a check, plus the three fixed
    // invariants — the report proves more than the plan strictly asked for.
    const checkIds = report.checks.map((check) => check.id);
    for (const testCase of plan.conformance) expect(checkIds).toContain(testCase.id);
    for (const invariant of [
      "idempotent_replay",
      "timeout_maps_to_structured_error",
      "non_idempotent_never_auto_retried",
    ]) {
      expect(checkIds).toContain(`legacy-bridge/invariant/${invariant}`);
    }
    const failed = report.checks.filter((check) => check.status === "fail");
    expect(failed).toEqual([]);

    expect(promotedBinding).toBeDefined();
    expect(promotedBinding?.runtime.status).toBe("conformance_passed");
    if (promotedBinding?.runtime.status === "conformance_passed") {
      expect(promotedBinding.runtime.conformanceReportHash).toBe(report.contentHash);
    }
    // Promotion changes only `runtime` — every other reviewed fact, and the
    // full lineage back to the inventory, carries over unchanged.
    expect(promotedBinding?.operation).toEqual(binding.operation);
    expect(promotedBinding?.transport).toEqual(binding.transport);
    expect(promotedBinding?.semantics).toEqual(binding.semantics);
    expect(promotedBinding?.proposalId).toBe(binding.proposalId);
    expect(promotedBinding?.receiptId).toBe(binding.receiptId);
    expect(promotedBinding?.bindingId).not.toBe(binding.bindingId);
  });

  it("is deterministic — running it twice on the same fixture produces the same report content", async () => {
    const binding = fixtureLegacyCapabilityBinding();
    const plan = planLegacyBridge(binding);
    const first = await runLegacyBridgeConformance(binding, plan);
    const second = await runLegacyBridgeConformance(binding, plan);
    expect(second.report.contentHash).toBe(first.report.contentHash);
  });

  it("refuses a plan bound to a different binding", async () => {
    const binding = fixtureLegacyCapabilityBinding();
    const otherBinding = fixtureLegacyCapabilityBinding({ timeoutMs: 999 });
    const plan = planLegacyBridge(binding);
    await expect(runLegacyBridgeConformance(otherBinding, plan)).rejects.toThrow(
      /bound to a different binding/,
    );
  });
});
