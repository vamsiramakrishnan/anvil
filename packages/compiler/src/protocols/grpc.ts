/**
 * Protocol Buffers (proto3) → OpenAPI 3.0 adapter for gRPC services.
 *
 * Each `rpc` in a `service` becomes one operation, lowered to POST — the
 * truthful wire method for every gRPC call. gRPC has no read/write verb of its
 * own, so effect is inferred conservatively from the method name: the
 * canonical read prefixes (Get/List/Watch/Search/Lookup/Query/Fetch/Read/…)
 * assert `x-anvil-effect: read`, everything else stays a mutation (treated as
 * unsafe until enriched). The request message becomes the body, the response
 * message the output schema, and every `message`/`enum` becomes a
 * `components.schemas` entry referenced by `$ref` — recursion is resolved by
 * the shared dereferencer.
 *
 * Parsing is delegated to `protobufjs` (`protobuf.parse`), which yields a
 * reflection tree covering the full proto3 grammar (nested types, `repeated`,
 * `map<>`, `oneof`, `stream`, options, imports). We walk that tree *without*
 * `resolveAll`, so an unresolved well-known import (e.g.
 * `google.protobuf.Timestamp`) degrades gracefully instead of throwing.
 */
import protobuf from "protobufjs";
import type { OpenApiDocument } from "../parse.js";

type JsonSchemaLike = Record<string, unknown>;

const SCALAR_TO_SCHEMA: Record<string, JsonSchemaLike> = {
  double: { type: "number" },
  float: { type: "number" },
  int32: { type: "integer", format: "int32" },
  int64: { type: "string", format: "int64" },
  uint32: { type: "integer", format: "int32" },
  uint64: { type: "string", format: "uint64" },
  sint32: { type: "integer", format: "int32" },
  sint64: { type: "string", format: "int64" },
  fixed32: { type: "integer", format: "int32" },
  fixed64: { type: "string", format: "uint64" },
  sfixed32: { type: "integer", format: "int32" },
  sfixed64: { type: "string", format: "int64" },
  bool: { type: "boolean" },
  string: { type: "string" },
  bytes: { type: "string", format: "byte" },
};

const READ_RPC =
  /^(get|list|watch|search|lookup|query|fetch|read|describe|count|stream|export|scan)/i;

/** Everything the walk gathers from the reflection tree. */
interface Collected {
  messages: protobuf.Type[];
  enums: protobuf.Enum[];
  services: protobuf.Service[];
  /** Reference string (simple or fully-qualified) → schema component key. */
  index: Map<string, string>;
  keyOf: Map<protobuf.ReflectionObject, string>;
}

function stripLeadingDot(name: string): string {
  return name.startsWith(".") ? name.slice(1) : name;
}

function localName(qualified: string): string {
  const parts = stripLeadingDot(qualified).split(".");
  return parts[parts.length - 1] as string;
}

/** Recursively collect messages/enums/services and assign stable schema keys. */
function collect(root: protobuf.NamespaceBase): Collected {
  const c: Collected = {
    messages: [],
    enums: [],
    services: [],
    index: new Map(),
    keyOf: new Map(),
  };
  const usedKeys = new Set<string>();

  const assignKey = (obj: protobuf.Type | protobuf.Enum): string => {
    // Prefer the simple name; disambiguate collisions with the qualified name.
    let key = obj.name;
    if (usedKeys.has(key)) key = stripLeadingDot(obj.fullName).split(".").join("_");
    usedKeys.add(key);
    c.keyOf.set(obj, key);
    c.index.set(obj.name, key);
    c.index.set(stripLeadingDot(obj.fullName), key);
    return key;
  };

  const walk = (ns: protobuf.NamespaceBase): void => {
    for (const obj of ns.nestedArray) {
      if (obj instanceof protobuf.Type) {
        assignKey(obj);
        c.messages.push(obj);
        walk(obj); // nested types/enums
      } else if (obj instanceof protobuf.Enum) {
        assignKey(obj);
        c.enums.push(obj);
      } else if (obj instanceof protobuf.Service) {
        c.services.push(obj);
      } else if (obj instanceof protobuf.Namespace) {
        walk(obj);
      }
    }
  };
  walk(root);
  return c;
}

/** Resolve a proto type name (scalar, message/enum ref, or well-known) to a schema. */
function typeToSchema(typeName: string, c: Collected): JsonSchemaLike {
  const scalar = SCALAR_TO_SCHEMA[typeName];
  if (scalar) return { ...scalar };
  const key = c.index.get(stripLeadingDot(typeName)) ?? c.index.get(localName(typeName));
  if (key) return { $ref: `#/components/schemas/${key}` };
  // Unresolved (e.g. a google.protobuf well-known type not imported) — degrade.
  if (/Timestamp$/.test(typeName)) return { type: "string", format: "date-time" };
  if (/Duration$/.test(typeName)) return { type: "string" };
  if (/(Struct|Value|Any)$/.test(typeName)) return { type: "object" };
  return { type: "string" };
}

/**
 * Resolve an RPC's request/response message type. Unlike a field type, a
 * method's payload is a *message* by grammar, so an unresolved import degrades
 * to a permissive object (all fields unknown, hence all optional — JSON
 * transcoding carries a message as a JSON object and `{}` must stay valid),
 * never to a scalar the wire could not carry.
 */
