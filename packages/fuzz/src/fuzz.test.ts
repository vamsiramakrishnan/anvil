import { describe, expect, it } from "vitest";
import {
  type Driver,
  fc,
  type JsonValue,
  type Property,
  replayCampaign,
  retainDependencies,
  runCampaign,
  runScenario,
  Step,
} from "./index.js";

const scenarios = fc
  .record({ amount: fc.integer({ min: 1, max: 1000 }), noise: fc.integer({ min: 0, max: 8 }) })
  .map(({ amount, noise }) => ({
    id: "refund",
    steps: [
      ...Array.from({ length: noise }, (_, n) =>
        Step.parse({ id: `noise-${n}`, operation: "read" }),
      ),
      Step.parse({ id: "read", operation: "read" }),
      Step.parse({
        id: "write",
        operation: "refund",
        input: { amount, key: "k" },
        bindings: { payment: { step: "read", pointer: "/id" } },
      }),
      Step.parse({
        id: "repeat",
        operation: "refund",
        input: { amount, key: "k" },
        bindings: { payment: { step: "read", pointer: "/id" } },
        requires: ["write"],
      }),
    ],
  }));

function driver(broken: boolean, lifecycle?: { opened: number; closed: number }): Driver {
  return {
    id: "sdk",
    async open() {
      if (lifecycle) lifecycle.opened++;
      let commits = 0;
      const keys = new Set<string>();
      return {
        async invoke(step) {
          if (step.operation === "refund" && (broken || !keys.has(String(step.input.key)))) {
            keys.add(String(step.input.key));
            commits++;
          }
          const value: JsonValue =
            step.operation === "read" ? { id: "p1" } : { refunded: step.input.amount ?? null };
          return { status: "ok", value, effects: { commits } };
        },
        async close() {
          if (lifecycle) lifecycle.closed++;
        },
      };
    },
  };
}
const atMostOnce: Property = (_scenario, traces) =>
  traces.flatMap((trace) =>
    trace.events
      .filter((event) => event.step.operation === "refund")
      .map((event) => ({
        id: "at-most-once",
        operation: "refund",
        driver: trace.driver,
        stepId: event.step.id,
        status:
          (event.outcome.effects as { commits: number }).commits <= 1
            ? ("passed" as const)
            : ("failed" as const),
        detail: "A logical refund commits at most once",
      })),
  );

