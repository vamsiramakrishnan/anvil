import { type AirDocument, Claim, contractHash, hashCanonical } from "@anvil/air";
import { makeDeficiency } from "../deficiency.js";
import type { Refinement } from "../model.js";
import type { RefinementPack, RefinementSummary } from "../pack.js";
import { parseRefinementPack } from "../pack-schema.js";
import { buildRefinementPlan } from "../plan.js";
import { reconcile } from "../reconcile.js";
import { assembleContext, evidenceForTarget } from "../skills/context.js";
import type { SkillProposal } from "../skills/contract.js";
import { skillByName, skillFor } from "../skills/registry.js";
import { validateProposal } from "../skills/validate.js";
import { targetKey } from "../target.js";
import { rejectHarness } from "./errors.js";
import { freezeHarnessEvidence } from "./repository.js";
import {
  type HarnessEvidenceArtifact,
  type HarnessSubmission,
  parseHarnessSubmission,
  parseRefinementTask,
  type RefinementTask,
  zHarnessImportRecord,
} from "./schema.js";
import { verifyRefinementTaskIntegrity } from "./task.js";

export interface ImportHarnessSubmissionOptions {
  repositoryRoot: string;
}

function claimSubject(task: RefinementTask): string {
  const target = task.deficiency.target;
  switch (target.kind) {
    case "service":
      return task.service.id;
    case "capability":
      return target.capabilityId;
    case "operation":
    case "field":
    case "enum":
      return target.kind === "operation" ? target.operationId : target.path;
    case "error":
      return target.code;
    case "workflow":
      return target.workflowId;
    case "group":
      return target.groupId;
  }
}

function assertTaskBinding(air: AirDocument, task: RefinementTask, submission: HarnessSubmission) {
  verifyRefinementTaskIntegrity(task);
  const issues: string[] = [];
  if (submission.taskId !== task.taskId) {
    issues.push(`submission taskId '${submission.taskId}' does not match '${task.taskId}'`);
  }
  if (submission.taskHash !== task.taskHash) {
    issues.push("submission taskHash does not match the exported task");
  }
  if (task.service.id !== air.service.id || task.service.version !== air.service.version) {
    issues.push("task service identity does not match AIR");
  }
  const currentHash = contractHash(air);
  if (task.sourceContractHash !== currentHash) {
    rejectHarness(
      "refinement/stale_contract",
      "binding",
      "AIR changed after the refinement task was exported.",
      [`task contract: ${task.sourceContractHash}`, `current contract: ${currentHash}`],
    );
  }
  const skill = skillByName(task.skill.name);
  if (!skill) issues.push(`task references unknown skill '${task.skill.name}'`);
  if (skill && skill.version !== task.skill.version) {
    issues.push(`skill version ${task.skill.version} does not match installed v${skill.version}`);
  }
  if (skill && hashCanonical(skill) !== task.skill.contractHash) {
    issues.push("installed skill contract does not match the task's contract hash");
  }
  const routed = skillFor(task.deficiency.code);
  if (!routed || routed.name !== task.skill.name) {
    issues.push(`deficiency '${task.deficiency.code}' no longer routes to '${task.skill.name}'`);
  }
  if (issues.length > 0) {
    rejectHarness(
      "refinement/task_binding_failed",
      "binding",
      "The harness submission is not bound to the current Anvil task and skill contract.",
      issues,
    );
  }
  if (!skill) {
    rejectHarness(
      "refinement/task_binding_failed",
      "binding",
      `Task references unknown skill '${task.skill.name}'.`,
    );
  }
  return skill;
}

function assertSubmissionPolicy(task: RefinementTask, submission: HarnessSubmission): void {
  const allowedSources = new Set(task.policy.allowedSources);
  const allowedPredicates = new Set([
    ...task.policy.writablePredicates,
    ...task.policy.supportingPredicates,
  ]);
  const issues: string[] = [];
  for (const evidence of submission.evidence) {
    if (!allowedSources.has(evidence.source)) {
      issues.push(`evidence '${evidence.id}' uses inadmissible source '${evidence.source}'`);
    }
  }
  for (const claim of submission.claims) {
    if (!allowedPredicates.has(claim.predicate)) {
      issues.push(`claim predicate '${claim.predicate}' is outside the skill policy`);
    }
  }
  for (const field of Object.keys(submission.patch?.set ?? {})) {
    if (!task.policy.writableFields.includes(field)) {
      issues.push(`patch field '${field}' is outside the skill boundary`);
    }
  }
  if (issues.length > 0) {
    rejectHarness(
      "refinement/task_binding_failed",
      "binding",
      "The harness submission exceeds the task's evidence or mutation policy.",
      issues,
    );
  }
}

