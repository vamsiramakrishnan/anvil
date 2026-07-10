import type { AirDocument } from "@anvil/air";
import { applyPatches, type SemanticChange } from "./apply.js";
import type { Deficiency, Severity } from "./deficiency.js";
import { severityRank } from "./deficiency.js";
import type { Refinement } from "./model.js";
import { buildRefinementPlan, type RefinementPlan } from "./plan.js";
import { reconcile } from "./reconcile.js";
import { assembleContext, evidenceForTarget } from "./skills/context.js";
import { HeuristicSkillExecutor, type SkillExecutor } from "./skills/executor.js";
import { skillFor } from "./skills/registry.js";
import { validateProposal } from "./skills/validate.js";
import { describeTarget, targetKey } from "./target.js";

/**
 * The back half of the flywheel: turn a plan into a **refinement pack**. A pack is
 * the reviewable, serialisable output unit — every deficiency Anvil could act on,
 * carried as a `Refinement` with its evidence, proposed patch, affected artifacts,
 * validation outcomes, measured eval delta, and approval decision. Building a pack
 * never mutates AIR; only `applyApproved` produces a changed document, and only
 * from refinements the policy already `approved`.
 */

export interface RunOptions {
  /** Only act on deficiencies at or above this severity. */
  minSeverity?: Severity;
  /** Only act on deficiencies owned by this skill. */
  skill?: string;
  /** Only act on safety-category deficiencies. */
  safeOnly?: boolean;
  /** Executor for the propose stage (defaults to the deterministic reference). */
  executor?: SkillExecutor;
}

export interface RefinementSummary {
  /** Deficiencies that produced a refinement (validated or not). */
  proposed: number;
  approved: number;
  /** Measured clean but awaiting a human (improved/neutral under the review tier). */
  review: number;
  rejected: number;
  regressed: number;
  /** In-scope deficiencies with no implemented skill or nothing to propose. */
  skipped: number;
}

export interface RefinementPack {
  service: { id: string; version: string };
  plan: RefinementPlan;
  refinements: Refinement[];
  summary: RefinementSummary;
}

/**
 * Run the refinement loop over an AIR document and return a pack. For each
 * in-scope deficiency: route it to its skill, assemble context from AIR-resident
 * evidence, propose (executor), validate, and reconcile. Deficiencies with no
 * skill or no groundable proposal are counted as skipped — honestly reported, not
 * silently dropped.
 */
