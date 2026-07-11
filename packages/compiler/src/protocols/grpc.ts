/**
 * Protocol Buffers (proto3) → OpenAPI 3.0 adapter for gRPC services.
 *
 * Each `rpc` in a `service` becomes one operation. gRPC has no read/write verb
 * of its own, so effect is inferred conservatively from the method name: the
 * canonical read prefixes (Get/List/Watch/Search/Lookup/Query/Fetch/Read/…)
 * lower to GET (read), everything else lowers to POST (mutation → treated as
 * unsafe until enriched). The request message becomes the body, the response
 * message the output schema, and every `message`/`enum` becomes a
 * `components.schemas` entry referenced by `$ref` — recursion is resolved by
 * the shared dereferencer.
 *
 * The proto3 subset parsed here is the part that shapes a tool surface:
 * package, services + rpcs (incl. `stream`), messages (incl. nested, `repeated`,
 * `map<>`, `oneof`), and enums. Options/imports/reserved/extensions are skipped.
 */
import type { OpenApiDocument } from "../parse.js";

type JsonSchemaLike = Record<string, unknown>;

interface ProtoField {
  name: string;
  type: string;
  repeated: boolean;
  map?: { key: string; value: string };
  comment?: string;
}

interface ProtoMessage {
  name: string;
  fields: ProtoField[];
}

interface ProtoEnum {
  name: string;
  values: string[];
}

interface ProtoRpc {
  name: string;
  requestType: string;
  responseType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  comment?: string;
}

interface ProtoService {
  name: string;
  rpcs: ProtoRpc[];
}

interface ProtoModel {
  package?: string;
  messages: Map<string, ProtoMessage>;
  enums: Map<string, ProtoEnum>;
  services: ProtoService[];
}

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

/* -------------------------------- tokenizer ------------------------------- */

/**
 * Strip comments (`// ...` and block comments) but keep a lightweight cursor so
 * we can walk tokens. Proto is punctuation-delimited, so a token stream of
 * identifiers and single-char punctuation is enough.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < n && src[i] !== quote) {
        out += src[i];
        i++;
      }
      out += src[i] ?? "";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function tokenize(src: string): string[] {
  const cleaned = stripComments(src);
  const tokens: string[] = [];
  let i = 0;
  const n = cleaned.length;
  const isWord = (ch: string) => /[A-Za-z0-9_.]/.test(ch);
  while (i < n) {
    const c = cleaned[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let val = c;
      i++;
      while (i < n && cleaned[i] !== quote) {
        val += cleaned[i];
        i++;
      }
      val += quote;
      i++;
      tokens.push(val);
      continue;
    }
    if (isWord(c)) {
      let val = "";
      while (i < n && isWord(cleaned[i] as string)) {
        val += cleaned[i];
        i++;
      }
      tokens.push(val);
      continue;
    }
    tokens.push(c);
    i++;
  }
  return tokens;
}

/* --------------------------------- parser --------------------------------- */

