import type { GraphqlSseBinding, GraphqlWireBinding } from "@anvil/air";
import type { GraphQLArgument, GraphQLField } from "graphql";
import { renderSelection, type Selection } from "./graphql-selection.js";

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
 * The selection set itself comes from `graphql-selection.ts`, the same tree the
 * response schema is rendered from — which is what keeps the two from
 * disagreeing about what a call returns. This module only wraps it in the
 * operation header and argument list.
 */

/**
 * Build the document for one root field.
 *
 * Every argument becomes a declared variable, so no agent-supplied value is
 * ever interpolated into the query text. That is the same rule the SQL query
 * policy enforces one layer over, and for the same reason: a value spliced into
 * a statement is a value that can rewrite the statement.
 *
 * A binding always exists: every root field has a selection (at worst
 * `{ __typename }`), so there is no shape the compiler declines to encode and
 * therefore no "unencodable" outcome for a caller to handle.
 */
export function graphqlWireBinding(
  kind: "query" | "mutation" | "subscription",
  field: GraphQLField<unknown, unknown>,
  selection: Selection,
): GraphqlWireBinding | GraphqlSseBinding {
  const operationName = `Anvil_${field.name.charAt(0).toUpperCase()}${field.name.slice(1)}`;
  const variables = field.args
    .map((arg: GraphQLArgument) => `$${arg.name}: ${arg.type.toString()}`)
    .join(", ");
  const argumentList = field.args.map((arg) => `${arg.name}: $${arg.name}`).join(", ");

  const call = argumentList ? `${field.name}(${argumentList})` : field.name;
  const header = variables ? `${kind} ${operationName}(${variables})` : `${kind} ${operationName}`;

  // A subscription is the same document over a different wire: the request opts
  // into Server-Sent Events and the answer is a sequence of frames rather than
  // one JSON body. Nothing about *building* it differs, which is why one
  // builder serves all three kinds — only the protocol it is filed under.
  return {
    protocol: kind === "subscription" ? "graphql_sse" : "graphql",
    document: `${header} { ${call}${renderSelection(selection.root)} }`,
    operationName,
    rootField: field.name,
  };
}
