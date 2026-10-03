/**
 * The effect contract (ADR-0030): what undoing an operation's effect means, and
 * the follow-up calls that undo it, cancel it, find it, or stage it.
 *
 * An operation declares this on `effect` (`class`, `inverse`, `compensate`,
 * `lookup`, `draft`); the compiler checks it against the other operations and
 * their schemas (`@anvil/compiler`'s `effects.ts`); the serving path resolves it
 * against one real call into concrete follow-up arguments (`resolveEffectReport`)
 * and returns that to the caller (`_meta.effect` over MCP, `X-Anvil-Effect`
 * over REST). Anvil never undoes anything itself: an undo is an ordinary call a
 * caller makes, under the same grant, with the arguments this module resolved.
 *
 * ## The path grammar
 *
 * A mapping names each argument of the follow-up call and where its value
 * comes from. A string source is a path:
 *
 * ```text
 * path     := root ( "." name | "[" index "]" )* [ "?" ]
 * root     := "request" | "response" | "idempotency_key"
 * name     := [A-Za-z_$][A-Za-z0-9_$-]*
 * index    := [0-9]+
 * ```
 *
 * - `request` is the original call's arguments, as the tool took them (agent
 *   input names, not wire names): `request.owner`, `request.body.title`.
 * - `response` is the upstream's answer: `response.id`, `response.items[0].id`.
 * - `idempotency_key` is the key the call carried upstream (lookups only); it
 *   takes no segments.
 * - A trailing `?` makes the argument optional: when the path names nothing,
 *   the argument is left out instead of making the follow-up unavailable
 *   (`request.name?` copies a name only when the caller gave one).
 *
 * Any other source is the literal `{ "const": <value> }`. There are no
 * wildcards, filters, or expressions: a path names one value or nothing, and a
 * path that names nothing at run time makes the follow-up unavailable rather
 * than called with a gap.
 */

import type {
  EffectArgumentMapping,
  EffectArgumentSource,
  EffectDeadline,
} from "./effect-schema.js";
import type { EffectClass } from "./enums.js";
import { resolveIdempotencyCarrier } from "./idempotency-carrier.js";
import type { JsonSchema, Operation } from "./schema.js";

/** The roots a path may start from. */
export type EffectPathRoot = "request" | "response" | "idempotency_key";

/** One parsed path: its root and the property names / array indices under it. */
export interface EffectPath {
  root: EffectPathRoot;
  segments: Array<string | number>;
  /** Written with a trailing `?`: a missing value leaves the argument out. */
  optional: boolean;
}

const ROOTS: readonly EffectPathRoot[] = ["request", "response", "idempotency_key"];
const NAME = /^[A-Za-z_$][A-Za-z0-9_$-]*/;
const INDEX = /^\[(\d+)\]/;

/** Parse a path, or say why it is not one. */
export function parseEffectPath(written: string): EffectPath | { error: string } {
  const optional = written.endsWith("?");
  const source = optional ? written.slice(0, -1) : written;
  const head = NAME.exec(source);
  const root = head?.[0];
  if (!root || !ROOTS.includes(root as EffectPathRoot)) {
    return { error: `a path starts with request, response, or idempotency_key: '${source}'` };
  }
  const segments: Array<string | number> = [];
  let rest = source.slice(root.length);
  while (rest.length > 0) {
    if (rest.startsWith(".")) {
      const name = NAME.exec(rest.slice(1));
      if (!name) return { error: `expected a property name after '.' in '${source}'` };
      segments.push(name[0]);
      rest = rest.slice(1 + name[0].length);
      continue;
    }
    const index = INDEX.exec(rest);
    if (index) {
      segments.push(Number(index[1]));
      rest = rest.slice(index[0].length);
      continue;
    }
    return { error: `unexpected '${rest[0]}' in '${source}'` };
  }
  if (root === "idempotency_key" && segments.length > 0) {
    return { error: `idempotency_key takes no segments: '${source}'` };
  }
  if (root !== "idempotency_key" && segments.length === 0) {
    return { error: `name a value under ${root}, not the whole ${root}: '${source}'` };
  }
  return { root: root as EffectPathRoot, segments, optional };
}

/**
 * The effect class an operation has: what it declares, else the conservative
 * default — `read` for a read, `irreversible` (no undo) for everything else.
 * A connector compiled before effect declarations existed reads as the worst
 * case, which is what a caller must assume about an effect nobody described.
 */