class Parser {
  private pos = 0;
  constructor(private readonly tokens: string[]) {}

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }
  private next(): string | undefined {
    return this.tokens[this.pos++];
  }
  private eat(value: string): boolean {
    if (this.peek() === value) {
      this.pos++;
      return true;
    }
    return false;
  }
  private skipTo(value: string): void {
    while (this.peek() !== undefined && this.peek() !== value) this.pos++;
    this.eat(value);
  }
  private skipBlock(): void {
    // Assumes the opening `{` has been consumed.
    let depth = 1;
    while (depth > 0 && this.peek() !== undefined) {
      const t = this.next();
      if (t === "{") depth++;
      else if (t === "}") depth--;
    }
  }

  parse(): ProtoModel {
    const model: ProtoModel = { messages: new Map(), enums: new Map(), services: [] };
    while (this.peek() !== undefined) {
      const t = this.next() as string;
      switch (t) {
        case "syntax":
        case "option":
        case "import":
          this.skipTo(";");
          break;
        case "package":
          model.package = this.readDottedName();
          this.skipTo(";");
          break;
        case "message":
          this.parseMessage(model, "");
          break;
        case "enum":
          this.parseEnum(model, "");
          break;
        case "service":
          this.parseService(model);
          break;
        case ";":
          break;
        default:
          // Unknown top-level token; if it opens a block, skip it.
          if (this.eat("{")) this.skipBlock();
          break;
      }
    }
    return model;
  }

  private readDottedName(): string {
    return this.next() ?? "";
  }

  private qualify(prefix: string, name: string): string {
    return prefix ? `${prefix}.${name}` : name;
  }

  private parseMessage(model: ProtoModel, prefix: string): void {
    const name = this.next() as string;
    const qualified = this.qualify(prefix, name);
    const message: ProtoMessage = { name: qualified, fields: [] };
    if (!this.eat("{")) return;
    while (this.peek() !== undefined && this.peek() !== "}") {
      const t = this.peek() as string;
      if (t === "message") {
        this.next();
        this.parseMessage(model, qualified);
        continue;
      }
      if (t === "enum") {
        this.next();
        this.parseEnum(model, qualified);
        continue;
      }
      if (t === "oneof") {
        this.next();
        this.next(); // oneof name
        this.eat("{");
        this.parseOneofFields(message);
        continue;
      }
      if (t === "reserved" || t === "option" || t === "extensions") {
        this.next();
        this.skipTo(";");
        continue;
      }
      if (t === "map") {
        this.parseMapField(message);
        continue;
      }
      if (t === ";") {
        this.next();
        continue;
      }
      this.parseField(message);
    }
    this.eat("}");
    model.messages.set(qualified, message);
  }

  private parseOneofFields(message: ProtoMessage): void {
    while (this.peek() !== undefined && this.peek() !== "}") {
      if (this.peek() === "option") {
        this.next();
        this.skipTo(";");
        continue;
      }
      if (this.peek() === "map") {
        this.parseMapField(message);
        continue;
      }
      this.parseField(message, false);
    }
    this.eat("}");
  }

  private parseField(message: ProtoMessage, allowRepeated = true): void {
    let repeated = false;
    if (allowRepeated && (this.peek() === "repeated" || this.peek() === "optional")) {
      repeated = this.next() === "repeated";
    } else if (this.peek() === "optional" || this.peek() === "required") {
      this.next();
    }
    const type = this.next() as string;
    if (type === undefined || type === "}") return;
    const name = this.next() as string;
    // `= <number>` and optional `[...]` options, then `;`.
    this.eat("=");
    this.next(); // field number
    if (this.eat("[")) this.skipTo("]");
    this.eat(";");
    if (name) message.fields.push({ name, type, repeated });
  }

  private parseMapField(message: ProtoMessage): void {
    this.next(); // map
    this.eat("<");
    const key = this.next() as string;
    this.eat(",");
    const value = this.next() as string;
    this.eat(">");
    const name = this.next() as string;
    this.eat("=");
    this.next();
    if (this.eat("[")) this.skipTo("]");
    this.eat(";");
    if (name) message.fields.push({ name, type: "map", repeated: false, map: { key, value } });
  }

  private parseEnum(model: ProtoModel, prefix: string): void {
    const name = this.next() as string;
    const qualified = this.qualify(prefix, name);
    const values: string[] = [];
    if (!this.eat("{")) return;
    while (this.peek() !== undefined && this.peek() !== "}") {
      const t = this.peek() as string;
      if (t === "option" || t === "reserved") {
        this.next();
        this.skipTo(";");
        continue;
      }
      if (t === ";") {
        this.next();
        continue;
      }
      const valueName = this.next() as string;
      this.eat("=");
      this.next();
      if (this.eat("[")) this.skipTo("]");
      this.eat(";");
      if (valueName) values.push(valueName);
    }
    this.eat("}");
    model.enums.set(qualified, { name: qualified, values });
  }

  private parseService(model: ProtoModel): void {
    const name = this.next() as string;
    const service: ProtoService = { name, rpcs: [] };
    if (!this.eat("{")) return;
    while (this.peek() !== undefined && this.peek() !== "}") {
      const t = this.next() as string;
      if (t === "rpc") {
        const rpcName = this.next() as string;
        this.eat("(");
        const clientStreaming = this.eat("stream");
        const requestType = this.next() as string;
        this.eat(")");
        // `returns`
        if (this.peek() === "returns") this.next();
        this.eat("(");
        const serverStreaming = this.eat("stream");
        const responseType = this.next() as string;
        this.eat(")");
        // Optional `{ ... }` body or trailing `;`.
        if (this.eat("{")) this.skipBlock();
        else this.eat(";");
        service.rpcs.push({
          name: rpcName,
          requestType,
          responseType,
          clientStreaming,
          serverStreaming,
        });
      } else if (t === "option") {
        this.skipTo(";");
      } else if (t === "{") {
        this.skipBlock();
      }
    }
    this.eat("}");
    model.services.push(service);
  }
}

/* -------------------------------- lowering -------------------------------- */

const READ_RPC =
  /^(get|list|watch|search|lookup|query|fetch|read|describe|count|stream|export|scan)/i;

function localName(qualified: string): string {
  const parts = qualified.split(".");
  return parts[parts.length - 1] as string;
}

