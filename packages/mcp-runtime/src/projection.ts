import type { Operation } from "@anvil/air";
import { AnvilError, type ErrorEnvelope } from "@anvil/runtime";
import { compile, type JSONValue, search } from "@jmespath-community/jmespath";
import { z } from "zod";

/**
 * Caller-directed response projection — the *control* path for context cost.
 *
 * Truncation is the failure path: the upstream cost is already paid, the
 * payload is already serialized, and the cut is a blind character-boundary slice
 * that can land mid-JSON. A projection is the opposite: the caller states which
 * fields it actually needs, and everything else is dropped *before* the payload
 * is measured or served. Nothing is recovered by truncation that a projection
 * could not have avoided more cheaply.
 *
 * Why JMESPath rather than a bespoke selector syntax: it is a written spec, it
 * is side-effect free and deterministic, and it is the language behind
 * `aws --query`. The agents calling this surface have already seen millions of
 * JMESPath examples in training data. Picking the projection language the model
 * already knows beats any syntax we could design, because the failure mode we
 * care about is the model guessing — and it does not have to guess at this.
 *
 * ORDERING (load-bearing): projection is applied to the response BEFORE the
 * truncation measurement in `server.ts`. If it ran after, the tokens would
 * already have been counted against the budget and the whole point would be
 * lost — the caller would pay full context cost for a narrowed view. The
 * expression is also compiled BEFORE the upstream call, so a malformed
 * expression costs nothing upstream.
 */

/**
 * The reserved, `anvil_`-namespaced tool argument for projection, following the
 * same convention as `anvil_dry_run` (see `MCP_RESERVED` in zodshape.ts): the
 * prefix makes a clash with a real operation parameter effectively impossible,
 * and it must appear in the published input schema or the SDK's zod validation
 * strips it before the handler ever sees it. It lives here rather than in
 * `MCP_RESERVED` because it is a *view* control, not a safety control — the
 * safety keys change whether an effect happens, this one only changes what is
 * disclosed about it.
 */
export const MCP_PROJECTION = "anvil_projection" as const;

/**
 * Expression length cap. JMESPath evaluation is side-effect free but not free:
 * deeply nested projections over a large page are quadratic in the worst case,
 * and this runs on the serving hot path. A thousand characters is far beyond
 * any field-selection an agent legitimately writes, so the cap only ever fires
 * on abuse or on a runaway generation.
 */
const MAX_PROJECTION_CHARS = 1_000;

/**
 * Slack allowed by the non-expansion guard. Reshaping is legitimate — renaming
 * `id` to `identifier`, or wrapping selected fields in an object — and on a tiny
 * payload that reshaping can add a handful of characters without disclosing
 * anything new. Sixty-four characters is roughly sixteen tokens: far too small
 * to matter to a context budget, and far too small to hide the duplication of
 * anything that does.
 */
const PROJECTION_SLACK_CHARS = 64;

/** The projection control's slice of the published tool input schema. */
export function projectionShape(): z.ZodRawShape {
  return {
    [MCP_PROJECTION]: z
      .string()
      .optional()
      .describe(
        "JMESPath expression (as in `aws --query`) applied to a successful response " +
          "before it is measured against the context budget, e.g. " +
          "`items[].{id: id, name: name}`. Selecting fewer fields lowers the cost per " +
          "item, which raises the number of items that fit in one page. It may only " +
          "narrow the response, never expand it; an invalid expression fails the call " +
          "rather than returning the unprojected payload.",
      ),
  } as z.ZodRawShape;
}

/**
 * Peel the projection control off tool arguments in place. Reserved controls are
 * never forwarded upstream — an `anvil_projection` that leaked into the wire
 * request would be an unmodeled parameter with no place to go.
 */
