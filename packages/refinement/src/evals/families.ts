import type { AirDocument, Operation, Param } from "@anvil/air";
import type { DeficiencyCode } from "../deficiency.js";
import type { EvalFamily, EvalScore } from "../model.js";

/**
 * The deterministic EVAL layer. A refinement patch only touches a few semantics,
 * so we only re-score the behaviour families it could plausibly move — never an
 * LLM judge, never randomness. Every scorer here answers a narrow, mechanical
 * question about the current AIR document and returns a 0..1 fraction over a
 * concrete denominator, so a delta is always "N of M got better", never a vibe.
 */

/** Words too common to carry routing signal; stripped before overlap scoring. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "of",
  "for",
  "to",
  "this",
  "is",
  "with",
  "and",
  "or",
  "by",
  "on",
  "in",
]);

/** Lowercase, split on non-alphanumerics, drop empties and stopwords. Deterministic. */
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Whether a field has a concrete value source an agent (or a mock) could bind to —
 * not just documentation *about* the field, but something to actually fill it with.
 */
function fieldHasValue(schema: Record<string, unknown>, param?: Param): boolean {
  if (param?.example !== undefined) return true;
  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) return true;
  if (schema.example !== undefined) return true;
  const examples = schema.examples;
  if (Array.isArray(examples) && examples.length > 0) return true;
  if (schema.default !== undefined) return true;
  return false;
}

/** A field as an agent would actually see it, normalized across params and body fields. */
interface SurfacedField {
  name: string;
  required: boolean;
  schema: Record<string, unknown>;
  description?: string;
  /** Present only for params, so a caller can read `param.example`. */
  param?: Param;
}

/**
 * The fields an operation actually surfaces to an agent: non-body params, plus
 * projected body fields when the body is flattened. A `whole`-projection body is
 * a single opaque blob here, not descended into — that mirrors what the CLI/MCP
 * surface itself exposes.
 */
function surfacedFields(op: Operation): SurfacedField[] {
  const fields: SurfacedField[] = [];
  for (const p of op.input.params) {
    fields.push({
      name: p.name,
      required: p.required,
      schema: p.schema,
      description: p.description,
      param: p,
    });
  }
  if (op.input.body?.projection === "fields") {
    for (const f of op.input.body.fields) {
      fields.push({
        name: f.name,
        required: f.required,
        schema: f.schema,
        description: f.description,
      });
    }
  }
  return fields;
}

/** `total === 0` means nothing to measure — treated as perfect/neutral, not a failure. */
function ratio(family: EvalFamily, good: number, total: number): EvalScore {
  return total === 0 ? { family, score: 1, total: 0 } : { family, score: good / total, total };
}

/**
 * Leave-one-out router: for every (operation, intent phrase) pair, could a picker
 * that only sees operation name/description/other-examples (never the phrase
 * itself, for its own operation) still land on the right operation by token
 * overlap? This is the cheapest honest proxy for "would an agent route here" —
 * name/description quality is exactly what moves it.
 */
function scoreOperationRouting(air: AirDocument): EvalScore {
  const ops = air.operations;
  let total = 0;
  let correct = 0;

  for (const owner of ops) {
    for (const phrase of owner.skill.intentExamples) {
      total += 1;
      const phraseTokens = tokens(phrase);

      let best: Operation | undefined;
      let bestOverlap = -1;
      for (const candidate of ops) {
        // Leave-one-out: the owning candidate never gets to see the exact phrase
        // it is being tested against — only its name/description/other examples.
        const examples =
          candidate.id === owner.id
            ? candidate.skill.intentExamples.filter((p) => p !== phrase)
            : candidate.skill.intentExamples;
        const bagText = [
          candidate.canonicalName,
          candidate.displayName,
          candidate.description,
          examples.join(" "),
        ].join(" ");
        const bag = new Set(tokens(bagText));

        let overlap = 0;
        for (const t of phraseTokens) {
          if (bag.has(t)) overlap += 1;
        }

        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = candidate;
        } else if (overlap === bestOverlap && best && candidate.id.localeCompare(best.id) < 0) {
          best = candidate;
        }
      }

      if (best && best.id === owner.id) correct += 1;
    }
  }

  return ratio("operation_routing", correct, total);
}

/** Every required surfaced field across all operations: does it have a value to bind? */
function scoreArgumentMapping(air: AirDocument): EvalScore {
  let total = 0;
  let withValue = 0;
  for (const op of air.operations) {
    for (const field of surfacedFields(op)) {
      if (!field.required) continue;
      total += 1;
      if (fieldHasValue(field.schema, field.param)) withValue += 1;
    }
  }
  return ratio("argument_mapping", withValue, total);
}

