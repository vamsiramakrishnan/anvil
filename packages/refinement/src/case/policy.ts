import type { RefinementSkill, SkillConstraint } from "../skills/contract.js";
import type { CaseWorkspace } from "./identity.js";
import type { AllowedToolsDoc, EvidencePolicyDoc } from "./model.js";

/** Human wording for each machine constraint, shared by case and portable-task views. */
const CONSTRAINT_PROSE: Record<SkillConstraint, string> = {
  do_not_invent_business_rules: "infer business rules the sources do not support",
  do_not_change_field_type: "change the field's type",
  do_not_change_requiredness: "change whether the field is required",
  preserve_domain_terms: "replace the domain's own terms with invented vocabulary",
  do_not_loosen_safety:
    "loosen safety (e.g. mark an error retryable) without authoritative evidence",
};

/** Hard prohibitions every investigation carries, independent of the selected skill. */
export const BASE_INVESTIGATION_DENY = [
  "modify source files",
  "edit canonical AIR",
  "change schema structure (type, requiredness, enum)",
  "use generated documentation or mocks as authoritative evidence",
] as const;

/** Case-local helper commands rendered into the bounded investigation brief. */
export const CASE_HELPERS = [
  "anvil case inspect <case>",
  "anvil case add-evidence <case> --predicate p --source k --path file --lines a-b",
  "anvil case validate-claims <case>",
  "anvil case synthesize <case> field=value",
  "anvil case validate-proposal <case> <air>",
  "anvil case finalize <case> [--status ...]",
] as const;

/** Project a skill's executable evidence and mutation policy into a portable document. */
export function evidencePolicyForSkill(skill: RefinementSkill): EvidencePolicyDoc {
  return {
    allowedSources: skill.evidence.allowed,
    minimumStrength: skill.evidence.minimumStrength,
    writablePredicates: skill.output.predicates,
    supportingPredicates: skill.output.supportingPredicates,
    writableFields: skill.output.fields,
    constraints: skill.constraints,
    mustNot: skill.constraints.map((constraint) => CONSTRAINT_PROSE[constraint]),
    minimumVerification: skill.evidence.minimumVerification,
    fieldVerification: skill.evidence.fieldVerification,
  };
}

/** Build the case-only tools document around the same shared investigation policy. */
export function allowedToolsForWorkspace(workspace: CaseWorkspace): AllowedToolsDoc {
  return {
    workspace,
    helpers: [...CASE_HELPERS],
    deny: [...BASE_INVESTIGATION_DENY],
  };
}
