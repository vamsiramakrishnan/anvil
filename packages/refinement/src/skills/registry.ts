import type { DeficiencyCode } from "../deficiency.js";
import type { RefinementSkill } from "./contract.js";

/**
 * The initial skill packages. Each is a narrow, typed procedure — never "improve
 * this". They share the same contract shape so the executor and validator treat
 * them uniformly, and each triggers on the exact deficiency codes its catalog
 * entry points at (asserted by the tests), so a plan routes deficiencies to
 * skills with no drift.
 */

const describeField: RefinementSkill = {
  name: "describe-field",
  version: 1,
  triggers: ["missing_field_description"],
  targetKind: "field",
  context: ["parent_operation", "field_schema", "sibling_fields", "source_evidence"],
  evidence: {
    allowed: ["source_impl", "test_fixture", "spec", "doc_example", "postman"],
    minimumStrength: "corroborated",
  },
  output: {
    predicates: ["field.description"],
    supportingPredicates: [
      "field.visibility",
      "field.unit",
      "field.usage",
      "field.lifecycle",
      "field.sensitivity",
    ],
    fields: ["description"],
  },
  constraints: [
    "do_not_invent_business_rules",
    "do_not_change_field_type",
    "do_not_change_requiredness",
    "preserve_domain_terms",
  ],
  validation: [
    "patch_within_boundary",
    "no_semantic_schema_change",
    "claims_from_allowed_sources",
    "evidence_meets_minimum_strength",
    "evidence_supports_value",
    "description_nonempty",
    "description_not_tautological",
  ],
};

const describeOperation: RefinementSkill = {
  name: "describe-operation",
  version: 1,
  triggers: ["missing_operation_description"],
  targetKind: "operation",
  context: ["parent_operation", "source_evidence", "capability"],
  evidence: {
    allowed: ["source_impl", "test_fixture", "spec", "doc_example", "postman"],
    minimumStrength: "corroborated",
  },
  output: {
    predicates: ["operation.description"],
    supportingPredicates: ["operation.effect", "operation.behavior"],
    fields: ["description"],
  },
  constraints: ["do_not_invent_business_rules", "preserve_domain_terms"],
  validation: [
    "patch_within_boundary",
    "no_semantic_schema_change",
    "claims_from_allowed_sources",
    "evidence_meets_minimum_strength",
    "evidence_supports_value",
    "description_nonempty",
    "description_not_tautological",
  ],
};

const generateExamples: RefinementSkill = {
  name: "generate-examples",
  version: 1,
  triggers: ["required_field_no_example"],
  targetKind: "field",
  context: ["parent_operation", "field_schema", "source_evidence"],
  evidence: {
    allowed: ["spec", "source_impl", "test_fixture", "doc_example", "postman", "generated_mock"],
    minimumStrength: "single",
  },
  output: {
    predicates: ["field.example"],
    supportingPredicates: ["field.format", "field.description"],
    fields: ["examples"],
  },
  constraints: ["do_not_change_field_type", "do_not_change_requiredness"],
  validation: [
    "patch_within_boundary",
    "no_semantic_schema_change",
    "claims_from_allowed_sources",
    "evidence_meets_minimum_strength",
    "evidence_supports_value",
    "examples_validate_against_schema",
  ],
};

const enrichErrors: RefinementSkill = {
  name: "enrich-errors",
  version: 1,
  triggers: ["undocumented_error", "error_retryability_unclear"],
  targetKind: "error",
  context: ["parent_operation", "declared_error", "source_evidence"],
  evidence: {
    allowed: ["source_impl", "test_fixture", "spec", "incident", "doc_example"],
    minimumStrength: "single",
  },
  output: {
    predicates: ["error.message", "error.retryable"],
    supportingPredicates: ["error.cause", "error.httpStatus"],
    fields: ["message", "retryable"],
  },
  // Retryability can only tighten from evidence here; loosening it (retryable=true)
  // is a safety change reserved for the reconcile stage's asymmetric trust gate.
  constraints: ["do_not_loosen_safety"],
  validation: [
    "patch_within_boundary",
    "no_semantic_schema_change",
    "claims_from_allowed_sources",
    "evidence_meets_minimum_strength",
    "evidence_supports_value",
  ],
};

/** Every skill Anvil ships today. Executors are separate; these are semantics only. */
export const REFINEMENT_SKILLS: readonly RefinementSkill[] = [
  describeField,
  describeOperation,
  generateExamples,
  enrichErrors,
];

/** Discover the available skills (stable order). */
export function discoverSkills(): readonly RefinementSkill[] {
  return REFINEMENT_SKILLS;
}

/** The skill that closes a given deficiency, if one is implemented. */
export function skillFor(code: DeficiencyCode): RefinementSkill | undefined {
  return REFINEMENT_SKILLS.find((s) => s.triggers.includes(code));
}

/** Look a skill up by name. */
export function skillByName(name: string): RefinementSkill | undefined {
  return REFINEMENT_SKILLS.find((s) => s.name === name);
}
