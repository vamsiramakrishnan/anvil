/**
 * GraphQL SDL → OpenAPI 3.0 adapter.
 *
 * Anvil's compiler consumes one internal shape: a dereferenced OpenAPI 3.0
 * document (see parse.ts). Rather than teach normalize/classify/validate a
 * second grammar, every non-REST protocol is *lowered* into that same shape and
 * handed to the identical downstream pipeline. This module lowers a GraphQL
 * schema:
 *
 *   Query.field     → a read operation   (GET; no side effect)
 *   Mutation.field  → a write operation  (POST; conservative — mutation)
 *   Subscription.f  → a read operation   (GET; streaming, noted in description)
 *
 * A field's arguments become the request body; its return type becomes the
 * response schema. Object/input/enum/union types become `components.schemas`
 * and are referenced with `$ref`, so recursion is resolved by the same
 * dereferencer the OpenAPI path uses.
 *
 * Parsing is delegated to the reference `graphql` implementation (`buildSchema`
 * + the type predicates); this module only walks the resulting schema and maps
 * its types to JSON Schema.
 */
import {
  buildSchema,
  type GraphQLArgument,
  type GraphQLField,
  type GraphQLInputField,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLSchema,
  type GraphQLType,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
} from "graphql";
import type { OpenApiDocument } from "../parse.js";

type JsonSchemaLike = Record<string, unknown>;

const BUILTIN_SCALARS: Record<string, JsonSchemaLike> = {
  Int: { type: "integer" },
  Float: { type: "number" },
  String: { type: "string" },
  Boolean: { type: "boolean" },
  ID: { type: "string", description: "GraphQL ID" },
};

function scalarSchema(name: string): JsonSchemaLike {
  if (BUILTIN_SCALARS[name]) return { ...BUILTIN_SCALARS[name] };
  return { type: "string", description: `custom scalar ${name}` };
}

/** Map a (possibly wrapped) GraphQL type to a JSON schema. */
function typeToSchema(type: GraphQLType): JsonSchemaLike {
  if (isNonNullType(type)) return typeToSchema(type.ofType);
  if (isListType(type)) return { type: "array", items: typeToSchema(type.ofType) };
  // A named type: scalars inline, everything else is referenced.
  if (isScalarType(type)) return scalarSchema(type.name);
  return { $ref: `#/components/schemas/${type.name}` };
}

/** Object/input/interface → an object schema built from its fields. */
function fieldsSchema(
  fields: Record<string, GraphQLField<unknown, unknown> | GraphQLInputField>,
  description?: string | null,
): JsonSchemaLike {
  const properties: Record<string, JsonSchemaLike> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(fields)) {
    const schema = typeToSchema(field.type);
    if (field.description) schema.description = field.description;
    properties[name] = schema;
    if (isNonNullType(field.type)) required.push(name);
  }
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    ...(description ? { description } : {}),
  };
}

function namedTypeSchema(type: GraphQLNamedType): JsonSchemaLike | undefined {
  if (isObjectType(type) || isInterfaceType(type)) {
    return fieldsSchema(type.getFields(), type.description);
  }
  if (isInputObjectType(type)) {
    return fieldsSchema(type.getFields(), type.description);
  }
  if (isEnumType(type)) {
    return {
      type: "string",
      enum: type.getValues().map((v) => v.name),
      ...(type.description ? { description: type.description } : {}),
    };
  }
  if (isUnionType(type)) {
    return {
      oneOf: type.getTypes().map((t) => ({ $ref: `#/components/schemas/${t.name}` })),
      ...(type.description ? { description: type.description } : {}),
    };
  }
  return undefined; // scalars are inlined at reference sites
}

/** Build the request-body schema for a field's arguments. */
function argsSchema(args: readonly GraphQLArgument[]): JsonSchemaLike | undefined {
  if (args.length === 0) return undefined;
  const properties: Record<string, JsonSchemaLike> = {};
  const required: string[] = [];
  for (const arg of args) {
    const schema = typeToSchema(arg.type);
    if (arg.description) schema.description = arg.description;
    properties[arg.name] = schema;
    if (isNonNullType(arg.type) && arg.defaultValue === undefined) required.push(arg.name);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function addRoot(
  paths: Record<string, Record<string, unknown>>,
  root: GraphQLObjectType | null | undefined,
  kind: "query" | "mutation" | "subscription",
): void {
  if (!root) return;
  const httpMethod = kind === "mutation" ? "post" : "get";
  for (const [fieldName, field] of Object.entries(root.getFields())) {
    const path = `/graphql/${root.name}/${fieldName}`;
    const reqSchema = argsSchema(field.args);
    const streaming = kind === "subscription" ? " (streaming subscription)" : "";
    const op: Record<string, unknown> = {
      operationId: fieldName,
      summary: field.description ?? `GraphQL ${kind} ${fieldName}${streaming}`,
      description: field.description ?? undefined,
      tags: [root.name],
      responses: {
        "200": {
          description: `${fieldName} result`,
          content: { "application/json": { schema: typeToSchema(field.type) } },
        },
      },
      "x-graphql-operation": kind,
      "x-graphql-field": fieldName,
    };
    if (reqSchema) {
      op.requestBody = {
        required: field.args.some((a) => isNonNullType(a.type) && a.defaultValue === undefined),
        content: { "application/json": { schema: reqSchema } },
      };
    }
    paths[path] = { [httpMethod]: op };
  }
}

/**
 * Lower a GraphQL SDL string into an OpenAPI 3.0 document (with `$ref`s). The
 * caller dereferences it, so recursion in the schema graph is handled by the
 * same machinery the OpenAPI path relies on.
 */
export function adaptGraphql(source: string, title = "GraphQL API"): OpenApiDocument {
  // assumeValid: build a partial/example schema without a full type-system
  // validation pass, so a permissive SDL still lowers into a tool surface.
  const schema: GraphQLSchema = buildSchema(source, { assumeValid: true });
  const query = schema.getQueryType();
  const mutation = schema.getMutationType();
  const subscription = schema.getSubscriptionType();

  const paths: Record<string, Record<string, unknown>> = {};
  addRoot(paths, query, "query");
  addRoot(paths, mutation, "mutation");
  addRoot(paths, subscription, "subscription");

  const rootNames = new Set(
    [query, mutation, subscription].filter(Boolean).map((t) => (t as GraphQLObjectType).name),
  );
  const schemas: Record<string, JsonSchemaLike> = {};
  for (const [name, type] of Object.entries(schema.getTypeMap())) {
    if (name.startsWith("__")) continue; // introspection types
    if (rootNames.has(name)) continue; // edge-only root types
    const namedType = getNamedType(type);
    const lowered = namedTypeSchema(namedType);
    if (lowered) schemas[name] = lowered;
  }

  return {
    openapi: "3.0.3",
    info: { title, version: "1.0.0" },
    paths,
    components: { schemas: schemas as Record<string, unknown> },
  };
}