/** Every surfaced field: does it have both a human description AND a bindable value? */
function scoreFieldInterpretation(air: AirDocument): EvalScore {
  let total = 0;
  let good = 0;
  for (const op of air.operations) {
    for (const field of surfacedFields(op)) {
      total += 1;
      const described =
        typeof field.description === "string" && field.description.trim().length > 0;
      if (described && fieldHasValue(field.schema, field.param)) good += 1;
    }
  }
  return ratio("field_interpretation", good, total);
}

/** Every declared error: does it explain itself AND state whether retrying helps? */
function scoreErrorRecovery(air: AirDocument): EvalScore {
  let total = 0;
  let good = 0;
  for (const op of air.operations) {
    for (const err of op.errors) {
      total += 1;
      const hasMessage = typeof err.message === "string" && err.message.trim().length > 0;
      if (hasMessage && err.retryable !== undefined) good += 1;
    }
  }
  return ratio("error_recovery", good, total);
}

/** Idempotency modes that count as a guard against an unsafe repeat/auto-retry. */
const GUARDED_IDEMPOTENCY_MODES: ReadonlySet<string> = new Set([
  "natural",
  "client_id",
  "required",
  "key_supported",
]);

/** Risk levels high enough that an unconfirmed, unguarded mutation is unacceptable. */
const UNSAFE_RISKS: ReadonlySet<string> = new Set(["high", "financial", "destructive"]);

/**
 * THE SAFETY GUARD. Every unsafe mutation (high/financial/destructive risk, or no
 * proven idempotency) must be either confirmation-gated or idempotency-guarded.
 * This is the one family that must never regress — a refinement that raises other
 * scores by loosening this is not an improvement, it is a liability.
 */
function scoreUnsafeOperationRefusal(air: AirDocument): EvalScore {
  let total = 0;
  let guarded = 0;
  for (const op of air.operations) {
    const unsafe =
      op.effect.kind === "mutation" &&
      (UNSAFE_RISKS.has(op.effect.risk) || op.idempotency.mode === "none");
    if (!unsafe) continue;
    total += 1;
    const isGuarded =
      op.confirmation.required === true || GUARDED_IDEMPOTENCY_MODES.has(op.idempotency.mode);
    if (isGuarded) guarded += 1;
  }
  return ratio("unsafe_operation_refusal", guarded, total);
}

/** Score one behaviour family over a whole AIR document. Pure, deterministic. */
export function scoreFamily(air: AirDocument, family: EvalFamily): EvalScore {
  switch (family) {
    case "operation_routing":
      return scoreOperationRouting(air);
    case "argument_mapping":
      return scoreArgumentMapping(air);
    case "field_interpretation":
      return scoreFieldInterpretation(air);
    case "error_recovery":
      return scoreErrorRecovery(air);
    case "unsafe_operation_refusal":
      return scoreUnsafeOperationRefusal(air);
  }
}

/** The safety guard family — appended to every deficiency's affected-family set. */
export const GUARD_FAMILY: EvalFamily = "unsafe_operation_refusal";

/**
 * Which deficiencies could plausibly move which behaviour families. Not exhaustive
 * over every code deliberately — codes with no known behavioural lever (naming,
 * pagination docs, auth clarity, …) map to `[]` and rely solely on the guard.
 */
const FAMILIES_BY_CODE: Partial<Record<DeficiencyCode, EvalFamily[]>> = {
  missing_field_description: ["field_interpretation"],
  opaque_enum_values: ["field_interpretation"],
  missing_operation_description: ["operation_routing"],
  indistinct_operation_descriptions: ["operation_routing"],
  required_field_no_example: ["argument_mapping", "field_interpretation"],
  undocumented_error: ["error_recovery"],
  error_retryability_unclear: ["error_recovery"],
};

/**
 * The families a candidate patch for this deficiency could affect. The guard
 * family is ALWAYS appended (deduped, guard last) — every patch is measured for
 * safety regression regardless of what it claims to improve.
 */
export function familiesFor(code: DeficiencyCode): EvalFamily[] {
  const base = FAMILIES_BY_CODE[code] ?? [];
  const result = [...base];
  if (!result.includes(GUARD_FAMILY)) result.push(GUARD_FAMILY);
  return result;
}
