import type { AirDocument } from "@anvil/air";
import type { Deficiency, DeficiencyCategory, DeficiencyCode, Severity } from "./deficiency.js";
import { DEFICIENCY_CATALOG } from "./deficiency.js";
import { DETECTORS, type Detector, runDetectors } from "./detect.js";
import { skillByName } from "./skills/registry.js";
import { describeTarget, targetOperationId } from "./target.js";

/**
 * A **refinement plan**: the deterministic, agent-free picture of everything AIR
 * says is missing or weak, with counts by severity, category, code, and owning
 * skill. This is the input to the loop — you read the plan, then run narrow
 * skills against the deficiencies it names. Building the plan never mutates AIR.
 */
export interface RefinementPlan {
  service: { id: string; version: string };
  deficiencies: Deficiency[];
  /** Distinct operations touched by at least one deficiency. */
  affectedOperations: number;
  bySeverity: Record<Severity, number>;
  byCategory: Record<DeficiencyCategory, number>;
  byCode: Partial<Record<DeficiencyCode, number>>;
  /** How many deficiencies each narrow skill would own, worst-first friendly. */
  bySkill: Record<string, number>;
  /** The blocking-severity subset, in plan order (safety gaps that stop exposure). */
  blocking: Deficiency[];
}

function tally<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

const ALL_SEVERITIES: readonly Severity[] = ["blocking", "high", "medium", "low", "info"];
const ALL_CATEGORIES: readonly DeficiencyCategory[] = [
  "safety",
  "documentation",
  "usability",
  "coverage",
];

/** Detect deficiencies and roll them up into a plan. */
export function buildRefinementPlan(
  air: AirDocument,
  detectors: readonly Detector[] = DETECTORS,
): RefinementPlan {
  const deficiencies = runDetectors(air, detectors);

  const bySeverity = tally(ALL_SEVERITIES);
  const byCategory = tally(ALL_CATEGORIES);
  const byCode: Partial<Record<DeficiencyCode, number>> = {};
  const bySkill: Record<string, number> = {};
  const operations = new Set<string>();

  for (const d of deficiencies) {
    bySeverity[d.severity]++;
    byCategory[d.category]++;
    byCode[d.code] = (byCode[d.code] ?? 0) + 1;
    bySkill[d.suggestedSkill] = (bySkill[d.suggestedSkill] ?? 0) + 1;
    const opId = targetOperationId(d.target);
    if (opId) operations.add(opId);
  }

  return {
    service: { id: air.service.id, version: air.service.version },
    deficiencies,
    affectedOperations: operations.size,
    bySeverity,
    byCategory,
    byCode,
    bySkill,
    blocking: deficiencies.filter((d) => d.severity === "blocking"),
  };
}

/** Sort a count map into worst-first, then alphabetical, entries for stable output. */
function rankedEntries(counts: Record<string, number>): Array<[string, number]> {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Render a plan as the text `anvil refine plan` prints: a triage view, not the
 * full list. It leads with blocking safety gaps (the thing that stops exposure),
 * then the shape of the work by category and by skill. `--json` carries the rest.
 */
export function summarizeRefinementPlan(plan: RefinementPlan): string {
  const lines: string[] = [];
  const total = plan.deficiencies.length;
  lines.push(`Refinement Plan — ${plan.service.id} @ ${plan.service.version}`);
  if (total === 0) {
    lines.push("");
    lines.push("No deficiencies detected. AIR is complete against the deterministic checks.");
    return lines.join("\n");
  }
  lines.push(
    `  ${total} deficienc${total === 1 ? "y" : "ies"} across ${plan.affectedOperations} operation(s)`,
  );

  lines.push("");
  lines.push(`Blocking safety gaps: ${plan.blocking.length}`);
  for (const d of plan.blocking) {
    lines.push(`  ${describeTarget(d.target).padEnd(40)} ${d.code}`);
  }

  const humanDecisions = plan.deficiencies.filter(
    (d) => DEFICIENCY_CATALOG[d.code].readinessDisposition === "humanDecisionRequired",
  );
  lines.push("");
  lines.push(`Human-decision gaps: ${humanDecisions.length}`);
  for (const d of humanDecisions) {
    lines.push(`  ${describeTarget(d.target).padEnd(40)} ${d.message}`);
  }

  lines.push("");
  lines.push("By severity:");
  for (const [sev, n] of rankedEntries(plan.bySeverity)) {
    lines.push(`  ${sev.padEnd(10)} ${n}`);
  }

  lines.push("");
  lines.push("By category:");
  for (const [cat, n] of rankedEntries(plan.byCategory)) {
    lines.push(`  ${cat.padEnd(14)} ${n}`);
  }

  lines.push("");
  lines.push("Proposed skills:");
  for (const [skill, n] of rankedEntries(plan.bySkill)) {
    const availability = skillByName(skill) ? "" : " [not yet implemented]";
    lines.push(`  ${skill.padEnd(26)} ${n}${availability}`);
  }

  lines.push("");
  lines.push("Detection is deterministic; no evidence was gathered and AIR was not changed.");
  lines.push("Run `anvil refine plan --json` for the full, per-target list.");
  return lines.join("\n");
}

/** The catalog entry for a code, for callers that want its title/skill/category. */
export function describeCode(code: DeficiencyCode) {
  return DEFICIENCY_CATALOG[code];
}
