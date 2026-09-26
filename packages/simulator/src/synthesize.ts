/**
 * Response bodies synthesized from a declared schema under a seeded `Rng`.
 * Split out of runtime.ts unchanged; see the note there on why the store and
 * the response are different objects.
 */
import type { JsonSchema } from "@anvil/air";
import type { Rng } from "./rng.js";

/**
 * How deep a synthesized body follows a declared schema. `materializeSchema`
 * has already removed `$ref` cycles, so this is not a termination guard — it is
 * a statement that a body nested past this point contributes structure no agent
 * reads, and following it further would inflate a cost figure with depth the
 * caller never sees.
 */
const MAX_BODY_DEPTH = 8;

/** Default synthesized string length when the schema constrains neither end. */
const DEFAULT_STRING_LENGTH = 8;

/**
 * The most items a synthesized array carries. `minItems` is a declared fact and
 * is honoured up to this bound; the bound itself is a limit on the *instrument*
 * (a pathological declaration must not make synthesis unbounded), never a claim
 * about the payload — which is why it is not consulted unless the contract
 * asked for more than it.
 */
const MAX_ARRAY_ITEMS = 10;

/** Fixed values for the formats whose shape, not whose entropy, is the point. */
const FORMAT_VALUES: Record<string, string> = {
  date: "2026-01-01",
  "date-time": "2026-01-01T00:00:00Z",
  time: "00:00:00Z",
  email: "user@example.com",
  uri: "https://example.com/resource",
  url: "https://example.com/resource",
  hostname: "api.example.com",
  ipv4: "192.0.2.1",
  ipv6: "2001:db8::1",
};

/** Schema keys that annotate without constraining — a schema of only these is a stub. */
const ANNOTATION_KEYS = new Set([
  "description",
  "title",
  "deprecated",
  "readOnly",
  "writeOnly",
  "nullable",
  "default",
  "$comment",
  "externalDocs",
  "xml",
]);

/**
 * A body for one entity, drawn from a declared item schema under a seeded `Rng`.
 *
 * Returns `undefined` for anything that is not a JSON object: the store is
 * object-keyed, and a resource whose declared representation is a scalar or an
 * array keeps its historical body rather than being served a shape the state
 * machine cannot carry.
 */
export function synthesizeBody(schema: JsonSchema, rng: Rng): Record<string, unknown> | undefined {
  const value = synthesize(schema, rng, 0);
  return isRecord(value) ? value : undefined;
}

/**
 * One value for one declared schema node.
 *
 * Declared values beat synthesized ones in every case the contract states one
 * (`const`, `example`, `examples`, `enum`): they are the most faithful answer
 * available, and they cost what the contract says they cost. Everything else is
 * seeded from the `Rng`, so the whole walk stays a pure function of (contract,
 * seed) — the property that lets a measured figure be re-derived instead of
 * merely believed.
 */
function synthesize(schema: JsonSchema, rng: Rng, depth: number): unknown {
  if (schema.const !== undefined) return schema.const;
  if (schema.example !== undefined && schema.example !== null) return schema.example;
  if (Array.isArray(schema.examples)) {
    const first = schema.examples.find((e) => e !== null && e !== undefined);
    if (first !== undefined) return first;
  }
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((v) => v !== null && v !== undefined);
    const picked = values[rng.int(values.length)];
    if (picked !== undefined) return picked;
  }
  if (depth >= MAX_BODY_DEPTH) return schema.type === "array" ? [] : {};

  // A materialized `allOf` composes one object out of several declarations —
  // including truncation stubs that contribute nothing — so every member is
  // synthesized and the object results merged, later members winning.
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const merged: Record<string, unknown> = {};
    for (const member of schema.allOf) {
      if (!isRecord(member)) continue;
      const part = synthesize(member as JsonSchema, rng, depth + 1);
      if (isRecord(part)) Object.assign(merged, part);
    }
    return merged;
  }
  // `oneOf`/`anyOf`: any branch satisfies the contract, so take the first
  // declared one. A schema may carry both its own structure and alternatives
  // that only refine it, so the branch merges onto the base rather than
  // replacing it.
  const alternatives = (
    Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : []
  ).filter(isRecord) as JsonSchema[];
  const branch = alternatives[0];
  if (branch !== undefined) {
    const value = synthesize(branch, rng, depth + 1);
    if (schema.type === undefined && !isRecord(schema.properties)) return value;
    const own = ownValue(schema, rng, depth);
    return isRecord(own) && isRecord(value) ? { ...own, ...value } : (own ?? value);
  }
  return ownValue(schema, rng, depth);
}

