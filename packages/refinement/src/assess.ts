import { type AirDocument, contractHash, type Operation, OperationState } from "@anvil/air";
import { z } from "zod";
import {
  compareSeverity,
  constraintRank,
  DEFICIENCY_CATALOG,
  type Deficiency,
  type DeficiencyCode,
  type ReadinessConstraint,
  SEVERITIES,
  type Severity,
  severityRank,
} from "./deficiency.js";
import { DETECTORS, type Detector, runDetectors } from "./detect.js";
import { skillFor } from "./skills/registry.js";
import type { SemanticTarget } from "./target.js";
import { targetOperationId } from "./target.js";

/**
 * Agent-readiness assessment (Layer 2). Where `anvil refine plan` is
 * *deficiency-centric* — the list of gaps and the skills that own them — the
 * assessment is *operation-centric*: for every operation it answers the only
 * question a customer asks first, "can this safely become an agent capability,
 * and if not, why not?". It is a triage, not a fix: it never mutates AIR and
 * gathers no evidence. It reuses the same deterministic detectors so the two
 * views can never disagree about what is wrong — they only frame it differently.
 *
 * The assessment is a **versioned artifact** (a Zod model): it carries a
 * `schemaVersion` and the `contractHash` of the AIR document it judged, so a
 * stored assessment can be validated and bound to the exact contract it
 * describes. Dispositions are projected from the deficiency catalog's
 * per-code readiness policy plus the lifecycle state machine — never inferred
 * here from category or severity.
 */

/**
 * What Anvil is willing to do with an operation right now. Ordered worst-first
 * by how much stands between the operation and exposure.
 *
 * - `excluded` — structurally not a candidate (deprecated); assessed but not counted
 *   against readiness.
 * - `blocked` — a blocking gap or a reviewer's lifecycle decision; must not be
 *   exposed until resolved.
 * - `humanDecisionRequired` — an unproven *safety* posture a human must decide;
 *   a skill can propose, but a person approves.
 * - `refinementRequired` — real gaps, but ones a narrow refinement skill can close.
 * - `ready` — nothing constrains it; safe to expose as-is.
 */
export const Disposition = z.enum([
  "ready",
  "refinementRequired",
  "humanDecisionRequired",
  "blocked",
  "excluded",
]);
export type Disposition = z.infer<typeof Disposition>;

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

/* -------------------------------------------------------------------------- */
/* The versioned artifact model                                               */
/* -------------------------------------------------------------------------- */

/** Deficiency codes, validated against the catalog so an unknown code is rejected. */
const DeficiencyCodeSchema = z.enum(
  Object.keys(DEFICIENCY_CATALOG) as [DeficiencyCode, ...DeficiencyCode[]],
);

/** The semantic target — a discriminated union, so a malformed target fails to parse. */
const SemanticTargetSchema: z.ZodType<SemanticTarget> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("service") }),
  z.object({ kind: z.literal("capability"), capabilityId: z.string() }),
  z.object({ kind: z.literal("operation"), operationId: z.string() }),
  z.object({ kind: z.literal("field"), operationId: z.string(), path: z.string() }),
  z.object({ kind: z.literal("enum"), operationId: z.string(), path: z.string() }),
  z.object({ kind: z.literal("error"), operationId: z.string(), code: z.string() }),
  z.object({ kind: z.literal("workflow"), workflowId: z.string() }),
]);

/**
 * A detector finding as the assessment reports it: the deficiency itself plus
 * the catalog's agent impact and an honest `automatable` — whether the
 * suggested skill is actually implemented today, not merely named.
 */
export const AssessedDeficiency = z.object({
  code: DeficiencyCodeSchema,
  category: z.enum(["documentation", "usability", "safety", "coverage"]),
  target: SemanticTargetSchema,
  severity: z.enum(SEVERITIES),
  message: z.string(),
  facts: z.record(z.string(), z.unknown()),
  /** The narrow skill that would close this gap (may not be implemented yet). */
  suggestedSkill: z.string(),
  /** Why this gap matters to an agent (per-code catalog wording). */
  agentImpact: z.string(),
  /** True only when `suggestedSkill` is implemented in the skills registry. */
  automatable: z.boolean(),
});
export type AssessedDeficiency = z.infer<typeof AssessedDeficiency>;

/** The readiness verdict for a single operation. */
export const OperationReadiness = z.object({
  operationId: z.string(),
  /** The human coordinate — the generated CLI command, e.g. `payments refunds create`. */
  command: z.string(),
  displayName: z.string(),
  /** Effect posture, mirroring `anvil inspect`: `read` or `mutation/<risk>`. */
  effect: z.string(),
  /** Lifecycle state — the reviewer's decision the disposition must honor. */
  state: OperationState,
  disposition: Disposition,
  /** Worst severity among this operation's gaps, or absent if there are none. */
  worstSeverity: z.enum(SEVERITIES).optional(),
  /** The gaps bound to this operation, worst-first. */
  deficiencies: z.array(AssessedDeficiency),
});
export type OperationReadiness = z.infer<typeof OperationReadiness>;

