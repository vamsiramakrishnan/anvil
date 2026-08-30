import {
  type Claim,
  charsForTokenBudget,
  DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS,
  estimateTokens,
  GENERIC_NOUNS,
  IdempotencyMechanism,
  IdempotencyMode,
  KeyDerivation,
  nameWeaknesses,
  type Operation,
  OperationAction,
  Pagination,
  RetryBasis,
  snakeCase,
  WEAK_VERBS,
} from "@anvil/air";
import type { SqlDialect } from "@anvil/grammar";
import { proposeFieldBinding, proposeUiProjection } from "./agent-semantics.js";
import type {
  FieldContext,
  JsonValue,
  RefinementSkill,
  SkillContext,
  SkillProposal,
  VerifiableArtifact,
} from "./contract.js";
import { claimsAsserting, claimsFor, proposal, strongestValue } from "./proposal-helpers.js";

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

/** English plural good enough for spec nouns: category→categories, box→boxes, doc→docs. */
function pluralize(noun: string): string {
  if (noun.length === 0) return noun;
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(noun)) return `${noun}es`;
  return `${noun}s`;
}

/**
 * The inverse, character-for-character identical to the compiler's `singularize`
 * (naming.ts). Duplicated rather than imported: `@anvil/compiler` is a *dev*
 * dependency of this package (the runtime dependency graph runs
 * compiler → refinement, never back), so importing it here would ship a package
 * with an undeclared runtime dependency. Kept byte-compatible so a name this
 * skill proposes is the name the compiler would have derived for the same
 * (resource, action) pair — `naming.test.ts` (compiler) asserts the two
 * function bodies are literally identical, so a change to one that misses the
 * other fails the suite instead of drifting silently.
 */
function singularize(s: string): string {
  if (/ies$/.test(s)) return s.replace(/ies$/, "y");
  // `-ches` words whose stem really ends in `-che` (GitHub's actions caches):
  // stripping the whole `es` would mint a non-word, the exact defect this
  // function exists to avoid, so these few known stems lose only the `s`.
  if (/(?:caches|niches|headaches|mustaches|avalanches)$/.test(s)) return s.replace(/s$/, "");
  // Sibilant stems take `-es`; stripping it restores the stem whole
  // (searches→search, branches→branch, boxes→box, addresses→address). A single
  // `z` is deliberately NOT in the class — `sizes`/`prizes` are `-e` stems and
  // a true z-sibilant plural doubles the z (`quizzes`).
  if (/(?:ch|sh|x|zz|ss)es$/.test(s)) return s.replace(/es$/, "");
  // Singular nouns ending in `-us` (status, bus, virus) pluralize to `-uses`;
  // strip the `es` so the singular keeps its final `s`.
  if (/uses$/.test(s)) return s.replace(/es$/, "");
  // Every other `-ses` is a `-se` stem plus a plural `s` (releases, databases,
  // cases, licenses): strip only the final `s`. The old blanket `-ses → -s`
  // branch over-stripped these to non-words (`releas`, `databas`) that no
  // operation's own name text can ever corroborate.
  if (/ses$/.test(s)) return s.replace(/s$/, "");
  if (/s$/.test(s) && !/(?:ss|us)$/.test(s)) return s.replace(/s$/, "");
  return s;
}

/** "a", "a and b", "a, b, and c" — a readable list with a deterministic order. */
function sentenceList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Sentence-case a templated clause without touching the domain terms inside it. */
function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}