/** Synthesize from a schema's own declared structure, with no compositors left. */
function ownValue(schema: JsonSchema, rng: Rng, depth: number): unknown {
  switch (schema.type) {
    case "string":
      return synthesizeString(schema, rng);
    case "integer":
      return synthesizeInteger(schema, rng);
    case "number":
      return synthesizeInteger(schema, rng) + Math.floor(rng.next() * 100) / 100;
    case "boolean":
      return rng.next() < 0.5;
    case "array":
      return synthesizeArray(schema, rng, depth);
    case "object":
      return synthesizeObject(schema, rng, depth);
    default:
      // An untyped schema that still declares `properties` (or a `required`
      // list, which is an object constraint in all but name) is an object. A
      // bare annotation stub is an object we know nothing about, so `{}`. A
      // schema that declares neither is a field the contract admits exists
      // without saying what it holds: `null` records that honestly, and costs
      // what an unknown field costs.
      if (isRecord(schema.properties) || Array.isArray(schema.required)) {
        return synthesizeObject(schema, rng, depth);
      }
      if (Object.keys(schema).every((k) => ANNOTATION_KEYS.has(k))) return {};
      return null;
  }
}

function synthesizeString(schema: JsonSchema, rng: Rng): string {
  const format = typeof schema.format === "string" ? schema.format : "";
  const fixed = FORMAT_VALUES[format];
  if (fixed !== undefined) return fixed;
  if (format === "uuid") {
    return `${rng.token(8)}-${rng.token(4)}-4${rng.token(3)}-a${rng.token(3)}-${rng.token(12)}`;
  }
  // Length is declared or it is not: a declared bound is a fact about the
  // payload's size and is honoured in both directions, which is exactly how a
  // contract that promises long strings comes to simulate as expensive.
  const min = boundedInt(schema.minLength, 0);
  const max = boundedInt(schema.maxLength, Number.POSITIVE_INFINITY);
  return rng.token(Math.max(0, Math.max(min, Math.min(max, DEFAULT_STRING_LENGTH))));
}

function synthesizeInteger(schema: JsonSchema, rng: Rng): number {
  const min = boundedInt(schema.minimum, 0);
  const max = boundedInt(schema.maximum, Number.POSITIVE_INFINITY);
  if (max === Number.POSITIVE_INFINITY) return min + rng.int(1000);
  return min + rng.int(Math.max(1, Math.floor(max - min) + 1));
}

function synthesizeArray(schema: JsonSchema, rng: Rng, depth: number): unknown[] {
  const items = isRecord(schema.items) ? (schema.items as JsonSchema) : undefined;
  const min = boundedInt(schema.minItems, 1);
  const max = boundedInt(schema.maxItems, Number.POSITIVE_INFINITY);
  const count = Math.min(MAX_ARRAY_ITEMS, Math.max(0, Math.min(max, Math.max(1, min))));
  if (!items) return new Array(count).fill(null);
  return Array.from({ length: count }, () => synthesize(items, rng, depth + 1));
}

function synthesizeObject(schema: JsonSchema, rng: Rng, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = isRecord(schema.properties)
    ? (schema.properties as Record<string, JsonSchema | undefined>)
    : {};
  // Declared order, not sorted: this is a payload as served, not a digest, and
  // reordering keys would move a measured byte count for no reason.
  for (const [name, prop] of Object.entries(props)) {
    out[name] = isRecord(prop) ? synthesize(prop, rng, depth + 1) : null;
  }
  // A map/record schema (typed `additionalProperties`, no fixed properties)
  // gets one representative entry, so the body exercises the map shape rather
  // than the degenerate `{}` that would report a dictionary as free.
  const extra = schema.additionalProperties;
  if (Object.keys(out).length === 0 && isRecord(extra)) {
    out.key = synthesize(extra as JsonSchema, rng, depth + 1);
  }
  return out;
}

function boundedInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A schema that declares nothing is not a schema, so callers treat it as absent. */
export function nonEmpty(schema: JsonSchema | undefined): JsonSchema | undefined {
  return schema && Object.keys(schema).length > 0 ? schema : undefined;
}