/** Bump when the artifact's shape changes incompatibly. */
export const ASSESSMENT_SCHEMA_VERSION = 1;

/**
 * The whole-service readiness picture, as a versioned, storable artifact.
 *
 * `readyPercent` is the share of assessable (non-excluded) operations that are
 * `ready` — a proportion, deliberately not called a score. When *every*
 * operation is excluded (or there are none), there is no gap among assessable
 * operations, so `readyPercent` is vacuously 100 and `overallDisposition` is
 * `excluded` — the disposition, not the percent, is the headline signal.
 *
 * `overallDisposition` is worst-constraint-wins across the assessable
 * operations AND the service-level (surface) findings, so a blocking service
 * finding can never be hidden by good per-operation counts.
 */
export const ReadinessAssessment = z.object({
  schemaVersion: z.literal(ASSESSMENT_SCHEMA_VERSION),
  /** sha256 of the canonical AIR contract this assessment judged (see @anvil/air). */
  contractHash: z.string(),
  service: z.object({ id: z.string(), version: z.string() }),
  overallDisposition: Disposition,
  /** 0–100: the share of assessable (non-excluded) operations that are `ready`. */
  readyPercent: z.number().int().min(0).max(100),
  /** How many operations fall into each disposition. */
  summary: z.object({
    ready: z.number().int(),
    refinementRequired: z.number().int(),
    humanDecisionRequired: z.number().int(),
    blocked: z.number().int(),
    excluded: z.number().int(),
  }),
  operations: z.array(OperationReadiness),
  /** Gaps that belong to the service/capabilities/workflows, not any one operation. */
  surfaceDeficiencies: z.array(AssessedDeficiency),
});
export type ReadinessAssessment = z.infer<typeof ReadinessAssessment>;

/* -------------------------------------------------------------------------- */
/* Assessment                                                                 */
/* -------------------------------------------------------------------------- */

/** Effect posture string, identical to what `anvil inspect` shows. */
function describeEffect(op: Operation): string {
  return op.effect.kind === "mutation" ? `mutation/${op.effect.risk}` : "read";
}

/** Project a detector finding into the artifact: catalog impact + skill honesty. */
function assessDeficiency(d: Deficiency): AssessedDeficiency {
  return {
    code: d.code,
    category: d.category,
    target: d.target,
    severity: d.severity,
    message: d.message,
    facts: d.facts,
    suggestedSkill: d.suggestedSkill,
    agentImpact: DEFICIENCY_CATALOG[d.code].agentImpact,
    automatable: skillFor(d.code) !== undefined,
  };
}

/** The catalog constraint a finding imposes on readiness. */
function constraintOf(d: AssessedDeficiency): ReadinessConstraint {
  return DEFICIENCY_CATALOG[d.code].readinessDisposition;
}

/** The worst catalog constraint among a set of findings (`none` when empty). */
function worstConstraint(defs: readonly AssessedDeficiency[]): ReadinessConstraint {
  let worst: ReadinessConstraint = "none";
  for (const d of defs) {
    const c = constraintOf(d);
    if (constraintRank(c) > constraintRank(worst)) worst = c;
  }
  return worst;
}

/**
 * Map an operation and its gaps to a disposition. The lifecycle state machine
 * outranks detector gaps: deprecation can arrive via the manifest/enrichment as
 * `state: deprecated` without the boolean, and a review can set `state: blocked`
 * for reasons recorded in reviewNotes that no detector re-derives from AIR —
 * readiness must never contradict a human's explicit lifecycle decision. Below
 * that, the worst catalog constraint among the gaps wins; nothing here infers a
 * disposition from a gap's category or severity.
 */
function dispositionFor(op: Operation, defs: readonly AssessedDeficiency[]): Disposition {
  if (op.deprecated || op.state === "deprecated") return "excluded";
  if (op.state === "blocked") return "blocked";
  const worst = worstConstraint(defs);
  return worst === "none" ? "ready" : worst;
}

function emptySummary(): ReadinessAssessment["summary"] {
  return { ready: 0, refinementRequired: 0, humanDecisionRequired: 0, blocked: 0, excluded: 0 };
}

/**
 * The whole-service disposition: worst-constraint-wins across assessable
 * operations and surface findings. `excluded` only when there is nothing to
 * constrain at all — no assessable operation and no constraining surface finding.
 */
