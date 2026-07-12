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
export const SEVERITIES = ["info", "low", "medium", "high", "blocking"] as const;
export type Severity = (typeof SEVERITIES)[number];

const SEVERITY_ORDER: readonly Severity[] = SEVERITIES;

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
  | "required_field_no_example"
  // artifact review (raised by the model-driven review in review/, not detectors)
  | "phantom_operation_documented"
  | "cross_surface_disagreement";

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

/**
 * What one instance of a code, by itself, does to readiness — the catalog's
 * readiness policy, ordered least- to most-constraining. Readiness projects the
 * worst constraint among an operation's gaps; severity orders output but never
 * redefines what a code *means*.
 *
 * - `none`                  — informational; does not hold the operation back.
 * - `refinementRequired`    — a narrow refinement skill can close it.
 * - `humanDecisionRequired` — a skill can gather evidence, but a person decides.
 * - `blocked`               — must not be exposed until resolved.
 */
export const READINESS_CONSTRAINTS = [
  "none",
  "refinementRequired",
  "humanDecisionRequired",
  "blocked",
] as const;
export type ReadinessConstraint = (typeof READINESS_CONSTRAINTS)[number];

/** Rank of a readiness constraint (higher is more constraining). */
export function constraintRank(c: ReadinessConstraint): number {
  return READINESS_CONSTRAINTS.indexOf(c);
}

/** The static metadata behind a code: its category, default severity, skill, and policy. */
export interface DeficiencyDef {
  code: DeficiencyCode;
  category: DeficiencyCategory;
  defaultSeverity: Severity;
  suggestedSkill: string;
  /** Short human title used to group codes in a plan. */
  title: string;
  /** What this gap does to an operation's readiness disposition (worst wins). */
  readinessDisposition: ReadinessConstraint;
  /** One line of *why this gap matters to an agent* — not what is missing, but
   *  what the agent cannot do because it is missing. */
  agentImpact: string;
}

function def(
  code: DeficiencyCode,
  category: DeficiencyCategory,
  defaultSeverity: Severity,
  suggestedSkill: string,
  title: string,
  readinessDisposition: ReadinessConstraint,
  agentImpact: string,
): DeficiencyDef {
  return {
    code,
    category,
    defaultSeverity,
    suggestedSkill,
    title,
    readinessDisposition,
    agentImpact,
  };
}

/**
 * The catalog: the single source of truth for what each deficiency *is*. Detectors
 * read from it so a code's category, default severity, owning skill, readiness
 * policy, and agent impact are declared once, not scattered across detection or
 * assessment logic. The readiness dispositions follow one rule: documentation,
 * usability, and coverage gaps are closable by a narrow skill (refinement);
 * unproven or contested *safety* semantics need a person (human decision or
 * blocked); info-only observations constrain nothing.
 */