export function takeProjectionArg(input: Record<string, unknown>): string | undefined {
  const raw = input[MCP_PROJECTION];
  delete input[MCP_PROJECTION];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** A refused projection, already normalized onto the standard error envelope. */
export interface ProjectionRefusal {
  ok: false;
  envelope: ErrorEnvelope;
  message: string;
}

export type ProjectionResult = { ok: true; data: unknown } | ProjectionRefusal;

/**
 * Parse-check a projection without evaluating it, so a malformed expression is
 * refused before the upstream call rather than after. Returns undefined when the
 * expression is usable.
 */
export function validateProjection(
  expression: string,
  op: Operation,
  traceId: string,
): ProjectionRefusal | undefined {
  if (expression.length > MAX_PROJECTION_CHARS) {
    return projectionError(
      op,
      traceId,
      expression,
      `Projection expression is ${expression.length} characters; the limit is ${MAX_PROJECTION_CHARS}.`,
    );
  }
  try {
    compile(expression);
  } catch (err) {
    return projectionError(op, traceId, expression, describeJmespathFailure(err));
  }
  return undefined;
}

/**
 * Evaluate a projection against a successful response.
 *
 * Fails SAFE in the strict sense: on any failure the call returns a normalized
 * `validation_error` and NEVER the unprojected payload. Silently falling back to
 * the full response would be the worst available outcome — an agent that asked
 * for three fields and received eight hundred has been lied to about its own
 * context cost, and it has no way to detect the lie. A refusal it can read and
 * retry is strictly better than a payload it cannot trust.
 */
export function applyProjection(
  data: unknown,
  expression: string,
  op: Operation,
  traceId: string,
): ProjectionResult {
  const invalid = validateProjection(expression, op, traceId);
  if (invalid) return invalid;

  let projected: unknown;
  try {
    // `search` is pure: no I/O, no globals, no mutation of `data`. The JMESPath
    // grammar has no assignment and no function that reaches outside the
    // document, which is why a caller-supplied expression is safe to run here at
    // all — it can only ever address the response it was handed.
    projected = search(data as JSONValue, expression);
  } catch (err) {
    return projectionError(op, traceId, expression, describeJmespathFailure(err));
  }

  // JMESPath models "no match" as null; normalize `undefined` so the served JSON
  // is a value rather than a hole. An empty match is a legitimate answer — it
  // tells the caller its selector found nothing, which is information.
  const value = projected === undefined ? null : projected;

  // A projection may only *remove*. JMESPath multi-selects can duplicate a
  // subtree (`{a: @, b: @}`) and can splice in literals, so "it is a projection"
  // is not by itself a guarantee that less is disclosed. Comparing serialized
  // volume is the cheap, deterministic check that the invariant actually holds
  // — and an expression that grows the payload is precisely the one that
  // defeats the feature's purpose, so refusing it loses nothing worth having.
  const before = serializedLength(data);
  const after = serializedLength(value);
  if (after === undefined) {
    return projectionError(
      op,
      traceId,
      expression,
      "Projection produced a value that cannot be serialized as JSON.",
    );
  }
  // A null result discloses nothing, so it cannot expand disclosure however the
  // literals compare — `null` is four characters and an empty source object is
  // two, which would otherwise trip the guard on the one case that is trivially
  // safe.
  if (value !== null && before !== undefined && after > before + PROJECTION_SLACK_CHARS) {
    return projectionError(
      op,
      traceId,
      expression,
      `Projection expanded the response (${before} → ${after} serialized characters). ` +
        "A projection may only narrow what is disclosed; rewrite it to select fields " +
        "rather than duplicate or synthesize them.",
    );
  }

  return { ok: true, data: value };
}

/**
 * Normalize a projection failure onto the standard error envelope (spec §10)
 * with the `validation_error` code: the fault is in the caller's expression, not
 * upstream, and it is not retryable without a change to the request. The
 * expression is echoed back in `details` because it is caller-supplied and
 * non-secret, and because an agent repairing its own selector needs to see what
 * it actually sent.
 */
function projectionError(
  op: Operation,
  traceId: string,
  expression: string,
  reason: string,
): ProjectionRefusal {
  const message = `Invalid '${MCP_PROJECTION}' expression: ${reason}`;
  const envelope = new AnvilError({
    code: "validation_error",
    message,
    operation: op.id,
    traceId,
    retryable: false,
    safeToRetry: false,
    details: { parameter: MCP_PROJECTION, expression, syntax: "jmespath" },
  }).toEnvelope();
  return { ok: false, envelope, message };
}

/** JMESPath throws plain `Error`s; keep the message, never the stack. */
function describeJmespathFailure(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "expression could not be evaluated";
}

/**
 * Serialized character count, or undefined when the value cannot be JSON at all.
 * Compact form deliberately: this measures content volume, and indentation would
 * make the comparison depend on nesting shape rather than on how much was kept.
 */
function serializedLength(value: unknown): number | undefined {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : text.length;
  } catch {
    return undefined;
  }
}
