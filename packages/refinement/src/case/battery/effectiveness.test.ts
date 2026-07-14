import { describe, expect, it } from "vitest";
import { ClaudeCodeAgentDriver } from "../driver.js";
import {
  type EffectivenessRow,
  effectivenessMetrics,
  runEffectivenessCase,
} from "./effectiveness.js";
import { EFFECTIVENESS_CASES } from "./effectiveness-cases.js";

/**
 * The investigator effectiveness battery. The well-formedness checks are CI-safe. The
 * real-driver run is OPT-IN (set `ANVIL_EFFECTIVENESS_BATTERY=1`) — it invokes an
 * actual coding-agent binary, is slow, and is excluded from unit CI by default.
 */
describe("effectiveness taxonomy is well-formed", () => {
  it("has 30 cases across six categories with unique ids", () => {
    expect(EFFECTIVENESS_CASES).toHaveLength(30);
    expect(new Set(EFFECTIVENESS_CASES.map((c) => c.id)).size).toBe(30);
    const byCat = new Map<string, number>();
    for (const c of EFFECTIVENESS_CASES) byCat.set(c.category, (byCat.get(c.category) ?? 0) + 1);
    expect([...byCat.values()].every((n) => n === 5)).toBe(true);
    expect(byCat.size).toBe(6);
  });

  it("keeps the evaluator's answer key out of the agent-visible repository fixture", () => {
    // The evidence itself may (and for explicit cases must) live in the fixture — that
    // is what the agent investigates. What must NOT leak is the evaluator's verdict:
    // the expected-outcome label. `runEffectivenessCase` writes only `repoFiles` into
    // the agent's scope and never the `labels` object, so this is a belt-and-braces
    // check that no fixture accidentally names the expected outcome.
    for (const c of EFFECTIVENESS_CASES) {
      const fixture = Object.values(c.repoFiles).join("\n");
      expect(fixture, `${c.id}: expected-outcome label leaked`).not.toContain(
        c.labels.expectedOutcome,
      );
    }
  });

  it("points every expected-evidence coordinate at a real fixture file", () => {
    for (const c of EFFECTIVENESS_CASES) {
      for (const coord of c.labels.expectedEvidence) {
        const path = coord.split("#")[0] as string;
        expect(Object.keys(c.repoFiles), `${c.id}: ${coord}`).toContain(path);
      }
    }
  });
});

// Opt-in: the real coding-agent driver. Skipped unless explicitly enabled.
const RUN_REAL = Boolean(process.env.ANVIL_EFFECTIVENESS_BATTERY);
describe.skipIf(!RUN_REAL)("investigator effectiveness battery (real driver)", () => {
  it(
    "scores the real investigator across the taxonomy",
    async () => {
      const driver = new ClaudeCodeAgentDriver({
        command: process.env.ANVIL_AGENT_COMMAND ?? "claude",
      });
      const rows: EffectivenessRow[] = [];
      for (const c of EFFECTIVENESS_CASES) rows.push(await runEffectivenessCase(c, driver));
      const metrics = effectivenessMetrics(rows);
      // Report; do not hard-assert thresholds — this is a measurement, not a gate.
      console.log(JSON.stringify(metrics, null, 2));
      expect(metrics.cases).toBe(30);
    },
    30 * 60 * 1000,
  );
});