export const DEFICIENCY_CATALOG: Record<DeficiencyCode, DeficiencyDef> = {
  missing_service_description: def(
    "missing_service_description",
    "documentation",
    "low",
    "describe-service",
    "missing service description",
    "refinementRequired",
    "the agent cannot summarize what this service is for when choosing tools",
  ),
  missing_capability_description: def(
    "missing_capability_description",
    "documentation",
    "low",
    "describe-capability",
    "missing capability description",
    "refinementRequired",
    "the agent cannot tell what this capability covers when routing a request",
  ),
  missing_operation_description: def(
    "missing_operation_description",
    "documentation",
    "medium",
    "describe-operation",
    "missing operation description",
    "refinementRequired",
    "the agent cannot tell what calling this operation actually does",
  ),
  missing_field_description: def(
    "missing_field_description",
    "documentation",
    "medium",
    "describe-field",
    "missing field description",
    "refinementRequired",
    "the agent must guess what value this field expects",
  ),
  opaque_enum_values: def(
    "opaque_enum_values",
    "documentation",
    "medium",
    "describe-enum",
    "opaque enum values",
    "refinementRequired",
    "the agent cannot choose between enum values it cannot interpret",
  ),
  undocumented_error: def(
    "undocumented_error",
    "documentation",
    "low",
    "enrich-errors",
    "undocumented error",
    "refinementRequired",
    "the agent cannot explain this failure or pick a recovery",
  ),
  undocumented_pagination: def(
    "undocumented_pagination",
    "documentation",
    "low",
    "document-pagination",
    "undocumented pagination",
    "refinementRequired",
    "the agent will silently read only the first page of results",
  ),
  weak_operation_name: def(
    "weak_operation_name",
    "usability",
    "low",
    "rename-operation",
    "weak operation name",
    "refinementRequired",
    "the agent cannot infer intent from the name and may route wrongly",
  ),
  indistinct_operation_descriptions: def(
    "indistinct_operation_descriptions",
    "usability",
    "medium",
    "disambiguate-operations",
    "indistinct sibling descriptions",
    "refinementRequired",
    "the agent cannot pick between siblings that describe themselves identically",
  ),
  capability_missing_routing_phrases: def(
    "capability_missing_routing_phrases",
    "usability",
    "low",
    "author-intent-examples",
    "capability has no routing phrases",
    "refinementRequired",
    "the agent has no phrases to match a request to this capability",
  ),
  operation_lacks_intent_examples: def(
    "operation_lacks_intent_examples",
    "usability",
    "low",
    "author-intent-examples",
    "operation lacks intent examples",
    "refinementRequired",
    "the agent has no example phrasings to match a request to this operation",
  ),
  // Info-only: a large surface costs context, but nothing is wrong or unsafe.
  schema_too_large_for_disclosure: def(
    "schema_too_large_for_disclosure",
    "usability",
    "info",
    "reduce-schema-disclosure",
    "schema too large for initial disclosure",
    "none",
    "the agent pays a large context cost before it can call this",
  ),
  // Whether repeating a mutation duplicates its effect is a trust decision:
  // a skill can gather evidence, but a person approves the classification.
  mutation_effect_unproven: def(
    "mutation_effect_unproven",
    "safety",
    "high",
    "classify-idempotency",
    "mutation idempotency unproven",
    "humanDecisionRequired",
    "the agent cannot know whether repeating this call duplicates its effect",
  ),
  // Same shape: retries are already enabled on a basis nobody proved, and only
  // a person may keep (or revoke) that posture.
  retry_basis_unproven: def(
    "retry_basis_unproven",
    "safety",
    "high",
    "classify-idempotency",
    "retry basis unproven",
    "humanDecisionRequired",
    "the agent may retry this on a basis nobody has proven safe",
  ),
  // An unconfirmed irreversible/high-risk mutation must never reach an agent.
  confirmation_posture_incomplete: def(
    "confirmation_posture_incomplete",
    "safety",
    "blocking",
    "confirm-posture",
    "confirmation posture incomplete",
    "blocked",
    "the agent could trigger an irreversible effect without a human confirming it",
  ),
  // Whose authority a call runs under is the decisive agent-safety question;
  // reconciling an incoherent principal/delegation declaration is a human call,
  // not a documentation patch (hence humanDecisionRequired, not refinement).
  auth_principal_unclear: def(
    "auth_principal_unclear",
    "safety",
    "medium",
    "clarify-auth",
    "auth principal unclear",
    "humanDecisionRequired",
    "the agent cannot tell whose authority this call runs under",
  ),
  // Unknown retryability fails safe at runtime (never auto-retried), and the
  // enrich-errors skill may only tighten it — so a skill can close this gap.
  error_retryability_unclear: def(
    "error_retryability_unclear",
    "safety",
    "medium",
    "enrich-errors",
    "error retryability unclear",
    "refinementRequired",
    "the agent cannot decide whether retrying this failure is safe",
  ),
  // Authoritative sources disagree about a safety semantic: acting on either
  // side would be a guess, so the operation is blocked until a review resolves it.
  contested_safety_semantic: def(
    "contested_safety_semantic",
    "safety",
    "blocking",
    "classify-idempotency",
    "contested safety semantic",
    "blocked",
    "the agent would act on a safety semantic its own evidence disputes",
  ),
  required_field_no_example: def(
    "required_field_no_example",
    "coverage",
    "low",
    "generate-examples",
    "required field has no example",
    "refinementRequired",
    "no realistic value can be generated to mock or eval this before it ships",
  ),
  // The two codes below are raised only by the model-driven artifact review
  // (review/): they judge generated artifacts against AIR, which no AIR-only
  // detector can do. Both are closable by regenerating/refining the artifact,
  // hence refinementRequired; a *safety* disagreement between surfaces maps to
  // `contested_safety_semantic` instead, which blocks.
  phantom_operation_documented: def(
    "phantom_operation_documented",
    "documentation",
    "high",
    "align-artifacts",
    "phantom operation documented",
    "refinementRequired",
    "the agent will plan around (and try to call) an operation that does not exist",
  ),
  cross_surface_disagreement: def(
    "cross_surface_disagreement",
    "usability",
    "high",
    "align-artifacts",
    "surfaces disagree about an operation",
    "refinementRequired",
    "the agent learns a different meaning for the operation depending on which surface it reads",
  ),
};

/**
 * Construct a deficiency from the catalog. Detectors pass the target, a message,
 * and facts; category, default severity, and skill come from the catalog so they
 * cannot drift. A detector may raise (never lower) severity via `severity` when a
 * particular instance is worse than the default (e.g. a required field vs optional)
 * — escalation affects ordering only; it never redefines what the code means, so
 * the catalog's `readinessDisposition` is untouched by it.
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
