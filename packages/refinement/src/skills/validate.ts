import type { Claim, EvidenceKind, JsonSchema } from "@anvil/air";
import {
  type EvidenceStrength,
  type JsonValue,
  type RefinementSkill,
  type SemanticPatch,
  type SkillContext,
  type SkillProposal,
  STRUCTURAL_KEYS,
  type ValidationCheckId,
  type ValidationEvidenceContext,
  type VerifiableArtifact,
} from "./contract.js";

/* -------------------------------------------------------------------------- */
/* Evidence strength                                                          */
/* -------------------------------------------------------------------------- */

/** Sources strong enough that a single one clears the highest bar. */
const AUTHORITATIVE_KINDS: ReadonlySet<EvidenceKind> = new Set(["source_impl", "recorded_traffic"]);

const STRENGTH_RANK: Record<EvidenceStrength, number> = {
  single: 0,
  corroborated: 1,
  authoritative: 2,
};

/**
 * The aggregate strength of a set of claims: authoritative if any single claim is
 * from an authoritative source, else corroborated if two *independent* sources
 * agree, else single. Independence is keyed on `sourceRef` (falling back to the
 * source kind) so two reads of the same file do not "corroborate" themselves.
 */
export function strengthOf(claims: Claim[]): EvidenceStrength {
  if (claims.length === 0) return "single";
  if (claims.some((c) => AUTHORITATIVE_KINDS.has(c.source))) return "authoritative";
  const distinct = new Set(claims.map((c) => c.sourceRef ?? c.source)).size;
  return distinct >= 2 ? "corroborated" : "single";
}

/** Does `have` meet or exceed `need`? */
export function meetsStrength(have: EvidenceStrength, need: EvidenceStrength): boolean {
  return STRENGTH_RANK[have] >= STRENGTH_RANK[need];
}

/* -------------------------------------------------------------------------- */
/* Value grounding + schema checks                                            */
/* -------------------------------------------------------------------------- */

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The target-relative field a claim predicate speaks to (`field.example` → `examples`). */
function predicateKey(predicate: string): string {
  const seg = predicate.split(".").pop() ?? predicate;
  return seg === "example" ? "examples" : seg;
}

/** Does this claim ground `value` for the given patch key? */
function claimGrounds(claim: Claim, key: string, value: JsonValue): boolean {
  if (predicateKey(claim.predicate) !== key) return false;
  if (key === "description" || key === "message") {
    return typeof claim.value === "string" && claim.value === value;
  }
  if (key === "retryable") {
    return Boolean(claim.value) === Boolean(value);
  }
  return deepEqual(claim.value, value);
}

/** Minimal JSON-Schema value check: enough to reject an example the schema forbids. */
export function valueMatchesSchema(value: unknown, schema: JsonSchema): boolean {
  const t = schema.type as string | undefined;
  if (t === "string" && typeof value !== "string") return false;
  if ((t === "integer" || t === "number") && typeof value !== "number") return false;
  if (t === "integer" && !Number.isInteger(value)) return false;
  if (t === "boolean" && typeof value !== "boolean") return false;
  if (t === "object" && (typeof value !== "object" || value === null || Array.isArray(value)))
    return false;
  if (t === "array" && !Array.isArray(value)) return false;
  const en = schema.enum;
  if (Array.isArray(en) && !en.some((e) => deepEqual(e, value))) return false;
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Validation checks                                                          */
/* -------------------------------------------------------------------------- */

export interface ValidationOutcome {
  check: ValidationCheckId;
  ok: boolean;
  reason: string;
}

export interface ValidatedProposal {
  proposal: SkillProposal;
  outcomes: ValidationOutcome[];
  status: "validated" | "rejected";
}

type Check = (
  skill: RefinementSkill,
  proposal: SkillProposal,
  context: SkillContext,
  evidence?: ValidationEvidenceContext,
) => ValidationOutcome;

/** The verification bar a given output field must clear: its per-field override, else the skill default. */
function requiredVerification(
  skill: RefinementSkill,
  field: string,
): "verified" | "allow_unverified" {
  return skill.evidence.fieldVerification?.[field] ?? skill.evidence.minimumVerification;
}

const STOPWORDS = new Set(["the", "a", "an", "of", "for", "to", "this", "is", "with", "and", "or"]);

function contentTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));
}

function ok(check: ValidationCheckId, reason: string): ValidationOutcome {
  return { check, ok: true, reason };
}
function fail(check: ValidationCheckId, reason: string): ValidationOutcome {
  return { check, ok: false, reason };
}

function patchEntries(patch: SemanticPatch): Array<[string, JsonValue]> {
  return Object.entries(patch.set);
}

