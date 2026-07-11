import { createHash } from "node:crypto";
import { AirDocument } from "./schema.js";

/**
 * Content-derived identity of an AIR contract. Lives in @anvil/air so both the
 * refinement layer (readiness assessments) and the generators (capability
 * bundles) can stamp the same hash for the same contract without either
 * depending on the other.
 */

/** Recursively sort object keys so hashing is independent of insertion order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** sha256 hex of the canonical (key-sorted) JSON of a value. */
export function hashCanonical(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

/**
 * The hash of an AIR document's *contract*: the normalized document minus its
 * diagnostics. Diagnostics are compiler commentary about the contract, not part
 * of it — excluding them means re-linting cannot change what artifacts and
 * assessments claim to be bound to. Normalizing through the schema first makes
 * the hash independent of which optional defaults a caller happened to spell out.
 */
export function contractHash(air: AirDocument): string {
  return hashCanonical({ ...AirDocument.parse(air), diagnostics: undefined });
}
