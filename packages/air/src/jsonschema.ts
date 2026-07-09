import { propKey } from "./naming.js";
import type { JsonSchema, Operation } from "./schema.js";

/**
 * Build the bounded input JSON Schema for an operation from its AIR params plus
 * the synthesized safety fields (idempotency_key, confirm). This exact schema is
 * shared by the MCP tool `inputSchema`, `cli --schema`, and the skill package —
 * one shape, three surfaces, no drift.
 */
export function operationInputSchema(op: Operation): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const p of op.input.params) {
    const key = propKey(p.name);
    const schema: JsonSchema = { ...p.schema };
    if (p.description && !("description" in schema)) schema.description = p.description;
    if (p.example !== undefined && !("examples" in schema)) schema.examples = [p.example];
    properties[key] = schema;
    if (p.required) required.push(key);
  }

  if (op.idempotency.mode === "required") {
    properties.idempotency_key = {
      type: "string",
      description:
        "Idempotency key. Required — repeating this operation with the same key is safe; a new key is a new operation.",
      minLength: 1,
    };
    required.push("idempotency_key");
  }

  if (op.confirmation.required) {
    properties.confirm = {
      type: "boolean",
      const: true,
      description:
        op.confirmation.reason ??
        "Explicit confirmation. This operation has side effects and will not run without confirm=true.",
    };
    required.push("confirm");
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    title: op.canonicalName,
    description: op.description || op.displayName,
    additionalProperties: false,
    properties,
    required,
  };
}
