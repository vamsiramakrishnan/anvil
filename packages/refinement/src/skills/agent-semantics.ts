import type { Claim } from "@anvil/air";
import type { JsonValue, RefinementSkill, SkillContext, SkillProposal } from "./contract.js";
import { claimsAsserting, claimsFor, proposal, strongestValue } from "./proposal-helpers.js";

/** Build a reviewed agent name without changing the upstream wire name. */
export function proposeFieldBinding(
  skill: RefinementSkill,
  context: SkillContext,
): SkillProposal | null {
  const set: Record<string, JsonValue> = {};
  const used: Claim[] = [];
  const nameClaims = claimsFor(context, skill, ".agent_name");
  const name = strongestValue(nameClaims);
  if (typeof name === "string" && name.trim().length > 0) {
    set.agent_name = name;
    used.push(...claimsAsserting(nameClaims, name));
  }
  const aliasClaims = claimsFor(context, skill, ".aliases");
  const aliases = strongestValue(aliasClaims);
  if (Array.isArray(aliases) && aliases.every((alias) => typeof alias === "string")) {
    set.aliases = aliases as JsonValue[];
    used.push(...claimsAsserting(aliasClaims, aliases));
  }
  return "agent_name" in set ? proposal(skill, context, used, set) : null;
}

/** Propose only evidence-backed descriptions and declarative response views. */
export function proposeUiProjection(
  skill: RefinementSkill,
  context: SkillContext,
): SkillProposal | null {
  const set: Record<string, JsonValue> = {};
  const used: Claim[] = [];
  for (const field of ["description", "response_projection"] as const) {
    const claims = claimsFor(context, skill, `.${field}`);
    const value = strongestValue(claims);
    if (field === "description" && typeof value === "string" && value.trim().length > 0) {
      set.description = value;
      used.push(...claimsAsserting(claims, value));
    }
    if (field === "response_projection" && value && typeof value === "object") {
      set.response_projection = value as JsonValue;
      used.push(...claimsAsserting(claims, value));
    }
  }
  return Object.keys(set).length > 0 ? proposal(skill, context, used, set) : null;
}
