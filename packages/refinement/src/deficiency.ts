import type { SemanticTarget } from "./target.js";

/**
 * The four families a deficiency can belong to. They map to *why* the artifact is
 * worse for an agent: it can't understand it (documentation), can't route to it
 * (usability), can't trust it (safety), or can't be exercised against it (coverage).
 */
export type DeficiencyCategory = "documentation" | "usability" | "safety" | "coverage";

/**
 * Severity is ordered: a plan sorts by it and the loop gates on it. `blocking`
 * means the artifact should not be exposed until resolved; `info` is a nicety.
 */
export type Severity = "info" | "low" | "medium" | "high" | "blocking";

const SEVERITY_ORDER: readonly Severity[] = ["info", "low", "medium", "high", "blocking"];

/** Rank of a severity (higher is worse). */
export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

/** Order two severities, worst first. */
export function compareSeverity(a: Severity, b: Severity): number {
  return severityRank(b) - severityRank(a);
}

/**
 * Every deficiency Anvil can detect deterministically from AIR alone. Codes are
 * stable strings so plans, packs, and (later) skills key on them. Grouped by the
 * category their catalog entry assigns.
 */
export type DeficiencyCode =
  // documentation completeness
  | "missing_service_description"
  | "missing_capability_description"
  | "missing_operation_description"
  | "missing_field_description"
  | "opaque_enum_values"
  | "undocumented_error"
  | "undocumented_pagination"
  // agent usability
  | "weak_operation_name"
  | "indistinct_operation_descriptions"
  | "capability_missing_routing_phrases"
  | "operation_lacks_intent_examples"
  | "schema_too_large_for_disclosure"
  // safety
  | "mutation_effect_unproven"
  | "retry_basis_unproven"
  | "confirmation_posture_incomplete"
  | "auth_principal_unclear"
  | "error_retryability_unclear"
  | "contested_safety_semantic"
  // mock / eval coverage
  | "required_field_no_example";

/**
 * A single, typed, evidence-free observation: this specific semantic node is
 * missing or weak. Detection is deterministic and never mutates AIR — a
 * deficiency only *names* the gap and points at the narrow skill that could
 * close it. `facts` carries detector-specific detail for the skill and the
 * review pack; `message` is the human-facing one-liner for the plan.
 */
export interface Deficiency {
  code: DeficiencyCode;
  category: DeficiencyCategory;
  target: SemanticTarget;
  severity: Severity;
  /** One-line, human-facing statement of the gap (rendered in `anvil refine plan`). */
  message: string;
  /** Detector-specific structured detail (predicate names, sibling ids, counts, …). */
  facts: Record<string, unknown>;
  /** The narrow skill that, in a later stage, would propose a patch for this gap. */
  suggestedSkill: string;
}

/** The static metadata behind a code: its category, default severity, and skill. */
export interface DeficiencyDef {
  code: DeficiencyCode;
  category: DeficiencyCategory;
  defaultSeverity: Severity;
  suggestedSkill: string;
  /** Short human title used to group codes in a plan. */
  title: string;
}

function def(
  code: DeficiencyCode,
  category: DeficiencyCategory,
  defaultSeverity: Severity,
  suggestedSkill: string,
  title: string,
): DeficiencyDef {
  return { code, category, defaultSeverity, suggestedSkill, title };
}

/**
 * The catalog: the single source of truth for what each deficiency *is*. Detectors
 * read from it so a code's category, default severity, and owning skill are
 * declared once, not scattered across detection logic.
 */
export const DEFICIENCY_CATALOG: Record<DeficiencyCode, DeficiencyDef> = {
  missing_service_description: def(
    "missing_service_description",
    "documentation",
    "low",
    "describe-service",
    "missing service description",
  ),
  missing_capability_description: def(
    "missing_capability_description",
    "documentation",
    "low",
    "describe-capability",
    "missing capability description",
  ),
  missing_operation_description: def(
    "missing_operation_description",
    "documentation",
    "medium",
    "describe-operation",
    "missing operation description",
  ),
  missing_field_description: def(
    "missing_field_description",
    "documentation",
    "medium",
    "describe-field",
    "missing field description",
  ),
  opaque_enum_values: def(
    "opaque_enum_values",
    "documentation",
    "medium",
    "describe-enum",
    "opaque enum values",
  ),
  undocumented_error: def(
    "undocumented_error",
    "documentation",
    "low",
    "enrich-errors",
    "undocumented error",
  ),
  undocumented_pagination: def(
    "undocumented_pagination",
    "documentation",
    "low",
    "document-pagination",
    "undocumented pagination",
  ),
  weak_operation_name: def(
    "weak_operation_name",
    "usability",
    "low",
    "rename-operation",
    "weak operation name",
  ),
  indistinct_operation_descriptions: def(
    "indistinct_operation_descriptions",
    "usability",
    "medium",
    "disambiguate-operations",
    "indistinct sibling descriptions",
  ),
  capability_missing_routing_phrases: def(
    "capability_missing_routing_phrases",
    "usability",
    "low",
    "author-intent-examples",
    "capability has no routing phrases",
  ),
  operation_lacks_intent_examples: def(
    "operation_lacks_intent_examples",
    "usability",
    "low",
    "author-intent-examples",
    "operation lacks intent examples",
  ),
  schema_too_large_for_disclosure: def(
    "schema_too_large_for_disclosure",
    "usability",
    "info",
    "reduce-schema-disclosure",
    "schema too large for initial disclosure",
  ),
  mutation_effect_unproven: def(
    "mutation_effect_unproven",
    "safety",
    "high",
    "classify-idempotency",
    "mutation idempotency unproven",
  ),
  retry_basis_unproven: def(
    "retry_basis_unproven",
    "safety",
    "high",
    "classify-idempotency",
    "retry basis unproven",
  ),
  confirmation_posture_incomplete: def(
    "confirmation_posture_incomplete",
    "safety",
    "blocking",
    "confirm-posture",
    "confirmation posture incomplete",
  ),
  auth_principal_unclear: def(
    "auth_principal_unclear",
    "safety",
    "medium",
    "clarify-auth",
    "auth principal unclear",
  ),
  error_retryability_unclear: def(
    "error_retryability_unclear",
    "safety",
    "medium",
    "enrich-errors",
    "error retryability unclear",
  ),
  contested_safety_semantic: def(
    "contested_safety_semantic",
    "safety",
    "blocking",
    "classify-idempotency",
    "contested safety semantic",
  ),
  required_field_no_example: def(
    "required_field_no_example",
    "coverage",
    "low",
    "generate-examples",
    "required field has no example",
  ),
};

/**
 * Construct a deficiency from the catalog. Detectors pass the target, a message,
 * and facts; category, default severity, and skill come from the catalog so they
 * cannot drift. A detector may raise (never lower) severity via `severity` when a
 * particular instance is worse than the default (e.g. a required field vs optional).
 */
export function makeDeficiency(
  code: DeficiencyCode,
  target: SemanticTarget,
  message: string,
  facts: Record<string, unknown> = {},
  severity?: Severity,
): Deficiency {
  const meta = DEFICIENCY_CATALOG[code];
  const chosen = severity ?? meta.defaultSeverity;
  const effective =
    severityRank(chosen) >= severityRank(meta.defaultSeverity) ? chosen : meta.defaultSeverity;
  return {
    code,
    category: meta.category,
    target,
    severity: effective,
    message,
    facts,
    suggestedSkill: meta.suggestedSkill,
  };
}
