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
 * dereferencer the OpenAPI path uses. No third-party GraphQL dependency: the
 * SDL subset that matters for tool generation (types, fields, args, wrappers,
 * enums, unions, interfaces, descriptions) is small and parsed directly here.
 */
import type { OpenApiDocument } from "../parse.js";

interface TypeRef {
  name: string;
  list: boolean;
  nonNull: boolean;
  /** Inner-item non-null, for `[T!]`. Informational only. */
  itemNonNull: boolean;
}

interface FieldArg {
  name: string;
  type: TypeRef;
  description?: string;
  defaultValue?: string;
}

interface FieldDef {
  name: string;
  type: TypeRef;
  args: FieldArg[];
  description?: string;
}

interface ObjectType {
  kind: "object" | "input" | "interface";
  name: string;
  description?: string;
  fields: FieldDef[];
}

interface EnumType {
  kind: "enum";
  name: string;
  description?: string;
  values: string[];
}

interface UnionType {
  kind: "union";
  name: string;
  description?: string;
  members: string[];
}

type NamedType = ObjectType | EnumType | UnionType;

interface SchemaModel {
  query?: string;
  mutation?: string;
  subscription?: string;
  types: Map<string, NamedType>;
  scalars: Set<string>;
}

/* ------------------------------- tokenizer -------------------------------- */

type Token =
  | { kind: "name"; value: string }
  | { kind: "punct"; value: string }
  | { kind: "string"; value: string };

const PUNCT = new Set(["{", "}", "(", ")", "[", "]", "!", ":", "=", "|", "&", "@"]);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] as string;
    // Whitespace and commas (commas are insignificant in GraphQL).
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "," || c === "﻿") {
      i++;
      continue;
    }
    // Line comment.
    if (c === "#") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // Block string """...""".
    if (c === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      i += 3;
      let val = "";
      while (i < n && !(src[i] === '"' && src[i + 1] === '"' && src[i + 2] === '"')) {
        val += src[i];
        i++;
      }
      i += 3;
      tokens.push({ kind: "string", value: dedentBlock(val) });
      continue;
    }
    // Plain string "...".
    if (c === '"') {
      i++;
      let val = "";
      while (i < n && src[i] !== '"' && src[i] !== "\n") {
        if (src[i] === "\\" && i + 1 < n) {
          val += src[i + 1];
          i += 2;
          continue;
        }
        val += src[i];
        i++;
      }
      i++;
      tokens.push({ kind: "string", value: val });
      continue;
    }
    if (PUNCT.has(c)) {
      tokens.push({ kind: "punct", value: c });
      i++;
      continue;
    }
    // Name / number / keyword.
    if (/[_A-Za-z0-9.+-]/.test(c)) {
      let val = "";
      while (i < n && /[_A-Za-z0-9.+-]/.test(src[i] as string)) {
        val += src[i];
        i++;
      }
      tokens.push({ kind: "name", value: val });
      continue;
    }
    // Unknown punctuation (e.g. an unexpected char) — skip it defensively.
    i++;
  }
  return tokens;
}

/** Strip the common leading indentation from a block string (GraphQL spec). */
function dedentBlock(raw: string): string {
  const lines = raw.split("\n");
  let common = Number.POSITIVE_INFINITY;
  for (const line of lines.slice(1)) {
    const stripped = line.trimStart();
    if (stripped.length === 0) continue;
    common = Math.min(common, line.length - stripped.length);
  }
  if (!Number.isFinite(common)) common = 0;
  const out = lines.map((line, idx) => (idx === 0 ? line : line.slice(common)));
  return out.join("\n").trim();
}

