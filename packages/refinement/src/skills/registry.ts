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
    predicates: [
      "error.message",
      "error.retryable",
      "error.upstream_code",
      "error.recovery_action",
      "error.field_path",
    ],
    supportingPredicates: ["error.cause", "error.httpStatus"],
    fields: ["message", "retryable", "upstream_code", "recovery_action", "field_path"],
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
 * This skill is deliberately bounded: verified behavioral evidence may clarify
 * the operation and select/remove/rename existing response fields, but may not
 * derive values or invent a replacement facade. The result always routes to a
 * human and is applied only through a receipt-bound decision.
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
    predicates: ["operation.description", "operation.response_projection"],
    supportingPredicates: [
      "operation.agent_capability",
      "operation.ui_projection",
      "operation.behavior",
      "operation.ownership",
    ],
    fields: ["description", "response_projection"],
  },
  constraints: ["do_not_invent_business_rules", "preserve_domain_terms"],
  validation: [
    "patch_within_boundary",
    "no_semantic_schema_change",
    "claims_from_allowed_sources",
    "evidence_meets_minimum_strength",
    "evidence_supports_value",
    "evidence_meets_verification",
    "response_projection_valid",
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
 * Propose a conservative grammar policy for an unguarded query-passthrough
 * operation — the reviewable path off `blocked`. Like `classify-idempotency`
 * this is safety-sensitive and NEVER auto-approved: the proposal restricts the
 * surface (SELECT-only, single-statement, no comments) but *exposing* a query
 * surface at all is a human's decision, and the tighter bounds an operator
 * should add — a row cap, a table allowlist — need estate knowledge the
 * detector does not have. The heuristic executor proposes the safe skeleton and
 * names exactly what a reviewer still must decide.
 */
const reviewQueryPassthrough: RefinementSkill = {
  name: "review-query-passthrough",
  version: 1,
  triggers: ["query_language_passthrough"],
  targetKind: "operation",
  context: ["parent_operation", "source_evidence", "capability"],
  evidence: {
    allowed: ["source_impl", "test_fixture", "spec", "doc_example", "recorded_traffic", "incident"],
    minimumStrength: "single",
    minimumVerification: "allow_unverified",
  },
  output: {
    predicates: ["operation.query_policy"],
    supportingPredicates: ["operation.behavior", "operation.effect"],
    fields: ["query_policy"],
  },
  constraints: ["do_not_loosen_safety", "do_not_invent_business_rules"],
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
      "pagination_page_size_param",
      "pagination_max_page_size",
      "pagination_default_page_size",
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

/**
 * Separate the name an agent reasons about from the exact upstream coordinate.
 * The wire name remains immutable; a reviewed binding changes every generated
 * surface together and retains explicit discovery aliases.
 */
const renameField: RefinementSkill = {
  name: "rename-field",
  version: 1,
  triggers: ["weak_field_name", "unit_ambiguous_field"],
  targetKind: "field",
  context: ["parent_operation", "field_schema", "sibling_fields", "source_evidence"],
  evidence: {
    allowed: ["source_impl", "test_fixture", "spec", "doc_example", "postman"],
    minimumStrength: "single",
    minimumVerification: "allow_unverified",
  },
  output: {
    predicates: ["field.agent_name", "field.aliases"],
    supportingPredicates: ["field.description", "field.unit", "field.usage"],
    fields: ["agent_name", "aliases"],
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
    "agent_field_name_valid",
  ],
};

/**
 * Author routing intents for an operation that has none. Intent examples are
 * the phrases an agent (and the benchmark's tool-discovery tasks) route by;
 * a compiled operation ships with zero, which leaves `anvil benchmark` with
 * no derivable tasks and the skill's "Example intents" line empty.
 *
 * Grounding is deliberately narrow: the heuristic executor only *templates*
 * phrases from the operation's own spec-derived semantics (effect action,
 * resource, display name) — never behavior claims — so the proposal restates
 * what the spec already names, in intent form. Documentation-tier risk, same
 * class as `generate-examples`.
 */
const authorIntentExamples: RefinementSkill = {
  name: "author-intent-examples",
  version: 1,
  triggers: ["operation_lacks_intent_examples"],
  targetKind: "operation",
  context: ["parent_operation", "capability", "source_evidence"],
  evidence: {
    allowed: ["spec", "doc_example", "postman"],
    minimumStrength: "single",
    minimumVerification: "allow_unverified",
  },
  output: {
    predicates: ["operation.intent_examples"],
    supportingPredicates: [],
    fields: ["intent_examples"],
  },
  constraints: ["do_not_invent_business_rules", "preserve_domain_terms"],
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
 * The capability-level sibling of `author-intent-examples`: routing phrases so
 * an agent can match a request to a capability. Templated from the capability's
 * own name and resource nouns — the same documentation-tier risk class.
 */
const authorRoutingPhrases: RefinementSkill = {
  name: "author-routing-phrases",
  version: 1,
  triggers: ["capability_missing_routing_phrases"],
  targetKind: "capability",
  context: ["capability", "source_evidence"],
  evidence: {
    allowed: ["spec", "doc_example", "postman"],
    minimumStrength: "single",
    minimumVerification: "allow_unverified",
  },
  output: {
    predicates: ["capability.intent_examples"],
    supportingPredicates: [],
    fields: ["intent_examples"],
  },
  constraints: ["do_not_invent_business_rules", "preserve_domain_terms"],
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
 * Propose a routable `verb_resource` name for an operation whose current name an
 * agent cannot route on — `do_transition` (vague verb), `get_object` (generic
 * resource), a bare `refunds` (no verb at all).
 *
 * A name is not decoration; it is the primary routing surface, and it is *three*
 * surfaces at once. The canonical name, the CLI command, and the MCP tool name
 * are one projection of the same (service, resource, action) triple, so they are
 * all in the boundary together: proposing a canonical name alone would leave the
 * CLI help and the tool list disagreeing with it, which is precisely the drift
 * Anvil exists to prevent.
 *
 * The operation `id` is deliberately NOT in the boundary. It is the coordinate
 * capability membership, workflow steps, cases, and every proposal target point
 * at; re-homing it is a migration, not a refinement.
 *
 * Documentation-tier evidence, and `single` on purpose: the proposal is a
 * *projection* of axes the spec already states (`effect.resource`,
 * `effect.action`, the route), so a second source cannot corroborate it — it can
 * only restate the first, the same reason `generate-examples` accepts a
 * schema-lifted value. No approval rule names this skill, so it always routes to
 * a human, which is right for a change that moves an agent-facing name (and is
 * the seam where a cross-document name collision — invisible from one
 * operation's context — gets caught).
 */
const renameOperation: RefinementSkill = {
  name: "rename-operation",
  version: 1,
  triggers: ["weak_operation_name"],
  targetKind: "operation",
  context: ["parent_operation", "capability", "source_evidence"],
  evidence: {
    allowed: ["spec", "doc_example", "postman"],
    minimumStrength: "single",
    minimumVerification: "allow_unverified",
  },
  output: {
    predicates: ["operation.canonical_name", "operation.cli_command", "operation.tool_name"],
    supportingPredicates: ["operation.name_weaknesses"],
    fields: ["canonical_name", "cli_command", "tool_name"],
  },
  constraints: ["do_not_invent_business_rules", "preserve_domain_terms"],
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
 * Give two siblings that describe themselves identically a description that says
 * which is which.
 *
 * The gap here is *distinctness*, not absence — the shared sentence is often
 * perfectly good prose, it just fits both operations — so this skill never
 * replaces the existing text. It keeps it verbatim and appends the axis on which
 * the spec ALREADY separates the siblings: the route, the required parameters,
 * the effect action. That ordering is the whole safety argument. Rewriting the
 * shared sentence would put invented business meaning where the spec's own words
 * used to be; appending a fact the spec states cannot.
 *
 * Same documentation tier as `describe-operation`, but a lower strength bar for
 * the same reason as `rename-operation`: the appended clause is read off this
 * operation's own contract, and asking a second source to corroborate the
 * contract is asking it to restate the spec.
 */
const disambiguateOperations: RefinementSkill = {
  name: "disambiguate-operations",
  version: 1,
  triggers: ["indistinct_operation_descriptions"],
  targetKind: "operation",
  context: ["parent_operation", "capability", "source_evidence"],
  evidence: {
    allowed: ["spec", "source_impl", "test_fixture", "doc_example", "postman"],
    minimumStrength: "single",
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

/**
 * Template a capability description from its own membership.
 *
 * A capability is *a view over operations* (see `Capability.operationIds`), so
 * its members are not outside evidence about it — they are what it is. Saying
 * "create, get, and list refunds" restates the grouping the compiler already
 * derived, in the sentence an agent reads while routing. What this skill must
 * never do is say what the capability is *for* in business terms; that needs
 * evidence, and the executor proposes nothing when membership yields no verbs
 * and no resource nouns rather than padding the sentence out.
 *
 * The documentation tier of `author-routing-phrases`, its sibling on the same
 * node, and the same `single` bar for the same reason.
 */
const describeCapability: RefinementSkill = {
  name: "describe-capability",
  version: 1,
  triggers: ["missing_capability_description"],
  targetKind: "capability",
  context: ["capability", "source_evidence"],
  evidence: {
    allowed: ["spec", "doc_example", "postman"],
    minimumStrength: "single",
    minimumVerification: "allow_unverified",
  },
  output: {
    predicates: ["capability.description"],
    supportingPredicates: [],
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
 * Bring an operation's tool surface back under the per-operation disclosure
 * budget — the cost every agent in the session pays before it can route
 * anywhere.
 *
 * The boundary is one field wide, and the omission is the design. An oversized
 * surface has exactly two kinds of contributor: prose, and contract. Prose (the
 * operation description, a field's paragraph of documentation) can be bounded
 * without changing what calls are legal. Contract — a 400-value enum, a
 * forty-property body — cannot: dropping enum members changes which requests the
 * API will accept, which is a schema change, which is why `enum`/`schema`/`type`
 * are in `STRUCTURAL_KEYS` and no skill may write them. So this skill acts on the
 * prose and *reports* the contract: the ranked contributors ride along as a
 * supporting claim so the owner reads a line item about a field ("enum with 412
 * values") instead of a verdict about their API.
 *
 * `do_not_invent_business_rules` is doing unusually literal work here. The
 * executor never rewrites the description — it keeps a verbatim leading run of
 * whole sentences and drops the tail, so the proposal is a prefix of the spec's
 * own text and the full wording stays in the source spec. A paraphrase that
 * happened to be shorter would be a new assertion about the operation wearing
 * the old one's provenance.
 */
const reduceSchemaDisclosure: RefinementSkill = {
  name: "reduce-schema-disclosure",
  version: 1,
  triggers: ["schema_too_large_for_disclosure"],
  targetKind: "operation",
  context: ["parent_operation", "field_schema", "source_evidence"],
  evidence: {
    allowed: ["spec"],
    minimumStrength: "single",
    minimumVerification: "allow_unverified",
  },
  output: {
    predicates: ["operation.description"],
    supportingPredicates: ["operation.disclosure_contributors"],
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

/** Every skill Anvil ships today. Executors are separate; these are semantics only. */
export const REFINEMENT_SKILLS: readonly RefinementSkill[] = [
  describeField,
  describeOperation,
  generateExamples,
  enrichErrors,
  investigateUiProjection,
  classifyIdempotency,
  classifyPagination,
  renameField,
  authorIntentExamples,
  authorRoutingPhrases,
  reviewQueryPassthrough,
  renameOperation,
  disambiguateOperations,
  describeCapability,
  reduceSchemaDisclosure,
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
