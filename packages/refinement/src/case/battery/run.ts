import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AirDocument, loadAirDocument } from "@anvil/air";
import type { Deficiency } from "../../deficiency.js";
import type { ApprovalTier, RefinementStatus } from "../../model.js";
import { buildRefinementPlan } from "../../plan.js";
import { assembleContext, evidenceForTarget } from "../../skills/context.js";
import { HeuristicSkillExecutor } from "../../skills/executor.js";
import { skillFor } from "../../skills/registry.js";
import { validateProposal } from "../../skills/validate.js";
import { targetKey } from "../../target.js";
import { ScriptedAgentDriver } from "../driver.js";
import { addEvidence } from "../evidence.js";
import { closeCase, readInvestigation } from "../executor.js";
import { openCase } from "../materialize.js";
import { finalize, synthesizeProposal, validateCaseProposal } from "../proposal.js";
import {
  type BatteryReport,
  type BatteryRow,
  type ClassSummary,
  type Contribution,
  type FieldScenario,
  outcomeOf,
  type ScenarioClass,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* Build a one-operation AIR that trips exactly the scenario's deficiency      */
/* -------------------------------------------------------------------------- */

const OP_ID = "bench.op";

function buildAir(s: FieldScenario): AirDocument {
  const params: unknown[] = [];
  let body: unknown;
  const errors: unknown[] = [];

  if (s.field) {
    const f = {
      name: s.field.name,
      required: s.field.required,
      schema: s.field.schema,
      ...(s.field.description ? { description: s.field.description } : {}),
    };
    if (s.field.in === "param") {
      params.push({ in: "query", ...f });
    } else {
      body = { projection: "fields", fields: [f] };
    }
  }
  if (s.error) {
    errors.push({
      code: s.error.code,
      ...(s.error.message ? { message: s.error.message } : {}),
      ...(s.error.retryable !== undefined ? { retryable: s.error.retryable } : {}),
    });
  }

  return loadAirDocument({
    service: {
      id: "bench",
      displayName: "Bench",
      version: "2026-07-10",
      source: { kind: "openapi", uri: "./bench.openapi.yaml" },
    },
    operations: [
      {
        id: OP_ID,
        canonicalName: "do_thing",
        displayName: "Do thing",
        description: "A benchmark operation.",
        sourceRef: { kind: "openapi", path: "/thing", method: "post" },
        effect: { kind: "mutation", action: "create", risk: "low", reversible: true },
        input: { params, ...(body ? { body } : {}) },
        errors,
        idempotency: { mode: "required", mechanism: "header", header: "Idempotency-Key" },
        retries: { mode: "safe" },
        confirmation: { required: true },
        auth: { type: "api_key" },
        cli: { command: "bench do thing" },
        mcp: { toolName: "bench_do_thing" },
        skill: { intentExamples: ["Do the thing."] },
      },
    ],
  });
}

/** The exact target key the scenario acts on, so we can find its deficiency. */
function expectedTargetKey(s: FieldScenario): string {
  if (s.skill === "enrich-errors" && s.error) {
    return targetKey({ kind: "error", operationId: OP_ID, code: s.error.code });
  }
  const seg = s.field?.in === "param" ? "params" : "body";
  return targetKey({ kind: "field", operationId: OP_ID, path: `input.${seg}.${s.field?.name}` });
}

function findDeficiency(air: AirDocument, s: FieldScenario): Deficiency {
  const key = expectedTargetKey(s);
  const plan = buildRefinementPlan(air);
  const d = plan.deficiencies.find(
    (x) => targetKey(x.target) === key && skillFor(x.code)?.name === s.skill,
  );
  if (!d) {
    throw new Error(
      `scenario '${s.id}': no ${s.skill} deficiency at ${key} (got: ${plan.deficiencies
        .map((p) => `${targetKey(p.target)}→${skillFor(p.code)?.name ?? p.code}`)
        .join(", ")})`,
    );
  }
  return d;
}

/* -------------------------------------------------------------------------- */
/* Run one scenario: baseline vs investigation                                 */
/* -------------------------------------------------------------------------- */

async function runScenario(s: FieldScenario, root: string): Promise<BatteryRow> {
  const air = buildAir(s);
  const deficiency = findDeficiency(air, s);
  const skill = skillFor(deficiency.code);
  if (!skill) throw new Error(`scenario '${s.id}': no skill for ${deficiency.code}`);

  // Baseline: the deterministic executor sees only AIR (schema + any resident
  // evidence), never the repository. It closes only what the model already carries.
  const context = assembleContext(air, deficiency, evidenceForTarget(air, deficiency));
  const baselineProposal = await new HeuristicSkillExecutor().execute(skill, context);
  const baselineProposed =
    baselineProposal != null &&
    validateProposal(skill, baselineProposal, context).status === "validated";

  // Investigation: deposit the repository evidence via the rails, then synthesize
  // (or decline), test, and finalize — the scripted stand-in for a Claude Code run.
  // Isolate every scenario in its own root so two scenarios that share a field
  // name (hence a case id) can never leak evidence into one another.
  const dir = openCase(air, deficiency, { root: join(root, s.id) }).dir;
  await new ScriptedAgentDriver((d) => {
    for (const ev of s.repository) {
      addEvidence(d, {
        predicate: ev.predicate,
        value: ev.value,
        source: ev.source,
        ref: ev.ref,
        note: ev.note,
      });
    }
    if (s.finalizeStatus) {
      finalize(d, { status: s.finalizeStatus });
      return;
    }
    if (s.draft) {
      synthesizeProposal(d, s.draft);
      validateCaseProposal(air, d);
    }
    finalize(d);
  }).run(dir);

  const result = readInvestigation(dir);
  const refinement = closeCase(air, dir);
  const refinementStatus: RefinementStatus | "none" = refinement?.status ?? "none";
  const outcome = outcomeOf(refinementStatus);
  const approvalTier: ApprovalTier | "none" = refinement?.approval.tier ?? "none";

  const investigationClosed = result.status === "proposal_generated";
  const contribution: Contribution = investigationClosed
    ? baselineProposed
      ? "both"
      : "investigation_only"
    : baselineProposed
      ? "baseline_only"
      : "declined";

  const matchedExpectation =
    result.status === s.expected.investigation &&
    outcome === s.expected.outcome &&
    (s.expected.approval === undefined || approvalTier === s.expected.approval);

  return {
    id: s.id,
    class: s.class,
    skill: s.skill,
    probes: s.probes,
    baselineProposed,
    investigationStatus: result.status,
    refinementStatus,
    outcome,
    approvalTier,
    contribution,
    matchedExpectation,
  };
}

/* -------------------------------------------------------------------------- */
/* Run the whole battery + roll up                                             */
/* -------------------------------------------------------------------------- */

export interface RunBatteryOptions {
  /** Where cases are materialised (a fresh temp dir by default). */
  root?: string;
}

export async function runBattery(
  scenarios: readonly FieldScenario[],
  options: RunBatteryOptions = {},
): Promise<BatteryReport> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "anvil-battery-"));
  const rows: BatteryRow[] = [];
  for (const s of scenarios) rows.push(await runScenario(s, root));

  const classes = [...new Set(rows.map((r) => r.class))] as ScenarioClass[];
  const byClass: ClassSummary[] = classes
    .map((cls) => {
      const group = rows.filter((r) => r.class === cls);
      return {
        class: cls,
        runs: group.length,
        investigationClosed: group.filter((r) => r.investigationStatus === "proposal_generated")
          .length,
        baselineClosed: group.filter((r) => r.baselineProposed).length,
        investigationOnly: group.filter((r) => r.contribution === "investigation_only").length,
        declined: group.filter((r) => r.contribution === "declined").length,
      };
    })
    .sort((a, b) => a.class.localeCompare(b.class));

  return {
    rows,
    byClass,
    totals: {
      runs: rows.length,
      baselineClosed: rows.filter((r) => r.baselineProposed).length,
      investigationClosed: rows.filter((r) => r.investigationStatus === "proposal_generated")
        .length,
      investigationOnly: rows.filter((r) => r.contribution === "investigation_only").length,
      conflictsFound: rows.filter((r) => r.investigationStatus === "conflicted").length,
      declined: rows.filter((r) => r.contribution === "declined").length,
      mismatches: rows.filter((r) => !r.matchedExpectation).length,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Render                                                                      */
/* -------------------------------------------------------------------------- */

export function renderBatteryReport(report: BatteryReport): string {
  const t = report.totals;
  const lines: string[] = [];
  lines.push("Investigation battery — deterministic baseline vs case investigation");
  lines.push("");
  lines.push(
    `  ${t.runs} scenarios · baseline closed ${t.baselineClosed} · investigation closed ` +
      `${t.investigationClosed} · investigation-only ${t.investigationOnly} · ` +
      `conflicts found ${t.conflictsFound} · declined ${t.declined}`,
  );
  if (t.mismatches > 0) lines.push(`  ⚠ ${t.mismatches} scenario(s) did not match expectation`);
  lines.push("");

  lines.push("By class (does the investigation add over the deterministic baseline?):");
  lines.push(
    `  ${"class".padEnd(20)} ${"runs".padStart(4)} ${"base".padStart(4)} ${"invsg".padStart(5)} ${"only".padStart(4)} ${"decl".padStart(4)}`,
  );
  for (const c of report.byClass) {
    lines.push(
      `  ${c.class.padEnd(20)} ${String(c.runs).padStart(4)} ${String(c.baselineClosed).padStart(4)} ` +
        `${String(c.investigationClosed).padStart(5)} ${String(c.investigationOnly).padStart(4)} ${String(c.declined).padStart(4)}`,
    );
  }
  lines.push("");

  lines.push("Per scenario:");
  for (const r of report.rows) {
    const flag = r.matchedExpectation ? " " : "⚠";
    lines.push(
      `  ${flag} ${r.id.padEnd(28)} ${r.contribution.padEnd(18)} ` +
        `base=${r.baselineProposed ? "y" : "n"} invsg=${r.investigationStatus} ` +
        `refine=${r.refinementStatus}/${r.approvalTier}`,
    );
  }
  lines.push("");
  lines.push("base = deterministic executor grounded a validated proposal.");
  lines.push("invsg = investigation status; refine = reconciled status/approval tier.");
  return lines.join("\n");
}