function overallDispositionOf(
  operations: readonly OperationReadiness[],
  surface: readonly AssessedDeficiency[],
): Disposition {
  const assessable = operations.filter((o) => o.disposition !== "excluded");
  let worst = worstConstraint(surface);
  for (const o of assessable) {
    if (o.disposition === "excluded" || o.disposition === "ready") continue;
    if (constraintRank(o.disposition) > constraintRank(worst)) worst = o.disposition;
  }
  if (worst !== "none") return worst;
  return assessable.length === 0 ? "excluded" : "ready";
}

/**
 * Assess a compiled AIR document. Deterministic and read-only: it runs the
 * detectors, buckets each gap onto its operation, and projects dispositions
 * from the catalog policy plus lifecycle state. Same detectors as
 * `anvil refine plan` — the two views cannot drift.
 */
export function assessReadiness(
  air: AirDocument,
  detectors: readonly Detector[] = DETECTORS,
): ReadinessAssessment {
  const deficiencies = runDetectors(air, detectors).map(assessDeficiency);

  const byOp = new Map<string, AssessedDeficiency[]>();
  const surface: AssessedDeficiency[] = [];
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
      state: op.state,
      disposition: dispositionFor(op, defs),
      worstSeverity: defs[0]?.severity,
      deficiencies: defs,
    };
  });

  const summary = emptySummary();
  for (const o of operations) summary[o.disposition]++;
  const assessable = operations.length - summary.excluded;
  const readyPercent = assessable <= 0 ? 100 : Math.round((100 * summary.ready) / assessable);

  return {
    schemaVersion: ASSESSMENT_SCHEMA_VERSION,
    contractHash: contractHash(air),
    service: { id: air.service.id, version: air.service.version },
    overallDisposition: overallDispositionOf(operations, surface),
    readyPercent,
    summary,
    operations,
    surfaceDeficiencies: surface,
  };
}

/* -------------------------------------------------------------------------- */
/* Views — a filter never mutates the artifact                                */
/* -------------------------------------------------------------------------- */

/** What a view narrows by. Absent fields match everything. */
export interface ReadinessFilter {
  minimumSeverity?: Severity;
}

/**
 * A **view** over an assessment: the complete, immutable artifact plus the rows
 * that match a filter. The headline totals (`summary`, `readyPercent`,
 * `overallDisposition`) always come from the full assessment — a filter narrows
 * what a customer drills into, never what the service honestly looks like.
 */
export interface ReadinessView {
  /** The complete assessment — never narrowed by the filter. */
  assessment: ReadinessAssessment;
  filter: ReadinessFilter;
  /** Operations with at least one matching gap, carrying only the matching gaps. */
  matchingOperations: OperationReadiness[];
  matchingSurfaceDeficiencies: AssessedDeficiency[];
}

function matchesFilter(d: AssessedDeficiency, filter: ReadinessFilter): boolean {
  if (filter.minimumSeverity === undefined) return true;
  return severityRank(d.severity) >= severityRank(filter.minimumSeverity);
}

/** Build a view. The assessment is carried whole; only the matching rows are derived. */
export function viewAssessment(
  assessment: ReadinessAssessment,
  filter: ReadinessFilter = {},
): ReadinessView {
  const matchingOperations = assessment.operations
    .map((o) => ({ ...o, deficiencies: o.deficiencies.filter((d) => matchesFilter(d, filter)) }))
    .filter((o) => o.deficiencies.length > 0);
  const matchingSurfaceDeficiencies = assessment.surfaceDeficiencies.filter((d) =>
    matchesFilter(d, filter),
  );
  return { assessment, filter, matchingOperations, matchingSurfaceDeficiencies };
}

/* -------------------------------------------------------------------------- */
/* Rendering — deterministic, color-free, honest about remediation            */
/* -------------------------------------------------------------------------- */

/**
 * The remediation line for a gap. Honest by construction: a skill that exists
 * only as a name in the catalog renders as not yet implemented, so the report
 * never promises automation Anvil does not ship.
 */
function remediationLine(d: AssessedDeficiency): string {
  return d.automatable
    ? `remediation: ${d.suggestedSkill} (anvil refine run --skill ${d.suggestedSkill})`
    : `remediation: ${d.suggestedSkill} [not yet implemented]`;
}

/** One rendered gap: the message, why it matters to an agent, and the honest fix. */
function gapLines(d: AssessedDeficiency, indent: string): string[] {
  return [
    `${indent}${d.message}`,
    `${indent}  impact: ${d.agentImpact}`,
    `${indent}  ${remediationLine(d)}`,
  ];
}

/** The gaps to surface for an operation in a triage line: those that put it there. */
function headlineGaps(o: OperationReadiness): AssessedDeficiency[] {
  if (o.disposition === "blocked" || o.disposition === "humanDecisionRequired") {
    return o.deficiencies.filter((d) => constraintOf(d) === o.disposition);
  }
  return o.deficiencies;
}

