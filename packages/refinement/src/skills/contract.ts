import type { Capability, Claim, ErrorSpec, EvidenceKind, JsonSchema, Operation } from "@anvil/air";
import type { Deficiency, DeficiencyCode } from "../deficiency.js";
import type { SemanticTarget } from "../target.js";

/**
 * The skill layer. A **refinement skill** is not a Markdown file that tells an
 * agent to "improve this" — it is a *typed procedure* with a trigger, a fixed
 * set of context it needs, an evidence policy, an output shape, hard constraints,
 * and deterministic validation checks. The contract is stable; the executor
 * (Claude Code, Codex, a deterministic transformer) is swappable. That split is
 * the point: skill *semantics* never depend on who runs them, and no executor
 * can widen what a skill is allowed to touch.
 */

/** A concrete JSON value a patch may carry. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/**
 * The evidential bar a skill demands before it may propose. Ascending: a single
 * source, two independent sources that corroborate, or one authoritative source
 * (implementation / recorded traffic). A skill that invents business meaning from
 * thin air is the failure this gate exists to prevent.
 */
export type EvidenceStrength = "single" | "corroborated" | "authoritative";

/** A slice of context a skill needs assembled before it runs. */
export type ContextNeed =
  | "parent_operation"
  | "field_schema"
  | "sibling_fields"
  | "source_evidence"
  | "declared_error"
  | "capability";

/** An invariant a skill must not violate. Enforced by validation, never trusted. */
export type SkillConstraint =
  | "do_not_invent_business_rules"
  | "do_not_change_field_type"
  | "do_not_change_requiredness"
  | "preserve_domain_terms"
  | "do_not_loosen_safety";

/** A named deterministic validation check (implemented in validate.ts). */
export type ValidationCheckId =
  | "patch_within_boundary"
  | "no_semantic_schema_change"
  | "claims_from_allowed_sources"
  | "evidence_meets_minimum_strength"
  | "evidence_supports_value"
  | "evidence_meets_verification"
  | "description_nonempty"
  | "description_not_tautological"
  | "examples_validate_against_schema"
  | "error_message_nonempty";

/**
 * The minimal view of a frozen evidence artifact the `evidence_meets_verification`
 * check needs: its `id` (a claim references it by `sourceRef`) and whether a source
 * verifier confirmed its bytes. The case layer's richer `EvidenceArtifact` is
 * structurally assignable to this, so the generic validator resolves grounding claims
 * to real verification state WITHOUT importing the case model or reading the filesystem.
 */
export interface VerifiableArtifact {
  id: string;
  verification: { status: "verified" | "unverified" };
  /**
   * The re-readable source coordinate (a repository path) a `verified` artifact must
   * carry so Anvil can re-hash its bytes. A `verified` status *without* one cannot be
   * re-verified — a hand-written `evidence.json` could forge it — so such an artifact is
   * never counted as verified. The case `EvidenceArtifact` (which has an optional `path`)
   * is structurally assignable to this.
   */
  path?: string;
}

/**
 * The frozen evidence report handed to `validateProposal` so verification-sensitive
 * checks can resolve a claim's `sourceRef` to the artifact it actually rests on. The
 * case path always supplies it; the deterministic heuristic path omits it (it has no
 * frozen artifacts), leaving `evidence_meets_verification` inert there.
 */
export interface ValidationEvidenceContext {
  artifacts: VerifiableArtifact[];
}

/**
 * The typed contract for one refinement skill.
 */
export interface RefinementSkill {
  name: string;
  version: number;
  /** The deficiencies this skill closes. A plan routes each deficiency to its skill. */
  triggers: DeficiencyCode[];
  /** The target kind it operates on (a field skill never runs on an operation). */
  targetKind: SemanticTarget["kind"];
  /** Context slices to assemble before running. */
  context: ContextNeed[];
  /**
   * Which source kinds are admissible, and the minimum aggregate strength.
   * `minimumVerification` is the skill-wide trust bar a claim's evidence must
   * clear (`"verified"` demands a source Anvil re-hashed itself; `"allow_unverified"`
   * accepts a caller-supplied excerpt). `fieldVerification` is a narrow, optional
   * per-output-field override (keyed by the skill's target-relative field name,
   * e.g. `"retryable"`) for the rare field that needs a stricter bar than the
   * skill default — not a general policy engine.
   */
  evidence: {
    allowed: EvidenceKind[];
    minimumStrength: EvidenceStrength;
    minimumVerification: "verified" | "allow_unverified";
    fieldVerification?: Record<string, "verified" | "allow_unverified">;
  };
  /**
   * The output boundary. `predicates` are the claim predicates the patch asserts;
   * `supportingPredicates` are the narrow intermediate facts an investigation may
   * legitimately record on the way there (kept deliberately small); `fields` are
   * the **target-relative** semantic keys it may write (e.g. `description`,
   * `examples`, `message`). A key outside `fields` — or a predicate outside
   * `predicates` ∪ `supportingPredicates`, or any structural key like
   * `schema`/`type`/`required` — is a boundary violation. The skill owns this
   * whole contract, so evidence policy never has a second owner that can drift.
   */
  output: { predicates: string[]; supportingPredicates: string[]; fields: string[] };
  constraints: SkillConstraint[];
  /** The checks a proposal from this skill must pass to be `validated`. */
  validation: ValidationCheckId[];
}

/** A flat, read-only view of one input field, assembled for a field skill. */
export interface FieldContext {
  path: string;
  name: string;
  required: boolean;
  schema: JsonSchema;
  description?: string;
  enumValues?: unknown[];
  example?: unknown;
}

/**
 * Everything a skill is handed for one target: the deficiency, the AIR nodes it
 * concerns, and the **already-gathered** evidence (the gather stage's output).
 * The executor reads only this — it never reaches back into AIR — so a skill run
 * is a pure function of its context.
 */
export interface SkillContext {
  deficiency: Deficiency;
  target: SemanticTarget;
  operation?: Operation;
  capability?: Capability;
  field?: FieldContext;
  siblingFields?: FieldContext[];
  errorSpec?: ErrorSpec;
  /** Claim-scoped evidence gathered for this target (may be empty). */
  evidence: Claim[];
}

/**
 * A **target-relative** semantic patch: which semantic keys to set to which
 * values on the target node. Paths are relative to the target (a field patch
 * sets `description`, not `operations.x.input.body.reason.description`), so a
 * patch cannot address anything outside its target — the coarse mutation
 * boundary is structural, and the fine one is checked against the skill's `fields`.
 */
export interface SemanticPatch {
  target: SemanticTarget;
  set: Record<string, JsonValue>;
}

/**
 * What an executor returns: evidence-backed claims plus the semantic patch they
 * justify. This is a *proposal* — it is validated and (later) reconciled before
 * anything touches canonical AIR. `null` from an executor means "nothing to
 * propose" (e.g. no admissible evidence) — the honest answer, not a guess.
 */
export interface SkillProposal {
  skill: string;
  skillVersion: number;
  deficiency: DeficiencyCode;
  target: SemanticTarget;
  claims: Claim[];
  patch: SemanticPatch;
}

/** Structural keys a patch may never set — changing these is a schema change. */
export const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "schema",
  "type",
  "required",
  "in",
  "name",
  "enum",
]);
