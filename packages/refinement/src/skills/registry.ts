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
    minimumVerification: "allow_unverified",
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
    "evidence_meets_verification",
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
    minimumVerification: "allow_unverified",
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
    "evidence_meets_verification",
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
    minimumVerification: "allow_unverified",
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
    "evidence_meets_verification",
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
    // Descriptions may rest on unverified evidence, but `retryable` is safety-affecting
    // and requires a source Anvil verified itself.
    minimumVerification: "allow_unverified",
    fieldVerification: { retryable: "verified" },
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
    "evidence_meets_verification",
  ],
};

/**
 * Investigate whether a screen-shaped endpoint is a durable agent capability.
 *
 * This skill is deliberately asymmetric: it may turn verified behavioral
 * evidence into a precise operation description, but it cannot approve,
 * exclude, regroup, or invent a replacement facade. A view-specific result is
 * still valuable as an evidence-bearing case with no proposal; the API owner
 * makes the exposure decision in the receipt-bound manifest.
 */
const investigateUiProjection: RefinementSkill = {
  name: "investigate-ui-projection",
  version: 1,
  triggers: ["ui_projection_contract"],
  targetKind: "operation",
  context: ["parent_operation", "capability", "source_evidence"],
  evidence: {
    allowed: [
      "source_impl",
      "test_fixture",
      "spec",
      "doc_example",
      "postman",
      "recorded_traffic",
      "incident",
    ],
    minimumStrength: "authoritative",
    minimumVerification: "verified",
  },
  output: {
    predicates: ["operation.description"],
    supportingPredicates: [
      "operation.agent_capability",
      "operation.ui_projection",
      "operation.behavior",
      "operation.ownership",
    ],
    fields: ["description"],
  },
  constraints: ["do_not_invent_business_rules", "preserve_domain_terms"],
  validation: [
    "patch_within_boundary",
    "no_semantic_schema_change",
    "claims_from_allowed_sources",
    "evidence_meets_minimum_strength",
    "evidence_supports_value",
    "evidence_meets_verification",
    "description_nonempty",
    "description_not_tautological",
  ],
};

/**
 * Investigate whether a mutation's repeat-call effect, or an already-enabled
 * retry posture, rests on real evidence.
 *
 * This is the highest-stakes skill Anvil ships: `idempotency.mode` gates
 * whether the runtime will ever auto-retry this call, and every one of its
 * outputs — mode, mechanism, key, key derivation, and the retry-basis label
 * — is a `do_not_loosen_safety` field. Unlike `describe-field`, this skill's
 * proposals are NEVER auto-approved (see approval.ts's idempotency guard):
 * there is no safe-to-auto-apply "tightening" direction here the way
 * `enrich-errors` has for `retryable=false`, because AIR's own default for
 * an unclassified mutation (`mode: "none"`) is already the most conservative
 * state possible — every reclassification moves away from that, never
 * further from it, so a human always signs off. The skill may gather
 * evidence and propose a specific claim; only a person may act on it.
 *
 * `contested_safety_semantic` also names this skill, for any safety-sensitive
 * predicate whose evidence conflicts — not only idempotency. The heuristic
 * executor still only ever gathers idempotency/retry-basis-shaped claims, so
 * a contest over an unrelated predicate (auth, confirmation, ...) naturally
 * grounds nothing here and the skill honestly proposes null, exactly as it
 * would for any other insufficiently-evidenced target — no special-casing.
 */
const classifyIdempotency: RefinementSkill = {
  name: "classify-idempotency",
  version: 1,
  triggers: ["mutation_effect_unproven", "retry_basis_unproven", "contested_safety_semantic"],
  targetKind: "operation",
  context: ["parent_operation", "source_evidence", "capability"],
  evidence: {
    allowed: ["source_impl", "test_fixture", "spec", "doc_example", "recorded_traffic", "incident"],
    minimumStrength: "authoritative",
    minimumVerification: "verified",
  },
  output: {
    predicates: ["operation.idempotency_mode", "operation.retry_basis"],
    supportingPredicates: ["operation.behavior", "operation.effect"],
    fields: [
      "idempotency_mode",
      "idempotency_mechanism",
      "idempotency_key",
      "idempotency_key_derivation",
      "retry_basis",
    ],
  },
  constraints: ["do_not_loosen_safety", "do_not_invent_business_rules"],
  validation: [
    "patch_within_boundary",
    "no_semantic_schema_change",
    "claims_from_allowed_sources",
    "evidence_meets_minimum_strength",
    "evidence_supports_value",
    "evidence_meets_verification",
    "idempotency_carrier_resolves",
  ],
};

/**
 * Document how a paginated operation's results are fetched: the pagination style
 * (cursor/page/offset/link), the parameter name used to pass a cursor/page/offset,
 * the field containing the next cursor/page/offset or link, and the field containing
 * the result items.
 *
 * This skill is lower-stakes than `classify-idempotency`: pagination misclassification
 * breaks an agent's ability to page through results, but it does not loosen retry or
 * idempotency safety. It uses the gentler bar of `describe-field` (corroborated evidence,
 * unverified sources allowed), not the authoritative-only bar of safety changes.
 */
const classifyPagination: RefinementSkill = {
  name: "document-pagination",
  version: 1,
  triggers: ["undocumented_pagination"],
  targetKind: "operation",
  context: ["parent_operation", "source_evidence", "capability"],
  evidence: {
    allowed: ["source_impl", "test_fixture", "spec", "doc_example", "postman"],
    minimumStrength: "corroborated",
    minimumVerification: "allow_unverified",
  },
  output: {
    predicates: ["operation.pagination"],
    supportingPredicates: ["operation.behavior", "operation.effect"],
    fields: [
      "pagination_style",
      "pagination_cursor_param",
      "pagination_next_field",
      "pagination_items_field",
    ],
  },
  constraints: ["do_not_invent_business_rules"],
  validation: [
    "patch_within_boundary",
    "no_semantic_schema_change",
    "claims_from_allowed_sources",
    "evidence_meets_minimum_strength",
    "evidence_supports_value",
    "evidence_meets_verification",
    "pagination_binding_resolves",
  ],
};

/** Every skill Anvil ships today. Executors are separate; these are semantics only. */
export const REFINEMENT_SKILLS: readonly RefinementSkill[] = [
  describeField,
  describeOperation,
  generateExamples,
  enrichErrors,
  investigateUiProjection,
  classifyIdempotency,
  classifyPagination,
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
