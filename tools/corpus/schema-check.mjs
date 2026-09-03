// A minimal, dependency-free JSON Schema (draft-07-ish) checker.
//
// tools/corpus is a plain-Node-ESM, no-build-step directory (see README.md),
// and the workspace carries no ajv dependency — adding one just for a single
// self-authored report shape would be a new dependency for a corpus tool to
// validate its OWN output. This implements the small subset actually used by
// refine-loop.schema.json: type, enum, required, properties,
// additionalProperties, items. It is not a general-purpose validator (no
// $ref, no oneOf/anyOf, no format) — grow it only if a new schema genuinely
// needs a keyword it doesn't support yet; do not silently ignore a keyword a
// schema uses; unsupported keywords throw eagerly at validate() time so a
// schema author never believes a check ran when it did not.

const SUPPORTED_KEYWORDS = new Set([
  "type",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "$ref",
  "$schema",
  "title",
  "description",
  "definitions",
]);

/** Resolve a local `#/definitions/<name>` pointer against the root schema.
 *  Only that one pointer shape is supported — enough for one report schema
 *  to share a repeated sub-shape without duplicating it twice. */
function resolveRef(ref, rootSchema) {
  const m = /^#\/definitions\/([A-Za-z0-9_]+)$/.exec(ref);
  if (!m || !rootSchema.definitions?.[m[1]]) {
    throw new Error(`schema-check: unresolvable $ref '${ref}' — only local '#/definitions/<name>' pointers are supported`);
  }
  return rootSchema.definitions[m[1]];
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(schemaType, value) {
  const actual = typeOf(value);
  if (schemaType === "number") return actual === "number" || actual === "integer";
  return actual === schemaType;
}

function assertSupported(schema, path) {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new Error(`schema-check: unsupported keyword '${key}' at ${path || "<root>"} — extend schema-check.mjs before using it`);
    }
  }
}

/**
 * Validate `value` against `schema`. Returns an array of error strings
 * (empty means valid). Never throws for a validation finding — only for a
 * schema itself using an unsupported keyword, which is a harness bug, not a
 * report defect.
 */
export function validateAgainstSchema(schema, value, path = "", rootSchema = schema) {
  assertSupported(schema, path);
  if (schema.$ref !== undefined) {
    return validateAgainstSchema(resolveRef(schema.$ref, rootSchema), value, path, rootSchema);
  }
  const errors = [];
  const here = path || "<root>";

  if (schema.type !== undefined && !typeMatches(schema.type, value)) {
    errors.push(`${here}: expected type '${schema.type}', got '${typeOf(value)}'`);
    return errors; // further checks would be noise once the type itself is wrong
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${here}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (schema.type === "object" || (schema.type === undefined && typeOf(value) === "object")) {
    if (typeOf(value) === "object") {
      for (const key of schema.required ?? []) {
        if (!(key in value)) errors.push(`${here}: missing required property '${key}'`);
      }
      if (schema.properties) {
        for (const [key, subSchema] of Object.entries(schema.properties)) {
          if (key in value) {
            errors.push(...validateAgainstSchema(subSchema, value[key], `${here}.${key}`, rootSchema));
          }
        }
        if (schema.additionalProperties === false) {
          const allowed = new Set(Object.keys(schema.properties));
          for (const key of Object.keys(value)) {
            if (!allowed.has(key)) errors.push(`${here}: unexpected property '${key}'`);
          }
        }
      }
    }
  }

  if (schema.type === "array" && schema.items && Array.isArray(value)) {
    value.forEach((item, i) => {
      errors.push(...validateAgainstSchema(schema.items, item, `${here}[${i}]`, rootSchema));
    });
  }

  return errors;
}
