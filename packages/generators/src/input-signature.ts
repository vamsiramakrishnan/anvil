import type { Operation } from "@anvil/air";

/**
 * Generate a compact input signature for an operation.
 *
 * Format: required params first (suffixed with `*`), then optional params,
 * then body fields (as `body.<name>`) when projection is "fields".
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

  // Body fields (when projection is "fields")
  const body = op.input.body;
  if (body?.projection === "fields") {
    for (const f of body.fields) {
      parts.push(`body.${f.name}${f.required ? "*" : ""}`);
    }
  }

  // Cap at 8 entries with ellipsis
  if (parts.length > 8) {
    return `${parts.slice(0, 8).join(", ")}, …`;
  }

  return parts.join(", ");
}
