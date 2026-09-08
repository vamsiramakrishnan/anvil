import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { fc, replayCampaign, runCampaign, runScenario, Step } from "@anvil/fuzz";
import { generateBundle, writeBundle } from "@anvil/generators";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bundleFuzzDrivers,
  compilePaymentFuzzFixture,
  contractProperties,
  contractScenarios,
  paymentFuzzFixture,
  paymentProperties,
  paymentScenarios,
} from "./index.js";

const cliPackageDir = fileURLToPath(new URL("../../../cli", import.meta.url));
let dir: string;
let air: AirDocument;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "anvil-fuzz-test-"));
  air = await compilePaymentFuzzFixture();
  writeBundle(dir, generateBundle(air));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("real generated payment surfaces", () => {
  it.each([
    "mcp",
    "cli",
    "python",
  ] as const)("checks %s contract wire behavior and negative gates through the generated mock", async (surface) => {
    const report = await runCampaign({
      arbitrary: contractScenarios(air),
      drivers: bundleFuzzDrivers(dir, { cliPackageDir, surfaces: [surface] }),
      properties: [contractProperties(air)],
      seed: 13,
      runs: 6,
      budgetMs: 25000,
    });
    expect(report.status, JSON.stringify(report, null, 2)).toBe("passed");
    expect(report.coverage.operations).toHaveLength(2);
  });
  it("preserves confirmation, idempotent replay and lost-response recovery on MCP, CLI and Python", async () => {
    const drivers = bundleFuzzDrivers(dir, {
      surfaces: ["mcp", "cli", "cli-mcp", "python"],
      cliPackageDir,
      fixture: paymentFuzzFixture,
    });
    const base = fc.sample(paymentScenarios(air), { seed: 13, numRuns: 1 })[0];
    if (!base) throw new Error("No generated scenario");
    const refund = base.steps.find((s) => s.id === "refund");
    if (!refund) throw new Error("No refund");
    const scenario = {
      ...base,
      steps: [
        ...base.steps
          .filter((s) => !s.id.startsWith("noise") && !["unconfirmed", "conflict"].includes(s.id))
          .map((s) =>
            s.id === "refund" ? { ...s, fault: { kind: "lost-response-after-commit" } } : s,
          ),
      ],
    };
    scenario.steps.splice(
      1,
      0,
      Step.parse({
        ...refund,
        id: "unconfirmed",
        fault: undefined,
        input: Object.fromEntries(
          Object.entries(refund.input).filter(([key]) => key !== "confirm"),
        ),
      }),
    );
    const report = await runScenario(scenario, drivers, [paymentProperties(air)]);
    expect(
      report.checks.filter((c) => c.status !== "passed"),
      JSON.stringify(report, null, 2),
    ).toEqual([]);
    expect(
      report.traces.every((t) =>
        t.events.some((e) => (e.outcome.effects as { dropped?: number })?.dropped === 1),
      ),
    ).toBe(true);
  });

  it("finds a planted Python key-regeneration defect, minimizes it, and proves the repair", async () => {
    const path = join(dir, "sdk/python/anvil_fuzz_payments/client.py");
    const original = readFileSync(path, "utf8");
    expect(original).toContain("idempotency_key=idempotency_key,");
    writeFileSync(
      path,
      original.replace(
        "idempotency_key=idempotency_key,",
        "idempotency_key=__import__('uuid').uuid4().hex if idempotency_key else None,",
      ),
    );
    try {
      const report = await runCampaign({
        arbitrary: paymentScenarios(air),
        drivers: bundleFuzzDrivers(dir, { surfaces: ["python"], fixture: paymentFuzzFixture }),
        properties: [paymentProperties(air)],
        seed: 39,
        runs: 5,
        budgetMs: 60_000,
      });
      expect(report.status, JSON.stringify(report, null, 2)).toBe("failed");
      expect(report.replay?.scenario.steps).toHaveLength(3);
      expect(report.replay?.scenario.steps.find((s) => s.id === "refund")?.input.amount).toBe(1);
      if (!report.replay) throw new Error("No minimized replay");
      const broken = await replayCampaign(report.replay, {
        drivers: bundleFuzzDrivers(dir, { surfaces: ["python"], fixture: paymentFuzzFixture }),
        properties: [paymentProperties(air)],
      });
      expect(broken.status).toBe("failed");
      writeFileSync(path, original);
      const repaired = await replayCampaign(report.replay, {
        drivers: bundleFuzzDrivers(dir, { surfaces: ["python"], fixture: paymentFuzzFixture }),
        properties: [paymentProperties(air)],
      });
      expect(repaired.status, JSON.stringify(repaired, null, 2)).toBe("passed");
    } finally {
      writeFileSync(path, original);
    }
  });

  it("leaves the source bundle untouched and marks absent CLI configuration unsupported", async () => {
    const before = readFileSync(join(dir, "air.yaml"), "utf8");
    const scenario = fc.sample(paymentScenarios(air), { seed: 2, numRuns: 1 })[0];
    if (!scenario) throw new Error("No scenario");
    const report = await runScenario(scenario, bundleFuzzDrivers(dir, { surfaces: ["cli"] }), [
      paymentProperties(air),
    ]);
    expect(report.checks.some((c) => c.status === "unsupported")).toBe(true);
    expect(readFileSync(join(dir, "air.yaml"), "utf8")).toBe(before);
  });
});
