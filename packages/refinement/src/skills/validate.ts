import type {
  Claim,
  EvidenceKind,
  IdempotencyMechanism,
  IdempotencyMode,
  JsonSchema,
  KeyDerivation,
} from "@anvil/air";
import {
  AgentProjection,
  agentProjectionIssues,
  agentPropKey,
  laneEntryToolName,
  resolveIdempotencyCarrier,
  snakeCase,
} from "@anvil/air";
import { curatedCatalog, lexicalRoute, type RoutableTool } from "../benchmark/routing.js";
import { concretePathSegments, normalizedWords, wordGrounds } from "../vocabulary.js";
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
import {
  buildGroupWorkflow,
  disambiguationIssues,
  groupGrantOf,
  groupNameIssues,
  groupPatchReferences,
  parseGroupPatch,
  resolveOperationReference,
  supersedesOutsideSteps,
  workflowBindingIssues,
  workflowComposeIssues,
} from "./group-proposal.js";

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

function schemaAtDottedPath(schema: JsonSchema | undefined, path: string): JsonSchema | undefined {
  let current = schema;
  for (const segment of path.split(".")) {
    if (current?.type === "array") {
      const items = current.items;
      if (!items || typeof items !== "object" || Array.isArray(items)) return undefined;
      current = items as JsonSchema;
    }
    const properties = current?.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties))
      return undefined;
    const next = (properties as Record<string, unknown>)[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) return undefined;
    current = next as JsonSchema;
  }
  return current;
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

  agent_field_name_valid(_skill, proposal, context) {
    const name = proposal.patch.set.agent_name;
    if (typeof name !== "string" || name.trim().length === 0) {
      return fail("agent_field_name_valid", "agent_name must be a non-empty string");
    }
    const candidate = agentPropKey({ name: context.field?.name ?? "", agentName: name });
    if (!candidate || candidate === "_") {
      return fail("agent_field_name_valid", "agent_name must contain letters or numbers");
    }
    const collision = context.siblingFields?.find(
      (field) => agentPropKey({ name: field.name, agentName: field.agentName }) === candidate,
    );
    if (collision) {
      return fail(
        "agent_field_name_valid",
        `agent_name '${name}' collides with '${collision.agentName ?? collision.name}'`,
      );
    }
    const aliases = proposal.patch.set.aliases;
    if (aliases !== undefined) {
      if (
        !Array.isArray(aliases) ||
        aliases.length === 0 ||
        aliases.some((alias) => typeof alias !== "string" || alias.trim().length === 0)
      ) {
        return fail("agent_field_name_valid", "aliases must be a non-empty list of names");
      }
      const normalized = aliases.map((alias) => agentPropKey({ name: String(alias) }));
      if (new Set(normalized).size !== normalized.length || normalized.includes(candidate)) {
        return fail(
          "agent_field_name_valid",
          "aliases must be distinct from each other and the agent_name",
        );
      }
    }
    return ok("agent_field_name_valid", `agent input '${candidate}' is unique on the operation`);
  },

  response_projection_valid(_skill, proposal, context) {
    if (!("response_projection" in proposal.patch.set)) {
      return ok("response_projection_valid", "patch does not define a response projection");
    }
    const projection = proposal.patch.set.response_projection;
    const parsed = AgentProjection.safeParse(projection);
    if (!parsed.success) {
      return fail(
        "response_projection_valid",
        parsed.error.issues.map((issue) => issue.message).join("; "),
      );
    }
    const issues = agentProjectionIssues(parsed.data, context.operation?.output.schema);
    if (issues.length > 0) return fail("response_projection_valid", issues.join("; "));
    return ok("response_projection_valid", "every projection path resolves without synthesis");
  },

  idempotency_carrier_resolves(_skill, proposal, context) {
    const set = proposal.patch.set;
    // retry_basis alone (no idempotency.* keys) touches no carrier — inert.
    if (
      !("idempotency_mode" in set) &&
      !("idempotency_mechanism" in set) &&
      !("idempotency_key" in set) &&
      !("idempotency_key_derivation" in set)
    ) {
      return ok("idempotency_carrier_resolves", "patch does not touch the idempotency carrier");
    }
    const op = context.operation;
    if (!op) {
      return fail("idempotency_carrier_resolves", "no operation in context to resolve against");
    }
    // Merge the proposed values onto the operation's current idempotency block —
    // never invent a candidate from the patch alone, so a proposal that only sets
    // `idempotency_mechanism` is still checked against the operation's real mode.
    const candidate = {
      ...op,
      idempotency: {
        ...op.idempotency,
        ...(typeof set.idempotency_mode === "string"
          ? { mode: set.idempotency_mode as IdempotencyMode }
          : {}),
        ...(typeof set.idempotency_mechanism === "string"
          ? { mechanism: set.idempotency_mechanism as IdempotencyMechanism }
          : {}),
        ...(typeof set.idempotency_key === "string" ? { key: set.idempotency_key } : {}),
        ...(typeof set.idempotency_key_derivation === "string"
          ? { keyDerivation: set.idempotency_key_derivation as KeyDerivation }
          : {}),
      },
    };
    const resolution = resolveIdempotencyCarrier(candidate);
    return resolution.ok
      ? ok("idempotency_carrier_resolves", "the proposed idempotency carrier resolves cleanly")
      : fail("idempotency_carrier_resolves", resolution.issue);
  },

  pagination_binding_resolves(_skill, proposal, context) {
    const set = proposal.patch.set;
    // No pagination keys touched — inert.
    if (
      !("pagination_style" in set) &&
      !("pagination_cursor_param" in set) &&
      !("pagination_next_field" in set) &&
      !("pagination_items_field" in set) &&
      !("pagination_page_size_param" in set) &&
      !("pagination_max_page_size" in set) &&
      !("pagination_default_page_size" in set)
    ) {
      return ok("pagination_binding_resolves", "patch does not touch pagination");
    }

    const op = context.operation;
    if (!op) {
      return fail("pagination_binding_resolves", "no operation in context to resolve against");
    }

    // A field-only patch needs a style to anchor to: either the proposal sets
    // `pagination_style` or the operation already has one. Applying a bare field
    // would otherwise require fabricating a style no evidence claimed.
    if (!("pagination_style" in set) && !op.pagination) {
      return fail(
        "pagination_binding_resolves",
        "pagination fields need a pagination_style — the operation has none and the patch proposes none",
      );
    }

    // When pagination_style is one of {cursor, page, offset}, pagination_cursor_param
    // must name an existing op.input.params entry.
    const style = typeof set.pagination_style === "string" ? set.pagination_style : undefined;
    if (style && ["cursor", "page", "offset"].includes(style)) {
      const cursorParam =
        typeof set.pagination_cursor_param === "string"
          ? set.pagination_cursor_param
          : op.pagination?.cursorParam;

      if (!cursorParam) {
        return fail(
          "pagination_binding_resolves",
          `pagination_style '${style}' requires pagination_cursor_param, but none was provided`,
        );
      }

      // Check that the cursor param exists in op.input.params
      const paramExists = op.input.params.some((p) => p.name === cursorParam);
      if (!paramExists) {
        return fail(
          "pagination_binding_resolves",
          `pagination_cursor_param '${cursorParam}' does not name an existing input parameter`,
        );
      }
    }

    const pageSizeParam =
      typeof set.pagination_page_size_param === "string"
        ? set.pagination_page_size_param
        : op.pagination?.pageSizeParam;
    if ("pagination_page_size_param" in set) {
      if (!pageSizeParam || !op.input.params.some((p) => p.name === pageSizeParam)) {
        return fail(
          "pagination_binding_resolves",
          `pagination_page_size_param '${String(pageSizeParam)}' does not name an existing input parameter`,
        );
      }
    }

    // Response bindings are dotted schema paths, not unchecked labels.
    if ("pagination_items_field" in set) {
      const itemsField = set.pagination_items_field;
      if (typeof itemsField !== "string" || itemsField.trim().length === 0) {
        return fail(
          "pagination_binding_resolves",
          "pagination_items_field must be a non-empty string",
        );
      }
      if (schemaAtDottedPath(op.output.schema, itemsField)?.type !== "array") {
        return fail(
          "pagination_binding_resolves",
          `pagination_items_field '${itemsField}' does not resolve to an array in the response schema`,
        );
      }
    }
    if ("pagination_next_field" in set) {
      const nextField = set.pagination_next_field;
      if (
        typeof nextField !== "string" ||
        nextField.trim().length === 0 ||
        !schemaAtDottedPath(op.output.schema, nextField)
      ) {
        return fail(
          "pagination_binding_resolves",
          `pagination_next_field '${String(nextField)}' does not resolve in the response schema`,
        );
      }
    }

    const positiveInteger = (value: JsonValue | undefined): value is number =>
      typeof value === "number" && Number.isInteger(value) && value > 0;
    for (const key of ["pagination_max_page_size", "pagination_default_page_size"] as const) {
      if (key in set && !positiveInteger(set[key])) {
        return fail("pagination_binding_resolves", `${key} must be a positive integer`);
      }
    }
    const max =
      typeof set.pagination_max_page_size === "number"
        ? set.pagination_max_page_size
        : op.pagination?.maxPageSize;
    const dflt =
      typeof set.pagination_default_page_size === "number"
        ? set.pagination_default_page_size
        : op.pagination?.defaultPageSize;
    if (max !== undefined && dflt !== undefined && dflt > max) {
      return fail(
        "pagination_binding_resolves",
        `pagination default ${dflt} exceeds maximum ${max}`,
      );
    }

    return ok("pagination_binding_resolves", "the proposed pagination binding resolves cleanly");
  },

  /**
   * The boundary that makes an unreliable harness safe on `rehome-resource`:
   * every token of a proposed routing resource must be a word the operation's
   * OWN contract states — its concrete path segments, its canonical name, or
   * its display name (plural-insensitive, tolerant of the compiler
   * singularizer's known over-strip so `release` grounds against `releases`).
   * An invented word — however plausible — is refused deterministically here,
   * never left for a reviewer to catch.
   */
  resource_grounded_in_contract(_skill, proposal, context) {
    const set = proposal.patch.set;
    if (!("resource" in set)) {
      return ok("resource_grounded_in_contract", "patch does not touch the routing resource");
    }
    const value = set.resource;
    if (typeof value !== "string" || snakeCase(value).length === 0) {
      return fail("resource_grounded_in_contract", "resource must be a non-empty string");
    }
    const op = context.operation;
    if (!op) {
      return fail("resource_grounded_in_contract", "no operation in context to ground against");
    }
    const contractWords = new Set<string>();
    for (const segment of concretePathSegments(op.sourceRef.path)) {
      for (const word of normalizedWords(segment)) contractWords.add(word);
    }
    for (const word of normalizedWords(`${op.canonicalName} ${op.displayName}`)) {
      contractWords.add(word);
    }
    const proposedWords = normalizedWords(snakeCase(value));
    if (proposedWords.length === 0) {
      return fail("resource_grounded_in_contract", "resource contains no content words");
    }
    const ungrounded = proposedWords.filter(
      (word) => ![...contractWords].some((contractWord) => wordGrounds(word, contractWord)),
    );
    if (ungrounded.length > 0) {
      return fail(
        "resource_grounded_in_contract",
        `proposed resource word(s) not stated by the operation's own path or name text: ${ungrounded.join(", ")}`,
      );
    }
    return ok(
      "resource_grounded_in_contract",
      "every proposed resource word is grounded in the operation's own path or name vocabulary",
    );
  },

  /**
   * The gap `findings-log.md`'s helpdesk-views live loop names directly: the
   * templated intent "list the views" landed on THREE different operations
   * (execute/count/list variants of `/views`), organically, on a real
   * six-operation compile. `author-intent-examples` already requires an
   * operation's OWN name text to corroborate a phrasing
   * (`executor.ts`'s corroboration filter, mutant
   * `intents/skill-and-tool-name-must-agree`) — which catches a phrase that
   * describes nothing this operation is called. It cannot, by construction,
   * see a SIBLING: a phrase can restate this operation's own vocabulary and
   * still be the exact phrase an agent would use for `execute_view` or
   * `list_active_views`. This check is the other half: it does not ask
   * "does this phrase describe the operation", it asks "does this phrase, put
   * in front of the actual router the benchmark measures with, come back to
   * this operation" — which corroboration-from-self cannot answer because it
   * never looks past the one operation it is templating for.
   *
   * Reuses the benchmark's own deterministic floor router (`lexicalRoute`,
   * the synchronous core `lexicalRouter()` wraps — see routing.ts) rather
   * than a bespoke heuristic, for the same reason `scoreGroupProposal` scores
   * a group proposal with it: a proposal must be judged by the exact
   * instrument that measured the problem, or a validator and the benchmark
   * could quietly disagree about what "routes correctly" means. `lexicalRoute`
   * is used directly, not `lexicalRouter().route()`, because this check is a
   * synchronous, deterministic `Check` like every other one in this file —
   * going through the `Promise`-returning `TaskRouter` interface (needed only
   * so a real model can be swapped in as a router, over a real process
   * boundary) would force `validateProposal` and its five call sites async
   * for a router that does no actual asynchronous work.
   *
   * Ties are not a special case. `lexicalRoute`'s tie-break (lexicographic on
   * tool/card name) is how the deterministic floor router resolves ambiguity
   * everywhere else it is used (`routeAndScore`, `scoreGroupProposal`); a tie
   * that resolves away from the target is scored as a collision here too —
   * anything more lenient would let this check pass a phrase the benchmark
   * itself would count as a miss.
   *
   * Refuses ONLY a real collision (a phrase that routes to a *different*
   * served name). A phrase that routes to nothing is weak, not a trap:
   * nobody is misdirected by it, and it is surfaced in the passing reason
   * for a reviewer rather than failing the check — a separate, softer
   * "author better intents" signal, not this check's job. `findings-log.md`
   * already has that softer signal (the corroboration filter, and
   * `benchmark/clusters.ts`'s post-hoc confusion clustering); duplicating it
   * here as a hard failure would refuse a phrase for being unremarkable, not
   * for being a trap.
   */
  intent_routes_to_own_tool(_skill, proposal, context) {
    const set = proposal.patch.set;
    if (!("intent_examples" in set)) {
      return ok("intent_routes_to_own_tool", "patch does not propose intent examples to route");
    }
    const proposed = set.intent_examples;
    const phrases = Array.isArray(proposed)
      ? proposed.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : [];
    if (phrases.length === 0) {
      return ok("intent_routes_to_own_tool", "no non-empty phrase proposed to route");
    }

    let ownName: string | undefined;
    let catalog: RoutableTool[] | undefined;
    if (context.operation) {
      ownName = context.operation.mcp.toolName;
      catalog =
        context.routingCatalogOperations && curatedCatalog(context.routingCatalogOperations);
    } else if (context.capability) {
      const capabilityId = context.capability.id;
      ownName = laneEntryToolName(capabilityId);
      catalog = context.routingCatalogCapabilities?.map((cap) => ({
        name: laneEntryToolName(cap.id),
        // A lightweight stand-in for the real entry card
        // (`laneEntryDescription` in @anvil/air's ladder.ts also folds in
        // member vocabulary drawn from the capability's own operations),
        // built from exactly the fields this proposal can change plus the
        // capability's stable identity — enough to judge whether a proposed
        // routing phrase reads like ANOTHER capability's own text, without
        // depending on ladder-mode membership math a documentation-tier
        // proposal has no business needing.
        description: [cap.displayName, cap.description, ...cap.intentExamples]
          .filter((part) => part.length > 0)
          .join(" "),
        // Reused purely as this catalog's local correlation key — no
        // operation exists at capability granularity.
        operationId: cap.id,
      }));
    }

    if (ownName === undefined || catalog === undefined) {
      return fail(
        "intent_routes_to_own_tool",
        "no routing catalog in context to check the proposed phrases against",
      );
    }

    const collisions: string[] = [];
    let unrouted = 0;
    for (const phrase of phrases) {
      const routed = lexicalRoute(phrase, catalog);
      if (routed === undefined) unrouted += 1;
      else if (routed !== ownName) {
        collisions.push(`"${phrase}" routes to '${routed}' instead of '${ownName}'`);
      }
    }

    if (collisions.length > 0) {
      return fail("intent_routes_to_own_tool", `not an example, a trap: ${collisions.join("; ")}`);
    }
    return ok(
      "intent_routes_to_own_tool",
      unrouted === 0
        ? "every proposed phrase routes back to this target's own tool"
        : `no proposed phrase collides with another served tool (${unrouted} route to none)`,
    );
  },

  /* ---------------------- group (confusable-cluster) checks ---------------------- */
  // The deterministic boundary that makes an unreliable harness safe on a whole
  // CLUSTER: the proposal union is closed (exactly one of
  // workflow/capability/disambiguate, strict zod shapes), every referenced
  // operation stays inside the task's hash-bound grant, `supersedes` never
  // leaves the payload's own steps, the composed workflow must register on the
  // SHARED surface planner with bindings that actually thread, a disambiguation
  // must leave each member saying something its siblings do not, and every
  // proposed name/intent is the member operations' own vocabulary. All of it
  // delegates to group-proposal.ts so the apply path and the CLI's
  // benchmark-scored admission read the same code.

  group_proposal_shape(_skill, proposal) {
    const parsed = parseGroupPatch(proposal.patch.set);
    return parsed.issues.length === 0
      ? ok("group_proposal_shape", "the patch is exactly one well-formed group proposal")
      : fail("group_proposal_shape", parsed.issues.join("; "));
  },

  group_grant_respected(_skill, proposal, context) {
    const parsed = parseGroupPatch(proposal.patch.set);
    if (parsed.issues.length > 0)
      return ok("group_grant_respected", "no parsable payload to check");
    const grant = groupGrantOf(context.deficiency.facts);
    const grantedIds = new Set([...grant.memberOperationIds, ...grant.relatedOperationIds]);
    const grantOps = (context.groupOperations ?? []).filter((op) => grantedIds.has(op.id));
    const outside = groupPatchReferences(parsed).filter((reference) => {
      const op = resolveOperationReference(grantOps, reference);
      return op === undefined;
    });
    return outside.length === 0
      ? ok("group_grant_respected", "every referenced operation is inside the task's grant")
      : fail(
          "group_grant_respected",
          `operation reference(s) outside the task's grant: ${[...new Set(outside)].join(", ")}`,
        );
  },

  group_disambiguation_distinguishes(_skill, proposal, context) {
    const parsed = parseGroupPatch(proposal.patch.set);
    if (!parsed.disambiguate) {
      return ok("group_disambiguation_distinguishes", "patch proposes no disambiguation");
    }
    const issues = disambiguationIssues(parsed.disambiguate, context.groupOperations ?? []);
    return issues.length === 0
      ? ok(
          "group_disambiguation_distinguishes",
          "every member now carries a content word no sibling in this proposal carries",
        )
      : fail("group_disambiguation_distinguishes", issues.join("; "));
  },

  group_supersedes_within_steps(_skill, proposal, context) {
    const parsed = parseGroupPatch(proposal.patch.set);
    if (!parsed.workflow) {
      return ok("group_supersedes_within_steps", "patch proposes no workflow");
    }
    const outside = supersedesOutsideSteps(parsed.workflow, context.groupOperations ?? []);
    return outside.length === 0
      ? ok("group_supersedes_within_steps", "supersedes names only the proposal's own steps")
      : fail(
          "group_supersedes_within_steps",
          `supersedes may only name the proposal's own steps; outside: ${outside.join(", ")}`,
        );
  },

  group_workflow_composes(_skill, proposal, context) {
    const parsed = parseGroupPatch(proposal.patch.set);
    if (!parsed.workflow) return ok("group_workflow_composes", "patch proposes no workflow");
    const grantOps = context.groupOperations ?? [];
    const build = buildGroupWorkflow(parsed.workflow, grantOps, "group");
    if (!build.workflow) return fail("group_workflow_composes", build.issues.join("; "));
    const issues = [
      ...workflowComposeIssues(build.workflow, grantOps),
      ...workflowBindingIssues(parsed.workflow, grantOps),
    ];
    return issues.length === 0
      ? ok(
          "group_workflow_composes",
          "the shared surface planner registers the composite and its bindings thread",
        )
      : fail("group_workflow_composes", issues.join("; "));
  },

  group_names_grounded(_skill, proposal, context) {
    const parsed = parseGroupPatch(proposal.patch.set);
    if (parsed.issues.length > 0) return ok("group_names_grounded", "no parsable payload to check");
    const issues = groupNameIssues(parsed, context.groupOperations ?? []);
    return issues.length === 0
      ? ok(
          "group_names_grounded",
          "every proposed name and intent is grounded in the members' own vocabulary",
        )
      : fail("group_names_grounded", issues.join("; "));
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
