import { AirDocument } from "@anvil/air";
import { compileBusiness } from "@anvil/compiler";
import type { AgentAdapter, Check, JsonValue, Property } from "@anvil/fuzz";
import { generateBundle } from "@anvil/generators";
import { bundleFuzzDrivers } from "../fuzz/drivers.js";
import type { BusinessEvaluator } from "./comparison.js";
import { businessFuzzFixture } from "./fixture.js";

/** Calibration backend only. The caller supplies a real model adapter or an explicitly scripted one. */
export function ownedBusinessEvaluator(agent: AgentAdapter): BusinessEvaluator {
  return {
    id: "owned-business-calibration",
    version: "1",
    agent,
    async fixture(project, task, _seed, lane) {
      const { air, plan } = compileBusiness(project.definition, project.sources);
      const raw = AirDocument.parse({
        ...Object.values(project.sources)[0],
        service: { ...air.service, id: "business-raw" },
        business: undefined,
        capabilities: [],
        workflows: [],
        operations: Object.values(project.sources).flatMap((source) => source.operations),
      });
      const files = generateBundle(
        lane === "raw" ? raw : air,
        lane === "raw" ? {} : { businessPlan: plan },
      ).files;
      const driver = bundleFuzzDrivers(files, {
        surfaces: ["mcp"],
        fixture: async (bundle, seed, signal) => {
          const fixture = await businessFuzzFixture(bundle, seed, signal);
          return {
            ...fixture,
            before: async (step) =>
              fixture.before?.({
                ...step,
                fault: task.fixture.fault ? { kind: task.fixture.fault } : undefined,
              }),
          };
        },
      })[0];
      if (!driver) throw new Error("MCP driver unavailable.");
      const expected = task.expected.effects as Record<string, JsonValue> | undefined;
      if (!expected || !Object.keys(expected).length)
        throw new Error("Owned evaluation tasks must declare expected backend effects.");
      const property: Property = (_scenario, traces) => {
        const events = traces.flatMap((trace) => trace.events);
        const observations = events
          .map((event) => event.outcome.effects)
          .filter(
            (state): state is Record<string, JsonValue> =>
              !!state && typeof state === "object" && !Array.isArray(state),
          );
        if (!observations.length)
          return [
            {
              id: "business.state",
              status: "inconclusive",
              detail: "No independent backend observation was captured.",
            },
          ];
        const final = observations.at(-1) ?? {};
        const checks: Check[] = [
          {
            id: "business.terminal-state",
            status: Object.entries(expected).every(
              ([key, value]) => JSON.stringify(final[key]) === JSON.stringify(value),
            )
              ? "passed"
              : "failed",
            detail: "Terminal backend state must satisfy the held-out task's independent oracle.",
          },
        ];
        const unsafe = observations.some((state) =>
          ["refunds", "cases", "amendments", "grants"].some(
            (key) =>
              typeof state[key] === "number" && Number(state[key]) > Number(expected[key] ?? 0),
          ),
        );
        checks.push({
          id: "business.unauthorized-effects",
          status: unsafe ? "failed" : "passed",
          detail: "No observed effect count may exceed the task's allowed effects.",
        });
        return checks;
      };
      return { driver, properties: [property] };
    },
  };
}