/* --------------------------------- parser --------------------------------- */

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }
  private isPunct(value: string): boolean {
    const t = this.peek();
    return t?.kind === "punct" && t.value === value;
  }
  private eatPunct(value: string): boolean {
    if (this.isPunct(value)) {
      this.pos++;
      return true;
    }
    return false;
  }
  private isName(value: string): boolean {
    const t = this.peek();
    return t?.kind === "name" && t.value === value;
  }
  private expectName(): string {
    const t = this.next();
    if (t?.kind !== "name") throw new Error(`Expected a name near token ${this.pos}`);
    return t.value;
  }

  /** Consume a leading description string if present. */
  private description(): string | undefined {
    const t = this.peek();
    if (t?.kind === "string") {
      this.pos++;
      return t.value || undefined;
    }
    return undefined;
  }

  /** Skip a directive application `@name(args...)` list. */
  private skipDirectives(): void {
    while (this.isPunct("@")) {
      this.pos++; // @
      this.expectName();
      if (this.eatPunct("(")) this.skipBalanced("(", ")");
    }
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (!t) return;
      if (t.kind === "punct" && t.value === open) depth++;
      else if (t.kind === "punct" && t.value === close) depth--;
    }
  }

  private parseTypeRef(): TypeRef {
    if (this.eatPunct("[")) {
      const inner = this.parseTypeRef();
      this.eatPunct("]");
      const nonNull = this.eatPunct("!");
      return { name: inner.name, list: true, nonNull, itemNonNull: inner.nonNull };
    }
    const name = this.expectName();
    const nonNull = this.eatPunct("!");
    return { name, list: false, nonNull, itemNonNull: false };
  }

  private parseArgs(): FieldArg[] {
    const args: FieldArg[] = [];
    if (!this.eatPunct("(")) return args;
    while (!this.isPunct(")") && this.peek()) {
      const description = this.description();
      const name = this.expectName();
      this.eatPunct(":");
      const type = this.parseTypeRef();
      let defaultValue: string | undefined;
      if (this.eatPunct("=")) defaultValue = this.parseValueToken();
      this.skipDirectives();
      args.push({ name, type, description, defaultValue });
    }
    this.eatPunct(")");
    return args;
  }

  /** Read one default value token/structure as a raw string (best-effort). */
  private parseValueToken(): string {
    if (this.isPunct("[")) {
      this.pos++;
      this.skipBalanced("[", "]");
      return "[]";
    }
    if (this.isPunct("{")) {
      this.pos++;
      this.skipBalanced("{", "}");
      return "{}";
    }
    const t = this.next();
    return t?.kind === "string" || t?.kind === "name" ? t.value : "";
  }

  private parseFields(): FieldDef[] {
    const fields: FieldDef[] = [];
    if (!this.eatPunct("{")) return fields;
    while (!this.isPunct("}") && this.peek()) {
      const description = this.description();
      const name = this.expectName();
      const args = this.parseArgs();
      this.eatPunct(":");
      const type = this.parseTypeRef();
      this.skipDirectives();
      fields.push({ name, type, args, description });
    }
    this.eatPunct("}");
    return fields;
  }

  parse(): SchemaModel {
    const model: SchemaModel = { types: new Map(), scalars: new Set() };
    while (this.peek()) {
      const description = this.description();
      const t = this.peek();
      if (!t) break;
      // Ignore `extend` prefix — treat the extension like the base definition.
      if (t.kind === "name" && t.value === "extend") {
        this.pos++;
        continue;
      }
      if (t.kind !== "name") {
        this.pos++;
        continue;
      }
      const keyword = t.value;
      this.pos++;
      switch (keyword) {
        case "schema": {
          this.skipDirectives();
          this.eatPunct("{");
          while (!this.isPunct("}") && this.peek()) {
            const role = this.expectName();
            this.eatPunct(":");
            const typeName = this.expectName();
            if (role === "query") model.query = typeName;
            else if (role === "mutation") model.mutation = typeName;
            else if (role === "subscription") model.subscription = typeName;
          }
          this.eatPunct("}");
          break;
        }
        case "type":
        case "input":
        case "interface": {
          const name = this.expectName();
          if (this.isName("implements")) {
            this.pos++;
            // Consume the interface list (`A & B`).
            while (this.peek()?.kind === "name" || this.isPunct("&")) {
              if (this.isPunct("{")) break;
              this.pos++;
            }
          }
          this.skipDirectives();
          const kind = keyword === "type" ? "object" : keyword === "input" ? "input" : "interface";
          const fields = this.parseFields();
          model.types.set(name, { kind, name, description, fields });
          break;
        }
        case "enum": {
          const name = this.expectName();
          this.skipDirectives();
          const values: string[] = [];
          if (this.eatPunct("{")) {
            while (!this.isPunct("}") && this.peek()) {
              this.description();
              values.push(this.expectName());
              this.skipDirectives();
            }
            this.eatPunct("}");
          }
          model.types.set(name, { kind: "enum", name, description, values });
          break;
        }
        case "union": {
          const name = this.expectName();
          this.skipDirectives();
          const members: string[] = [];
          if (this.eatPunct("=")) {
            this.eatPunct("|");
            members.push(this.expectName());
            while (this.eatPunct("|")) members.push(this.expectName());
          }
          model.types.set(name, { kind: "union", name, description, members });
          break;
        }
        case "scalar": {
          const name = this.expectName();
          this.skipDirectives();
          model.scalars.add(name);
          break;
        }
        case "directive": {
          // `directive @name(args) on LOC` — skip to the next definition.
          while (this.peek() && !this.atDefinitionStart()) this.pos++;
          break;
        }
        default:
          // Unknown top-level token; skip to stay resilient.
          break;
      }
    }
    return model;
  }

  private atDefinitionStart(): boolean {
    const t = this.peek();
    if (t?.kind !== "name") return false;
    return ["type", "input", "interface", "enum", "union", "scalar", "schema", "extend"].includes(
      t.value,
    );
  }
}

/* ------------------------------- lowering --------------------------------- */

const BUILTIN_SCALARS: Record<string, JsonSchemaLike> = {
  Int: { type: "integer" },
  Float: { type: "number" },
  String: { type: "string" },
  Boolean: { type: "boolean" },
  ID: { type: "string", description: "GraphQL ID" },
};

type JsonSchemaLike = Record<string, unknown>;

