/**
 * The selection tree behind one GraphQL root field.
 *
 * The compiled query document and the operation's response schema used to be
 * computed by two independent walks over the SDL, and they disagreed: a union
 * was selected as `{ __typename }` while the schema promised the members'
 * fields; a field that takes required arguments was skipped on the wire and
 * kept in the schema; a depth cut was silent. Both artifacts now derive from
 * this one tree, so the schema can only describe what the document asks for.
 *
 * The tree is positional. A GraphQL schema is a graph, so the same type reached
 * at different depths, or through a cycle, gets a different selection — and
 * the schema for that position has to say so rather than pointing at the
 * type's full component. `responseSchemaFor` renders a node as a `$ref` to the
 * type's component only when the node's whole subtree is the type's canonical
 * selection; anything else is rendered inline, bounded by `INLINE_MAX_DEPTH`
 * so it stays inside the anonymous-nesting budget the shared `decycle` pass
 * applies to every spec.
 */
import {
  type GraphQLField,
  type GraphQLInterfaceType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLSchema,
  type GraphQLUnionType,
  getNamedType,
  isEnumType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
} from "graphql";

type JsonSchemaLike = Record<string, unknown>;

/** How deep a selection set may go before it stops descending.
 *
 *  A GraphQL schema is a graph, not a tree — `Order.customer.orders` is legal
 *  and infinite. Cycles are cut by the visited-set below; this bounds the
 *  merely-deep case, where a legitimate schema would otherwise produce a
 *  selection set nobody wants to read or transfer. */
export const MAX_SELECTION_DEPTH = 4;

/**
 * The deepest JSON nesting level at which an object schema is still rendered
 * inline. `decycle` truncates anonymous schema structure past six levels; an
 * inline object at level 3 puts its field schemas at level 5, the last level
 * that survives. Past this, a non-canonical node falls back to the type's
 * component, and the `graphql_selection_truncated` diagnostic names what the
 * component then over-describes.
 */
const INLINE_MAX_DEPTH = 3;

/** The component that stands in wherever the selection stops. */
export const TYPENAME_ONLY_SCHEMA = "TypenameOnly";

/** Why a selection stops at a node. */
type SelectionCut = "depth" | "cycle";

interface SelectionField {
  name: string;
  /** The field's declared (possibly wrapped) type; list wrappers become arrays. */
  type: GraphQLOutputType;
  description: string | null | undefined;
  node: SelectionNode;
}

interface SelectionMember {
  type: GraphQLObjectType;
  /** The member's own fields (those not on the interface), or undefined when cut. */
  fields: SelectionField[] | undefined;
}

export type SelectionNode =
  | { kind: "leaf"; type: GraphQLNamedType }
  | { kind: "object"; type: GraphQLObjectType | GraphQLInterfaceType; fields: SelectionField[] }
  | {
      kind: "abstract";
      type: GraphQLUnionType | GraphQLInterfaceType;
      /** An interface's own fields, selected once; empty for a union. */
      fields: SelectionField[];
      members: SelectionMember[];
    }
  | { kind: "cut"; type: GraphQLNamedType; reason: SelectionCut };

export interface SelectionCutRecord {
  path: string;
  type: string;
  reason: SelectionCut;
}

export interface Selection {
  root: SelectionNode;
  /** `Type.field(arg: T!, …)` for every field left out for taking required arguments. */
  omittedRequiredArgs: string[];
  cuts: SelectionCutRecord[];
}

/**
 * A field that takes a required argument cannot be selected without inventing
 * a value for it, and inventing values is Anvil making up a request. Such a
 * field is left out of the document and of the response schema alike.
 */
export function requiresArguments(field: GraphQLField<unknown, unknown>): boolean {
  return field.args.some((arg) => isNonNullType(arg.type) && arg.defaultValue === undefined);
}

interface Findings {
  omitted: Map<string, string>;
  cuts: SelectionCutRecord[];
}

export function buildSelection(
  schema: GraphQLSchema,
  field: GraphQLField<unknown, unknown>,
): Selection {
  const findings: Findings = { omitted: new Map(), cuts: [] };
  const root = select(getNamedType(field.type), 0, new Set(), field.name, schema, findings);
  return { root, omittedRequiredArgs: [...findings.omitted.values()], cuts: findings.cuts };
}

