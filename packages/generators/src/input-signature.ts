import type { Operation } from "@anvil/air";

/**
 * Generate a compact input signature for an operation.
 *
 * Format: required params first (suffixed with `*`), then optional params,
 * then body fields (as `body.<name>`) when projection is "fields".
 * A `whole`-projection body still lists its top-level schema property names —
 * the projection only governs how the body is *passed* (one `body` value vs
 * per-field flags), not whether the agent deserves to see what goes in it.
 * Capped at 8 entries with `, …` if more.
 * Returns empty string if no inputs.
 *
 * Example: "charge*, amount, reason, body.metadata"
 */
export function operationInputSignature(op: Operation): string {
  const parts: string[] = [];

  // Required params first
  for (const p of op.input.params) {
    if (p.required) {
      parts.push(`${p.name}*`);
    }
  }

  // Optional params
  for (const p of op.input.params) {
    if (!p.required) {
      parts.push(p.name);
    }
  }

  const body = op.input.body;
  if (body?.projection === "fields") {
    for (const f of body.fields) {
      parts.push(`body.${f.name}${f.required ? "*" : ""}`);
    }
  } else if (body) {
    // Whole-projection body: surface top-level property names from the
    // preserved schema so rich create/update bodies aren't a blank signature.
    // Required fields first, mirroring the params ordering above.
    const schema = body.schema as { properties?: Record<string, unknown>; required?: unknown };
    const names = Object.keys(schema.properties ?? {});
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    for (const name of names.filter((n) => required.has(n))) {
      parts.push(`body.${name}*`);
    }
    for (const name of names.filter((n) => !required.has(n))) {
      parts.push(`body.${name}`);
    }
  }

  // Cap at 8 entries with ellipsis
  if (parts.length > 8) {
    return `${parts.slice(0, 8).join(", ")}, …`;
  }

  return parts.join(", ");
}
