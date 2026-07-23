import type { IdempotencyMode, ParamLocation } from "./enums.js";
import type { JsonSchema, Operation } from "./schema.js";

const KEYED_MODES = new Set<IdempotencyMode>(["required", "key_supported"]);
const HTTP_FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const RUNTIME_OWNED_HEADERS = new Set([
  "accept",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "expect",
  "host",
  "proxy-authorization",
  "transfer-encoding",
]);

export type IdempotencyCarrierBinding =
  | { mechanism: "header"; key: string }
  | { mechanism: "query"; key: string }
  | { mechanism: "path"; key: string }
  | { mechanism: "body"; key: string; path: string[] };

export type IdempotencyCarrierResolution =
  | { ok: true; binding?: IdempotencyCarrierBinding }
  | { ok: false; issue: string };

/** Whether this idempotency mode relies on an upstream request key. */
export function idempotencyModeUsesCarrier(mode: IdempotencyMode): boolean {
  return KEYED_MODES.has(mode);
}

function schemaAcceptsString(schema: JsonSchema | undefined): boolean {
  if (!schema) return false;
  if (schema.type === "string") return true;
  if (Array.isArray(schema.type) && schema.type.includes("string")) return true;
  if (typeof schema.const === "string") return true;
  return (
    Array.isArray(schema.enum) &&
    schema.enum.length > 0 &&
    schema.enum.every((v) => typeof v === "string")
  );
}

function decodeBodyPath(key: string): string[] | undefined {
  if (!key.startsWith("/")) return key.length > 0 ? [key] : undefined;
  const segments = key
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  return segments.length > 0 && segments.every((segment) => segment.length > 0)
    ? segments
    : undefined;
}

function schemaAtPath(schema: JsonSchema, path: readonly string[]): JsonSchema | undefined {
  let current: JsonSchema | undefined = schema;
  for (const segment of path) {
    const properties = current?.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties))
      return undefined;
    const next = (properties as Record<string, unknown>)[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) return undefined;
    current = next as JsonSchema;
  }
  return current;
}

/**
 * Resolve the exact on-wire idempotency carrier an executor may safely inject.
 *
 * Header carriers are explicit manifest policy, so a valid, non-reserved field
 * name is sufficient. Query/path/body carriers additionally have to exist in
 * the imported request contract; otherwise Anvil would be inventing a request
 * coordinate and falsely claiming retries are deduplicated upstream.
 */
export function resolveIdempotencyCarrier(op: Operation): IdempotencyCarrierResolution {
  if (!idempotencyModeUsesCarrier(op.idempotency.mode)) return { ok: true };

  const mechanism = op.idempotency.mechanism;
  const key = op.idempotency.key?.trim();
  if (mechanism === "none") {
    return {
      ok: false,
      issue: `idempotency mode '${op.idempotency.mode}' requires an explicit carrier mechanism`,
    };
  }
  if (!key) {
    return {
      ok: false,
      issue: `idempotency carrier '${mechanism}' requires an exact non-empty key name`,
    };
  }

  if (mechanism === "header") {
    if (!HTTP_FIELD_NAME.test(key)) {
      return { ok: false, issue: `idempotency header '${key}' is not a valid HTTP field name` };
    }
    if (RUNTIME_OWNED_HEADERS.has(key.toLowerCase())) {
      return {
        ok: false,
        issue: `idempotency header '${key}' is owned by the HTTP/auth runtime and cannot carry a key`,
      };
    }
    return { ok: true, binding: { mechanism, key } };
  }

  if (mechanism === "query" || mechanism === "path") {
    const parameter = op.input.params.find((candidate) => {
      if (candidate.in !== mechanism) return false;
      return mechanism === "query"
        ? candidate.name === key
        : candidate.name === key && (op.sourceRef.path ?? "").includes(`{${candidate.name}}`);
    });
    if (!parameter) {
      return {
        ok: false,
        issue:
          mechanism === "query"
            ? `idempotency query parameter '${key}' is not declared by the source operation`
            : `idempotency path parameter '${key}' is not declared in the source path template`,
      };
    }
    if (!schemaAcceptsString(parameter.schema)) {
      return {
        ok: false,
        issue: `idempotency ${mechanism} parameter '${key}' is not modeled as a string`,
      };
    }
    return { ok: true, binding: { mechanism, key } };
  }

  const path = decodeBodyPath(key);
  if (!path) {
    return {
      ok: false,
      issue: `idempotency body field '${key}' is not a valid field name or JSON Pointer`,
    };
  }

  const legacy = op.input.params.find(
    (candidate) => candidate.in === "body" && path.length === 1 && candidate.name === path[0],
  );
  if (legacy) {
    if (!schemaAcceptsString(legacy.schema)) {
      return {
        ok: false,
        issue: `idempotency body field '${key}' is not modeled as a string`,
      };
    }
    return { ok: true, binding: { mechanism, key, path } };
  }

  const body = op.input.body;
  const mediaType = body?.contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (!body || (mediaType !== "application/json" && !mediaType?.endsWith("+json"))) {
    return {
      ok: false,
      issue: `idempotency body field '${key}' requires a modeled JSON request body`,
    };
  }
  const fieldSchema = schemaAtPath(body.schema, path);
  if (!fieldSchema) {
    return {
      ok: false,
      issue: `idempotency body field '${key}' is not declared by the source request schema`,
    };
  }
  if (!schemaAcceptsString(fieldSchema)) {
    return {
      ok: false,
      issue: `idempotency body field '${key}' is not modeled as a string`,
    };
  }
  return { ok: true, binding: { mechanism, key, path } };
}

/** True when a normal AIR input coordinate is replaced by `idempotency_key`. */
export function isModeledIdempotencyCarrierInput(
  binding: IdempotencyCarrierBinding | undefined,
  location: ParamLocation,
  name: string,
): boolean {
  if (!binding || binding.mechanism !== location) return false;
  if (binding.mechanism === "body") {
    return binding.path.length === 1 && binding.path[0] === name;
  }
  return binding.mechanism === "header"
    ? binding.key.toLowerCase() === name.toLowerCase()
    : binding.key === name;
}