function select(
  type: GraphQLNamedType,
  depth: number,
  seen: ReadonlySet<string>,
  path: string,
  schema: GraphQLSchema,
  findings: Findings,
): SelectionNode {
  if (isScalarType(type) || isEnumType(type)) return { kind: "leaf", type };
  if (!isObjectType(type) && !isInterfaceType(type) && !isUnionType(type)) {
    return { kind: "leaf", type };
  }
  if (depth >= MAX_SELECTION_DEPTH) return cut(type, "depth", path, findings);
  if (seen.has(type.name)) return cut(type, "cycle", path, findings);
  const nested = new Set(seen).add(type.name);

  if (isObjectType(type)) {
    return { kind: "object", type, fields: fieldsOf(type, depth, nested, path, schema, findings) };
  }

  const possible = schema.getPossibleTypes(type);
  if (isInterfaceType(type) && possible.length === 0) {
    // An interface nothing implements is selectable only through its own fields.
    return { kind: "object", type, fields: fieldsOf(type, depth, nested, path, schema, findings) };
  }
  const own = isInterfaceType(type) ? fieldsOf(type, depth, nested, path, schema, findings) : [];
  const inherited = new Set(own.map((f) => f.name));
  const members: SelectionMember[] = possible.map((member) => {
    const memberPath = `${path}<${member.name}>`;
    if (nested.has(member.name)) {
      findings.cuts.push({ path: memberPath, type: member.name, reason: "cycle" });
      return { type: member, fields: undefined };
    }
    const memberSeen = new Set(nested).add(member.name);
    return {
      type: member,
      fields: fieldsOf(member, depth, memberSeen, memberPath, schema, findings, inherited),
    };
  });
  return { kind: "abstract", type, fields: own, members };
}

function fieldsOf(
  type: GraphQLObjectType | GraphQLInterfaceType,
  depth: number,
  seen: ReadonlySet<string>,
  path: string,
  schema: GraphQLSchema,
  findings: Findings,
  exclude: ReadonlySet<string> = new Set(),
): SelectionField[] {
  const out: SelectionField[] = [];
  for (const field of Object.values(type.getFields())) {
    if (exclude.has(field.name)) continue;
    if (requiresArguments(field)) {
      const key = `${type.name}.${field.name}`;
      if (!findings.omitted.has(key)) {
        const args = field.args
          .filter((arg) => isNonNullType(arg.type) && arg.defaultValue === undefined)
          .map((arg) => `${arg.name}: ${arg.type.toString()}`)
          .join(", ");
        findings.omitted.set(key, `${key}(${args})`);
      }
      continue;
    }
    out.push({
      name: field.name,
      type: field.type,
      description: field.description,
      node: select(
        getNamedType(field.type),
        depth + 1,
        seen,
        `${path}.${field.name}`,
        schema,
        findings,
      ),
    });
  }
  return out;
}

function cut(
  type: GraphQLNamedType,
  reason: SelectionCut,
  path: string,
  findings: Findings,
): SelectionNode {
  findings.cuts.push({ path, type: type.name, reason });
  return { kind: "cut", type, reason };
}

/* ------------------------------- the document ------------------------------ */

/** Render a node's selection set — ` { … }` — or nothing for a leaf. */
export function renderSelection(node: SelectionNode): string {
  switch (node.kind) {
    case "leaf":
      return "";
    case "cut":
      // `__typename` keeps the selection legal — an object selection may never
      // be empty — and says what was truncated.
      return " { __typename }";
    case "object":
      return node.fields.length === 0 ? " { __typename }" : ` { ${renderFields(node.fields)} }`;
    case "abstract": {
      // `__typename` first: it is what tells a caller which member came back.
      const parts = ["__typename"];
      if (node.fields.length > 0) parts.push(renderFields(node.fields));
      for (const member of node.members) {
        if (member.fields === undefined) {
          parts.push(`... on ${member.type.name} { __typename }`);
        } else if (member.fields.length > 0) {
          parts.push(`... on ${member.type.name} { ${renderFields(member.fields)} }`);
        }
      }
      return ` { ${parts.join(" ")} }`;
    }
  }
}

function renderFields(fields: readonly SelectionField[]): string {
  return fields.map((field) => `${field.name}${renderSelection(field.node)}`).join(" ");
}

/* -------------------------------- the schema ------------------------------- */

const BUILTIN_SCALARS: Record<string, JsonSchemaLike> = {
  Int: { type: "integer" },
  Float: { type: "number" },
  String: { type: "string" },
  Boolean: { type: "boolean" },
  ID: { type: "string", description: "GraphQL ID" },
};

export function scalarSchema(name: string): JsonSchemaLike {
  if (BUILTIN_SCALARS[name]) return { ...BUILTIN_SCALARS[name] };
  return { type: "string", description: `custom scalar ${name}` };
}

function ref(name: string): JsonSchemaLike {
  return { $ref: `#/components/schemas/${name}` };
}

/**
 * Whether a node's whole subtree is the type's canonical selection — every
 * field the component lists, each itself canonical. Only then may the schema
 * point at the component, because only then does the component describe what
 * this position returns.
 */