function rpcMessageSchema(typeName: string, c: Collected): JsonSchemaLike {
  const schema = typeToSchema(typeName, c);
  return schema.$ref !== undefined || schema.type === "object" ? schema : { type: "object" };
}

function fieldSchema(field: protobuf.Field, c: Collected): JsonSchemaLike {
  if (field instanceof protobuf.MapField) {
    return { type: "object", additionalProperties: typeToSchema(field.type, c) };
  }
  const base = typeToSchema(field.type, c);
  return field.repeated ? { type: "array", items: base } : base;
}

function messageSchema(message: protobuf.Type, c: Collected): JsonSchemaLike {
  const properties: Record<string, JsonSchemaLike> = {};
  for (const field of message.fieldsArray) properties[field.name] = fieldSchema(field, c);
  return { type: "object", properties };
}

/**
 * Resolve a proto `import "path"` to the imported file's text, or undefined if
 * it isn't available (a well-known type, or simply not provided). Real services
 * split their request/response messages across files — Temporal's
 * `WorkflowService` methods take `StartWorkflowExecutionRequest` etc. from a
 * sibling `request_response.proto` — so without this the bodies compile to an
 * opaque stub. Mirrors how the OpenAPI path resolves multi-file `$ref`s from the
 * snapshot: same-snapshot bytes only, never an ambient host path or the network.
 */
export type ProtoImportResolver = (importPath: string) => string | undefined;

/**
 * Lower a proto3 source into an OpenAPI 3.0 document (with `$ref`s), to be
 * dereferenced by the caller. When `resolveImport` is given, `import`ed files
 * are loaded into the same protobuf root (transitively) so cross-file message
 * types resolve to their real fields; an import that can't be resolved degrades
 * gracefully (its types stay unresolved) exactly as a missing well-known type
 * does. Single-file callers pass no resolver and get the original behaviour.
 */
export function adaptProto(
  source: string,
  title?: string,
  resolveImport?: ProtoImportResolver,
): OpenApiDocument {
  let root: protobuf.Root;
  let pkg: string | undefined;
  if (resolveImport) {
    root = new protobuf.Root();
    const seen = new Set<string>();
    const load = (text: string): void => {
      const parsed = protobuf.parse(text, root, { keepCase: true });
      pkg = pkg ?? parsed.package ?? undefined;
      for (const imp of [...(parsed.imports ?? []), ...(parsed.weakImports ?? [])]) {
        if (seen.has(imp)) continue;
        seen.add(imp);
        const importedText = resolveImport(imp);
        if (importedText !== undefined) load(importedText);
      }
    };
    load(source);
    // Best-effort: a remaining unresolved import (a well-known type, or one not
    // provided) must degrade, not throw — same contract as the single-file path.
    try {
      root.resolveAll();
    } catch {
      /* leave unresolved types as-is; typeToSchema handles them */
    }
  } else {
    ({ root, package: pkg } = protobuf.parse(source, { keepCase: true }));
  }
  const c = collect(root);

  const schemas: Record<string, JsonSchemaLike> = {};
  for (const message of c.messages)
    schemas[c.keyOf.get(message) as string] = messageSchema(message, c);
  for (const en of c.enums) {
    schemas[c.keyOf.get(en) as string] = { type: "string", enum: Object.keys(en.values) };
  }

  const paths: Record<string, Record<string, unknown>> = {};
  for (const service of c.services) {
    const serviceFqn = stripLeadingDot(service.fullName);
    for (const method of service.methodsArray) {
      // Every gRPC call is POST on the wire (HTTP/2 POST per the gRPC spec);
      // the read/write distinction is asserted explicitly via `x-anvil-effect`
      // instead of a fake GET, which cannot carry the required request body.
      const read = READ_RPC.test(method.name);
      // gRPC wire path is /package.Service/Method — used verbatim as the AIR path.
      const path = `/${serviceFqn}/${method.name}`;
      const streaming =
        method.requestStream || method.responseStream
          ? ` (${method.requestStream ? "client" : ""}${method.requestStream && method.responseStream ? "+" : ""}${method.responseStream ? "server" : ""} streaming)`
          : "";
      const op: Record<string, unknown> = {
        operationId: method.name,
        summary: `${service.name}.${method.name}${streaming}`,
        tags: [service.name],
        responses: {
          "200": {
            description: `${method.name} response`,
            content: { "application/json": { schema: rpcMessageSchema(method.responseType, c) } },
          },
        },
        "x-grpc-service": serviceFqn,
        "x-grpc-method": method.name,
        "x-grpc-streaming": streaming.trim() || undefined,
        // The READ_RPC name test is a heuristic; classify.ts records it as an
        // adapter assertion with heuristic-grade confidence.
        ...(read ? { "x-anvil-effect": "read" } : {}),
      };
      op.requestBody = {
        required: true,
        content: { "application/json": { schema: rpcMessageSchema(method.requestType, c) } },
      };
      paths[path] = { post: op };
    }
  }

  return {
    openapi: "3.0.3",
    info: { title: title ?? pkg ?? "gRPC API", version: "1.0.0" },
    paths,
    components: { schemas: schemas as Record<string, unknown> },
  };
}
