import { z } from "zod";
import {
  DEFICIENCY_CATALOG,
  type Deficiency,
  type DeficiencyCode,
  severityRank,
} from "./deficiency.js";
import type { DistillationReport } from "./distill.js";

/**
 * The bridge from distillation to enrichment: a distilled surface's OPEN QUESTIONS
 * — the writes it kept as basis without proving idempotent, the same-signature
 * mutation clusters, the reconstructible reads with stranded intents, the weak
 * names — are exactly what the enrichment sources should be asked about. This turns
 * a `DistillationReport` (plus the deterministic deficiency scan) into a targeted,
 * source-routed retrieval plan, so `anvil enrich` probes only the operations whose
 * meaning is UNCERTAIN, with sharp questions aimed at the tier that can answer them
 * (code proves idempotency; docs describe intent).
 *
 * It is a pure, deterministic peer of `distill` — `(report, deficiencies) → plan`,
 * no AIR mutation, and it does NOT run detection itself (the caller passes
 * deficiencies) so `distill()` stays a pure eigenbasis analysis. The plan is
 * ADVISORY ROUTING ONLY: `safetyDirection` on a question is documentation for the
 * case loop; the enrichment path's sole authority over what may loosen safety
 * remains `reconcile` — docs tighten / code loosens is preserved by construction,
 * never by this plan.
 */

export type EnrichmentMotive =
  | "unproven_safety"
  | "review_cluster"
  | "stranded_intent"
  | "weak_name";
export type SourceClass = "code" | "docs" | "any";

export interface ProbeQuestion {
  /** The natural-language question the investigation exists to answer. */
  ask: string;
  /** Search phrases seeded from stranded intents / tool name / resource+action. */
  queries: string[];
  /** Where the admissible-tier evidence lives — a routing signal, not a gate. */
  sourceClass: SourceClass;
  /** The AIR predicate an answer bears on. */
  predicate: string;
  /** Only on safety questions; ADVISORY — reconcile enforces the tier, not this. */
  safetyDirection?: "tighten" | "loosen";
  /** The case-loop skill that would consume an answer. */
  suggestedSkill?: string;
}

export interface EnrichmentTarget {
  operationId: string;
  toolName: string;
  capabilityId?: string;
  motive: EnrichmentMotive;
  /** Higher = investigate first. */
  priority: number;
  questions: ProbeQuestion[];
  reason: string;
}

export interface EnrichmentPlan {
  /** Provenance from the distill report. */
  total: number;
  basisSize: number;
  /** ONLY unresolved ops — a clean basis operation is absent. */
  targets: EnrichmentTarget[];
}

const PRIORITY: Record<EnrichmentMotive, number> = {
  unproven_safety: 90,
  review_cluster: 80,
  stranded_intent: 60,
  weak_name: 40,
};

/** The operationId a deficiency hangs off, when it is operation-scoped. */
function deficiencyOpId(d: Deficiency): string | undefined {
  const t = d.target;
  return "operationId" in t ? t.operationId : undefined;
}

/**
 * Build the retrieval plan. `deficiencies` are passed in (run `runDetectors(air)`),
 * so this stays a pure function and `distill` never secretly runs detection.
 */
