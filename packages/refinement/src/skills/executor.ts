import {
  type Claim,
  effectiveWeight,
  IdempotencyMechanism,
  IdempotencyMode,
  KeyDerivation,
  Pagination,
  RetryBasis,
} from "@anvil/air";
import type { SqlDialect } from "@anvil/grammar";
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

/** English plural good enough for spec nouns: category→categories, box→boxes, doc→docs. */
function pluralize(noun: string): string {
  if (noun.length === 0) return noun;
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(noun)) return `${noun}es`;
  return `${noun}s`;
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
      case "investigate-ui-projection":
        return this.describe(skill, context);
      case "generate-examples":
        return this.examples(skill, context);
      case "enrich-errors":
        return this.enrichError(skill, context);
      case "classify-idempotency":
        return this.classifyIdempotency(skill, context);
      case "document-pagination":
        return this.classifyPagination(skill, context);
      case "author-intent-examples":
        return this.authorIntentExamples(skill, context);
      case "author-routing-phrases":
        return this.authorRoutingPhrases(skill, context);
      case "review-query-passthrough":
        return this.reviewQueryPassthrough(skill, context);
      default:
        return null;
    }
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

    if (Object.keys(set).length === 0) return null;
    return proposal(skill, context, used, set);
  }
}

/** The unconstrained string param/body-field that makes an operation a passthrough. */
function passthroughQueryParam(op: SkillContext["operation"]): string | undefined {
  if (!op) return undefined;
  const isUnconstrainedString = (schema: Record<string, unknown> | undefined): boolean => {
    if (!schema || schema.type !== "string") return false;
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

/** Infer the SQL dialect from the query param's name and the op's description. */
function inferDialect(param: string, op: NonNullable<SkillContext["operation"]>): SqlDialect {
  const hay = `${param} ${op.description ?? ""} ${op.displayName ?? ""}`.toLowerCase();
  if (/postgres|postgresql|\bpg\b|redshift/.test(hay)) return "postgres";
  if (/mysql|mariadb/.test(hay)) return "mysql";
  return "ansi";
}