export async function runRefinements(
  air: AirDocument,
  options: RunOptions = {},
): Promise<RefinementPack> {
  const executor: SkillExecutor = options.executor ?? new HeuristicSkillExecutor();
  const plan = buildRefinementPlan(air);
  const minRank = options.minSeverity ? severityRank(options.minSeverity) : 0;

  const refinements: Refinement[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const deficiency of plan.deficiencies) {
    if (severityRank(deficiency.severity) < minRank) continue;
    if (options.safeOnly && deficiency.category !== "safety") continue;
    const skill = skillFor(deficiency.code);
    // An explicit --skill filter narrows to that skill without inflating `skipped`.
    if (options.skill && (!skill || skill.name !== options.skill)) continue;
    if (!skill) {
      skipped++;
      continue;
    }
    // Distinct deficiencies can route to the same (skill, target) — e.g. an error
    // that is both undocumented and of unknown retryability. Collapse them into one
    // refinement rather than proposing the identical patch twice.
    const id = `${skill.name}:${targetKey(deficiency.target)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const context = assembleContext(air, deficiency, evidenceForTarget(air, deficiency));
    const proposal = await executor.execute(skill, context);
    if (!proposal) {
      skipped++;
      continue;
    }
    // If the executor grounds proposals in a frozen evidence report (the case-backed
    // one does), carry those artifacts into validation AND reconcile so the verification
    // check and approval guard are enforced here too — not just on the `closeCase` path.
    const artifacts = executor.evidenceArtifactsFor?.(proposal);
    const validated = validateProposal(
      skill,
      proposal,
      context,
      artifacts ? { artifacts } : undefined,
    );
    refinements.push(reconcile({ air, context, validated, evidenceArtifacts: artifacts }));
  }

  const summary: RefinementSummary = {
    proposed: refinements.length,
    approved: refinements.filter((r) => r.status === "approved").length,
    review: refinements.filter((r) => r.status === "improved" || r.status === "neutral").length,
    rejected: refinements.filter((r) => r.status === "rejected").length,
    regressed: refinements.filter((r) => r.status === "regressed").length,
    skipped,
  };

  return {
    service: { id: air.service.id, version: air.service.version },
    plan,
    refinements,
    summary,
  };
}

/**
 * Apply only the `approved` refinements in a pack to AIR, returning a new document
 * and the refinements that were applied. Review-tier and regressed refinements are
 * intentionally left out — a human promotes those deliberately.
 */
export function applyApproved(
  air: AirDocument,
  pack: RefinementPack,
): { air: AirDocument; applied: Refinement[]; changes: SemanticChange[] } {
  const applied = pack.refinements.filter((r) => r.status === "approved");
  const { air: next, changes } = applyPatches(
    air,
    applied.map((r) => r.proposal),
  );
  return { air: next, applied, changes };
}

/* -------------------------------------------------------------------------- */
/* Serialisation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The files of a refinement pack — the on-disk record that makes a refinement
 * reviewable and auditable (spec's `refinements/<ts>/` layout). `eval-delta.json`
 * is populated here; the plan, claims, patches, validation, and artifacts each get
 * their own file so a reviewer can diff exactly one facet.
 */
export function packFiles(pack: RefinementPack): Record<string, string> {
  const j = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  return {
    "plan.json": j(pack.plan),
    "claims.json": j(pack.refinements.map((r) => ({ id: r.id, claims: r.evidence }))),
    "proposed.patch.json": j(pack.refinements.map((r) => ({ id: r.id, patch: r.proposal }))),
    "validation.json": j(pack.refinements.map((r) => ({ id: r.id, validation: r.validation }))),
    "eval-delta.json": j(pack.refinements.map((r) => ({ id: r.id, evalDelta: r.evalDelta }))),
    "artifacts-affected.json": j(
      pack.refinements.map((r) => ({ id: r.id, artifacts: r.affectedArtifacts })),
    ),
    "review.md": renderReviewMarkdown(pack),
  };
}

const STATUS_ORDER: Record<Refinement["status"], number> = {
  regressed: 0,
  approved: 1,
  improved: 2,
  neutral: 3,
  rejected: 4,
  proposed: 5,
  validated: 6,
};

/** Render the human review — one section per refinement, worst/most-actionable first. */
export function renderReviewMarkdown(pack: RefinementPack): string {
  const lines: string[] = [];
  lines.push(`# Refinement review — ${pack.service.id} @ ${pack.service.version}`);
  lines.push("");
  const s = pack.summary;
  lines.push(
    `${s.proposed} proposed · ${s.approved} approved · ${s.review} awaiting review · ` +
      `${s.rejected} rejected · ${s.regressed} regressed · ${s.skipped} skipped`,
  );
  lines.push("");
  lines.push("_Detection and measurement are deterministic; AIR was not changed._");
  lines.push("");

  const ordered = [...pack.refinements].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.id.localeCompare(b.id),
  );
  for (const r of ordered) {
    lines.push(`## ${r.skill} → ${describeTarget(r.target)}`);
    lines.push(`- **status**: ${r.status} (${r.approval.tier}: ${r.approval.reason})`);
    lines.push(`- **deficiency**: ${r.deficiency}`);
    const set = Object.entries(r.proposal.set)
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
      .join("; ");
    lines.push(`- **proposed**: ${set || "(none)"}`);
    if (r.evidence.length > 0) {
      const srcs = [...new Set(r.evidence.map((c) => c.sourceRef ?? c.source))];
      lines.push(`- **evidence**: ${srcs.join(", ")}`);
    }
    if (r.evalDelta.length > 0) {
      const d = r.evalDelta
        .map((e) => `${e.family} ${e.before.toFixed(2)}→${e.after.toFixed(2)} (${e.verdict})`)
        .join("; ");
      lines.push(`- **eval delta**: ${d}`);
    }
    const failed = r.validation.filter((v) => !v.ok);
    if (failed.length > 0) {
      lines.push(`- **validation failed**: ${failed.map((v) => v.check).join(", ")}`);
    }
    lines.push(`- **impact**: ${r.affectedArtifacts.map((a) => a.kind).join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}