export function distillToEnrichmentPlan(
  report: DistillationReport,
  deficiencies: readonly Deficiency[] = [],
): EnrichmentPlan {
  const byOp = new Map<string, EnrichmentTarget>();
  const worstSeverity = new Map<string, number>();

  const add = (t: EnrichmentTarget, severity: number) => {
    const prev = byOp.get(t.operationId);
    if (!prev) {
      byOp.set(t.operationId, t);
    } else {
      prev.questions.push(...t.questions);
      if (t.priority > prev.priority) {
        prev.priority = t.priority;
        prev.motive = t.motive;
        prev.reason = t.reason;
      }
    }
    worstSeverity.set(t.operationId, Math.max(worstSeverity.get(t.operationId) ?? 0, severity));
  };

  // 1. Highest: writes distill kept as basis without proving idempotency — the
  //    real "go ask GitHub for the Idempotency-Key" operations.
  for (const d of deficiencies) {
    const opId = deficiencyOpId(d);
    if (!opId) continue;
    if (d.code === "mutation_effect_unproven" || d.code === "retry_basis_unproven") {
      add(
        target(report, opId, "unproven_safety", [
          {
            ask: `Prove whether this mutation is idempotent — a documented idempotency key, dedup window, or natural key in the implementation.`,
            queries: [opId, "idempotency", "Idempotency-Key"],
            sourceClass: "code",
            predicate: "idempotency.mode",
            safetyDirection: "loosen",
            suggestedSkill: "classify-idempotency",
          },
        ]),
        severityRank(d.severity),
      );
    } else if (d.code === "error_retryability_unclear") {
      add(
        target(report, opId, "unproven_safety", [
          {
            ask: "Which upstream error codes are safe to retry, and which are terminal?",
            queries: [opId, "retry", "rate limit", "429", "503"],
            sourceClass: "docs",
            predicate: "errors.retryable",
            safetyDirection: "tighten",
            suggestedSkill: "enrich-errors",
          },
        ]),
        severityRank(d.severity),
      );
    }
  }

  // 2. Same-signature mutation clusters — redundancy + idempotency questions.
  for (const op of report.review) {
    add(
      target(report, op.operationId, "review_cluster", [
        {
          ask: `Prove whether ${op.toolName} is idempotent, and which of the same-signature mutations is canonical.`,
          queries: [
            op.toolName,
            `${op.signature.resource} ${op.signature.action}`,
            "idempotency",
            "Idempotency-Key",
          ],
          sourceClass: "code",
          predicate: "idempotency.mode",
          safetyDirection: "loosen",
          suggestedSkill: "classify-idempotency",
        },
        {
          ask: "Are any of these same-signature mutations deprecated or superseded?",
          queries: [op.toolName, "deprecated", "superseded"],
          sourceClass: "docs",
          predicate: "deprecated",
          safetyDirection: "tighten",
        },
      ]),
      severityRank("low"),
    );
  }

  // 3. Reconstructible reads with stranded intents — keep-or-re-home usability
  //    decision (no safety direction; distill already named it a Stage-2 call).
  for (const op of report.reconstructible) {
    if (op.strandedIntents.length === 0) continue;
    add(
      target(
        report,
        op.operationId,
        "stranded_intent",
        [
          {
            ask: `Is ${op.toolName} a meaningful projection of ${op.reconstructsFrom ?? "the canonical read"}, or dead weight — what does it do that the canonical read does not?`,
            queries: [...op.strandedIntents, op.toolName],
            sourceClass: "docs",
            predicate: "description",
            suggestedSkill: "describe-operation",
          },
        ],
        `reconstructible projection of ${op.reconstructsFrom ?? "?"} — stranded intent(s): ${op.strandedIntents.map((i) => `"${i}"`).join(", ")}`,
      ),
      severityRank("low"),
    );
  }

  // 4. Weak / indistinct names — an any-class description question.
  for (const d of deficiencies) {
    const opId = deficiencyOpId(d);
    if (!opId) continue;
    if (d.code === "weak_operation_name" || d.code === "indistinct_operation_descriptions") {
      add(
        target(report, opId, "weak_name", [
          {
            ask: agentImpactOf(d.code),
            queries: [opId],
            sourceClass: "any",
            predicate: "description",
            suggestedSkill:
              d.code === "weak_operation_name" ? "rename-operation" : "disambiguate-operations",
          },
        ]),
        severityRank(d.severity),
      );
    }
  }

  const targets = [...byOp.values()].sort(
    (a, b) =>
      b.priority - a.priority ||
      (worstSeverity.get(b.operationId) ?? 0) - (worstSeverity.get(a.operationId) ?? 0) ||
      a.operationId.localeCompare(b.operationId),
  );
  return { total: report.total, basisSize: report.basisSize, targets };
}

/** Look up an op's tool name / capability from the distill report (it lists them all). */
function target(
  report: DistillationReport,
  operationId: string,
  motive: EnrichmentMotive,
  questions: ProbeQuestion[],
  reason?: string,
): EnrichmentTarget {
  const d = [...report.basis, ...report.reconstructible, ...report.review].find(
    (x) => x.operationId === operationId,
  );
  return {
    operationId,
    toolName: d?.toolName ?? operationId,
    capabilityId: d?.capabilityId,
    motive,
    priority: PRIORITY[motive],
    questions,
    reason: reason ?? `${motive.replace(/_/g, " ")} on ${operationId}`,
  };
}

function agentImpactOf(code: DeficiencyCode): string {
  return (
    DEFICIENCY_CATALOG[code]?.agentImpact ?? "The agent cannot infer intent from this operation."
  );
}

// --- serialization (mirrors parseSources) ------------------------------------

const ProbeQuestionSchema = z.object({
  ask: z.string(),
  queries: z.array(z.string()),
  sourceClass: z.enum(["code", "docs", "any"]),
  predicate: z.string(),
  safetyDirection: z.enum(["tighten", "loosen"]).optional(),
  suggestedSkill: z.string().optional(),
});
export const EnrichmentPlanSchema = z.object({
  total: z.number(),
  basisSize: z.number(),
  targets: z.array(
    z.object({
      operationId: z.string(),
      toolName: z.string(),
      capabilityId: z.string().optional(),
      motive: z.enum(["unproven_safety", "review_cluster", "stranded_intent", "weak_name"]),
      priority: z.number(),
      questions: z.array(ProbeQuestionSchema),
      reason: z.string(),
    }),
  ),
});

/** Parse an enrichment plan (the machine-emitted JSON artifact), validated by zod. */
export function parseEnrichmentPlan(text: string): EnrichmentPlan {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("Enrichment plan is not valid JSON.");
  }
  return EnrichmentPlanSchema.parse(doc) as EnrichmentPlan;
}

/** Human view of the plan. */
export function renderEnrichmentPlan(plan: EnrichmentPlan): string {
  const lines = [
    `Enrichment plan — ${plan.targets.length} operation(s) to investigate (of ${plan.total}; ${plan.basisSize} clean basis skipped)`,
    "",
  ];
  for (const t of plan.targets) {
    lines.push(`  [${t.priority}] ${t.motive}  ${t.operationId}  (${t.toolName})`);
    lines.push(`        ${t.reason}`);
    for (const q of t.questions) {
      const dir = q.safetyDirection ? ` (${q.safetyDirection})` : "";
      lines.push(`        → ask ${q.sourceClass}${dir}: ${q.ask}`);
    }
  }
  if (plan.targets.length === 0) lines.push("  (surface is grounded — nothing to enrich)");
  return lines.join("\n");
}
