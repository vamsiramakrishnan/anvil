import type { AirDocument } from "@anvil/air";
import type { DeficiencyCode } from "../deficiency.js";
import { makeDeficiency } from "../deficiency.js";
import { assembleContext, evidenceForTarget } from "../skills/context.js";
import type { SkillContext } from "../skills/contract.js";
import { type SemanticTarget, targetKey } from "../target.js";
import type { CaseProposal, CaseTask } from "./model.js";
import { loadTargetDoc, loadTask } from "./store.js";

/**
 * **Proposal ↔ case identity binding.** A proposal produced for one case must never
 * mutate another semantic target: the skill, version, deficiency, the proposal's
 * target, AND the patch's target must all match the case exactly. This module owns
 * that binding — read the case's immutable identity, and reject any proposal that
 * does not match it — plus the reconstruction of the skill context the case was
 * opened with, so deterministic validation runs against real AIR facts.
 */

/** The immutable identity a proposal must match to be admissible for this case. */
export interface CaseIdentity {
  skill: string;
  skillVersion: number;
  deficiency: DeficiencyCode;
  target: SemanticTarget;
  targetKey: string;
}

/** The case's identity, read from its canonical task + target inputs. */
export function caseIdentity(dir: string): CaseIdentity {
  const task = loadTask(dir);
  const t = loadTargetDoc(dir);
  return {
    skill: task.skill,
    skillVersion: task.skillVersion,
    deficiency: task.deficiency,
    target: t.target,
    targetKey: t.key,
  };
}

/**
 * Bind a proposal to a case identity, or throw. Mismatches are rejected loudly —
 * never silently rewritten to the case target — so a hand-written or misrouted
 * `proposal.json` cannot patch a field the case never authorised.
 */
export function bindProposalToCase(proposal: CaseProposal, id: CaseIdentity): void {
  const mismatches: string[] = [];
  if (proposal.skill !== id.skill) mismatches.push(`skill '${proposal.skill}' ≠ '${id.skill}'`);
  if (proposal.skillVersion !== id.skillVersion)
    mismatches.push(`skillVersion ${proposal.skillVersion} ≠ ${id.skillVersion}`);
  if (proposal.deficiency !== id.deficiency)
    mismatches.push(`deficiency '${proposal.deficiency}' ≠ '${id.deficiency}'`);
  const pt = targetKey(proposal.target);
  if (pt !== id.targetKey) mismatches.push(`target '${pt}' ≠ '${id.targetKey}'`);
  const patchTarget = targetKey(proposal.patch.target);
  if (patchTarget !== id.targetKey)
    mismatches.push(`patch.target '${patchTarget}' ≠ '${id.targetKey}'`);
  if (mismatches.length > 0) {
    throw new Error(
      `Proposal is not bound to its case (${id.targetKey}): ${mismatches.join("; ")}. Refusing it.`,
    );
  }
}

/**
 * Rebuild the skill's `SkillContext` for a case from AIR — the same context the
 * case was opened with — so deterministic validation runs against real AIR facts
 * (the field schema, the operation, siblings), not against a stale copy.
 */
export function contextForCase(
  air: AirDocument,
  dir: string,
): { task: CaseTask; context: SkillContext } {
  const task = loadTask(dir);
  const tdoc = loadTargetDoc(dir);
  const deficiency = makeDeficiency(task.deficiency, tdoc.target, "", {}, task.severity);
  const context = assembleContext(air, deficiency, evidenceForTarget(air, deficiency));
  return { task, context };
}
