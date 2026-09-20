import type { ParamLocation, ParamStyle } from "./enums.js";

/**
 * Parameter serialization — how one bound value becomes text on the wire.
 *
 * OpenAPI lets a source declare `style` and `explode` on a parameter, and
 * defaults them per location when it does not. Until this existed the runtime
 * did `String(value)` for every location: an array became its comma-joined
 * `toString`, and an object became the literal text `[object Object]` — a
 * well-formed request carrying a value no server could ever have meant.
 *
 * This is the one definition every surface reads. The runtime binds through
 * it, the harness's wire oracle derives its expectation from it, and the four
 * generated SDKs mirror its table verbatim. A rule that lived in the executor
 * alone would let the oracle agree with the bug instead of catching it.
 *
 * It refuses rather than guesses: a shape no style gives a meaning to (an
 * object inside an object, an array of objects, an object under a delimiter
 * style) comes back `ok: false`, and the caller turns that into a typed error
 * before anything reaches the wire.
 */

/** A value serializable as one text atom: everything except objects and arrays. */
export type WirePrimitive = string | number | boolean | bigint;

export interface ParamSerializationInput {
  in: ParamLocation;
  name: string;
  style?: ParamStyle | undefined;
  explode?: boolean | undefined;
}

export type SerializedPairs =
  | { ok: true; pairs: Array<[string, string]> }
  | { ok: false; reason: string };

export type SerializedText = { ok: true; text: string } | { ok: false; reason: string };

/** The OpenAPI default style for a location. */
export function defaultParamStyle(location: ParamLocation): ParamStyle {
  return location === "path" || location === "header" ? "simple" : "form";
}

/** The style and explode that actually apply, with OpenAPI's defaults filled in. */
export function resolveParamSerialization(p: ParamSerializationInput): {
  style: ParamStyle;
  explode: boolean;
} {
  const style = p.style ?? defaultParamStyle(p.in);
  // OpenAPI: explode defaults to true for `form`, false for every other style.
  const explode = p.explode ?? style === "form";
  return { style, explode };
}

function isPrimitive(value: unknown): value is WirePrimitive {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean" || t === "bigint";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function primitiveArray(name: string, value: unknown[]): WirePrimitive[] | string {
  for (const item of value) {
    if (!isPrimitive(item)) {
      return `parameter '${name}' is an array whose items are not all scalars; no parameter style encodes an array of objects or nested arrays`;
    }
  }
  return value as WirePrimitive[];
}

function flatObject(name: string, value: Record<string, unknown>): [string, WirePrimitive][] | string {
  const out: [string, WirePrimitive][] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    if (!isPrimitive(item)) {
      return `parameter '${name}' is an object whose property '${key}' is itself an object or array; no parameter style encodes a nested object`;
    }
    out.push([key, item]);
  }
  return out;
}

const DELIMITER: Partial<Record<ParamStyle, string>> = {
  form: ",",
  simple: ",",
  spaceDelimited: " ",
  pipeDelimited: "|",
};

/**
 * Serialize a query or cookie parameter into name/value pairs. The pairs are
 * raw text; percent-encoding is the URL builder's job so that every surface
 * encodes exactly once, the same way.
 */
export function serializeQueryParam(p: ParamSerializationInput, value: unknown): SerializedPairs {
  const { style, explode } = resolveParamSerialization(p);
  if (isPrimitive(value)) return { ok: true, pairs: [[p.name, String(value)]] };
  if (Array.isArray(value)) {
    const items = primitiveArray(p.name, value);
    if (typeof items === "string") return { ok: false, reason: items };
    if (style === "deepObject") {
      return {
        ok: false,
        reason: `parameter '${p.name}' declares style deepObject, which encodes objects only; it was given an array`,
      };
    }
    const text = items.map(String);
    if (style === "form" && explode) {
      return { ok: true, pairs: text.map((item): [string, string] => [p.name, item]) };
    }
    return { ok: true, pairs: [[p.name, text.join(DELIMITER[style] ?? ",")]] };
  }
  if (isRecord(value)) {
    const entries = flatObject(p.name, value);
    if (typeof entries === "string") return { ok: false, reason: entries };
    if (style === "deepObject") {
      return {
        ok: true,
        pairs: entries.map(([k, v]): [string, string] => [`${p.name}[${k}]`, String(v)]),
      };
    }
    if (style === "form") {
      return explode
        ? { ok: true, pairs: entries.map(([k, v]): [string, string] => [k, String(v)]) }
        : { ok: true, pairs: [[p.name, entries.flatMap(([k, v]) => [k, String(v)]).join(",")]] };
    }
    return {
      ok: false,
      reason: `parameter '${p.name}' declares style ${style}, which has no defined encoding for an object`,
    };
  }
  return {
    ok: false,
    reason: `parameter '${p.name}' has a value of type ${typeof value}, which cannot be put on the wire`,
  };
}

/**
 * Serialize a path or header parameter (style `simple`) into one text value.
 * `encode` is applied to each atom before joining, so a path can percent-encode
 * its items while keeping the commas that separate them literal.
 */
export function serializeSimpleParam(
  p: ParamSerializationInput,
  value: unknown,
  encode: (atom: string) => string = (atom) => atom,
): SerializedText {
  const { explode } = resolveParamSerialization(p);
  if (isPrimitive(value)) return { ok: true, text: encode(String(value)) };
  if (Array.isArray(value)) {
    const items = primitiveArray(p.name, value);
    if (typeof items === "string") return { ok: false, reason: items };
    return { ok: true, text: items.map((item) => encode(String(item))).join(",") };
  }
  if (isRecord(value)) {
    const entries = flatObject(p.name, value);
    if (typeof entries === "string") return { ok: false, reason: entries };
    const text = explode
      ? entries.map(([k, v]) => `${encode(k)}=${encode(String(v))}`).join(",")
      : entries.map(([k, v]) => `${encode(k)},${encode(String(v))}`).join(",");
    return { ok: true, text };
  }
  return {
    ok: false,
    reason: `parameter '${p.name}' has a value of type ${typeof value}, which cannot be put on the wire`,
  };
}
