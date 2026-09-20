/**
 * GraphQL SDL → OpenAPI 3.0 adapter.
 *
 * Anvil's compiler consumes one internal shape: a dereferenced OpenAPI 3.0
 * document (see parse.ts). Rather than teach normalize/classify/validate a
 * second grammar, every non-REST protocol is *lowered* into that same shape and
 * handed to the identical downstream pipeline. This module lowers a GraphQL
 * schema:
 *
 *   Query.field     → a read operation   (POST + x-anvil-effect: read)
 *   Mutation.field  → a write operation  (POST; conservative — mutation)
 *   Subscription.f  → a read operation   (POST + x-anvil-effect: read; streaming,
 *                                          noted in description)
 *
 * Every GraphQL operation is POST on the wire; the read/write distinction is a
 * property of the operation KIND, not the HTTP method, so it is asserted
 * explicitly via the `x-anvil-effect` vendor extension rather than smuggled
 * through a fake GET (a GET with a required body is un-executable by fetch).
 *
 * A field's arguments become the request body; its return type becomes the
 * response schema. Object/input/enum/union/interface types become
 * `components.schemas` and are referenced with `$ref`, so recursion is resolved
 * by the same dereferencer the OpenAPI path uses. The response schema and the
 * compiled query document are both rendered from one selection tree
 * (`graphql-selection.ts`): where the document stops selecting, the schema
 * stops promising.
 *
 * Parsing is delegated to the reference `graphql` implementation (`buildSchema`
 * + the type predicates); this module only walks the resulting schema and maps
 * its types to JSON Schema.
 */

import type { Diagnostic } from "@anvil/air";
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
import { graphqlWireBinding } from "./graphql-binding.js";
import {
  buildSelection,
  describeCut,
  MAX_SELECTION_DEPTH,
  requiresArguments,
  responseSchemaFor,
  scalarSchema,
  TYPENAME_ONLY_SCHEMA,
  typenameOnlySchema,
} from "./graphql-selection.js";

type JsonSchemaLike = Record<string, unknown>;

/** Map a (possibly wrapped) GraphQL type to a JSON schema. */
function typeToSchema(type: GraphQLType): JsonSchemaLike {
  if (isNonNullType(type)) return typeToSchema(type.ofType);
  if (isListType(type)) return { type: "array", items: typeToSchema(type.ofType) };
  // A named type: scalars inline, everything else is referenced.
  if (isScalarType(type)) return scalarSchema(type.name);
  return { $ref: `#/components/schemas/${type.name}` };
}

/**
 * Object/input/interface → an object schema built from its fields.
 *
 * An output field that takes a required argument is left out, exactly as the
 * compiled document leaves it out (`requiresArguments`): a schema that listed
 * it would promise data no request Anvil sends can return. Input fields have
 * no arguments, so the check is a no-op for them.
 */