/** Resolve a proto type name to a JSON schema, honoring package qualification. */
function typeToSchema(type: string, model: ProtoModel, pkg: string): JsonSchemaLike {
  const scalar = SCALAR_TO_SCHEMA[type];
  if (scalar) return { ...scalar };
  const resolved = resolveTypeName(type, model, pkg);
  if (resolved) return { $ref: `#/components/schemas/${schemaKey(resolved)}` };
  // Unknown/well-known type (e.g. google.protobuf.Timestamp) — degrade sensibly.
  if (/Timestamp$/.test(type)) return { type: "string", format: "date-time" };
  if (/Duration$/.test(type)) return { type: "string" };
  if (/(Struct|Value|Any)$/.test(type)) return { type: "object" };
  return { type: "string" };
}

/** Find the fully-qualified key of a named message/enum given a possibly-relative ref. */
function resolveTypeName(type: string, model: ProtoModel, pkg: string): string | undefined {
  const candidates = [type, pkg ? `${pkg}.${type}` : type];
  for (const c of candidates) {
    if (model.messages.has(c) || model.enums.has(c)) return c;
  }
  // Match by local name as a last resort (nested types are stored qualified).
  for (const key of [...model.messages.keys(), ...model.enums.keys()]) {
    if (localName(key) === localName(type)) return key;
  }
  return undefined;
}

/** A stable, readable schema component key from a qualified proto name. */
function schemaKey(qualified: string): string {
  return qualified.split(".").join("_");
}

function fieldSchema(field: ProtoField, model: ProtoModel, pkg: string): JsonSchemaLike {
  if (field.map) {
    return {
      type: "object",
      additionalProperties: typeToSchema(field.map.value, model, pkg),
    };
  }
  const base = typeToSchema(field.type, model, pkg);
  return field.repeated ? { type: "array", items: base } : base;
}

function messageSchema(message: ProtoMessage, model: ProtoModel, pkg: string): JsonSchemaLike {
  const properties: Record<string, JsonSchemaLike> = {};
  for (const field of message.fields) properties[field.name] = fieldSchema(field, model, pkg);
  return { type: "object", properties };
}

/**
 * Lower a proto3 source string into an OpenAPI 3.0 document (with `$ref`s), to
 * be dereferenced by the caller.
 */
export function adaptProto(source: string, title?: string): OpenApiDocument {
  const model = new Parser(tokenize(source)).parse();
  const pkg = model.package ?? "";

  const schemas: Record<string, JsonSchemaLike> = {};
  for (const message of model.messages.values()) {
    schemas[schemaKey(message.name)] = messageSchema(message, model, pkg);
  }
  for (const en of model.enums.values()) {
    schemas[schemaKey(en.name)] = { type: "string", enum: en.values };
  }

  const paths: Record<string, Record<string, unknown>> = {};
  for (const service of model.services) {
    const serviceFqn = pkg ? `${pkg}.${service.name}` : service.name;
    for (const rpc of service.rpcs) {
      const read = READ_RPC.test(rpc.name);
      const httpMethod = read ? "get" : "post";
      // gRPC wire path is /package.Service/Method — used verbatim as the AIR path.
      const path = `/${serviceFqn}/${rpc.name}`;
      const streaming =
        rpc.clientStreaming || rpc.serverStreaming
          ? ` (${rpc.clientStreaming ? "client" : ""}${rpc.clientStreaming && rpc.serverStreaming ? "+" : ""}${rpc.serverStreaming ? "server" : ""} streaming)`
          : "";
      const reqRef = resolveTypeName(rpc.requestType, model, pkg);
      const resRef = resolveTypeName(rpc.responseType, model, pkg);
      const op: Record<string, unknown> = {
        operationId: rpc.name,
        summary: `${service.name}.${rpc.name}${streaming}`,
        tags: [service.name],
        responses: {
          "200": {
            description: `${rpc.name} response`,
            content: {
              "application/json": {
                schema: resRef
                  ? { $ref: `#/components/schemas/${schemaKey(resRef)}` }
                  : { type: "object" },
              },
            },
          },
        },
        "x-grpc-service": serviceFqn,
        "x-grpc-method": rpc.name,
        "x-grpc-streaming": streaming.trim() || undefined,
      };
      op.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: reqRef
              ? { $ref: `#/components/schemas/${schemaKey(reqRef)}` }
              : { type: "object" },
          },
        },
      };
      paths[path] = { [httpMethod]: op };
    }
  }

  return {
    openapi: "3.0.3",
    info: { title: title ?? model.package ?? "gRPC API", version: "1.0.0" },
    paths,
    components: { schemas: schemas as Record<string, unknown> },
  };
}