/** Worst-first ordering for operations: by disposition, then worst severity, then name. */
function compareReadiness(a: OperationReadiness, b: OperationReadiness): number {
  const disp = DISPOSITIONS.indexOf(a.disposition) - DISPOSITIONS.indexOf(b.disposition);
  if (disp !== 0) return disp;
  const sev = severityRank(b.worstSeverity ?? "info") - severityRank(a.worstSeverity ?? "info");
  if (sev !== 0) return sev;
  return a.command.localeCompare(b.command);
}

/** A short human coordinate for a surface finding's target. */
function surfaceTargetLabel(t: SemanticTarget): string {
  switch (t.kind) {
    case "capability":
      return t.capabilityId;
    case "workflow":
      return t.workflowId;
    default:
      return "service";
  }
}

/**
 * Render a view the way `anvil assess <service>` prints it: the contract
 * identity and headline first, the disposition counts, then what needs
 * attention — blocked and human-decision operations plus any constraining
 * surface finding, each with its impact and its honest remediation. The full
 * per-operation list lives in `--json`; this stays a small triage.
 *
 * When the view carries a filter, the attention section is replaced by the
 * matching rows — "show me those operations" — while the headline totals stay
 * the honest, unfiltered ones.
 */
export function summarizeAssessment(view: ReadinessView): string {
  const { assessment, filter } = view;
  const { service, summary } = assessment;
  const lines: string[] = [];
  lines.push(`Readiness — ${service.id} @ ${service.version}`);
  lines.push(`  Contract hash        ${assessment.contractHash}`);
  lines.push(`  Ready percent        ${assessment.readyPercent}%`);
  lines.push(`  Overall disposition  ${DISPOSITION_LABEL[assessment.overallDisposition]}`);
  lines.push("");
  lines.push(`  ${"Operations".padEnd(26)} ${assessment.operations.length}`);
  for (const disp of DISPOSITIONS) {
    lines.push(`  ${DISPOSITION_LABEL[disp].padEnd(26)} ${summary[disp]}`);
  }

  if (filter.minimumSeverity !== undefined) {
    // Narrowed view: list every operation with a matching gap, with all of them.
    const withGaps = view.matchingOperations.slice().sort(compareReadiness);
    lines.push("");
    if (withGaps.length === 0 && view.matchingSurfaceDeficiencies.length === 0) {
      lines.push("No operations match this filter.");
    } else {
      lines.push("Operations with matching gaps (worst first):");
      for (const o of withGaps) {
        lines.push(`  ${o.command}  (${DISPOSITION_LABEL[o.disposition].toLowerCase()})`);
        for (const d of o.deficiencies) lines.push(...gapLines(d, "    "));
      }
      for (const d of view.matchingSurfaceDeficiencies) {
        lines.push(`  ${surfaceTargetLabel(d.target)}  (surface)`);
        lines.push(...gapLines(d, "    "));
      }
    }
    return lines.join("\n");
  }

  const attention = assessment.operations
    .filter((o) => o.disposition === "blocked" || o.disposition === "humanDecisionRequired")
    .sort(compareReadiness);
  const surfaceAttention = assessment.surfaceDeficiencies.filter(
    (d) => constraintRank(constraintOf(d)) >= constraintRank("humanDecisionRequired"),
  );
  if (attention.length > 0 || surfaceAttention.length > 0) {
    lines.push("");
    lines.push("Needs attention:");
    for (const o of attention) {
      const marker = o.disposition === "blocked" ? "blocked" : "human decision";
      lines.push(`  ${o.command}  (${marker})`);
      if (o.state === "blocked") {
        lines.push("    Lifecycle state is 'blocked' — a reviewer decision recorded in AIR.");
      }
      for (const d of headlineGaps(o)) lines.push(...gapLines(d, "    "));
    }
    for (const d of surfaceAttention) {
      lines.push(`  ${surfaceTargetLabel(d.target)}  (surface)`);
      lines.push(...gapLines(d, "    "));
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
  if (o.state === "blocked" || o.state === "deprecated") {
    lines.push(`  state       ${o.state} (lifecycle decision; outranks detector findings)`);
  }
  if (o.deficiencies.length === 0) {
    lines.push("");
    lines.push(
      o.disposition === "ready"
        ? "No gaps detected. This operation is ready to expose."
        : "No gaps detected; the disposition reflects the lifecycle state alone.",
    );
    return lines.join("\n");
  }
  lines.push("");
  lines.push(`Gaps (${o.deficiencies.length}), worst first:`);
  for (const d of o.deficiencies) {
    lines.push(`  [${d.severity.padEnd(8)}] ${d.code}`);
    lines.push(`    ${d.message}`);
    lines.push(`    impact: ${d.agentImpact}`);
    lines.push(`    ${remediationLine(d)}`);
  }
  return lines.join("\n");
}
