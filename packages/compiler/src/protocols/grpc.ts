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

import type { Diagnostic } from "@anvil/air";
import protobuf from "protobufjs";
import type { OpenApiDocument } from "../parse.js";
import { httpRuleOf } from "./grpc-http-rule.js";

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

/** The message a method's request type names, when it is one this document
 *  defines. Absent for an unresolved import, which is what stops an HTTP rule
 *  over it from being claimed. */
function lookupMessage(typeName: string, c: Collected): protobuf.Type | undefined {
  const qualified = stripLeadingDot(typeName);
  return (
    c.messages.find((m) => stripLeadingDot(m.fullName) === qualified) ??
    c.messages.find((m) => m.name === localName(qualified))
  );
}

/**
 * The request message as a body schema with the fields the HTTP rule carries
 * elsewhere removed.
 *
 * A `$ref` to the whole message would be wrong here: an agent asked for
 * `order_id` in the path and again in the body has been given two places to put
 * one value, and the two can disagree. Each field appears in exactly one place.
 */
function messageSchemaOmitting(
  message: protobuf.Type,
  omit: readonly string[],
  c: Collected,
): JsonSchemaLike {
  const properties: Record<string, JsonSchemaLike> = {};
  for (const field of message.fieldsArray) {
    if (omit.includes(field.name)) continue;
    properties[field.name] = fieldSchema(field, c);
  }
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
  diagnostics?: Diagnostic[],
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
      const read = READ_RPC.test(method.name);
      const streaming =
        method.requestStream || method.responseStream
          ? ` (${method.requestStream ? "client" : ""}${method.requestStream && method.responseStream ? "+" : ""}${method.responseStream ? "server" : ""} streaming)`
          : "";
      // Streaming is refused outright: a stream is not a request and a
      // response, and no transcoder turns one into a single JSON exchange.
      // Unary calls record a binding that states the transcoding assumption
      // this adapter has always made in a comment.
      const unary = !method.requestStream && !method.responseStream;
      if (!unary) {
        diagnostics?.push({
          level: "warning",
          code: "grpc_binding_unencodable",
          path: `${serviceFqn}/${method.name}`,
          message:
            `Anvil recorded no wire binding for gRPC '${method.name}': it is a streaming RPC, and ` +
            `a stream is not a request and a response. Anvil has no streaming client and no ` +
            `transcoder turns one into a single JSON exchange.`,
        });
      }

      // A method carrying `google.api.http` states its own HTTP mapping, which
      // is read only for a unary call: no route turns a stream into a single
      // JSON exchange, so the annotation on one is moot.
      const requestMessage = lookupMessage(method.requestType, c);
      const outcome = unary
        ? httpRuleOf(
            method.parsedOptions,
            requestMessage?.fieldsArray.map((field) => field.name),
          )
        : undefined;
      if (outcome && !outcome.ok) {
        diagnostics?.push({
          level: "warning",
          code: "grpc_http_rule_unencodable",
          path: `${serviceFqn}/${method.name}`,
          message:
            `Anvil recorded no wire binding for gRPC '${method.name}': it declares a ` +
            `google.api.http rule Anvil declines to encode — ${outcome.reason}. Anvil does not ` +
            `fall back to gRPC's own path here, because a gateway serves the declared route and ` +
            `no other, so that path is one this deployment provably does not answer.`,
        });
      }
      const rule = outcome?.ok ? outcome.rule : undefined;

      // Unannotated, every gRPC call is POST on gRPC's own coordinate (HTTP/2
      // POST per the spec), and the read/write distinction is asserted through
      // `x-anvil-effect` rather than a fake GET that could not carry the body.
      // Annotated, the declared verb and path are the truth, and the operation
      // classifies exactly as the OpenAPI document it has just declared itself
      // to be — including the name-signal machinery that reclassifies a
      // POST-with-read-intent, which is why the hint steps aside.
      const verb = rule?.verb ?? "post";
      const path = rule?.path ?? `/${serviceFqn}/${method.name}`;
      const parameters: JsonSchemaLike[] = [];
      let requestBody: JsonSchemaLike | undefined;

      if (rule && requestMessage) {
        const byName = new Map(requestMessage.fieldsArray.map((field) => [field.name, field]));
        for (const name of rule.pathFields) {
          const field = byName.get(name);
          parameters.push({
            name,
            in: "path",
            required: true,
            schema: field ? fieldSchema(field, c) : { type: "string" },
          });
        }
        if (rule.body === "*") {
          requestBody = {
            required: true,
            content: {
              "application/json": {
                schema: messageSchemaOmitting(requestMessage, rule.pathFields, c),
              },
            },
          };
        } else {
          // Whatever the rule neither binds into the path nor names as the body
          // travels in the query string — the HttpRule default, and the reason
          // a `get:` rule needs no body at all.
          for (const field of requestMessage.fieldsArray) {
            if (rule.pathFields.includes(field.name) || field.name === rule.body) continue;
            parameters.push({
              name: field.name,
              in: "query",
              required: false,
              schema: fieldSchema(field, c),
            });
          }
          const bodyField = rule.body === undefined ? undefined : byName.get(rule.body);
          if (rule.body !== undefined) {
            requestBody = {
              required: true,
              content: {
                "application/json": {
                  schema: bodyField ? fieldSchema(bodyField, c) : { type: "object" },
                },
              },
            };
          }
        }
      } else {
        requestBody = {
          required: true,
          content: { "application/json": { schema: rpcMessageSchema(method.requestType, c) } },
        };
      }

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
        ...(parameters.length > 0 ? { parameters } : {}),
        ...(requestBody ? { requestBody } : {}),
        ...(unary && (rule || !outcome)
          ? {
              "x-anvil-wire-binding": {
                protocol: "grpc",
                service: serviceFqn,
                method: method.name,
                transport: rule ? "http_rule" : "json_transcoded",
              },
            }
          : {}),
        "x-grpc-service": serviceFqn,
        "x-grpc-method": method.name,
        "x-grpc-streaming": streaming.trim() || undefined,
        // The READ_RPC name test is a heuristic; classify.ts records it as an
        // adapter assertion with heuristic-grade confidence.
        ...(read && !rule ? { "x-anvil-effect": "read" } : {}),
      };

      // Declared routes collide where gRPC's own coordinates cannot: `GET` and
      // `DELETE` on `/v1/orders/{order_id}` are two RPCs sharing one path, so
      // verbs are merged into it rather than replacing what is already there.
      const existing = paths[path];
      if (existing?.[verb] !== undefined) {
        diagnostics?.push({
          level: "warning",
          code: "grpc_http_rule_collision",
          path: `${serviceFqn}/${method.name}`,
          message:
            `gRPC '${method.name}' declares ${verb.toUpperCase()} ${path}, which another RPC in ` +
            `this document already declares. Anvil kept the first and dropped this one; two ` +
            `operations on one route cannot both be addressed.`,
        });
        continue;
      }
      paths[path] = { ...(existing ?? {}), [verb]: op };
    }
  }

  return {
    openapi: "3.0.3",
    info: { title: title ?? pkg ?? "gRPC API", version: "1.0.0" },
    paths,
    components: { schemas: schemas as Record<string, unknown> },
  };
}