describe("stateful fuzz kernel", () => {
  it("finds, shrinks and replays a defect that an isolated example misses", async () => {
    const lifecycle = { opened: 0, closed: 0 };
    const report = await runCampaign({
      arbitrary: scenarios,
      drivers: [driver(true, lifecycle)],
      properties: [atMostOnce],
      seed: 39,
      runs: 20,
      identity: { fixture: "payments-v1" },
    });
    expect(report.status).toBe("failed");
    expect(report.shrinks).toBeGreaterThan(0);
    expect(report.replay?.scenario.steps).toHaveLength(3);
    expect(report.replay?.scenario.steps[1]?.input.amount).toBe(1);
    expect(lifecycle.closed).toBe(lifecycle.opened);
    if (!report.replay) throw new Error("Missing replay");
    expect(
      (
        await replayCampaign(report.replay, {
          drivers: [driver(true)],
          properties: [atMostOnce],
          identity: { fixture: "payments-v1" },
        })
      ).status,
    ).toBe("failed");
    expect(
      (
        await replayCampaign(report.replay, {
          drivers: [driver(false)],
          properties: [atMostOnce],
          identity: { fixture: "payments-v1" },
        })
      ).status,
    ).toBe("passed");
    await expect(
      replayCampaign(report.replay, {
        drivers: [driver(false)],
        properties: [atMostOnce],
        identity: { fixture: "other" },
      }),
    ).rejects.toThrow("identity mismatch");
    const acknowledged = await replayCampaign(report.replay, {
      drivers: [driver(false)],
      properties: [atMostOnce],
      identity: { fixture: "other" },
      allowIdentityChanges: ["fixture"],
    });
    expect(acknowledged.identityChanges).toEqual({
      fixture: { recorded: "payments-v1", current: "other" },
    });
    expect(acknowledged.replay?.identity.fixture).toBe("payments-v1");
  });

  it("reproduces the same minimized scenario for the same generator and seed", async () => {
    const opts = {
      arbitrary: scenarios,
      drivers: [driver(true)],
      properties: [atMostOnce],
      seed: 9,
    };
    const a = await runCampaign(opts);
    const b = await runCampaign(opts);
    expect(a.replay).toEqual(b.replay);
  });

  it("preserves prerequisite closure when shrinking command sequences", () => {
    const first = Step.parse({ id: "a", operation: "create" });
    const second = Step.parse({
      id: "b",
      operation: "use",
      bindings: { id: { step: "a", pointer: "/id" } },
    });
    const third = Step.parse({ id: "c", operation: "delete", requires: ["b"] });
    expect(retainDependencies([first, third])).toEqual([first]);
    expect(retainDependencies([second, third])).toEqual([]);
    expect(retainDependencies([first, second, third])).toHaveLength(3);
  });

  it("reports setup failures, unavailable drivers and absent assertions honestly", async () => {
    const scenario = { id: "one", steps: [Step.parse({ id: "one", operation: "read" })] };
    const broken: Driver = {
      id: "broken",
      async open() {
        throw new Error("token=DO_NOT_REPORT");
      },
    };
    const unavailable: Driver = {
      id: "missing",
      async open() {
        return {
          async invoke() {
            return { status: "unsupported", value: null };
          },
          async close() {},
        };
      },
    };
    const result = await runCampaign({
      arbitrary: fc.constant(scenario),
      drivers: [broken, unavailable],
      properties: [],
      runs: 1,
    });
    expect(result.status).toBe("inconclusive");
    expect(JSON.stringify(result)).not.toContain("DO_NOT_REPORT");
    expect((await runScenario(scenario, [driver(false)], [])).checks[0]?.id).toBe(
      "property.coverage",
    );
  });

  it("aborts stalled drivers and closes their fixtures", async () => {
    let closed = false;
    let aborted = false;
    const stalled: Driver = {
      id: "stalled",
      async open() {
        return {
          async invoke(_step, signal) {
            return new Promise((_, reject) =>
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(new Error("aborted"));
                },
                { once: true },
              ),
            );
          },
          async close() {
            closed = true;
          },
        };
      },
    };
    const result = await runScenario(
      { id: "slow", steps: [Step.parse({ id: "slow", operation: "read" })] },
      [stalled],
      [],
      { timeoutMs: 20 },
    );
    expect(result.checks.some((c) => c.status === "inconclusive")).toBe(true);
    expect(aborted && closed).toBe(true);
  });

  it("does not shrink a semantic failure into an unrelated driver failure", async () => {
    const variable: Driver = {
      id: "variable",
      async open() {
        return {
          async invoke(step) {
            if (step.input.n === 0) throw new Error("infrastructure");
            return { status: "ok", value: step.input.n ?? null };
          },
          async close() {},
        };
      },
    };
    const property: Property = (_, traces) =>
      traces.flatMap((t) =>
        t.events.map((e) => ({
          id: "semantic",
          status: "failed" as const,
          operation: e.step.operation,
          detail: "planted",
        })),
      );
    const report = await runCampaign({
      arbitrary: fc.integer({ min: 0, max: 100 }).map((n) => ({
        id: "case",
        steps: [Step.parse({ id: "step", operation: "op", input: { n } })],
      })),
      drivers: [variable],
      properties: [property],
      seed: 45,
    });
    expect(report.status).toBe("failed");
    expect(report.replay?.scenario.steps[0]?.input.n).toBe(1);
  });
});
