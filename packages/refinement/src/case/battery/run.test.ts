import { describe, expect, it } from "vitest";
import { BATTERY_SCENARIOS, runBattery } from "./index.js";

/**
 * The deterministic baseline-vs-investigation comparison. This is scripted and
 * illustrative — it shows *which deficiency classes need investigation over the
 * deterministic executor* without a real agent. It is distinct from the opt-in
 * effectiveness battery, which invokes the real driver and hides its answer labels.
 */
describe("scripted baseline-vs-investigation battery", () => {
  it("every exemplar matches its expected outcome", async () => {
    const report = await runBattery(BATTERY_SCENARIOS);
    const mismatched = report.rows.filter((r) => !r.matchedExpectation).map((r) => r.id);
    expect(mismatched, `mismatched: ${mismatched.join(", ")}`).toEqual([]);
  });

  it("shows the investigation closing gaps the deterministic baseline cannot", async () => {
    const report = await runBattery(BATTERY_SCENARIOS);
    // The deterministic baseline closes only the schema-native example.
    expect(report.totals.investigationOnly).toBeGreaterThan(0);
    // At least one contradiction is surfaced rather than forced into a proposal.
    expect(report.totals.conflictsFound).toBeGreaterThan(0);
    // At least one honest decline.
    expect(report.totals.declined).toBeGreaterThan(0);
  });
});
