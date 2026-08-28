import type { GraphqlSseBinding, GraphqlWireBinding } from "@anvil/air";
import {
  type GraphQLArgument,
  type GraphQLField,
  type GraphQLNamedType,
  type GraphQLOutputType,
  isEnumType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
} from "graphql";

/**
 * The GraphQL query document, built once at compile time.
 *
 * This is what makes GraphQL cheap where SOAP was expensive. A SOAP envelope
 * has to be assembled per call from namespaces and element names, so five
 * surfaces each needed an encoder. A GraphQL request is `{query, variables}` —
 * ordinary JSON — and the query is a pure function of the schema and the field.
 * So it is compiled here, stored on the operation, and every surface posts a
 * string it was handed. No client needs a GraphQL implementation of its own,
 * and the selection set is decided once, reviewably, rather than four times.
 *
 * It also closes the gap that made GraphQL look unrepresentable: AIR's
 * `output.schema` is depth-truncated to keep what an agent reads bounded, so it
 * cannot name the nested fields a selection set needs. That was never a limit
 * on the *model* — only on the agent-facing projection. The full SDL is right
 * here at compile time, which is where the selection set gets read.
 */

/** How deep a selection set may go before it stops descending.
 *
 *  A GraphQL schema is a graph, not a tree — `Order.customer.orders` is legal
 *  and infinite. Cycles are cut by the visited-set below; this bounds the
 *  merely-deep case, where a legitimate schema would otherwise produce a
 *  selection set nobody wants to read or transfer. */
const MAX_SELECTION_DEPTH = 4;

function namedTypeOf(type: GraphQLOutputType): GraphQLNamedType {
  let current: unknown = type;
  while (isNonNullType(current) || isListType(current)) {
    current = (current as { ofType: unknown }).ofType;
  }
  return current as GraphQLNamedType;
}

/**
 * The fields to ask for on this type.
 *
 * Fields that take required arguments are skipped: selecting one without its
 * arguments is a malformed document, and inventing values for it would be
 * Anvil making up a request. A field Anvil cannot ask for safely is a field it
 * does not ask for.
 */
function selectionFor(type: GraphQLNamedType, depth: number, seen: ReadonlySet<string>): string {
  if (isScalarType(type) || isEnumType(type)) return "";
  if (isUnionType(type)) {
    // A union has no fields of its own; `__typename` is the one thing always
    // selectable, and tells a caller which member came back.
    return " { __typename }";
  }
  if (!isObjectType(type) && !isInterfaceType(type)) return "";
  if (depth >= MAX_SELECTION_DEPTH || seen.has(type.name)) {
    // Cut rather than recurse. `__typename` keeps the selection legal — an
    // object selection may never be empty — and says what was truncated.
    return " { __typename }";
  }

  const nested = new Set(seen).add(type.name);
  const parts: string[] = [];
  for (const field of Object.values(type.getFields())) {
    if (field.args.some((arg) => isNonNullType(arg.type) && arg.defaultValue === undefined)) {
      continue;
    }
    parts.push(`${field.name}${selectionFor(namedTypeOf(field.type), depth + 1, nested)}`);
  }
  if (parts.length === 0) return " { __typename }";
  return ` { ${parts.join(" ")} }`;
}

/**
 * Build the document for one root field.
 *
 * Every argument becomes a declared variable, so no agent-supplied value is
 * ever interpolated into the query text. That is the same rule the SQL query
 * policy enforces one layer over, and for the same reason: a value spliced into
 * a statement is a value that can rewrite the statement.
 */
export function graphqlWireBinding(
  kind: "query" | "mutation" | "subscription",
  field: GraphQLField<unknown, unknown>,
): GraphqlWireBinding | GraphqlSseBinding | undefined {
  const operationName = `Anvil_${field.name.charAt(0).toUpperCase()}${field.name.slice(1)}`;
  const variables = field.args
    .map((arg: GraphQLArgument) => `$${arg.name}: ${arg.type.toString()}`)
    .join(", ");
  const argumentList = field.args.map((arg) => `${arg.name}: $${arg.name}`).join(", ");

  const selection = selectionFor(namedTypeOf(field.type), 0, new Set());
  const call = argumentList ? `${field.name}(${argumentList})` : field.name;
  const header = variables ? `${kind} ${operationName}(${variables})` : `${kind} ${operationName}`;

  // A subscription is the same document over a different wire: the request opts
  // into Server-Sent Events and the answer is a sequence of frames rather than
  // one JSON body. Nothing about *building* it differs, which is why one
  // builder serves all three kinds — only the protocol it is filed under.
  return {
    protocol: kind === "subscription" ? "graphql_sse" : "graphql",
    document: `${header} { ${call}${selection} }`,
    operationName,
    rootField: field.name,
  };
}