function fieldsSchema(
  fields: Record<string, GraphQLField<unknown, unknown> | GraphQLInputField>,
  description?: string | null,
): JsonSchemaLike {
  const properties: Record<string, JsonSchemaLike> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(fields)) {
    if ("args" in field && requiresArguments(field)) continue;
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

function namedTypeSchema(
  schema: GraphQLSchema,
  type: GraphQLNamedType,
): JsonSchemaLike | undefined {
  if (isInterfaceType(type)) {
    // The document selects the interface's fields plus an inline fragment per
    // implementation, so what comes back is one implementation's fields — the
    // component says so. An interface nothing implements is its own fields.
    const implementations = schema.getPossibleTypes(type);
    if (implementations.length === 0) return fieldsSchema(type.getFields(), type.description);
    return {
      oneOf: implementations.map((t) => ({ $ref: `#/components/schemas/${t.name}` })),
      ...(type.description ? { description: type.description } : {}),
    };
  }
  if (isObjectType(type)) {
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

/**
 * How much of a subscription one call observes.
 *
 * Deliberately modest. The window is meant to answer "what is happening right
 * now", which an agent then acts on or re-opens — not to be a substitute for a
 * durable consumer. A generous default would encourage holding a connection for
 * minutes inside a tool call, which is the unbounded case with extra steps.
 * An Anvil manifest can raise either ceiling for an operation that needs it.
 */
const DEFAULT_STREAM_MAX_EVENTS = 100;
const DEFAULT_STREAM_MAX_SECONDS = 30;

interface RootContext {
  schema: GraphQLSchema;
  paths: Record<string, Record<string, unknown>>;
  diagnostics: Diagnostic[] | undefined;
  /** The component cut positions point at; registered only once one exists. */
  typenameOnlyName: string;
  cutsSeen: boolean;
}

/**
 * Two things the lowering loses are stated where they happen, once per
 * operation, because no later stage can recover them from the output: a field
 * omitted for its required arguments, and a position where the selection
 * stopped. Both change what the operation returns, and an operator reading
 * the response schema deserves to know why a field they can see in the SDL is
 * not in it.
 */
function reportSelection(
  ctx: RootContext,
  kind: string,
  path: string,
  fieldName: string,
  selection: ReturnType<typeof buildSelection>,
): void {
  if (selection.omittedRequiredArgs.length > 0) {
    const listed = selection.omittedRequiredArgs;
    ctx.diagnostics?.push({
      level: "warning",
      code: "graphql_field_omitted_required_args",
      path,
      message:
        `Anvil left ${listed.length} field(s) that take required arguments out of GraphQL ${kind} ` +
        `'${fieldName}' — ${listed.join(", ")} — from both the compiled document and the ` +
        `response schema, because selecting one would mean inventing argument values. Expose ` +
        `such a field through a root field of its own, or give its arguments defaults in the SDL.`,
    });
  }
  if (selection.cuts.length > 0) {
    ctx.cutsSeen = true;
    const sample = selection.cuts.slice(0, 5).map(describeCut).join("; ");
    ctx.diagnostics?.push({
      level: "warning",
      code: "graphql_selection_truncated",
      path,
      message:
        `Anvil's compiled document for GraphQL ${kind} '${fieldName}' stops at ` +
        `${selection.cuts.length} position(s) and selects only __typename there: ${sample}` +
        `${selection.cuts.length > 5 ? "; …" : ""}. The selection is bounded to ` +
        `${MAX_SELECTION_DEPTH} levels and never re-enters a type. The response schema marks ` +
        `each such position as '${ctx.typenameOnlyName}' where it is rendered inline; past the ` +
        `inline bound it falls back to the type's component, which describes the type rather ` +
        `than what this position returns.`,
    });
  }
}

function addRoot(
  ctx: RootContext,
  root: GraphQLObjectType | null | undefined,
  kind: "query" | "mutation" | "subscription",
): void {
  if (!root) return;
  for (const [fieldName, field] of Object.entries(root.getFields())) {
    const path = `/graphql/${root.name}/${fieldName}`;
    const reqSchema = argsSchema(field.args);
    // The selection tree is decided once; the query document and the response
    // schema are both projections of it, so neither can promise what the
    // other does not deliver.
    const selection = buildSelection(ctx.schema, field);
    reportSelection(ctx, kind, `${root.name}.${fieldName}`, fieldName, selection);
    const wire = graphqlWireBinding(kind, field, selection);
    // A subscription is observed through a bounded window rather than held
    // open: the call collects events until one of these ceilings and returns
    // them. Without a bound there is no single result, so this contract is
    // exactly what `wireExecutability` requires before it will allow the call.
    const stream =
      kind === "subscription"
        ? {
            transport: "graphql_sse",
            delivery: "at_most_once",
            maxEvents: DEFAULT_STREAM_MAX_EVENTS,
            maxSeconds: DEFAULT_STREAM_MAX_SECONDS,
          }
        : undefined;
    const streaming = kind === "subscription" ? " (bounded subscription window)" : "";
    const op: Record<string, unknown> = {
      operationId: fieldName,
      summary: field.description ?? `GraphQL ${kind} ${fieldName}${streaming}`,
      description: field.description ?? undefined,
      tags: [root.name],
      responses: {
        "200": {
          description: `${fieldName} result`,
          content: {
            "application/json": {
              schema: responseSchemaFor(field, selection, ctx.typenameOnlyName),
            },
          },
        },
      },
      "x-graphql-operation": kind,
      ...(stream ? { "x-anvil-stream": stream } : {}),
      "x-anvil-wire-binding": wire,
      "x-graphql-field": fieldName,
      // Queries/subscriptions are definitionally reads — an adapter assertion
      // classify.ts honors regardless of the (truthful, POST) wire method.
      ...(kind === "mutation" ? {} : { "x-anvil-effect": "read" }),
    };
    if (reqSchema) {
      op.requestBody = {
        required: field.args.some((a) => isNonNullType(a.type) && a.defaultValue === undefined),
        content: { "application/json": { schema: reqSchema } },
      };
    }
    ctx.paths[path] = { post: op };
  }
}

/**
 * Lower a GraphQL SDL string into an OpenAPI 3.0 document (with `$ref`s). The
 * caller dereferences it, so recursion in the schema graph is handled by the
 * same machinery the OpenAPI path relies on.
 */
export function adaptGraphql(
  source: string,
  title = "GraphQL API",
  diagnostics?: Diagnostic[],
): OpenApiDocument {
  // assumeValid: build a partial/example schema without a full type-system
  // validation pass, so a permissive SDL still lowers into a tool surface.
  const schema: GraphQLSchema = buildSchema(source, { assumeValid: true });
  const query = schema.getQueryType();
  const mutation = schema.getMutationType();
  const subscription = schema.getSubscriptionType();

  const ctx: RootContext = {
    schema,
    paths: {},
    diagnostics,
    // A user type could, in principle, carry the stand-in's name; step aside.
    typenameOnlyName: schema.getType(TYPENAME_ONLY_SCHEMA)
      ? `Anvil_${TYPENAME_ONLY_SCHEMA}`
      : TYPENAME_ONLY_SCHEMA,
    cutsSeen: false,
  };
  addRoot(ctx, query, "query");
  addRoot(ctx, mutation, "mutation");
  addRoot(ctx, subscription, "subscription");

  const rootNames = new Set(
    [query, mutation, subscription].filter(Boolean).map((t) => (t as GraphQLObjectType).name),
  );
  const schemas: Record<string, JsonSchemaLike> = {};
  for (const [name, type] of Object.entries(schema.getTypeMap())) {
    if (name.startsWith("__")) continue; // introspection types
    if (rootNames.has(name)) continue; // edge-only root types
    const namedType = getNamedType(type);
    const lowered = namedTypeSchema(schema, namedType);
    if (lowered) schemas[name] = lowered;
  }
  if (ctx.cutsSeen) schemas[ctx.typenameOnlyName] = typenameOnlySchema();

  return {
    openapi: "3.0.3",
    info: { title, version: "1.0.0" },
    paths: ctx.paths,
    components: { schemas: schemas as Record<string, unknown> },
  };
}
