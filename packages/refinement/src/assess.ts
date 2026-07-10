import type { AirDocument, Operation } from "@anvil/air";
import type { Deficiency, DeficiencyCategory, Severity } from "./deficiency.js";
import { compareSeverity, severityRank } from "./deficiency.js";
import { DETECTORS, type Detector, runDetectors } from "./detect.js";
import { targetOperationId } from "./target.js";

/**
 * Agent-readiness assessment (Layer 2). Where `anvil refine plan` is
 * *deficiency-centric* — the list of gaps and the skills that own them — the
 * assessment is *operation-centric*: for every operation it answers the only
 * question a customer asks first, "can this safely become an agent capability,
 * and if not, why not?". It is a triage, not a fix: it never mutates AIR and
 * gathers no evidence. It reuses the same deterministic detectors so the two
 * views can never disagree about what is wrong — they only frame it differently.
 */

/**
 * What Anvil is willing to do with an operation right now. Ordered worst-first
 * by how much stands between the operation and exposure.
 *
 * - `excluded` — structurally not a candidate (deprecated); assessed but not counted
 *   against readiness.
 * - `blocked` — has a blocking-severity gap; must not be exposed until resolved.
 * - `humanDecisionRequired` — an unproven *safety* posture a human must decide;
 *   a skill can propose, but a person approves.
 * - `refinementRequired` — real gaps, but ones a narrow refinement skill can close.
 * - `ready` — nothing above `info`; safe to expose as-is.
 */
export type Disposition =
  | "ready"
  | "refinementRequired"
  | "humanDecisionRequired"
  | "blocked"
  | "excluded";

/** The dispositions in worst-first order, for stable summaries and rendering. */
export const DISPOSITIONS: readonly Disposition[] = [
  "blocked",
  "humanDecisionRequired",
  "refinementRequired",
  "ready",
  "excluded",
];

/** Human labels for each disposition, matching the customer-facing summary. */
const DISPOSITION_LABEL: Record<Disposition, string> = {
  ready: "Ready",
  refinementRequired: "Refinement required",
  humanDecisionRequired: "Human decision required",
  blocked: "Blocked",
  excluded: "Excluded",
};

/**
 * One line of *why a gap matters to an agent*, keyed by the deficiency's family.
 * This is the "agentImpact" the plan calls for: not what is missing, but what the
 * agent cannot do because it is missing.
 */
const CATEGORY_IMPACT: Record<DeficiencyCategory, string> = {
  documentation: "the agent cannot understand what this does or how to call it",
  usability: "the agent cannot reliably route to this among its siblings",
  safety: "the agent cannot trust what happens when it calls this",
  coverage: "this cannot be exercised or mocked before it ships",
};

/** The readiness verdict for a single operation. */
export interface OperationReadiness {
  operationId: string;
  /** The human coordinate — the generated CLI command, e.g. `payments refunds create`. */
  command: string;
  displayName: string;
  /** Effect posture, mirroring `anvil inspect`: `read` or `mutation/<risk>`. */
  effect: string;
  disposition: Disposition;
  /** Worst severity among this operation's gaps, or undefined if there are none. */
  worstSeverity?: Severity;
  /** The gaps bound to this operation, worst-first. */
  deficiencies: Deficiency[];
}

/**
 * The whole-service readiness picture: a per-operation disposition, the summary
 * counts a customer reads first, and a single readiness score.
 */
export interface ReadinessAssessment {
  service: { id: string; version: string };
  /** 0–100: the share of assessable (non-excluded) operations that are `ready`. */
  score: number;
  operations: OperationReadiness[];
  /** How many operations fall into each disposition. */
  summary: Record<Disposition, number>;
  /** Gaps that belong to the service/capabilities/workflows, not any one operation. */
  surfaceDeficiencies: Deficiency[];
}

/** Effect posture string, identical to what `anvil inspect` shows. */
function describeEffect(op: Operation): string {
  return op.effect.kind === "mutation" ? `mutation/${op.effect.risk}` : "read";
}

/**
 * Map an operation and its gaps to a disposition. Worst constraint wins, so the
 * disposition is honest about the single hardest thing standing in the way.
 */