function isCanonical(node: SelectionNode, memo: Map<SelectionNode, boolean>): boolean {
  const known = memo.get(node);
  if (known !== undefined) return known;
  let result: boolean;
  switch (node.kind) {
    case "leaf":
      result = true;
      break;
    case "cut":
      result = false;
      break;
    case "object":
      result = node.fields.every((field) => isCanonical(field.node, memo));
      break;
    case "abstract":
      result =
        node.fields.every((field) => isCanonical(field.node, memo)) &&
        node.members.every(
          (member) => member.fields?.every((field) => isCanonical(field.node, memo)) === true,
        );
      break;
  }
  memo.set(node, result);
  return result;
}

/** The response schema for a root field, wrapped exactly as its declared type is. */
export function responseSchemaFor(
  field: GraphQLField<unknown, unknown>,
  selection: Selection,
  typenameOnlyName = TYPENAME_ONLY_SCHEMA,
): JsonSchemaLike {
  const memo = new Map<SelectionNode, boolean>();
  return wrapped(field.type, selection.root, 0, { memo, typenameOnlyName });
}

interface RenderContext {
  memo: Map<SelectionNode, boolean>;
  typenameOnlyName: string;
}

function wrapped(
  type: GraphQLOutputType,
  node: SelectionNode,
  depth: number,
  ctx: RenderContext,
): JsonSchemaLike {
  if (isNonNullType(type)) return wrapped(type.ofType, node, depth, ctx);
  if (isListType(type)) return { type: "array", items: wrapped(type.ofType, node, depth + 1, ctx) };
  return nodeSchema(node, depth, ctx);
}

function nodeSchema(node: SelectionNode, depth: number, ctx: RenderContext): JsonSchemaLike {
  switch (node.kind) {
    case "leaf":
      return isScalarType(node.type) ? scalarSchema(node.type.name) : ref(node.type.name);
    case "cut":
      return ref(ctx.typenameOnlyName);
    case "object":
      if (isCanonical(node, ctx.memo) || depth > INLINE_MAX_DEPTH) return ref(node.type.name);
      return inlineObject(node.type, node.fields, depth, ctx);
    case "abstract": {
      // The `oneOf` array and the member inside it are two more levels.
      if (isCanonical(node, ctx.memo) || depth + 2 > INLINE_MAX_DEPTH) return ref(node.type.name);
      return {
        oneOf: node.members.map((member) => memberSchema(node, member, depth + 2, ctx)),
        description: `${node.type.name}: __typename names which member was returned.`,
      };
    }
  }
}

function memberSchema(
  abstract: Extract<SelectionNode, { kind: "abstract" }>,
  member: SelectionMember,
  depth: number,
  ctx: RenderContext,
): JsonSchemaLike {
  if (member.fields === undefined) return ref(ctx.typenameOnlyName);
  const fields = [...abstract.fields, ...member.fields];
  const canonical = fields.every((field) => isCanonical(field.node, ctx.memo));
  if (canonical || depth > INLINE_MAX_DEPTH) return ref(member.type.name);
  return inlineObject(member.type, fields, depth, ctx);
}

function inlineObject(
  type: GraphQLObjectType | GraphQLInterfaceType,
  fields: readonly SelectionField[],
  depth: number,
  ctx: RenderContext,
): JsonSchemaLike {
  const properties: Record<string, JsonSchemaLike> = {};
  const required: string[] = [];
  for (const field of fields) {
    const schema = wrapped(field.type, field.node, depth + 2, ctx);
    if (field.description) schema.description = field.description;
    properties[field.name] = schema;
    if (isNonNullType(field.type)) required.push(field.name);
  }
  return {
    type: "object",
    title: type.name,
    properties,
    ...(required.length ? { required } : {}),
    ...(type.description ? { description: type.description } : {}),
  };
}

/** The component every cut position points at. */
export function typenameOnlySchema(): JsonSchemaLike {
  return {
    type: "object",
    description:
      "Only __typename is selected here: Anvil's compiled document stops at this position " +
      `(its selection is bounded to ${MAX_SELECTION_DEPTH} levels and never re-enters a type), ` +
      "so no other field of the object is returned. Fetch it through a root field of its own.",
    properties: {
      __typename: { type: "string", description: "The concrete GraphQL type of this object." },
    },
    required: ["__typename"],
  };
}

/** One line per cut, for the diagnostic: `order.customer.orders (cycle back to Customer)`. */
export function describeCut(record: SelectionCutRecord): string {
  const why =
    record.reason === "cycle"
      ? `cycle back to ${record.type}`
      : `depth budget of ${MAX_SELECTION_DEPTH} reached at ${record.type}`;
  return `${record.path} (${why})`;
}
