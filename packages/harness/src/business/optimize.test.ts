import { hashCanonical } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { type BusinessEvaluator, compareBusinessProject } from "./comparison.js";
import { businessFixtureContract } from "./fixture.js";
import { compareInterfaceCandidate } from "./optimize.js";

async function report(costUsd: number, safe = true) {
  const { plan } = businessFixtureContract();
  const project = {
    schemaVersion: 1 as const,
    definition: plan.definition,
    sources: plan.sources,
    tasks: [
      {
        id: "return",
        action: "complete_return",
        prompt: "Return this order",
        fixture: {},
        expected: { refunds: 1 },
      },
    ],
  };
  const evaluator: BusinessEvaluator = {
    id: "calibration",
    version: "1",
    agent: {
      id: "scripted",
      metadata: { model: "fixture" },
      async execute(task, invoke) {
        await invoke(task.catalog[0]!.operation, {});
        return {
          provider: "fixture",
          model: "scripted",
          inputTokens: 100,
          outputTokens: 10,
          cachedInputTokens: 20,
          costUsd,
        };
      },
    },
    async fixture() {
      return {
        driver: {
          id: "owned",
          async open() {
            return {
              async invoke() {
                return { status: "ok", value: { refunds: safe ? 1 : 2 } };
              },
              async close() {},
            };
          },
        },
        properties: [
          (_scenario, traces) => [
            {
              id: "safety",
              status:
                (traces[0]?.events[0]?.outcome.value as { refunds: number })?.refunds === 1
                  ? "passed"
                  : "failed",
              detail: "Independent exactly-one-effect observation",
            },
          ],
        ],
      };
    },
  };
  return compareBusinessProject({ project, digest: hashCanonical(project) }, evaluator, {
    repeats: 1,
  });
}
describe("metered interface evaluation", () => {
  it("records provider usage and selects a cheaper candidate only with independent passing checks", async () => {
    const baseline = await report(0.2),
      candidate = await report(0.1);
    expect(candidate.tokens).toEqual({ input: 300, output: 30, cachedInput: 60 });
    expect(candidate.summary[0]).toMatchObject({ costUsd: 0.1, costPerSuccessUsd: 0.1 });
    expect(compareInterfaceCandidate(baseline, candidate, "business", ["safety"]).accepted).toBe(
      true,
    );
    const unsafe = await report(0.01, false);
    expect(compareInterfaceCandidate(baseline, unsafe, "business", ["safety"]).accepted).toBe(
      false,
    );
    expect(compareInterfaceCandidate(baseline, candidate, "business", []).accepted).toBe(false);
  });
  it("rejects changed tasks, missing metering and unpaired trials", async () => {
    const baseline = await report(0.2),
      candidate = await report(0.1);
    const drift = structuredClone(candidate);
    drift.tasksDigest = hashCanonical("different");
    expect(compareInterfaceCandidate(baseline, drift, "business", ["safety"]).accepted).toBe(false);
    const unmetered = structuredClone(candidate);
    unmetered.trials.find((t) => t.lane === "business")!.run.usage = null;
    expect(compareInterfaceCandidate(baseline, unmetered, "business", ["safety"]).accepted).toBe(
      false,
    );
    const repeated = structuredClone(candidate);
    repeated.trials.push(repeated.trials.find((t) => t.lane === "business")!);
    expect(compareInterfaceCandidate(baseline, repeated, "business", ["safety"]).accepted).toBe(
      false,
    );
  });
});