/** End a sentence exactly once, so an appended clause never reads as a run-on. */
function terminate(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
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
      case "investigate-ui-projection":
        return proposeUiProjection(skill, context);
      case "generate-examples":
        return this.examples(skill, context);
      case "enrich-errors":
        return this.enrichError(skill, context);
      case "classify-idempotency":
        return this.classifyIdempotency(skill, context);
      case "document-pagination":
        return this.classifyPagination(skill, context);
      case "rename-field":
        return proposeFieldBinding(skill, context);
      case "author-intent-examples":
        return this.authorIntentExamples(skill, context);
      case "author-routing-phrases":
        return this.authorRoutingPhrases(skill, context);
      case "review-query-passthrough":
        return this.reviewQueryPassthrough(skill, context);
      case "rename-operation":
        return this.renameOperation(skill, context);
      case "disambiguate-operations":
        return this.disambiguateOperations(skill, context);
      case "describe-capability":
        return this.describeCapability(skill, context);
      case "reduce-schema-disclosure":
        return this.reduceSchemaDisclosure(skill, context);
      default:
        return null;
    }
  }

  /**
   * A routable name re-projected from the two axes AIR already carries for this
   * operation: `effect.resource` (which the compiler set from the path, already
   * singularized) and `effect.action` (which the classifier proved, and which is
   * more truthful than the HTTP method for the POST-that-updates cases). The
   * projection itself mirrors the compiler's `projectRoutingNames`, so a name
   * proposed here is byte-identical to the one a manifest override naming the
   * same resource/action would produce — three surfaces moved together, never
   * one.
   *
   * Two refusals keep this honest. Without a *concrete* resource or a
   * *contentful* verb there is nothing to name the operation after, and the only
   * remaining move would be to invent a domain noun — so the executor proposes
   * nothing. And the candidate is re-critiqued with `nameWeaknesses`, the same
   * predicate the detector fired on: trading `get_object` for `list_data` would
   * close a finding without fixing anything, which is worse than leaving it open.
   */
  private renameOperation(skill: RefinementSkill, context: SkillContext): SkillProposal | null {
    const op = context.operation;
    if (!op) return null;
    // The service segment of the dotted id — the same axis `projectRoutingNames`
    // takes as `serviceId`, read off the coordinate rather than re-derived.
    const serviceId = op.id.split(".")[0] ?? "";
    if (!serviceId) return null;

    const resource = routableResource(op);
    const action = routableAction(op);
    if (!resource || !action) return null;

    const names = projectRoutingNames(serviceId, resource.value, action.value);
    if (names.canonicalName === op.canonicalName) return null;
    // Never trade one weak name for another: re-run the detector's own predicate
    // against the candidate before proposing it.
    if (
      nameWeaknesses({
        canonicalName: names.canonicalName,
        resource: resource.value,
        action: action.value,
        hasResource: true,
      }).length > 0
    ) {
      return null;
    }

    const set: Record<string, JsonValue> = {
      canonical_name: names.canonicalName,
      cli_command: names.cliCommand,
      tool_name: names.toolName,
    };
    // One sourceRef for all three, because all three are one projection of the
    // same two inputs — and because `strengthOf` keys independence on sourceRef,
    // so three claims off one derivation must not read as three sources.
    const sourceRef = `${resource.ref} + ${action.ref}`;
    const claims: Claim[] = Object.entries(set).map(([field, value]) => ({
      subject: op.id,
      predicate: `operation.${field}`,
      value,
      source: "spec",
      sourceRef,
      method: "template",
      confidence: 0.8,
      note: "re-projected from the operation's own resource and action; a human confirms the rename",
    }));
    // Why the name was flagged, carried alongside so a reviewer sees the finding
    // and the fix in one place. A supporting claim, never a patched value.
    const weaknesses = context.deficiency.facts.weaknesses;
    if (Array.isArray(weaknesses) && weaknesses.every((w) => typeof w === "string")) {
      claims.push({
        subject: op.id,
        predicate: "operation.name_weaknesses",
        value: weaknesses,
        source: "spec",
        sourceRef: `${op.id}.canonicalName`,
        method: "template",
        confidence: 0.9,
      });
    }
    return proposal(skill, context, claims, set);
  }

  /**
   * Keep the shared description verbatim and append the axis on which the spec
   * already separates these siblings — the route, and the parameters a caller
   * must supply. Two operations that collided on a description cannot also
   * collide on a route (they would be the same operation), so the appended
   * clause is guaranteed to differ; and because it is read off this operation's
   * own contract rather than asserted about it, the executor needs no sibling in
   * context to tell them apart.
   *
   * Deliberately NOT evidence-first, unlike `describe`: the gap is distinctness,
   * so a gathered claim restating the description both siblings already share
   * would validate cleanly and close nothing.
   */
  private disambiguateOperations(
    skill: RefinementSkill,
    context: SkillContext,
  ): SkillProposal | null {
    const op = context.operation;
    if (!op) return null;
    const existing = op.description.trim();
    // An empty description is `missing_operation_description`'s gap, and appending
    // a route to nothing would leave an operation described only by its plumbing.
    if (existing.length === 0) return null;

    const clause = distinguishingClause(op);
    if (!clause) return null;
    const description = `${terminate(existing)} ${clause}`;

    const claim: Claim = {
      subject: op.id,
      predicate: "operation.description",
      value: description,
      source: "spec",
      sourceRef: `${op.id}.sourceRef`,
      method: "template",
      confidence: 0.8,
      note: "the spec's own wording, kept verbatim, plus the contract axis that distinguishes this sibling",
    };
    return proposal(skill, context, [claim], { description });
  }

  /**
   * A capability description templated from what the capability *is*: the actions
   * its member operations name and the resource nouns it spans. Both come from
   * the grouping the compiler derived, so this restates membership rather than
   * asserting purpose — "create, get, and list refunds", never "handles the
   * refund lifecycle for finance".
   *
   * Member actions are read off the last segment of each member id and admitted
   * only when they are a declared `OperationAction`; an id segment that is not in
   * that vocabulary is a naming accident, not a verb, and guessing at it would be
   * the invention this skill exists to avoid.
   */
  private describeCapability(skill: RefinementSkill, context: SkillContext): SkillProposal | null {
    const cap = context.capability;
    if (!cap) return null;

    const actions: ReadonlySet<string> = new Set<string>(
      OperationAction.options.filter((a) => a !== "other"),
    );
    const verbs: string[] = [];
    for (const id of cap.operationIds) {
      const verb = id.split(".").pop() ?? "";
      if (actions.has(verb) && !verbs.includes(verb)) verbs.push(verb);
    }
    const nouns: string[] = [];
    for (const resource of cap.resources) {
      const noun = pluralize(resource.replace(/_/g, " ").trim());
      if (noun && !nouns.includes(noun)) nouns.push(noun);
    }

    let description: string;
    let derivedFrom: string;
    if (verbs.length > 0 && nouns.length > 0) {
      description = `${capitalize(sentenceList(verbs))} ${sentenceList(nouns)}.`;
      derivedFrom = `${cap.id}.operationIds + ${cap.id}.resources`;
    } else if (verbs.length > 0) {
      description = `Operations to ${sentenceList(verbs)}.`;
      derivedFrom = `${cap.id}.operationIds`;
    } else if (nouns.length > 0) {
      description = `Operations over ${sentenceList(nouns)}.`;
      derivedFrom = `${cap.id}.resources`;
    } else {
      // No members and no resources: the grouping states nothing to restate, and
      // the only sentence left would be the display name in other words.
      return null;
    }

    const claim: Claim = {
      subject: cap.id,
      predicate: "capability.description",
      value: description,
      source: "spec",
      sourceRef: derivedFrom,
      method: "template",
      confidence: 0.8,
      note: "restates the capability's membership; what it is FOR still needs an owner",
    };
    return proposal(skill, context, [claim], { description });
  }

  /**
   * Bound the one contributor a refinement is allowed to touch — the operation's
   * own prose — and report the ones it is not.
   *
   * Attribution here is an *estimate*: the exact per-fragment figures come from
   * the compiler's disclosure BOM, which tokenizes slices of the published wire
   * form with a real BPE table, and `@anvil/refinement` cannot import it (see
   * `singularize` above for the dependency direction). So contributors are ranked
   * with AIR's own `estimateTokens` under the calibration the measurement
   * recorded (`disclosureCost.charsPerToken`) — the same approximation the
   * serving path uses for truncation, honest for ranking "which field is the
   * story", never a certified count. The claim says so, and the recorded
   * `toolTokens` in the finding remains the authoritative number.
   *
   * The description is trimmed to whole leading sentences, never mid-sentence:
   * the result is a verbatim prefix of the spec's text, so nothing is asserted
   * that the spec did not, and the dropped tail is still in the source spec for
   * anyone who needs it. When the prose is not the driver — a 400-value enum
   * usually is — there is no lever inside this boundary and the executor proposes
   * nothing rather than trimming a description that was never the problem.
   */
  private reduceSchemaDisclosure(
    skill: RefinementSkill,
    context: SkillContext,
  ): SkillProposal | null {
    const op = context.operation;
    // No measurement means no finding (the detector requires one); without the
    // recorded calibration there is nothing to rank against either.
    const cost = op?.disclosureCost;
    if (!op || !cost) return null;

    const existing = op.description.trim();
    if (existing.length === 0) return null;

    const budgetChars = charsForTokenBudget(
      DESCRIPTION_DISCLOSURE_BUDGET_TOKENS,
      cost.charsPerToken,
    );
    if (existing.length <= budgetChars) return null;
    const bounded = boundToWholeSentences(existing, budgetChars);
    if (!bounded || bounded.length >= existing.length) return null;

    const contributors = rankDisclosureContributors(op, cost.charsPerToken);
    const claims: Claim[] = [
      {
        subject: op.id,
        predicate: "operation.description",
        value: bounded,
        source: "spec",
        sourceRef: `${op.id}.description`,
        method: "template",
        confidence: 0.75,
        note: `verbatim leading sentences of the operation's own description, bounded to ~${DESCRIPTION_DISCLOSURE_BUDGET_TOKENS} tokens; the full text remains in the source spec`,
      },
    ];
    if (contributors.length > 0) {
      claims.push({
        subject: op.id,
        predicate: "operation.disclosure_contributors",
        value: contributors,
        source: "spec",
        sourceRef: `${op.id}.input`,
        method: "template",
        confidence: 0.6,
        note: "estimated from character length under the recorded charsPerToken calibration — a ranking, not a certified token count; schema-shaped contributors are the owner's call, not a refinement's",
      });
    }
    return proposal(skill, context, claims, { description: bounded });
  }

  /**
   * A conservative starter query policy for an unguarded passthrough operation.
   * The executor names the query param (the unconstrained string that triggered
   * the passthrough) and infers the dialect from its name/description, then
   * proposes the safe skeleton: SELECT-only, single statement, no comments. It
   * deliberately does NOT invent a row cap or table allowlist — those need
   * estate knowledge — leaving them for the reviewer. The proposal always routes
   * to review (see approval.ts); exposing a query surface is a human decision.
   */
  private reviewQueryPassthrough(
    skill: RefinementSkill,
    context: SkillContext,
  ): SkillProposal | null {
    const op = context.operation;
    if (!op) return null;
    const queryParam = passthroughQueryParam(op);
    if (!queryParam) return null;
    const dialect = inferDialect(queryParam, op);
    const policy = {
      queryParam,
      dialect,
      allowedStatements: ["select"],
      singleStatementOnly: true,
      forbidComments: true,
    };
    const claim: Claim = {
      subject: op.id,
      predicate: "operation.query_policy",
      value: policy,
      source: "spec",
      sourceRef: `${op.id}.input.${queryParam}`,
      method: "template",
      confidence: 0.7,
      note: "conservative starter policy — reviewer should add a row cap and table allowlist",
    };
    return proposal(skill, context, [claim], { query_policy: policy });
  }

  /**
   * Capability routing phrases templated from the capability's own name and
   * resource nouns — the discovery-surface sibling of intent examples.
   */
  private authorRoutingPhrases(
    skill: RefinementSkill,
    context: SkillContext,
  ): SkillProposal | null {
    const cap = context.capability;
    if (!cap) return null;
    const name = (cap.displayName ?? cap.id ?? "").replace(/_/g, " ").trim();
    const phrases: string[] = [];
    if (name) phrases.push(`work with ${name.toLowerCase()}`);
    for (const resource of cap.resources ?? []) {
      const noun = resource.replace(/_/g, " ").trim();
      if (noun) phrases.push(`manage ${pluralize(noun)}`);
    }
    const intents = [...new Set(phrases)].slice(0, 4);
    if (intents.length === 0) return null;
    const claim: Claim = {
      subject: cap.id,
      predicate: "capability.intent_examples",
      value: intents,
      source: "spec",
      sourceRef: `${cap.id}.resources`,
      method: "template",
      confidence: 0.85,
    };
    return proposal(skill, context, [claim], { intent_examples: intents });
  }

  /**
   * Intent phrasings templated from the operation's own spec-derived semantics
   * (effect action + resource + display name). This restates what the spec
   * already names — in the form an agent routes by — and never asserts
   * behavior the spec did not: grounded, not invented.
   */
  private authorIntentExamples(
    skill: RefinementSkill,
    context: SkillContext,
  ): SkillProposal | null {
    const op = context.operation;
    if (!op) return null;
    const resource = (op.effect.resource ?? "").replace(/_/g, " ").trim();
    const action = op.effect.action ?? "";
    const display = op.displayName.trim();

    const phrases: string[] = [];
    const plural = pluralize(resource);
    const templates: Record<string, string> = {
      list: `list the ${plural}`,
      get: `get a ${resource} by id`,
      search: `find ${plural} matching a filter`,
      create: `create a new ${resource}`,
      update: `update an existing ${resource}`,
      delete: `delete a ${resource}`,
    };
    if (resource && templates[action]) phrases.push(templates[action] as string);
    else if (resource && action) phrases.push(`${action.replace(/_/g, " ")} ${resource}`);
    if (display) phrases.push(display.toLowerCase());

    const intents = [...new Set(phrases.filter((p) => p.trim().length > 0))];
    if (intents.length === 0) return null;

    const claim: Claim = {
      subject: op.id,
      predicate: "operation.intent_examples",
      value: intents,
      source: "spec",
      sourceRef: `${op.id}.effect`,
      method: "template",
      confidence: 0.85,
    };
    return proposal(skill, context, [claim], { intent_examples: intents });
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

    for (const field of ["upstream_code", "recovery_action", "field_path"] as const) {
      const claims = claimsFor(context, skill, `.${field}`);
      const value = strongestValue(claims);
      if (typeof value === "string" && value.trim().length > 0) {
        set[field] = value;
        used.push(...claimsAsserting(claims, value));
      }
    }

    if (Object.keys(set).length === 0) return null;
    return proposal(skill, context, used, set);
  }

  /**
   * Idempotency classification: unlike every other heuristic here, a claim whose
   * value is not an admissible enum member is never proposed — there is no
   * validation check downstream that rejects a malformed mode/mechanism/
   * derivation the way `examples_validate_against_schema` rejects a bad example,
   * so this executor is the one place a garbage classification is filtered out
   * before it can reach a human reviewer looking legitimate.
   */
  private classifyIdempotency(skill: RefinementSkill, context: SkillContext): SkillProposal | null {
    const set: Record<string, JsonValue> = {};
    const used: Claim[] = [];

    const take = (suffix: string, validValues: readonly string[]): void => {
      const claims = claimsFor(context, skill, suffix).filter((c) =>
        (validValues as readonly unknown[]).includes(c.value),
      );
      const value = strongestValue(claims);
      if (typeof value !== "string") return;
      set[suffix.slice(1)] = value;
      used.push(...claimsAsserting(claims, value));
    };

    take(".idempotency_mode", IdempotencyMode.options);
    take(".idempotency_mechanism", IdempotencyMechanism.options);
    take(".idempotency_key_derivation", KeyDerivation.options);
    take(".retry_basis", RetryBasis.options);

    // The key is a free-form field/header name, not an enum — grounded string only.
    const keyClaims = claimsFor(context, skill, ".idempotency_key");
    const key = strongestValue(keyClaims);
    if (typeof key === "string" && key.trim().length > 0) {
      set.idempotency_key = key;
      used.push(...claimsAsserting(keyClaims, key));
    }

    if (Object.keys(set).length === 0) return null;
    return proposal(skill, context, used, set);
  }

  /**
   * Pagination classification: extract and validate pagination metadata.
   * Like idempotency, the style enum values are filtered; the other fields
   * are free-form strings grounded-string-only (non-empty).
   */
  private classifyPagination(skill: RefinementSkill, context: SkillContext): SkillProposal | null {
    const set: Record<string, JsonValue> = {};
    const used: Claim[] = [];

    const take = (suffix: string, validValues: readonly string[]): void => {
      const claims = claimsFor(context, skill, suffix).filter((c) =>
        (validValues as readonly unknown[]).includes(c.value),
      );
      const value = strongestValue(claims);
      if (typeof value !== "string") return;
      set[suffix.slice(1)] = value;
      used.push(...claimsAsserting(claims, value));
    };

    take(".pagination_style", Pagination.shape.style.options);

    // The other fields are free-form strings — grounded string only.
    const cursorParamClaims = claimsFor(context, skill, ".pagination_cursor_param");
    const cursorParam = strongestValue(cursorParamClaims);
    if (typeof cursorParam === "string" && cursorParam.trim().length > 0) {
      set.pagination_cursor_param = cursorParam;
      used.push(...claimsAsserting(cursorParamClaims, cursorParam));
    }

    const nextFieldClaims = claimsFor(context, skill, ".pagination_next_field");
    const nextField = strongestValue(nextFieldClaims);
    if (typeof nextField === "string" && nextField.trim().length > 0) {
      set.pagination_next_field = nextField;
      used.push(...claimsAsserting(nextFieldClaims, nextField));
    }

    const itemsFieldClaims = claimsFor(context, skill, ".pagination_items_field");
    const itemsField = strongestValue(itemsFieldClaims);
    if (typeof itemsField === "string" && itemsField.trim().length > 0) {
      set.pagination_items_field = itemsField;
      used.push(...claimsAsserting(itemsFieldClaims, itemsField));
    }

    const pageSizeParamClaims = claimsFor(context, skill, ".pagination_page_size_param");
    const pageSizeParam = strongestValue(pageSizeParamClaims);
    if (typeof pageSizeParam === "string" && pageSizeParam.trim().length > 0) {
      set.pagination_page_size_param = pageSizeParam;
      used.push(...claimsAsserting(pageSizeParamClaims, pageSizeParam));
    }

    for (const field of ["pagination_max_page_size", "pagination_default_page_size"] as const) {
      const claims = claimsFor(context, skill, `.${field}`);
      const value = strongestValue(claims);
      if (typeof value === "number" && Number.isInteger(value) && value > 0) {
        set[field] = value;
        used.push(...claimsAsserting(claims, value));
      }
    }

    if (Object.keys(set).length === 0) return null;
    return proposal(skill, context, used, set);
  }
}