const CHECKS: Record<ValidationCheckId, Check> = {
  patch_within_boundary(skill, proposal) {
    const allowed = new Set(skill.output.fields);
    const outside = Object.keys(proposal.patch.set).filter((k) => !allowed.has(k));
    return outside.length === 0
      ? ok("patch_within_boundary", "all patched keys are within the skill's field boundary")
      : fail("patch_within_boundary", `patch writes outside boundary: ${outside.join(", ")}`);
  },

  no_semantic_schema_change(_skill, proposal) {
    const structural = Object.keys(proposal.patch.set).filter((k) => STRUCTURAL_KEYS.has(k));
    return structural.length === 0
      ? ok("no_semantic_schema_change", "patch touches no structural keys")
      : fail("no_semantic_schema_change", `patch would change schema: ${structural.join(", ")}`);
  },

  claims_from_allowed_sources(skill, proposal) {
    const allowed = new Set(skill.evidence.allowed);
    if (proposal.claims.length === 0) {
      return fail("claims_from_allowed_sources", "proposal carries no claims");
    }
    const bad = proposal.claims.filter((c) => !allowed.has(c.source));
    return bad.length === 0
      ? ok("claims_from_allowed_sources", "every claim is from an admissible source")
      : fail(
          "claims_from_allowed_sources",
          `claims from inadmissible sources: ${[...new Set(bad.map((c) => c.source))].join(", ")}`,
        );
  },

  evidence_meets_minimum_strength(skill, proposal) {
    const have = strengthOf(proposal.claims);
    return meetsStrength(have, skill.evidence.minimumStrength)
      ? ok("evidence_meets_minimum_strength", `evidence strength '${have}' meets minimum`)
      : fail(
          "evidence_meets_minimum_strength",
          `evidence strength '${have}' below minimum '${skill.evidence.minimumStrength}'`,
        );
  },

  evidence_supports_value(_skill, proposal) {
    for (const [key, value] of patchEntries(proposal.patch)) {
      if (key === "examples" && Array.isArray(value)) {
        const unsupported = value.filter(
          (el) => !proposal.claims.some((c) => claimGrounds(c, key, el as JsonValue)),
        );
        if (unsupported.length > 0) {
          return fail(
            "evidence_supports_value",
            `no evidence for example(s): ${JSON.stringify(unsupported)}`,
          );
        }
        continue;
      }
      if (!proposal.claims.some((c) => claimGrounds(c, key, value))) {
        return fail(
          "evidence_supports_value",
          `no claim grounds '${key}' = ${JSON.stringify(value)}`,
        );
      }
    }
    return ok("evidence_supports_value", "every patched value is grounded by a claim");
  },

  evidence_meets_verification(skill, proposal, _context, evidence) {
    // Verification is a case-investigation guarantee — it can only be enforced against
    // the FROZEN evidence report. The heuristic refinement path has no frozen artifacts
    // and supplies none, so the check is inert there; the case path always supplies it.
    if (!evidence) {
      return ok(
        "evidence_meets_verification",
        "no frozen evidence report supplied; verification is enforced on the case path",
      );
    }
    const byId = new Map(evidence.artifacts.map((a) => [a.id, a]));

    // Resolve the claims that ground THIS value to their frozen artifacts, then hold
    // them to the field's verification bar. A grounding claim whose sourceRef does not
    // resolve to a frozen artifact cannot satisfy the requirement (point 7); a claim
    // that does not ground the value is irrelevant and never consulted (point 8).
    const checkValue = (field: string, value: JsonValue): ValidationOutcome | null => {
      const grounding = proposal.claims.filter((c) => claimGrounds(c, field, value));
      if (grounding.length === 0) {
        return fail(
          "evidence_meets_verification",
          `no grounding claim for '${field}' = ${JSON.stringify(value)}`,
        );
      }
      const resolved: VerifiableArtifact[] = [];
      for (const c of grounding) {
        const art = c.sourceRef ? byId.get(c.sourceRef) : undefined;
        if (!art) {
          return fail(
            "evidence_meets_verification",
            `${field} claim references unknown frozen artifact '${c.sourceRef ?? "(none)"}'`,
          );
        }
        resolved.push(art);
      }
      // "Verified" here means re-hashable (see isVerifiedGrounding): a verified status with
      // no re-readable coordinate cannot be re-verified and must not clear the bar.
      if (
        requiredVerification(skill, field) === "verified" &&
        !resolved.some(isVerifiedGrounding)
      ) {
        return fail(
          "evidence_meets_verification",
          `${field} requires verified evidence, but no grounding artifact is verified and re-hashable`,
        );
      }
      return null;
    };

    for (const [field, value] of patchEntries(proposal.patch)) {
      if (field === "examples" && Array.isArray(value)) {
        for (const el of value) {
          const outcome = checkValue(field, el as JsonValue);
          if (outcome) return outcome;
        }
        continue;
      }
      const outcome = checkValue(field, value);
      if (outcome) return outcome;
    }
    return ok(
      "evidence_meets_verification",
      "every patched value is grounded by evidence meeting its verification bar",
    );
  },

  description_nonempty(_skill, proposal) {
    const d = proposal.patch.set.description;
    return typeof d === "string" && d.trim().length > 0
      ? ok("description_nonempty", "description is non-empty")
      : fail("description_nonempty", "description is missing or empty");
  },

  description_not_tautological(_skill, proposal, context) {
    const d = proposal.patch.set.description;
    if (typeof d !== "string")
      return fail("description_not_tautological", "no description to check");
    const nameSource =
      context.field?.name ??
      context.operation?.canonicalName ??
      context.capability?.displayName ??
      "";
    const nameTokens = new Set(contentTokens(nameSource));
    const descTokens = contentTokens(d);
    // Tautological = every content word in the description is just the name again.
    const novel = descTokens.filter((w) => !nameTokens.has(w));
    return novel.length > 0
      ? ok("description_not_tautological", "description adds meaning beyond the name")
      : fail("description_not_tautological", `description merely restates '${nameSource}'`);
  },

  examples_validate_against_schema(_skill, proposal, context) {
    const examples = proposal.patch.set.examples;
    if (!Array.isArray(examples) || examples.length === 0) {
      return fail("examples_validate_against_schema", "no examples proposed");
    }
    const schema = context.field?.schema;
    if (!schema)
      return fail("examples_validate_against_schema", "no field schema to validate against");
    const invalid = examples.filter((ex) => !valueMatchesSchema(ex, schema));
    return invalid.length === 0
      ? ok("examples_validate_against_schema", "all examples validate against the field schema")
      : fail("examples_validate_against_schema", `invalid example(s): ${JSON.stringify(invalid)}`);
  },

  error_message_nonempty(_skill, proposal) {
    const m = proposal.patch.set.message;
    return typeof m === "string" && m.trim().length > 0
      ? ok("error_message_nonempty", "error message is non-empty")
      : fail("error_message_nonempty", "error message is missing or empty");
  },
};

