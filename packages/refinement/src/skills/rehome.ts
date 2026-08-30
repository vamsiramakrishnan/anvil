import { type Claim, GENERIC_NOUNS, snakeCase } from "@anvil/air";
import { normalizedWords, routingTokens, singularize } from "../vocabulary.js";
import type { RefinementSkill, SkillContext, SkillProposal } from "./contract.js";
import { proposal } from "./proposal-helpers.js";

/**
 * `rehome-resource`, heuristic subset ONLY. The deficiency's general case —
 * "the derived resource shares no vocabulary with the name" — is a GREY AREA
 * by measurement: the design doc's hand audit found ~15 of 28 rule-B
 * re-homings semantically wrong, because vendors write synonyms (`hooks`
 * path, "webhook" name). No deterministic rule can pick between a synonym
 * and a mis-derivation, so for the general case this executor proposes
 * NOTHING and the deficiency flows to a coding harness via
 * `anvil refine export-task`.
 *
 * The one subset the audit data shows is ~100% precise is the singularizer
 * over-strip repair: the derived resource is a NON-WORD stem (`releas`,
 * `branche`) and the operation's own name spells the real word, differing by
 * exactly the over-stripped letter (`release` = `releas`+e, `branch` =
 * `branche`−e). All three defect-3 victims in the audit's "wrong" column are
 * this shape; the proposal is the vendor's own word, read verbatim off the
 * vendor's own name — nothing is invented. Anything else (multi-token stems,
 * ambiguous repairs, plain synonym mismatches) returns null.
 */
export function proposeResourceRehome(
  skill: RefinementSkill,
  context: SkillContext,
): SkillProposal | null {
  const op = context.operation;
  if (!op) return null;
  const resource = snakeCase((op.effect.resource ?? "").trim());
  // Single-token stems only: the over-strip defect corrupts one word, and a
  // multi-token resource with NO matching token is never that defect.
  if (!resource || resource.includes("_")) return null;

  const stems = new Set(routingTokens(resource));
  if (stems.size === 0) return null;
  // Shares vocabulary with the name after all → the detector's premise does
  // not hold on this context; proposing would close a finding that isn't there.
  if (routingTokens(`${op.canonicalName} ${op.displayName}`).some((s) => stems.has(s))) {
    return null;
  }

  // The repair: exactly one distinct name word whose singular differs from
  // the derived stem by the known over-stripped trailing `e`, in either
  // direction. Two candidates = ambiguity = a decision, not a repair.
  const repairFrom = (text: string, ref: string): { value: string; ref: string } | undefined => {
    const repaired = new Set<string>();
    for (const word of normalizedWords(text)) {
      const stem = singularize(word);
      if (stem === `${resource}e` || `${stem}e` === resource) repaired.add(stem);
    }
    const value = [...repaired][0];
    return repaired.size === 1 && value && !GENERIC_NOUNS.has(value) ? { value, ref } : undefined;
  };
  const candidate =
    repairFrom(op.canonicalName, `${op.id}.canonicalName`) ??
    repairFrom(op.displayName, `${op.id}.displayName`);
  if (!candidate) return null;

  const claim: Claim = {
    subject: op.id,
    predicate: "operation.resource",
    value: candidate.value,
    source: "spec",
    sourceRef: candidate.ref,
    method: "template",
    confidence: 0.9,
    note:
      "the operation's own name spells this word; the derived resource differs only by the " +
      "singularizer's over-stripped letter — a human still confirms the re-home",
  };
  return proposal(skill, context, [claim], { resource: candidate.value });
}
