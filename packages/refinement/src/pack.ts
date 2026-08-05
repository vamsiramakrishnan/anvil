import { type AirDocument, contractHash, hashCanonical } from "@anvil/air";
import { applyPatches, type SemanticChange } from "./apply.js";
import type { Severity } from "./deficiency.js";
import { severityRank } from "./deficiency.js";
import type { Refinement } from "./model.js";
import { parseRefinementPack, parseRefinementReviewReceipt } from "./pack-schema.js";
import { buildRefinementPlan, type RefinementPlan } from "./plan.js";
import type { HarnessImportRecord } from "./protocol/schema.js";
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
  schemaVersion: 1;
  service: { id: string; version: string };
  /** Exact canonical contract this investigation and measurement ran against. */
  sourceContractHash: string;
  plan: RefinementPlan;
  refinements: Refinement[];
  summary: RefinementSummary;
  /** Process-neutral harness transactions imported into this measured pack. */
  harnessImports?: HarnessImportRecord[];
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
    // The executor gets its own disposable copy. Validation uses the pristine
    // context assembled above, so an untrusted adapter cannot rewrite the facts
    // it will later be judged against.
    const proposal = await executor.execute(skill, structuredClone(context));
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
    schemaVersion: 1,
    service: { id: air.service.id, version: air.service.version },
    sourceContractHash: contractHash(air),
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
  parseRefinementPack(pack);
  assertPackMatchesAir(air, pack);
  const applied = pack.refinements.filter((r) => r.status === "approved");
  const { air: next, changes } = applyPatches(
    air,
    applied.map((r) => r.proposal),
  );
  return { air: next, applied, changes };
}

export type ReviewDecision = "approved" | "rejected";

/** A human decision bound to one exact source contract, pack, and proposal. */
export interface RefinementReviewReceipt {
  schemaVersion: 1;
  service: { id: string; version: string };
  sourceContractHash: string;
  packHash: string;
  refinementId: string;
  proposalHash: string;
  decision: ReviewDecision;
  reviewer: string;
  reason: string;
  reviewedAt: string;
}

/** Stable identity of every measured and reviewable facet in a pack. */
export function refinementPackHash(pack: RefinementPack): string {
  return hashCanonical(parseRefinementPack(pack));
}

/** Create a decision only for a clean proposal that the policy routed to review. */
export function createReviewReceipt(
  pack: RefinementPack,
  refinementId: string,
  decision: ReviewDecision,
  reviewer: string,
  reason: string,
  reviewedAt: string = new Date().toISOString(),
): RefinementReviewReceipt {
  parseRefinementPack(pack);
  const refinement = pack.refinements.find((candidate) => candidate.id === refinementId);
  if (!refinement) throw new Error(`Refinement '${refinementId}' is not present in this pack.`);
  if (
    refinement.approval.tier !== "review" ||
    (refinement.status !== "improved" && refinement.status !== "neutral")
  ) {
    throw new Error(
      `Refinement '${refinementId}' is not awaiting human review (status: ${refinement.status}, tier: ${refinement.approval.tier}).`,
    );
  }
  if (!reviewer.trim()) throw new Error("A non-empty reviewer identity is required.");
  if (!reason.trim()) throw new Error("A non-empty review reason is required.");
  return {
    schemaVersion: 1,
    service: pack.service,
    sourceContractHash: pack.sourceContractHash,
    packHash: refinementPackHash(pack),
    refinementId,
    proposalHash: hashCanonical(refinement.proposal),
    decision,
    reviewer: reviewer.trim(),
    reason: reason.trim(),
    reviewedAt,
  };
}

/**
 * Apply the original measured pack, plus explicit review decisions. No detector,
 * executor, or measurement is rerun here, so the reviewed bytes are the bytes
 * that reach AIR.
 */
export function applyReviewed(
  air: AirDocument,
  pack: RefinementPack,
  receipts: readonly RefinementReviewReceipt[],
): { air: AirDocument; applied: Refinement[]; changes: SemanticChange[] } {
  parseRefinementPack(pack);
  assertPackMatchesAir(air, pack);
  const decisions = new Map<string, RefinementReviewReceipt>();
  for (const receipt of receipts) {
    verifyReviewReceipt(pack, receipt);
    if (decisions.has(receipt.refinementId)) {
      throw new Error(`Multiple review receipts supplied for '${receipt.refinementId}'.`);
    }
    decisions.set(receipt.refinementId, receipt);
  }

  const applied = pack.refinements.filter((refinement) => {
    if (refinement.status === "approved") return true;
    return decisions.get(refinement.id)?.decision === "approved";
  });
  const result = applyPatches(
    air,
    applied.map((refinement) => refinement.proposal),
  );
  if (applied.length > 0 && result.changes.length === 0) {
    throw new Error(
      "The reviewed pack made no changes; the source contract is stale or incompatible.",
    );
  }
  return { air: result.air, applied, changes: result.changes };
}