/**
 * Run the checks a skill declares against a proposal, in order. The proposal is
 * `validated` only if every check passes — one failure rejects it. This is the
 * deterministic core that lets an unreliable executor be used safely: the machine
 * accepts demonstrated, grounded improvements and nothing else.
 */
export function validateProposal(
  skill: RefinementSkill,
  proposal: SkillProposal,
  context: SkillContext,
  evidenceContext?: ValidationEvidenceContext,
): ValidatedProposal {
  const outcomes = skill.validation.map((id) =>
    CHECKS[id](skill, proposal, context, evidenceContext),
  );
  const status = outcomes.every((o) => o.ok) ? "validated" : "rejected";
  return { proposal, outcomes, status };
}

/** The full set of implemented validation checks (for introspection/tests). */
export const VALIDATION_CHECKS = Object.keys(CHECKS) as ValidationCheckId[];

/**
 * Whether an artifact counts as *trustworthy* verified evidence: its status is
 * `verified` AND it carries a re-readable coordinate (a repository path) Anvil can
 * re-hash. A `verified` status with no such coordinate cannot be re-verified — a
 * hand-written or buggy `evidence.json` could assert it — so it does NOT satisfy a
 * verified-evidence requirement. Used by both the validation check and the approval
 * guard so "verified" means the same thing in both.
 */
export function isVerifiedGrounding(a: VerifiableArtifact): boolean {
  return a.verification.status === "verified" && typeof a.path === "string" && a.path.length > 0;
}

/**
 * The frozen artifacts that actually ground a proposal's patched values: for each
 * patched value (each example element for `examples`), the artifacts referenced by a
 * claim that grounds it. Artifacts referenced only by non-grounding claims — and
 * unrelated artifacts entirely — are excluded, so an approval decision counts only
 * evidence that backs the change, never a stray verified artifact from elsewhere in the
 * case. Generic over the artifact shape so both the case model and the minimal
 * `VerifiableArtifact` view flow through unchanged.
 */
export function groundingArtifacts<A extends { id: string }>(
  proposal: SkillProposal,
  artifacts: A[],
): A[] {
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  const out = new Map<string, A>();
  const collect = (field: string, value: JsonValue): void => {
    for (const c of proposal.claims) {
      if (!claimGrounds(c, field, value)) continue;
      const art = c.sourceRef ? byId.get(c.sourceRef) : undefined;
      if (art) out.set(art.id, art);
    }
  };
  for (const [field, value] of patchEntries(proposal.patch)) {
    if (field === "examples" && Array.isArray(value)) {
      for (const el of value) collect(field, el as JsonValue);
    } else {
      collect(field, value);
    }
  }
  return [...out.values()];
}
