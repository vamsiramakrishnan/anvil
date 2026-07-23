import {
  isModeledIdempotencyCarrierInput,
  resolveIdempotencyCarrier,
} from "./idempotency-carrier.js";
import { propKey } from "./naming.js";
import type { JsonSchema, Operation } from "./schema.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function removeValueAtPath(value: unknown, path: readonly string[]): void {
  if (!isRecord(value)) return;
  let current = value;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (!isRecord(next)) return;
    current = next;
  }
  delete current[path[path.length - 1] as string];
}

/**
 * Project a whole source body onto the agent input surface without asking for a
 * runtime-owned idempotency coordinate twice. The source schema on AIR remains
 * untouched and still validates the actual upstream wire body after injection.
 */
function surfaceBodySchema(schema: JsonSchema, path: readonly string[] | undefined): JsonSchema {
  const projected = structuredClone(schema);
  if (!path || path.length === 0) return projected;

  let current: JsonSchema = projected;
  for (let index = 0; index < path.length; index += 1) {
    const remaining = path.slice(index);
    removeValueAtPath(current.example, remaining);
    if (Array.isArray(current.examples)) {
      for (const example of current.examples) removeValueAtPath(example, remaining);
    }
    if (index === path.length - 1) break;

    const segment = path[index] as string;
    const properties = current?.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties))
      return projected;
    const next = (properties as Record<string, unknown>)[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) return projected;
    current = next as JsonSchema;
  }
  const leaf = path[path.length - 1] as string;
  const properties = current?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return projected;
  delete (properties as Record<string, unknown>)[leaf];
  if (Array.isArray(current.required)) {
    current.required = current.required.filter((name) => name !== leaf);
  }
  return projected;
}

/**
 * Build the bounded input JSON Schema for an operation from its AIR params plus
 * the synthesized safety fields (idempotency_key, confirm). This exact schema is
 * shared by the MCP tool `inputSchema`, `cli --schema`, and the skill package —
 * one shape, three surfaces, no drift.
 */
export function operationInputSchema(op: Operation): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const carrier = resolveIdempotencyCarrier(op);
  const binding = carrier.ok ? carrier.binding : undefined;

  for (const p of op.input.params) {
    if (isModeledIdempotencyCarrierInput(binding, p.in, p.name)) continue;
    const key = propKey(p.name);
    const schema: JsonSchema = { ...p.schema };
    if (p.description && !("description" in schema)) schema.description = p.description;
    if (p.example !== undefined && !("examples" in schema)) schema.examples = [p.example];
    properties[key] = schema;
    if (p.required) required.push(key);
  }

  // The body is projected onto the input surface without losing its schema:
  // a flat object becomes one property per field; anything richer stays whole
  // under a single `body` property carrying the verbatim schema.
  const body = op.input.body;
  if (body) {
    if (body.projection === "fields") {
      for (const f of body.fields) {
        if (isModeledIdempotencyCarrierInput(binding, "body", f.name)) continue;
        const key = propKey(f.name);
        const schema: JsonSchema = { ...f.schema };
        if (f.description && !("description" in schema)) schema.description = f.description;
        properties[key] = schema;
        if (f.required) required.push(key);
      }
    } else {
      const carrierPath =
        binding?.mechanism === "body" && body.projection === "whole" ? binding.path : undefined;
      properties.body = {
        ...surfaceBodySchema(body.schema, carrierPath),
        description:
          (body.schema.description as string | undefined) ??
          "The request body. Provide the full object; its structure is preserved from the source schema.",
      };
      if (body.required) required.push("body");
    }
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