export function verifyReviewReceipt(pack: RefinementPack, receipt: RefinementReviewReceipt): void {
  parseRefinementPack(pack);
  parseRefinementReviewReceipt(receipt);
  if (receipt.schemaVersion !== 1) throw new Error("Unsupported review receipt schema version.");
  if (receipt.decision !== "approved" && receipt.decision !== "rejected") {
    throw new Error(`Receipt '${receipt.refinementId}' has an invalid decision.`);
  }
  if (receipt.service.id !== pack.service.id || receipt.service.version !== pack.service.version) {
    throw new Error(`Receipt '${receipt.refinementId}' targets a different service.`);
  }
  if (receipt.sourceContractHash !== pack.sourceContractHash) {
    throw new Error(`Receipt '${receipt.refinementId}' targets a different source contract.`);
  }
  if (receipt.packHash !== refinementPackHash(pack)) {
    throw new Error(`Receipt '${receipt.refinementId}' targets a different refinement pack.`);
  }
  const refinement = pack.refinements.find((candidate) => candidate.id === receipt.refinementId);
  if (!refinement) throw new Error(`Receipt targets unknown refinement '${receipt.refinementId}'.`);
  if (receipt.proposalHash !== hashCanonical(refinement.proposal)) {
    throw new Error(`Receipt '${receipt.refinementId}' targets a different proposal.`);
  }
  if (
    refinement.approval.tier !== "review" ||
    (refinement.status !== "improved" && refinement.status !== "neutral")
  ) {
    throw new Error(
      `Receipt '${receipt.refinementId}' cannot promote status '${refinement.status}'.`,
    );
  }
  if (!receipt.reviewer.trim() || !receipt.reason.trim()) {
    throw new Error(`Receipt '${receipt.refinementId}' is missing reviewer identity or reason.`);
  }
  if (Number.isNaN(Date.parse(receipt.reviewedAt))) {
    throw new Error(`Receipt '${receipt.refinementId}' has an invalid reviewedAt timestamp.`);
  }
}

function assertPackMatchesAir(air: AirDocument, pack: RefinementPack): void {
  const current = contractHash(air);
  if (current !== pack.sourceContractHash) {
    throw new Error(
      `Refinement pack is stale: source contract hash ${pack.sourceContractHash}, current ${current}.`,
    );
  }
  if (air.service.id !== pack.service.id || air.service.version !== pack.service.version) {
    throw new Error("Refinement pack service identity does not match AIR.");
  }
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
  parseRefinementPack(pack);
  const j = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  const files: Record<string, string> = {
    "pack.json": j(pack),
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
  if (pack.harnessImports && pack.harnessImports.length > 0) {
    files["harness-tasks.json"] = j(pack.harnessImports.map((record) => record.task));
    files["harness-submissions.json"] = j(pack.harnessImports.map((record) => record.submission));
    files["harness-evidence.json"] = j(
      pack.harnessImports.map((record) => ({
        taskId: record.task.taskId,
        artifacts: record.artifacts,
      })),
    );
  }
  return files;
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
  lines.push(`_Source contract: \`${pack.sourceContractHash}\`._`);
  lines.push("");

  if (pack.harnessImports && pack.harnessImports.length > 0) {
    lines.push("## Harness provenance");
    for (const record of pack.harnessImports) {
      const verified = record.artifacts.filter(
        (artifact) => artifact.verification.status === "verified",
      ).length;
      lines.push(`- **task**: \`${record.task.taskId}\` (\`${record.task.taskHash}\`)`);
      lines.push(
        `- **executor**: ${record.submission.executor.name} · outcome: ${record.submission.status}`,
      );
      lines.push(`- **repository revision**: \`${record.task.repository.revision}\``);
      lines.push(`- **submission**: \`${record.submissionHash}\``);
      lines.push(
        `- **evidence**: ${record.artifacts.length} artifact(s), ${verified} Git-verified`,
      );
      lines.push("");
    }
  }

  const ordered = [...pack.refinements].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.id.localeCompare(b.id),
  );
  for (const r of ordered) {
    lines.push(`## ${r.skill} → ${describeTarget(r.target)}`);
    lines.push(`- **refinement id**: \`${r.id}\``);
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
