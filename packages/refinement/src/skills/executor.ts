import { type Claim, effectiveWeight } from "@anvil/air";
import type {
  FieldContext,
  JsonValue,
  RefinementSkill,
  SemanticPatch,
  SkillContext,
  SkillProposal,
  VerifiableArtifact,
} from "./contract.js";

/**
 * A **skill executor** turns a skill's context into a proposal. It is deliberately
 * separate from the skill's semantics: the same `describe-field` contract can be
 * run by Claude Code, Codex, Antigravity, or the deterministic transformer below,
 * and the validators judge every executor's output by the same rules. An executor
 * may return `null` — the honest "nothing to propose" — and it must never be
 * trusted: whatever it returns is validated before it can matter.
 */
export interface SkillExecutor {
  name: string;
  execute(skill: RefinementSkill, context: SkillContext): Promise<SkillProposal | null>;
  /**
   * The frozen evidence artifacts backing a proposal this executor produced, if it
   * grounds proposals in a frozen evidence report. Executors with no frozen report (the
   * heuristic transformer) omit this; the case-backed executor implements it so
   * `runRefinements` can carry the artifacts into verification-aware validation and
   * approval instead of silently losing them at this seam. Returning `undefined` leaves
   * the verification check inert (correct for the heuristic path).
   */
  evidenceArtifactsFor?(proposal: SkillProposal): VerifiableArtifact[] | undefined;
}

function claimsFor(
  context: SkillContext,
  skill: RefinementSkill,
  predicateSuffix: string,
): Claim[] {
  const allowed = new Set(skill.evidence.allowed);
  return context.evidence.filter(
    (c) => allowed.has(c.source) && c.predicate.endsWith(predicateSuffix),
  );
}

/** The value asserted by the strongest claim in a set, if any. */
function strongestValue(claims: Claim[]): unknown {
  if (claims.length === 0) return undefined;
  return [...claims].sort((a, b) => effectiveWeight(b) - effectiveWeight(a))[0]?.value;
}

/** Claims (from the given set) that assert exactly `value` — the grounding set. */
function claimsAsserting(claims: Claim[], value: unknown): Claim[] {
  return claims.filter((c) => JSON.stringify(c.value) === JSON.stringify(value));
}

function proposal(
  skill: RefinementSkill,
  context: SkillContext,
  claims: Claim[],
  set: Record<string, JsonValue>,
): SkillProposal {
  const patch: SemanticPatch = { target: context.target, set };
  return {
    skill: skill.name,
    skillVersion: skill.version,
    deficiency: context.deficiency.code,
    target: context.target,
    claims,
    patch,
  };
}

/** A synthesized example lifted from the field's own (spec) schema, if present. */
function exampleFromSchema(field: FieldContext): { value: JsonValue; ref: string } | undefined {
  if (field.enumValues && field.enumValues.length > 0) {
    return { value: field.enumValues[0] as JsonValue, ref: `${field.path}.schema.enum[0]` };
  }
  const s = field.schema;
  if (s.example !== undefined)
    return { value: s.example as JsonValue, ref: `${field.path}.schema.example` };
  if (Array.isArray(s.examples) && s.examples.length > 0)
    return { value: s.examples[0] as JsonValue, ref: `${field.path}.schema.examples[0]` };
  if (s.default !== undefined)
    return { value: s.default as JsonValue, ref: `${field.path}.schema.default` };
  return undefined;
}

/**
 * The reference executor: deterministic, no LLM. It only ever proposes what its
 * context already grounds — descriptions and error semantics come from gathered
 * evidence, examples from evidence or the field's own spec schema — so it can
 * never invent business meaning. It is the executor the harness falls back to and
 * the fixture every richer executor is measured against.
 */
export class HeuristicSkillExecutor implements SkillExecutor {
  readonly name = "heuristic";

  async execute(skill: RefinementSkill, context: SkillContext): Promise<SkillProposal | null> {
    switch (skill.name) {
      case "describe-field":
      case "describe-operation":
        return this.describe(skill, context);
      case "generate-examples":
        return this.examples(skill, context);
      case "enrich-errors":
        return this.enrichError(skill, context);
      default:
        return null;
    }
  }

  private describe(skill: RefinementSkill, context: SkillContext): SkillProposal | null {
    const claims = claimsFor(context, skill, ".description");
    const value = strongestValue(claims);
    if (typeof value !== "string" || value.trim().length === 0) return null;
    // Carry only the claims that assert the chosen value — that is the grounding,
    // and its independent-source count is what determines evidence strength.
    return proposal(skill, context, claimsAsserting(claims, value), { description: value });
  }

  private examples(skill: RefinementSkill, context: SkillContext): SkillProposal | null {
    const field = context.field;
    if (!field) return null;

    const evidenceClaims = claimsFor(context, skill, ".example");
    const value = strongestValue(evidenceClaims);
    if (value !== undefined) {
      return proposal(skill, context, claimsAsserting(evidenceClaims, value), {
        examples: [value as JsonValue],
      });
    }

    // No external example — lift one from the field's own spec schema. The schema
    // is part of the source spec, so this is grounded, not invented.
    const derived = exampleFromSchema(field);
    if (!derived) return null;
    const subject = context.operation?.id ?? field.path;
    const claim: Claim = {
      subject,
      predicate: "field.example",
      value: derived.value,
      source: "spec",
      sourceRef: derived.ref,
      method: "schema_lift",
      confidence: 0.9,
    };
    return proposal(skill, context, [claim], { examples: [derived.value] });
  }

  private enrichError(skill: RefinementSkill, context: SkillContext): SkillProposal | null {
    const set: Record<string, JsonValue> = {};
    const used: Claim[] = [];

    const messageClaims = claimsFor(context, skill, ".message");
    const message = strongestValue(messageClaims);
    if (typeof message === "string" && message.trim().length > 0) {
      set.message = message;
      used.push(...claimsAsserting(messageClaims, message));
    }

    const retryableClaims = claimsFor(context, skill, ".retryable");
    const retryable = strongestValue(retryableClaims);
    if (typeof retryable === "boolean") {
      set.retryable = retryable;
      used.push(...claimsAsserting(retryableClaims, retryable));
    }

    if (Object.keys(set).length === 0) return null;
    return proposal(skill, context, used, set);
  }
}