/** The unconstrained string param/body-field that makes an operation a passthrough. */
function passthroughQueryParam(op: SkillContext["operation"]): string | undefined {
  if (!op) return undefined;
  const isUnconstrainedString = (schema: Record<string, unknown> | undefined): boolean => {
    if (schema?.type !== "string") return false;
    return (
      schema.enum === undefined && schema.maxLength === undefined && schema.pattern === undefined
    );
  };
  const languageName = /sql|jql|cql|kql|xpath|dsl|where|expression|query|filter/i;
  for (const p of op.input.params) {
    if (languageName.test(p.name) && isUnconstrainedString(p.schema as Record<string, unknown>)) {
      return p.name;
    }
  }
  if (op.input.body?.projection === "fields") {
    for (const f of op.input.body.fields) {
      if (languageName.test(f.name) && isUnconstrainedString(f.schema as Record<string, unknown>)) {
        return f.name;
      }
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Naming — the `rename-operation` derivation                                 */
/* -------------------------------------------------------------------------- */

/** A derived value together with the AIR coordinate it was read off. */
interface Derived {
  value: string;
  ref: string;
}

/**
 * The ONE projection from (service, resource, action) to the three routing
 * surfaces, mirroring the compiler's `projectRoutingNames` exactly (see
 * `singularize` for why it is mirrored rather than imported). Keeping the
 * canonical name singular and the CLI segment as-written is what makes a
 * proposed rename indistinguishable from a compiled one.
 */
function projectRoutingNames(
  serviceId: string,
  resource: string,
  action: string,
): { canonicalName: string; cliCommand: string; toolName: string } {
  const canonicalName = `${action}_${singularize(resource)}`;
  return {
    canonicalName,
    cliCommand: `${serviceId} ${snakeCase(resource)} ${action}`,
    toolName: `${serviceId}_${canonicalName}`,
  };
}

/** The concrete (non-templated) segments of a REST path, cleaned of format suffixes. */
function concretePathSegments(path: string | undefined): string[] {
  if (!path) return [];
  return path
    .split("/")
    .filter((segment) => segment.length > 0 && !segment.startsWith("{"))
    .map((segment) => segment.replace(/\.(json|xml|csv|ya?ml|txt|html?|proto)$/i, ""))
    .filter((segment) => segment.length > 0 && !/^v?\d+(\.\d+)*$/i.test(segment));
}

/**
 * A resource noun concrete enough to name an operation after. `effect.resource`
 * is preferred because the compiler put the derived, singularized path resource
 * there — reusing it means this skill inherits the OData/RPC/format handling of
 * `deriveNames` instead of re-deriving (and disagreeing with) it. The trailing
 * path segment is the fallback for a document whose effect never recorded one.
 * A placeholder noun (`object`, `data`) is refused: it is the very weakness the
 * detector fired on.
 */
function routableResource(op: Operation): Derived | undefined {
  const concrete = (value: string | undefined, ref: string): Derived | undefined => {
    const token = snakeCase((value ?? "").trim());
    if (!token || GENERIC_NOUNS.has(token) || GENERIC_NOUNS.has(singularize(token))) {
      return undefined;
    }
    return { value: token, ref };
  };
  const fromEffect = concrete(op.effect.resource, `${op.id}.effect.resource`);
  if (fromEffect) return fromEffect;
  const segments = concretePathSegments(op.sourceRef.path);
  return concrete(segments[segments.length - 1], `${op.id}.sourceRef.path`);
}

/** The HTTP method's default action — the same table as the compiler's `actionFor`. */
const METHOD_ACTIONS: Record<string, string> = {
  post: "create",
  put: "replace",
  patch: "update",
  delete: "delete",
};

/**
 * A verb an agent can route on. `effect.action` first: the classifier proved it,
 * and it is more truthful than the wire method for the APIs that POST an update.
 * The method is the fallback for `other`, and a GET falls back by whether the
 * route addresses one item (`/refunds/{id}` → get) or a collection (→ list) —
 * the same split `actionFor` makes. A weak verb is never carried forward, since
 * that is what the finding is about.
 */
function routableAction(op: Operation): Derived | undefined {
  const action = op.effect.action;
  if (action !== "other" && !WEAK_VERBS.has(action)) {
    return { value: action, ref: `${op.id}.effect.action` };
  }
  const method = op.sourceRef.method;
  if (!method) return undefined;
  const mapped = METHOD_ACTIONS[method];
  if (mapped) return { value: mapped, ref: `${op.id}.sourceRef.method` };
  if (method === "get" || method === "head") {
    const path = op.sourceRef.path ?? "";
    const segments = path.split("/").filter(Boolean);
    const addressesOne = (segments[segments.length - 1] ?? "").startsWith("{");
    return { value: addressesOne ? "get" : "list", ref: `${op.id}.sourceRef` };
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Disambiguation — the `disambiguate-operations` derivation                  */
/* -------------------------------------------------------------------------- */

/** How many required parameter names to name before the clause stops helping. */
const MAX_NAMED_REQUIRED_PARAMS = 6;

/** The required inputs a caller must supply, params before body fields, as declared. */
function requiredInputNames(op: Operation): string[] {
  const names = op.input.params.filter((p) => p.required).map((p) => p.name);
  if (op.input.body?.projection === "fields") {
    names.push(...op.input.body.fields.filter((f) => f.required).map((f) => f.name));
  }
  return names.slice(0, MAX_NAMED_REQUIRED_PARAMS);
}

/**
 * The clause that tells two identically-described siblings apart, built only from
 * facts the spec states about THIS operation: its route, and what a caller must
 * supply to call it. Siblings cannot share a route, so this always separates
 * them; the required parameters are what usually make the difference legible
 * ("by its refund id" vs "by payment id"). For a source with no HTTP route
 * (WSDL, gRPC, GraphQL) the effect axis stands in.
 */
function distinguishingClause(op: Operation): string | undefined {
  const required = requiredInputNames(op);
  const requires = required.length > 0 ? ` (requires ${sentenceList(required)})` : "";
  const method = op.sourceRef.method;
  const path = op.sourceRef.path;
  if (method && path) return `Specifically: ${method.toUpperCase()} ${path}${requires}.`;
  const action = op.effect.action;
  const resource = (op.effect.resource ?? "").replace(/_/g, " ").trim();
  if (action !== "other" && resource) {
    return `Specifically: the ${action} operation on ${resource}${requires}.`;
  }
  // Nothing in the contract separates this operation from its siblings — saying
  // so is the honest outcome, and inventing a difference is the failure mode.
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Disclosure — the `reduce-schema-disclosure` derivation                     */
/* -------------------------------------------------------------------------- */

/**
 * The share of the per-operation tool budget prose may occupy: a quarter of it.
 * Derived from the budget rather than written as a bare number so the two can
 * never drift apart. The reasoning is proportional, not magic — the description
 * is one of several contributors to a surface an agent must read *before* it can
 * route, and a quarter leaves room for the input schema that actually enables the
 * call. Anything past it is prose the agent pays for on every listing.
 */
const DESCRIPTION_DISCLOSURE_BUDGET_TOKENS = Math.round(
  DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS * 0.25,
);

/**
 * The longest run of *whole* leading sentences that fits `maxChars`. Never cuts
 * mid-sentence: a truncated sentence is a new, subtly different assertion, and
 * this skill's entire safety argument is that its output is a verbatim prefix of
 * the spec's own text. Returns undefined when even the first sentence overruns —
 * there is then no bounded form that is still the spec's wording.
 */
function boundToWholeSentences(text: string, maxChars: number): string | undefined {
  const sentences = text.split(/(?<=[.!?])\s+/);
  let out = "";
  for (const sentence of sentences) {
    const next = out.length === 0 ? sentence : `${out} ${sentence}`;
    if (next.length > maxChars) break;
    out = next;
  }
  return out.length > 0 ? out : undefined;
}

/** One line item of the disclosure bill: what it is, roughly what it costs, and why. */
interface DisclosureContributorEstimate {
  kind: "description" | "input_property";
  label: string;
  estimatedTokens: number;
  note?: string;
}

/** How many line items a reviewer can act on before the list becomes a dump. */
const MAX_REPORTED_CONTRIBUTORS = 5;

/** Only prose long enough to be the reason a field is expensive is worth naming. */
const NOTEWORTHY_DESCRIPTION_TOKENS = 100;

/**
 * Rank the contributors to this operation's tool surface, largest first.
 *
 * Mirrors the *shape* of the compiler's disclosure BOM — attribute per published
 * property, note why a property is big — with an estimated cost rather than a
 * tokenized one (see `reduceSchemaDisclosure` for why). Ties break on label so
 * the ranking is stable for identical inputs.
 */
function rankDisclosureContributors(
  op: Operation,
  charsPerToken: number,
): DisclosureContributorEstimate[] {
  const out: DisclosureContributorEstimate[] = [];
  const tokensOf = (value: unknown): number =>
    estimateTokens(JSON.stringify(value ?? "").length, charsPerToken);

  if (op.description.trim().length > 0) {
    out.push({
      kind: "description",
      label: "description",
      estimatedTokens: tokensOf(op.description),
    });
  }

  const properties: Array<{ name: string; schema: unknown; description?: string }> =
    op.input.params.map((p) => ({ name: p.name, schema: p.schema, description: p.description }));
  if (op.input.body?.projection === "fields") {
    for (const f of op.input.body.fields) {
      properties.push({ name: f.name, schema: f.schema, description: f.description });
    }
  }
  for (const property of properties) {
    const note = contributorNote(property.schema, property.description, charsPerToken);
    out.push({
      kind: "input_property",
      label: property.name,
      // The published fragment is the property's schema and its documentation —
      // the name is the label a reader searches for, not part of what it costs.
      estimatedTokens: tokensOf({ schema: property.schema, description: property.description }),
      ...(note ? { note } : {}),
    });
  }

  out.sort((a, b) => b.estimatedTokens - a.estimatedTokens || a.label.localeCompare(b.label));
  return out.slice(0, MAX_REPORTED_CONTRIBUTORS);
}

/**
 * Say why a property is big when the shape says so plainly, in the register of
 * the compiler BOM's `propertyNote`: a pointer for the human reading the ticket,
 * never a schema analysis. An over-clever note that is subtly wrong costs more
 * trust than no note at all.
 */
function contributorNote(
  schema: unknown,
  description: string | undefined,
  charsPerToken: number,
): string | undefined {
  const parts: string[] = [];
  if (schema && typeof schema === "object") {
    const record = schema as Record<string, unknown>;
    if (Array.isArray(record.enum)) parts.push(`enum with ${record.enum.length} values`);
    if (record.properties && typeof record.properties === "object") {
      parts.push(`object with ${Object.keys(record.properties as object).length} properties`);
    }
    if (Array.isArray(record.items) || (record.items && typeof record.items === "object")) {
      parts.push("array");
    }
  }
  if (description) {
    const tokens = estimateTokens(description.length, charsPerToken);
    if (tokens >= NOTEWORTHY_DESCRIPTION_TOKENS) parts.push(`${tokens}-token description`);
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/** Infer the SQL dialect from the query param's name and the op's description. */
function inferDialect(param: string, op: NonNullable<SkillContext["operation"]>): SqlDialect {
  const hay = `${param} ${op.description ?? ""} ${op.displayName ?? ""}`.toLowerCase();
  if (/postgres|postgresql|\bpg\b|redshift/.test(hay)) return "postgres";
  if (/mysql|mariadb/.test(hay)) return "mysql";
  return "ansi";
}