function typeRefToSchema(ref: TypeRef, model: SchemaModel): JsonSchemaLike {
  const base = namedTypeToSchema(ref.name, model);
  if (ref.list) return { type: "array", items: base };
  return base;
}

function namedTypeToSchema(name: string, model: SchemaModel): JsonSchemaLike {
  if (BUILTIN_SCALARS[name]) return { ...BUILTIN_SCALARS[name] };
  if (model.scalars.has(name)) return { type: "string", description: `custom scalar ${name}` };
  if (model.types.has(name)) return { $ref: `#/components/schemas/${name}` };
  // Unknown type name — degrade to a permissive string rather than fail.
  return { type: "string" };
}

function objectSchema(type: ObjectType, model: SchemaModel): JsonSchemaLike {
  const properties: Record<string, JsonSchemaLike> = {};
  const required: string[] = [];
  for (const field of type.fields) {
    // A field that itself takes arguments is a query edge, not stored data; we
    // still surface it as its return shape so response schemas stay complete.
    const schema = typeRefToSchema(field.type, model);
    if (field.description) schema.description = field.description;
    properties[field.name] = schema;
    if (field.type.nonNull) required.push(field.name);
  }
  const out: JsonSchemaLike = { type: "object", properties };
  if (type.description) out.description = type.description;
  if (required.length > 0) out.required = required;
  return out;
}

function buildSchemas(model: SchemaModel): Record<string, JsonSchemaLike> {
  const schemas: Record<string, JsonSchemaLike> = {};
  for (const type of model.types.values()) {
    if (type.kind === "enum") {
      schemas[type.name] = {
        type: "string",
        enum: type.values,
        ...(type.description ? { description: type.description } : {}),
      };
    } else if (type.kind === "union") {
      schemas[type.name] = {
        oneOf: type.members.map((m) => namedTypeToSchema(m, model)),
        ...(type.description ? { description: type.description } : {}),
      };
    } else {
      schemas[type.name] = objectSchema(type, model);
    }
  }
  return schemas;
}

/** Build the request-body schema for a field's arguments. */
function argsSchema(args: FieldArg[], model: SchemaModel): JsonSchemaLike | undefined {
  if (args.length === 0) return undefined;
  const properties: Record<string, JsonSchemaLike> = {};
  const required: string[] = [];
  for (const arg of args) {
    const schema = typeRefToSchema(arg.type, model);
    if (arg.description) schema.description = arg.description;
    properties[arg.name] = schema;
    if (arg.type.nonNull && arg.defaultValue === undefined) required.push(arg.name);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

/**
 * Lower a GraphQL SDL string into an OpenAPI 3.0 document (with `$ref`s). The
 * caller dereferences it, so recursion in the schema graph is handled by the
 * same machinery the OpenAPI path relies on.
 */
export function adaptGraphql(source: string, title = "GraphQL API"): OpenApiDocument {
  const model = new Parser(tokenize(source)).parse();
  const queryType = model.query ?? (model.types.has("Query") ? "Query" : undefined);
  const mutationType = model.mutation ?? (model.types.has("Mutation") ? "Mutation" : undefined);
  const subscriptionType =
    model.subscription ?? (model.types.has("Subscription") ? "Subscription" : undefined);

  const paths: Record<string, Record<string, unknown>> = {};

  const addRoot = (rootName: string | undefined, kind: "query" | "mutation" | "subscription") => {
    if (!rootName) return;
    const root = model.types.get(rootName);
    if (root?.kind !== "object") return;
    const httpMethod = kind === "mutation" ? "post" : "get";
    for (const field of root.fields) {
      const path = `/graphql/${rootName}/${field.name}`;
      const reqSchema = argsSchema(field.args, model);
      const op: Record<string, unknown> = {
        operationId: field.name,
        summary:
          field.description ??
          `GraphQL ${kind} ${field.name}${kind === "subscription" ? " (streaming subscription)" : ""}`,
        description: field.description,
        tags: [rootName],
        responses: {
          "200": {
            description: `${field.name} result`,
            content: { "application/json": { schema: typeRefToSchema(field.type, model) } },
          },
        },
        "x-graphql-operation": kind,
        "x-graphql-field": field.name,
      };
      // Reads whose name looks mutating still stay reads (Query is authoritative);
      // writes keep POST semantics so they are treated conservatively.
      if (reqSchema) {
        op.requestBody = {
          required: field.args.some((a) => a.type.nonNull && a.defaultValue === undefined),
          content: { "application/json": { schema: reqSchema } },
        };
      }
      paths[path] = { [httpMethod]: op };
    }
  };

  addRoot(queryType, "query");
  addRoot(mutationType, "mutation");
  addRoot(subscriptionType, "subscription");

  // Only expose schemas that are not themselves the (edge-only) root types.
  const schemas = buildSchemas(model);
  for (const root of [queryType, mutationType, subscriptionType]) {
    if (root) delete schemas[root];
  }

  return {
    openapi: "3.0.3",
    info: { title, version: "1.0.0" },
    paths,
    components: { schemas: schemas as Record<string, unknown> },
  };
}
