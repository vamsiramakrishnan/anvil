import { z } from "zod";
import type { ParamLocation } from "./enums.js";
import {
  type IdempotencyCarrierBinding,
  idempotencyModeUsesCarrier,
  isModeledIdempotencyCarrierInput,
  resolveIdempotencyCarrier,
} from "./idempotency-carrier.js";
import { cliFlag, propKey } from "./naming.js";
import type { JsonSchema, Operation } from "./schema.js";

const PORTABLE_IDEMPOTENCY_KEY_SCHEMA: JsonSchema = {
  type: "string",
  minLength: 1,
  // Every upstream carrier shares one portable key contract. Visible ASCII
  // keeps header/query/body transport semantics aligned; with that alphabet,
  // JSON Schema's character bound is also the runtime's UTF-8 byte bound.
  maxLength: 255,
  pattern: "^[\\u0021-\\u007E]+$",
};

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

function businessInputKeys(
  op: Operation,
  binding: IdempotencyCarrierBinding | undefined,
): Set<string> {
  const occupied = new Set<string>();
  for (const parameter of op.input.params) {
    if (!isModeledIdempotencyCarrierInput(binding, parameter.in, parameter.name)) {
      occupied.add(propKey(parameter.name));
    }
  }
  if (op.input.body?.projection === "fields") {
    for (const field of op.input.body.fields) {
      if (!isModeledIdempotencyCarrierInput(binding, "body", field.name)) {
        occupied.add(propKey(field.name));
      }
    }
  } else if (op.input.body) {
    occupied.add("body");
  }
  return occupied;
}

function allocateSafetyKey(occupied: Set<string>, preferred: string): string {
  if (!occupied.has(preferred)) {
    occupied.add(preferred);
    return preferred;
  }
  const namespaced = `anvil_${preferred}`;
  if (!occupied.has(namespaced)) {
    occupied.add(namespaced);
    return namespaced;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${namespaced}_${suffix}`;
    if (!occupied.has(candidate)) {
      occupied.add(candidate);
      return candidate;
    }
  }
}

/**
 * Public safety-property coordinates. The familiar names remain stable for the
 * normal case; a real source field with the same normalized name is preserved
 * and the Anvil control moves to a deterministic namespaced property.
 */
export function operationSafetyInputKeys(op: Operation): {
  confirm: string;
  idempotencyKey: string;
} {
  const carrier = resolveIdempotencyCarrier(op);
  const binding = carrier.ok ? carrier.binding : undefined;
  const occupied = businessInputKeys(op, binding);
  const idempotencyKey = idempotencyModeUsesCarrier(op.idempotency.mode)
    ? allocateSafetyKey(occupied, "idempotency_key")
    : "idempotency_key";
  const confirm = op.confirmation.required ? allocateSafetyKey(occupied, "confirm") : "confirm";
  return { confirm, idempotencyKey };
}

/**
 * CLI coordinate for a real source input. Engine safety keeps the familiar
 * `--confirm` / `--idempotency-key`; a business field with either spelling is
 * made reachable through a deterministic `--input-*` flag. This belongs beside
 * the public safety-key allocator so every CLI driver projects collisions the
 * same way as the generated CLI itself.
 */
export function operationBusinessInputCliFlag(
  op: Operation,
  location: ParamLocation,
  name: string,
): string | undefined {
  const resolution = resolveIdempotencyCarrier(op);
  const binding = resolution.ok ? resolution.binding : undefined;
  if (isModeledIdempotencyCarrierInput(binding, location, name)) return undefined;

  const base = cliFlag(name).slice(2);
  const reserved =
    base === "confirm" ||
    (base === "idempotency-key" && idempotencyModeUsesCarrier(op.idempotency.mode));
  if (!reserved) return `--${base}`;

  const occupied = new Set<string>();
  for (const parameter of op.input.params) {
    if (!isModeledIdempotencyCarrierInput(binding, parameter.in, parameter.name)) {
      occupied.add(cliFlag(parameter.name).slice(2));
    }
  }
  if (op.input.body?.projection === "fields") {
    for (const field of op.input.body.fields) {
      if (!isModeledIdempotencyCarrierInput(binding, "body", field.name)) {
        occupied.add(cliFlag(field.name).slice(2));
      }
    }
  }
  let candidate = `input-${base}`;
  while (occupied.has(candidate)) candidate = `anvil-${candidate}`;
  return `--${candidate}`;
}

function carrierHasMaterialStringConstraints(schema: JsonSchema | undefined): boolean {
  if (!schema) return false;
  return Object.keys(schema).some(
    (key) =>
      !new Set([
        "type",
        "title",
        "description",
        "default",
        "example",
        "examples",
        "deprecated",
        "readOnly",
        "writeOnly",
      ]).has(key),
  );
}

/** Exact public/runtime key schema: portable transport rules ∩ source carrier. */
export function operationIdempotencyKeySchema(op: Operation): JsonSchema {
  const resolution = resolveIdempotencyCarrier(op);
  const source = resolution.ok ? resolution.binding?.schema : undefined;
  if (!carrierHasMaterialStringConstraints(source)) {
    return { ...PORTABLE_IDEMPOTENCY_KEY_SCHEMA };
  }
  return {
    allOf: [structuredClone(source), { ...PORTABLE_IDEMPOTENCY_KEY_SCHEMA }],
  };
}

/** Runtime guard for embedders that do not pass through CLI/MCP validation. */
export function idempotencyKeyMatchesOperation(op: Operation, key: string): boolean {
  try {
    const validator = z.fromJSONSchema(
      operationIdempotencyKeySchema(op) as Parameters<typeof z.fromJSONSchema>[0],
    );
    return validator.safeParse(key).success;
  } catch {
    return false;
  }
}

/** Compiler-facing proof that the advertised carrier intersection is executable. */
export function operationIdempotencyKeySchemaIssue(op: Operation): string | undefined {
  if (!idempotencyModeUsesCarrier(op.idempotency.mode)) return undefined;
  try {
    z.fromJSONSchema(operationIdempotencyKeySchema(op) as Parameters<typeof z.fromJSONSchema>[0]);
    return undefined;
  } catch {
    return "the modeled carrier schema cannot be enforced by the generated runtime";
  }
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
  const safetyKeys = operationSafetyInputKeys(op);

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

  if (idempotencyModeUsesCarrier(op.idempotency.mode)) {
    const canDeriveKey = op.idempotency.keyDerivation === "request_fingerprint";
    properties[safetyKeys.idempotencyKey] = {
      ...operationIdempotencyKeySchema(op),
      description:
        op.idempotency.mode === "required" && !canDeriveKey
          ? "Idempotency key. Required — repeating this operation with the same key is safe; a new key is a new operation."
          : "Optional explicit idempotency key. When omitted, Anvil derives a deterministic request-fingerprint key; an explicit business-operation key is easier to audit and reuse deliberately.",
    };
    if (op.idempotency.mode === "required" && !canDeriveKey) {
      required.push(safetyKeys.idempotencyKey);
    }
  }

  if (op.confirmation.required) {
    properties[safetyKeys.confirm] = {
      type: "boolean",
      const: true,
      description:
        op.confirmation.reason ??
        "Explicit confirmation. This operation has side effects and will not run without confirm=true.",
    };
    required.push(safetyKeys.confirm);
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