function dispositionFor(op: Operation, defs: readonly Deficiency[]): Disposition {
  // The lifecycle state machine outranks detector gaps: deprecation can arrive
  // via the manifest/enrichment as `state: deprecated` without the boolean, and
  // a review can set `state: blocked` for reasons recorded in reviewNotes that
  // no detector re-derives from AIR. Readiness must never contradict a human's
  // explicit lifecycle decision.
  if (op.deprecated || op.state === "deprecated") return "excluded";
  if (op.state === "blocked") return "blocked";
  if (defs.some((d) => d.severity === "blocking")) return "blocked";
  // An unproven safety posture (high-severity safety gap) is a human's call: a
  // skill can gather evidence, but a person decides whether to trust the effect.
  if (defs.some((d) => d.category === "safety" && severityRank(d.severity) >= severityRank("high")))
    return "humanDecisionRequired";
  // Anything above `info` is a real gap a refinement skill can close.
  if (defs.some((d) => severityRank(d.severity) >= severityRank("low")))
    return "refinementRequired";
  return "ready";
}

function emptySummary(): Record<Disposition, number> {
  return { ready: 0, refinementRequired: 0, humanDecisionRequired: 0, blocked: 0, excluded: 0 };
}

/**
 * Assess a compiled AIR document. Deterministic and read-only: it runs the
 * detectors, buckets each gap onto its operation, and derives a disposition and
 * score. Same detectors as `anvil refine plan` — the two views cannot drift.
 */
export function assessReadiness(
  air: AirDocument,
  detectors: readonly Detector[] = DETECTORS,
): ReadinessAssessment {
  const deficiencies = runDetectors(air, detectors);

  const byOp = new Map<string, Deficiency[]>();
  const surface: Deficiency[] = [];
  for (const d of deficiencies) {
    const opId = targetOperationId(d.target);
    if (opId) {
      const list = byOp.get(opId);
      if (list) list.push(d);
      else byOp.set(opId, [d]);
    } else {
      surface.push(d);
    }
  }

  const operations: OperationReadiness[] = air.operations.map((op) => {
    const defs = (byOp.get(op.id) ?? [])
      .slice()
      .sort((a, b) => compareSeverity(a.severity, b.severity));
    return {
      operationId: op.id,
      command: op.cli.command,
      displayName: op.displayName,
      effect: describeEffect(op),
      disposition: dispositionFor(op, defs),
      worstSeverity: defs[0]?.severity,
      deficiencies: defs,
    };
  });

  const summary = emptySummary();
  for (const o of operations) summary[o.disposition]++;
  const assessable = operations.length - summary.excluded;
  const score = assessable <= 0 ? 100 : Math.round((100 * summary.ready) / assessable);

  return {
    service: { id: air.service.id, version: air.service.version },
    score,
    operations,
    summary,
    surfaceDeficiencies: surface,
  };
}

/**
 * A view of an assessment narrowed to a minimum severity: operations keep only
 * gaps at or above `min`, and only operations that still have one are listed.
 * The headline `summary` and `score` are left intact — they are the honest
 * totals; the filter only controls which detail a customer drills into.
 */
export function restrictToSeverity(
  assessment: ReadinessAssessment,
  min: Severity,
): ReadinessAssessment {
  const rank = severityRank(min);
  const operations = assessment.operations
    .map((o) => ({
      ...o,
      deficiencies: o.deficiencies.filter((d) => severityRank(d.severity) >= rank),
    }))
    .filter((o) => o.deficiencies.length > 0);
  const surfaceDeficiencies = assessment.surfaceDeficiencies.filter(
    (d) => severityRank(d.severity) >= rank,
  );
  return { ...assessment, operations, surfaceDeficiencies };
}

/** The gaps to surface for an operation in a triage line: its blocking/decision gaps. */
function headlineGaps(o: OperationReadiness): Deficiency[] {
  if (o.disposition === "blocked") return o.deficiencies.filter((d) => d.severity === "blocking");
  if (o.disposition === "humanDecisionRequired")
    return o.deficiencies.filter(
      (d) => d.category === "safety" && severityRank(d.severity) >= severityRank("high"),
    );
  return o.deficiencies;
}

/** One rendered gap line: the message, and (when explaining) why it matters to an agent. */
function gapLine(d: Deficiency, explain: boolean): string {
  const base = `    ${d.message}`;
  return explain ? `${base}\n      → ${CATEGORY_IMPACT[d.category]}` : base;
}

