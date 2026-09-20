import {
  agentPropKey,
  bodyEncodingFor,
  type JsonSchema,
  type Param,
  type RequestBody,
  snakeCase,
} from "@anvil/air";
import { materializeSchema } from "./decycle.js";

const SCALAR_TYPES = new Set(["string", "integer", "number", "boolean"]);

/** A body field is flag-projectable when it is a scalar (or an enum of scalars). */
function isScalarField(schema: JsonSchema): boolean {
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf) || Array.isArray(schema.allOf)) {
    return false;
  }
  if (Array.isArray(schema.enum)) return true;
  if (schema.const !== undefined) return true;
  return typeof schema.type === "string" && SCALAR_TYPES.has(schema.type);
}

/**
 * Build the preserved request body plus its surface projection (spec: "preserve
 * the body as a body, derive the CLI projection separately"). The body schema is
 * kept verbatim; a flat object of scalars is additionally projected into
 * per-field flags, while anything richer (nesting, arrays, unions) is surfaced
 * whole so nothing is lost.
 */
export function buildRequestBody(
  content: Record<string, { schema?: JsonSchema }> | undefined,
  required: boolean,
  namedSchemas: Record<string, unknown>,
  params: readonly Param[],
): RequestBody | undefined {
  if (!content) return undefined;
  // One body, one content type. JSON first because it is the wire the whole
  // toolchain speaks best; then any other type the runtime can encode; then the
  // source's first declaration, kept verbatim so the compile diagnostic and the
  // runtime refusal both name the type the source actually declared.
  const declared = Object.keys(content);
  const contentType =
    (content["application/json"] ? "application/json" : undefined) ??
    declared.find((type) => bodyEncodingFor(type) !== undefined) ??
    declared[0] ??
    "application/json";
  const rawSchema = content[contentType]?.schema;
  if (!rawSchema) return undefined;
  // `bundleDocument` (decycle.ts) left named-schema references as `$ref`
  // pointers so the whole spec's schema graph is only ever walked once; this
  // is the one place a body needs its own fields directly inspectable
  // (`.properties`, `.type`), so resolve back to a small, self-contained
  // schema scoped to just this operation before doing anything else with it.
  const schema = materializeSchema(rawSchema, namedSchemas).schema as JsonSchema;

  const props = schema.properties as Record<string, JsonSchema> | undefined;
  const requiredList = (schema.required as string[] | undefined) ?? [];
  const noCompositor =
    !Array.isArray(schema.oneOf) && !Array.isArray(schema.anyOf) && !Array.isArray(schema.allOf);
  const flat =
    schema.type === "object" &&
    props !== undefined &&
    noCompositor &&
    Object.values(props).every(isScalarField);

  // Flattening is only a convenience projection. A path/query/header input
  // and a body field may legitimately share a wire name (e.g. an addressed
  // org unit and its new orgUnitPath). Preserve their independent values by
  // keeping the body envelope whenever flattening would merge agent inputs.
  const paramKeys = new Set(params.map(agentPropKey));
  const fieldKeys = Object.keys(props ?? {}).map(snakeCase);
  const unambiguous =
    new Set(fieldKeys).size === fieldKeys.length && fieldKeys.every((key) => !paramKeys.has(key));
  if (flat && props && unambiguous) {
    return {
      contentType,
      required,
      schema,
      projection: "fields",
      fields: Object.entries(props).map(([name, propSchema]) => ({
        name,
        required: requiredList.includes(name),
        schema: propSchema,
        description: propSchema.description as string | undefined,
      })),
    };
  }
  return { contentType, required, schema, projection: "whole", fields: [] };
}
