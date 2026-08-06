import { type Claim, effectiveWeight } from "@anvil/air";
import type {
  JsonValue,
  RefinementSkill,
  SemanticPatch,
  SkillContext,
  SkillProposal,
} from "./contract.js";

export function claimsFor(
  context: SkillContext,
  skill: RefinementSkill,
  predicateSuffix: string,
): Claim[] {
  const allowed = new Set(skill.evidence.allowed);
  return context.evidence.filter(
    (claim) => allowed.has(claim.source) && claim.predicate.endsWith(predicateSuffix),
  );
}

/** The value asserted by the strongest claim in a set, if any. */
export function strongestValue(claims: Claim[]): unknown {
  if (claims.length === 0) return undefined;
  return [...claims].sort((a, b) => effectiveWeight(b) - effectiveWeight(a))[0]?.value;
}

/** Claims that assert exactly `value` — the proposal's grounding set. */
export function claimsAsserting(claims: Claim[], value: unknown): Claim[] {
  return claims.filter((claim) => JSON.stringify(claim.value) === JSON.stringify(value));
}

export function proposal(
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