/** Worst-first ordering for operations: by disposition, then worst severity, then name. */
function compareReadiness(a: OperationReadiness, b: OperationReadiness): number {
  const disp = DISPOSITIONS.indexOf(a.disposition) - DISPOSITIONS.indexOf(b.disposition);
  if (disp !== 0) return disp;
  const sev = severityRank(b.worstSeverity ?? "info") - severityRank(a.worstSeverity ?? "info");
  if (sev !== 0) return sev;
  return a.command.localeCompare(b.command);
}

/**
 * Render an assessment the way `anvil assess <service>` prints it: the summary
 * counts first, then the operations a human must act on (blocked, then
 * human-decision), each with the gaps that put it there. The full per-operation
 * list lives in `--json`; this stays a triage.
 *
 * `opts.detail` lists *every* operation that still carries a gap, worst-first —
 * used when the caller has narrowed the view (e.g. `--severity`) and now wants
 * the matching operations, not just the summary.
 */
export function summarizeAssessment(
  assessment: ReadinessAssessment,
  opts: { explain?: boolean; detail?: boolean } = {},
): string {
  const explain = opts.explain === true;
  const lines: string[] = [];
  const { service, summary, score } = assessment;
  lines.push(`Readiness — ${service.id} @ ${service.version}   (score ${score}/100)`);
  lines.push("");
  lines.push(`  ${"Operations".padEnd(26)} ${assessment.operations.length}`);
  for (const disp of DISPOSITIONS) {
    lines.push(`  ${DISPOSITION_LABEL[disp].padEnd(26)} ${summary[disp]}`);
  }

  if (opts.detail) {
    // Narrowed view: list every operation that still has a gap, with all of it.
    const withGaps = assessment.operations
      .filter((o) => o.deficiencies.length > 0)
      .sort(compareReadiness);
    lines.push("");
    if (withGaps.length === 0) {
      lines.push("No operations match this filter.");
    } else {
      lines.push("Operations with matching gaps (worst first):");
      for (const o of withGaps) {
        lines.push(`  ${o.command}  (${DISPOSITION_LABEL[o.disposition].toLowerCase()})`);
        for (const d of o.deficiencies) lines.push(gapLine(d, explain));
      }
    }
    return lines.join("\n");
  }

  const attention = assessment.operations
    .filter((o) => o.disposition === "blocked" || o.disposition === "humanDecisionRequired")
    .sort(compareReadiness);
  if (attention.length > 0) {
    lines.push("");
    lines.push("Needs a decision before it can be exposed:");
    for (const o of attention) {
      const marker = o.disposition === "blocked" ? "blocked" : "human decision";
      lines.push(`  ${o.command}  (${marker})`);
      for (const d of headlineGaps(o)) lines.push(gapLine(d, explain));
    }
  }

  lines.push("");
  if (summary.blocked === 0) {
    lines.push("No blocking safety gaps. Refinement-required operations can be closed by skills:");
  } else {
    lines.push(
      "Detection is deterministic; no evidence was gathered and AIR was not changed. Next:",
    );
  }
  lines.push("  anvil assess <service> <operation>   drill into one operation");
  lines.push("  anvil refine plan <service>          the gaps and the skills that own them");
  return lines.join("\n");
}

/** Render the drill-down for a single operation: `anvil assess <service> <operation>`. */
export function renderOperationReadiness(o: OperationReadiness): string {
  const lines: string[] = [];
  lines.push(`${o.command}  —  ${o.displayName}`);
  lines.push(`  effect      ${o.effect}`);
  lines.push(`  disposition ${DISPOSITION_LABEL[o.disposition]}`);
  if (o.deficiencies.length === 0) {
    lines.push("");
    lines.push("No gaps detected. This operation is ready to expose.");
    return lines.join("\n");
  }
  lines.push("");
  lines.push(`Gaps (${o.deficiencies.length}), worst first:`);
  for (const d of o.deficiencies) {
    lines.push(`  [${d.severity.padEnd(8)}] ${d.code}`);
    lines.push(`    ${d.message}`);
    lines.push(`    why it matters — ${CATEGORY_IMPACT[d.category]}`);
    lines.push(`    fix with       — anvil refine skill: ${d.suggestedSkill}`);
  }
  return lines.join("\n");
}