export function effectClassOf(op: Pick<Operation, "effect">): EffectClass {
  return op.effect.class ?? (op.effect.kind === "read" ? "read" : "irreversible");
}

/** The values a mapping reads from one call. */
export interface EffectScope {
  request?: unknown;
  response?: unknown;
  idempotencyKey?: string | undefined;
}

function valueAt(value: unknown, segments: ReadonlyArray<string | number>): unknown {
  let current = value;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (current === null || typeof current !== "object" || Array.isArray(current)) {
        return undefined;
      }
      if (!Object.hasOwn(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

/** One source's value in a scope; `undefined` when the path names nothing. */
export function resolveEffectSource(source: EffectArgumentSource, scope: EffectScope): unknown {
  if (typeof source !== "string") return source.const;
  const path = parseEffectPath(source);
  if ("error" in path) return undefined;
  if (path.root === "idempotency_key") return scope.idempotencyKey;
  const value = valueAt(path.root === "request" ? scope.request : scope.response, path.segments);
  return value === null ? undefined : value;
}

export type EffectArgumentsResolution =
  | { ok: true; arguments: Record<string, unknown> }
  | { ok: false; argument: string; source: string };

/**
 * Concrete arguments for a follow-up call. All or nothing: a mapping with one
 * path that names nothing yields no arguments (and says which), never a call
 * with that argument left out.
 */
export function resolveEffectArguments(
  mapping: EffectArgumentMapping,
  scope: EffectScope,
): EffectArgumentsResolution {
  const out: Record<string, unknown> = {};
  for (const [argument, source] of Object.entries(mapping)) {
    const value = resolveEffectSource(source, scope);
    if (value === undefined) {
      if (typeof source === "string" && source.endsWith("?")) continue;
      return {
        ok: false,
        argument,
        source: typeof source === "string" ? source : JSON.stringify(source),
      };
    }
    out[argument] = value;
  }
  return { ok: true, arguments: out };
}

/**
 * Epoch milliseconds by which an undo must run, or `null` when none applies.
 * `undefined` means the rule names a response value that is missing or not a
 * time, which a caller must treat as "deadline unknown", not "no deadline".
 */
export function resolveEffectDeadline(
  deadline: EffectDeadline | undefined,
  scope: EffectScope,
  answeredAt: number,
): number | null | undefined {
  if (!deadline) return null;
  if (deadline.withinMs !== undefined) return answeredAt + deadline.withinMs;
  if (deadline.at === undefined) return null;
  const value = resolveEffectSource(deadline.at, scope);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/** How a path fares against a JSON Schema. */
export type EffectSchemaCheck = "ok" | "missing" | "unverifiable";

function refTarget(schema: JsonSchema, defs: Record<string, JsonSchema>): JsonSchema | undefined {
  const ref = schema.$ref;
  if (typeof ref !== "string") return schema;
  const match = /^#\/(?:components\/schemas|\$defs|definitions)\/(.+)$/.exec(ref);
  return match ? defs[decodeURIComponent(match[1] as string)] : undefined;
}

/**
 * Whether `segments` name a value a document matching `schema` can hold.
 * `missing` when the schema declares its properties and not this one (unless
 * it explicitly allows others), or has a type with no such member; a schema
 * too open or too complex to judge is `unverifiable`, never a refusal. `$ref`s into the document's own
 * schemas are followed; `allOf` branches are all searched, `anyOf`/`oneOf`
 * branches any.
 */
export function effectPathInSchema(
  schema: JsonSchema | undefined,
  segments: ReadonlyArray<string | number>,
  defs: Record<string, JsonSchema> = {},
  depth = 0,
): EffectSchemaCheck {
  if (!schema || depth > 32) return "unverifiable";
  const resolved = refTarget(schema, defs);
  if (!resolved) return "unverifiable";
  if (segments.length === 0) return "ok";
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = resolved[key];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const results = (branches as JsonSchema[]).map((branch) =>
      effectPathInSchema(branch, segments, defs, depth + 1),
    );
    if (results.includes("ok")) return "ok";
    if (results.includes("unverifiable")) return "unverifiable";
    if (key !== "allOf") return "missing";
  }
  const [head, ...rest] = segments;
  const type = resolved.type;
  const types = Array.isArray(type) ? type : type === undefined ? [] : [type];
  if (typeof head === "number") {
    if (resolved.items && typeof resolved.items === "object") {
      return effectPathInSchema(resolved.items as JsonSchema, rest, defs, depth + 1);
    }
    if (types.length > 0 && !types.includes("array")) return "missing";
    return "unverifiable";
  }
  const properties = resolved.properties as Record<string, JsonSchema> | undefined;
  if (properties && Object.hasOwn(properties, head as string)) {
    return effectPathInSchema(properties[head as string], rest, defs, depth + 1);
  }
  // A schema that declares its properties and does not explicitly invite
  // others is taken at its word: a path to an undeclared name is a typo far
  // more often than a real, undocumented field.
  const invitesOthers =
    resolved.additionalProperties === true ||
    (typeof resolved.additionalProperties === "object" && resolved.additionalProperties !== null);
  if (properties && !invitesOthers) return "missing";
  if (types.length > 0 && !types.includes("object")) return "missing";
  return "unverifiable";
}

/**
 * The subschema `segments` name inside `schema`, when it can be found without
 * guessing: through `$ref`s, declared `properties`, array `items`, and the
 * first `allOf` branch that has it. Undefined otherwise.
 */
export function effectSchemaAtPath(
  schema: JsonSchema | undefined,
  segments: ReadonlyArray<string | number>,
  defs: Record<string, JsonSchema> = {},
  depth = 0,
): JsonSchema | undefined {
  if (!schema || depth > 32) return undefined;
  const resolved = refTarget(schema, defs);
  if (!resolved) return undefined;
  if (segments.length === 0) return resolved;
  const [head, ...rest] = segments;
  if (typeof head === "number") {
    const items = resolved.items;
    return items && typeof items === "object" && !Array.isArray(items)
      ? effectSchemaAtPath(items as JsonSchema, rest, defs, depth + 1)
      : undefined;
  }
  const properties = resolved.properties as Record<string, JsonSchema> | undefined;
  if (properties && Object.hasOwn(properties, head as string)) {
    return effectSchemaAtPath(properties[head as string], rest, defs, depth + 1);
  }
  for (const branch of (resolved.allOf as JsonSchema[] | undefined) ?? []) {
    const found = effectSchemaAtPath(branch, segments, defs, depth + 1);
    if (found) return found;
  }
  return undefined;
}

type JsonType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

/** The JSON types a schema admits, when it says; undefined when it does not. */
export function effectSchemaTypes(schema: JsonSchema | undefined): Set<JsonType> | undefined {
  if (!schema) return undefined;
  const type = schema.type;
  if (typeof type === "string") return new Set([type as JsonType]);
  if (Array.isArray(type) && type.length > 0) return new Set(type as JsonType[]);
  const literals =
    "const" in schema ? [schema.const] : Array.isArray(schema.enum) ? schema.enum : undefined;
  return literals ? new Set(literals.map(effectValueType)) : undefined;
}

/** The JSON type of one value. */
export function effectValueType(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value as JsonType;
}

/**
 * Whether a value of one of `source` types can go where `target` types are
 * accepted. An integer is a number; nothing else converts.
 */
export function effectTypesCompatible(source: Set<JsonType>, target: Set<JsonType>): boolean {
  for (const type of source) {
    if (target.has(type)) return true;
    if (type === "integer" && target.has("number")) return true;
  }
  return false;
}

/** A resolved follow-up call: what to call, and with exactly what. */
export interface EffectCall {
  operation: string;
  /** The tool's name as this server publishes it (a fleet prefixes it). */
  tool: string;
  arguments: Record<string, unknown>;
}

/**
 * What `_meta.effect` (MCP) and `X-Anvil-Effect` (REST) carry for one call.
 * Snake case: it is read by other programs (Branchyard's effect ledger), not
 * by this one.
 */
export interface EffectReport {
  class: EffectClass;
  /** The AIR operation that ran (the draft's, for a staged call). */
  operation: string;
  /** The idempotency key the call carried upstream; null when it carried none. */
  idempotency_key: string | null;
  /**
   * The call that undoes this effect: the inverse (`kind: "inverse"`) of a
   * reversible effect, or the compensation (`kind: "compensate"`) of a
   * compensable one. Null when there is none, or when it could not be resolved
   * (`undo_unavailable` says why).
   */
  undo: (EffectCall & { kind: "inverse" | "compensate" }) | null;
  /** Epoch milliseconds after which `undo` may no longer work; null when none applies. */
  deadline_ms: number | null;
  /** A reversible effect's compensation as well, when it declares one (for after the deadline). */
  compensate?: EffectCall & { deadline_ms: number | null };
  /** The lookup a reconciler calls when the answer was lost; null when none is declared or resolvable. */
  lookup: (EffectCall & { by: "idempotency_key" | "id" }) | null;
  /** Why `undo` is null although the class has one. */
  undo_unavailable?: string;
  /**
   * Present on a staged call, which performed the draft form (`draft_operation`)
   * and not the effect itself: the draft's handle, the call that promotes it
   * (performs the real effect), and the call that discards it. `class`, `undo`
   * and `lookup` above describe the effect the promotion would have.
   */
  staged?: {
    draft_operation: string;
    handle: unknown;
    promote: EffectCall | null;
    discard: EffectCall | null;
    unavailable?: string;
  };
}

/** Resolve the follow-up operation's published tool name; undefined when it is not served. */
export type EffectToolResolver = (operationId: string) => string | undefined;

export interface EffectReportInput {
  op: Operation;
  /** The call's arguments as the tool took them (reserved controls removed). */
  request: Record<string, unknown>;
  /** The upstream's answer; undefined when there is none (an error). */
  response?: unknown;
  /** The idempotency key that went upstream, if any. */
  idempotencyKey?: string | undefined;
  /** When the call answered (epoch ms). */
  answeredAt: number;
  /** Operation id → published tool name, for served operations only. */
  toolFor: EffectToolResolver;
  /** False when the call failed: there is no effect to undo, only one to look up. */
  succeeded: boolean;
}

function followUp(
  operation: string,
  mapping: EffectArgumentMapping,
  scope: EffectScope,
  toolFor: EffectToolResolver,
): { ok: true; call: EffectCall } | { ok: false; reason: string } {
  const tool = toolFor(operation);
  if (!tool) return { ok: false, reason: `operation '${operation}' is not served here` };
  const resolved = resolveEffectArguments(mapping, scope);
  if (!resolved.ok) {
    return {
      ok: false,
      reason: `argument '${resolved.argument}' (${resolved.source}) names no value in this call`,
    };
  }
  return { ok: true, call: { operation, tool, arguments: resolved.arguments } };
}

/**
 * The effect report for one finished call. Pure: the serving path supplies the
 * request, the response, the key that went upstream, and which follow-up
 * operations it actually serves.
 */
export function resolveEffectReport(input: EffectReportInput): EffectReport {
  const { op, toolFor } = input;
  const effectClass = effectClassOf(op);
  const scope: EffectScope = {
    request: input.request,
    response: input.response,
    idempotencyKey: input.idempotencyKey,
  };
  const report: EffectReport = {
    class: effectClass,
    operation: op.id,
    idempotency_key: input.idempotencyKey ?? null,
    undo: null,
    deadline_ms: null,
    lookup: null,
  };
  const lookup = op.effect.lookup;
  if (lookup && effectClass !== "read") {
    const resolved = followUp(lookup.operation, lookup.arguments, scope, toolFor);
    if (resolved.ok) report.lookup = { ...resolved.call, by: lookup.by };
  }
  if (!input.succeeded) return report;

  const declared =
    effectClass === "reversible"
      ? { kind: "inverse" as const, undo: op.effect.inverse }
      : effectClass === "compensable"
        ? { kind: "compensate" as const, undo: op.effect.compensate }
        : undefined;
  if (declared) {
    if (!declared.undo) {
      report.undo_unavailable = `the operation declares no ${declared.kind}`;
    } else {
      const resolved = followUp(declared.undo.operation, declared.undo.arguments, scope, toolFor);
      const deadline = resolveEffectDeadline(declared.undo.deadline, scope, input.answeredAt);
      if (!resolved.ok) {
        report.undo_unavailable = resolved.reason;
      } else if (deadline === undefined) {
        report.undo_unavailable = `the ${declared.kind}'s deadline (${declared.undo.deadline?.at}) names no time in this call`;
      } else {
        report.undo = { kind: declared.kind, ...resolved.call };
        report.deadline_ms = deadline;
      }
    }
  }
  if (effectClass === "reversible" && op.effect.compensate) {
    const resolved = followUp(
      op.effect.compensate.operation,
      op.effect.compensate.arguments,
      scope,
      toolFor,
    );
    const deadline = resolveEffectDeadline(op.effect.compensate.deadline, scope, input.answeredAt);
    if (resolved.ok && deadline !== undefined) {
      report.compensate = { ...resolved.call, deadline_ms: deadline };
    }
  }
  return report;
}

/**
 * The report for a staged call: `op` (the effect that was staged, not
 * performed) with no undo, plus the draft's handle and its promote and
 * discard calls, resolved from the staged request and the draft's answer.
 */
export function resolveStagedReport(input: {
  op: Operation;
  request: Record<string, unknown>;
  draftResponse: unknown;
  idempotencyKey?: string | undefined;
  toolFor: EffectToolResolver;
}): EffectReport {
  const { op, toolFor } = input;
  const draft = op.effect.draft;
  const report: EffectReport = {
    class: effectClassOf(op),
    operation: op.id,
    idempotency_key: input.idempotencyKey ?? null,
    undo: null,
    deadline_ms: null,
    lookup: null,
  };
  if (!draft) return report;
  const scope: EffectScope = { request: input.request, response: input.draftResponse };
  const handle = resolveEffectSource(draft.handle, scope) ?? null;
  const promote = followUp(draft.promote.operation, draft.promote.arguments, scope, toolFor);
  const discard = draft.discard
    ? followUp(draft.discard.operation, draft.discard.arguments, scope, toolFor)
    : undefined;
  const unavailable = [
    ...(promote.ok ? [] : [`promote: ${promote.reason}`]),
    ...(discard && !discard.ok ? [`discard: ${discard.reason}`] : []),
  ];
  report.staged = {
    draft_operation: draft.operation,
    handle,
    promote: promote.ok ? promote.call : null,
    discard: discard?.ok ? discard.call : null,
    ...(unavailable.length > 0 ? { unavailable: unavailable.join("; ") } : {}),
  };
  return report;
}

/**
 * Whether an operation takes an idempotency key upstream (a header, query,
 * body, or path carrier). A caller's key for one that does not is not
 * forwarded: inventing a carrier would send a header the upstream ignores
 * and claim protection that does not exist.
 */
export function operationForwardsIdempotencyKey(op: Operation): boolean {
  const carrier = resolveIdempotencyCarrier(op);
  return carrier.ok && carrier.binding !== undefined;
}

/**
 * The declared contract as a tool publishes it in `tools/list` `_meta`
 * (`anvil/effect_contract`), so a caller can resolve a lookup itself when the
 * call's answer never arrived. Absent when nothing is declared.
 */
export function effectContractMeta(op: Operation): Record<string, unknown> | undefined {
  const { class: declaredClass, inverse, compensate, lookup, draft } = op.effect;
  if (!declaredClass && !inverse && !compensate && !lookup && !draft) return undefined;
  return {
    class: effectClassOf(op),
    ...(inverse ? { inverse } : {}),
    ...(compensate ? { compensate } : {}),
    ...(lookup ? { lookup } : {}),
    ...(draft ? { draft } : {}),
  };
}

/** One plain sentence for docs and skills: whether, and how, this action can be undone. */
export function effectUndoSentence(
  op: Operation,
  nameOf: (operationId: string) => string = (id) => id,
): string {
  switch (effectClassOf(op)) {
    case "read":
      return "Changes nothing.";
    case "reversible": {
      const inverse = op.effect.inverse;
      const within = inverse?.deadline?.withinMs;
      return inverse
        ? `This action can be undone with \`${nameOf(inverse.operation)}\`${within ? ` within ${humanDuration(within)}` : inverse.deadline?.at ? " until the deadline the response gives" : ""}.`
        : "This action can be undone.";
    }
    case "compensable": {
      const compensate = op.effect.compensate;
      return compensate
        ? `This action cannot be undone, but can be compensated with \`${nameOf(compensate.operation)}\` (which leaves a trace).`
        : "This action cannot be undone, but can be compensated.";
    }
    default:
      return op.effect.draft
        ? `This action cannot be undone. It has a draft form (\`${nameOf(op.effect.draft.operation)}\`) that can be reviewed before it is promoted.`
        : "This action cannot be undone.";
  }
}

function humanDuration(ms: number): string {
  const units: Array<[number, string]> = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
    [1000, "second"],
  ];
  for (const [size, name] of units) {
    if (ms >= size && ms % size === 0) {
      const n = ms / size;
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  return `${ms} ms`;
}