function claimsFromSubmission(
  task: RefinementTask,
  submission: HarnessSubmission,
  artifacts: readonly HarnessEvidenceArtifact[],
) {
  const artifactByInput = new Map(artifacts.map((artifact) => [artifact.inputId, artifact]));
  const evidenceById = new Map(submission.evidence.map((evidence) => [evidence.id, evidence]));
  return submission.claims.map((input) => {
    const artifact = artifactByInput.get(input.evidenceId);
    const evidence = evidenceById.get(input.evidenceId);
    if (!artifact || !evidence) {
      rejectHarness(
        "refinement/invalid_submission",
        "binding",
        `Claim evidence '${input.evidenceId}' could not be resolved.`,
      );
    }
    return Claim.parse({
      subject: claimSubject(task),
      predicate: input.predicate,
      value: input.value,
      source: evidence.source,
      sourceRef: artifact.id,
      sourceRevision: artifact.revision,
      method: "case_investigation",
      confidence: input.confidence ?? 0.8,
      note: input.note,
    });
  });
}

function summary(refinements: readonly Refinement[], skipped: number): RefinementSummary {
  return {
    proposed: refinements.length,
    approved: refinements.filter((refinement) => refinement.status === "approved").length,
    review: refinements.filter(
      (refinement) => refinement.status === "improved" || refinement.status === "neutral",
    ).length,
    rejected: refinements.filter((refinement) => refinement.status === "rejected").length,
    regressed: refinements.filter((refinement) => refinement.status === "regressed").length,
    skipped,
  };
}

/**
 * Import one portable harness response into Anvil's existing deterministic back half.
 * Coordinates are re-resolved, context is rebuilt from AIR, and only then is the
 * proposal validated, measured, reconciled, and serialized as a normal review pack.
 */
export function importHarnessSubmission(
  air: AirDocument,
  taskValue: unknown,
  submissionValue: unknown,
  options: ImportHarnessSubmissionOptions,
): RefinementPack {
  const task = parseRefinementTask(taskValue);
  const submission = parseHarnessSubmission(submissionValue);
  const skill = assertTaskBinding(air, task, submission);
  assertSubmissionPolicy(task, submission);

  const plan = buildRefinementPlan(air);
  // A GROUP task's deficiency is derived from the benchmark report — a derived
  // record the pure-over-AIR detectors cannot re-derive — so the plan lookup
  // that guards every node-scoped task cannot apply. Its still-exists check is
  // the pair the task already carries: `taskHash` binds the cluster's members
  // and evidence, and `sourceContractHash` (verified above) pins the exact AIR
  // document the benchmark measured, so a document change invalidates the task
  // through the same stale-contract gate a plan change would have.
  const currentDeficiency =
    task.deficiency.target.kind === "group"
      ? undefined
      : plan.deficiencies.find(
          (candidate) =>
            candidate.code === task.deficiency.code &&
            targetKey(candidate.target) === targetKey(task.deficiency.target),
        );
  if (!currentDeficiency && task.deficiency.target.kind !== "group") {
    rejectHarness(
      "refinement/stale_contract",
      "binding",
      "The deficiency named by the task no longer exists in the current refinement plan.",
    );
  }

  const artifacts = freezeHarnessEvidence(task, submission.evidence, options.repositoryRoot);
  const claims = claimsFromSubmission(task, submission, artifacts);
  const refinements: Refinement[] = [];
  if (submission.status === "proposal_generated") {
    const patch = submission.patch;
    if (!patch) {
      rejectHarness(
        "refinement/invalid_submission",
        "binding",
        "A proposal_generated submission must include a patch.",
      );
    }
    const deficiency = makeDeficiency(
      task.deficiency.code,
      task.deficiency.target,
      task.deficiency.message,
      task.deficiency.facts,
      task.deficiency.severity,
    );
    const context = assembleContext(air, deficiency, evidenceForTarget(air, deficiency));
    context.evidence = claims;
    const proposal: SkillProposal = {
      skill: task.skill.name,
      skillVersion: task.skill.version,
      deficiency: task.deficiency.code,
      target: task.deficiency.target,
      claims,
      patch: { target: task.deficiency.target, set: patch.set },
    };
    const validated = validateProposal(skill, proposal, context, { artifacts });
    if (validated.status === "rejected") {
      rejectHarness(
        "refinement/proposal_rejected",
        "validation",
        "The harness proposal failed Anvil's deterministic validation.",
        validated.outcomes
          .filter((outcome) => !outcome.ok)
          .map((outcome) => `${outcome.check}: ${outcome.reason}`),
      );
    }
    refinements.push(reconcile({ air, context, validated, evidenceArtifacts: artifacts }));
  }

  const record = zHarnessImportRecord.parse({
    task,
    submission,
    submissionHash: hashCanonical(submission),
    artifacts,
  });
  return parseRefinementPack({
    schemaVersion: 1,
    service: { id: air.service.id, version: air.service.version },
    sourceContractHash: contractHash(air),
    plan,
    refinements,
    summary: summary(refinements, refinements.length === 0 ? 1 : 0),
    harnessImports: [record],
  });
}
