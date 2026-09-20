import type { Claim, Operation } from "@anvil/air";
import { routingTokens } from "../vocabulary.js";
import type { RefinementSkill, SkillContext, SkillProposal } from "./contract.js";
import {
  disambiguationIssues,
  type GroupDisambiguationPayload,
  groupGrantOf,
  groupNameIssues,
} from "./group-proposal.js";
import { proposal } from "./proposal-helpers.js";

/**
 * `resolve-confusable-cluster`, deterministic fallback — the trivially-safe
 * subset ONLY. The skill's general case (compose a workflow, author a
 * capability, or reword a cluster into distinguishable prose) needs judgement
 * a rule cannot supply, and flows to a coding harness via
 * `anvil refine export-task`. What a rule CAN do without inventing anything is
 * notice when a member's own name already says how it differs from its
 * siblings and its served text does not: `count_view` beside `list_views` and
 * `execute_view`, described as "Count tickets in a view." — the router reads
 * the description, the description never says "count", and the name did all
 * along.
 *
 * The move is a `disambiguate` proposal that appends, to the served
 * DESCRIPTION only, the distinguishing word(s) each member's `canonicalName`
 * carries and no sibling's name or served text does. It never renames, never
 * touches `skill.intentExamples` (the benchmark's held-out task set), never
 * rewrites existing prose, and proposes nothing unless EVERY member has such a
 * word — a cluster where one member's name does not separate it is a decision,
 * not a repair. It also proposes nothing when every member's served text
 * already carries its distinguishing word: then the confusion is not a missing
 * word, and appending one would change nothing a router reads.
 *
 * Every proposal is re-checked here against the same group validators the
 * import path runs (`disambiguationIssues`, `groupNameIssues`), so a fallback
 * that could not pass validation is withheld rather than proposed. The
 * approval policy pins the `disambiguate` key to review regardless of who
 * proposed it (approval.ts), so this never auto-applies.
 */
export function proposeClusterDisambiguation(
  skill: RefinementSkill,
  context: SkillContext,
): SkillProposal | null {
  const grant = groupGrantOf(context.deficiency.facts);
  const memberIds = new Set(grant.memberOperationIds);
  const members = (context.groupOperations ?? []).filter((op) => memberIds.has(op.id));
  if (members.length < 2) return null;
  // An empty description is `missing_operation_description`'s gap; appending a
  // word to nothing would leave a member described only by its name.
  if (members.some((op) => op.description.trim().length === 0)) return null;

  const served = (op: Operation): Set<string> =>
    new Set(routingTokens(`${op.description} ${op.displayName}`));
  const named = (op: Operation): Set<string> => new Set(routingTokens(op.canonicalName));

  const entries: GroupDisambiguationPayload["operations"] = [];
  let appended = 0;
  for (const op of members) {
    const siblings = members.filter((other) => other.id !== op.id);
    const elsewhere = new Set(siblings.flatMap((other) => [...named(other), ...served(other)]));
    const distinguishing = [...named(op)].filter((token) => !elsewhere.has(token));
    // No word in this member's name separates it from its siblings: nothing
    // trivially safe to say, so nothing is said — for the whole cluster.
    if (distinguishing.length === 0) return null;

    const own = served(op);
    const missing = distinguishing.filter((token) => !own.has(token));
    if (missing.length === 0) {
      entries.push({
        operation: op.id,
        description: op.description,
        rationale: `unchanged: its served text already carries ${quote(distinguishing)}, which no sibling's name or served text does`,
      });
      continue;
    }
    // The name's own spelling of each missing stem, so the appended clause is
    // the vendor's word rather than a singularized fragment of it.
    const words = op.canonicalName
      .split(/[^A-Za-z0-9]+/)
      .filter((word) => missing.includes(routingTokens(word)[0] ?? ""));
    if (words.length === 0) return null;
    appended += 1;
    entries.push({
      operation: op.id,
      description: `${terminate(op.description)} Specifically: the ${words.join(" ")} operation.`,
      rationale: `its own name carries ${quote(words)}, which no sibling's name or served text does, and its served text did not say so`,
    });
  }
  if (appended === 0) return null;

  const payload: GroupDisambiguationPayload = { operations: entries };
  if (
    disambiguationIssues(payload, members).length > 0 ||
    groupNameIssues({ disambiguate: payload }, members).length > 0
  ) {
    return null;
  }

  const groupId = context.target.kind === "group" ? context.target.groupId : undefined;
  const claim: Claim = {
    subject: groupId ?? members.map((op) => op.id).join(","),
    predicate: "group.disambiguate",
    value: payload,
    source: "spec",
    sourceRef: members.map((op) => `${op.id}.canonicalName`).join(", "),
    method: "template",
    confidence: 0.8,
    note: "each member's own description, kept verbatim, plus the distinguishing word its canonical name already carries",
  };
  return proposal(skill, context, [claim], { disambiguate: payload as never });
}

function terminate(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function quote(words: readonly string[]): string {
  return words.map((word) => `'${word}'`).join(", ");
}
