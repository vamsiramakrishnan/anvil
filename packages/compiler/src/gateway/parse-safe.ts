/**
 * Safe parsing + shape coercion for vendor gateway adapters. The whole gateway
 * surface makes one promise — "parse as data, never throw": a malformed vendor
 * export becomes diagnostics, not an exception. A YAML parser rejects on bad
 * syntax and object code rejects on wrong-shaped fields (`services: 42` →
 * `.map is not a function`, `scopes: 7` → not iterable). These helpers are the
 * single place that turns both into empty/typed data, so every adapter can
 * assume the shapes it declares without re-deriving the defense.
 *
 * The `fuzz.test.ts` properties machine-check this: no adapter may reject on
 * any input. For well-formed input every helper is the identity, so goldens
 * never move.
 */
import { parse as parseYaml } from "yaml";
import type { GatewayDiagnostic } from "./model.js";

export interface ParsedGatewayDocument {
  document?: Record<string, unknown>;
  diagnostics: GatewayDiagnostic[];
}

/**
 * Parse a vendor export as a root object while preserving why parsing failed.
 * Adapters still validate their own vendor-specific root collection; this
 * helper prevents syntax errors, blank files, arrays, and scalars from quietly
 * collapsing to an empty estate.
 */
export function parseGatewayDocument(
  text: string,
  vendor: string,
  origin: string,
): ParsedGatewayDocument {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    return {
      diagnostics: [
        {
          level: "error",
          code: `${vendor}/unparseable_export`,
          message: `Could not parse ${vendor} gateway export: ${String(err)}`,
          coordinate: { origin },
        },
      ],
    };
  }
  if (parsed === undefined || parsed === null || String(text).trim().length === 0) {
    return {
      diagnostics: [
        {
          level: "error",
          code: `${vendor}/empty_export`,
          message: `The ${vendor} gateway export is empty.`,
          coordinate: { origin },
        },
      ],
    };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      diagnostics: [
        {
          level: "error",
          code: `${vendor}/invalid_export`,
          message: `The ${vendor} gateway export must be a mapping/object.`,
          coordinate: { origin },
        },
      ],
    };
  }
  return { document: parsed as Record<string, unknown>, diagnostics: [] };
}

/** Parse YAML/JSON as data; a syntax error becomes `undefined`, never a throw. */
export function safeParseYaml(text: string): unknown {
  try {
    return parseYaml(text);
  } catch {
    return undefined;
  }
}

/** A non-null, non-array object, or `{}` — safe to read declared fields from. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** An array, or `[]` — safe to `.map`/`.forEach`/`.findIndex` over. */
export function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * The object entries of an array, or `[]` — safe to iterate AND dereference,
 * so `[null]` / `[42]` entries can't throw when a field is read off them. The
 * cast reflects the adapter's declared element type; unexpected extra fields
 * ride along untouched (they surface later as opaque, never silently dropped).
 */
export function asObjects<T = Record<string, unknown>>(value: unknown): T[] {
  return asArray(value).filter((e) => e !== null && typeof e === "object") as T[];
}

/** The string entries of an array, or `[]` — safe to iterate and use as scopes. */
export function asStrings(value: unknown): string[] {
  return asArray(value).filter((e): e is string => typeof e === "string");
}
