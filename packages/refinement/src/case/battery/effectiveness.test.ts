import { describe, expect, it } from "vitest";
import { ClaudeCodeAgentDriver, ScriptedAgentDriver } from "../driver.js";
import { addEvidence } from "../evidence.js";
import { synthesizeProposal } from "../proposal.js";
import {
  type EffectivenessCase,
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

describe("runEffectivenessCase — agent stops before validate-proposal", () => {
  // Regression for a bug-bash finding: readInvestigation reports "proposal_generated"
  // whenever a proposalDoc exists and validation isn't recorded 'rejected' — which is
  // also true when validate-proposal was simply never run. closeCase then refuses
  // (throws "Cannot close: ... never run through validate-proposal") for that case.
  // runEffectivenessCase must score that refusal as a non-grounded outcome instead of
  // letting it crash the whole battery loop and discard every row computed so far.
  it("scores the case as ungrounded instead of throwing", async () => {
    const DESC = "Customer-supplied explanation stored with the refund.";
    const c: EffectivenessCase = {
      id: "eff-unvalidated",
      category: "explicit_evidence",
      skill: "describe-field",
      field: { name: "reason", required: true, schema: { type: "string" }, in: "body" },
      repoFiles: {
        "src/service.ts": `// reason: ${DESC}\n`,
      },
      labels: {
        expectedOutcome: "proposal_generated",
        expectedEvidence: ["src/service.ts#L1-L1"],
      },
    };
    const driver = new ScriptedAgentDriver(async (dir) => {
      await addEvidence(dir, {
        predicate: "field.description",
        value: DESC,
        source: "source_impl",
        path: "src/service.ts",
        startLine: 1,
        endLine: 1,
      });
      synthesizeProposal(dir, { description: DESC });
      // Deliberately stop here: never run validate-proposal (or finalize), the
      // realistic failure mode the effectiveness harness exists to exercise.
    });

    const row = await runEffectivenessCase(c, driver);
    expect(row.observed).toBe("proposal_generated");
    expect(row.grounded).toBe(false);
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
