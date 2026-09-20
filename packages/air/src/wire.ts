import { bodyEncodingFor, SUPPORTED_BODY_CONTENT_TYPES } from "./body-encoding.js";
import type { SourceKind } from "./enums.js";
import type { Operation, SourceRef } from "./schema.js";

/**
 * The wire protocol a real call to an operation must actually speak.
 *
 * AIR has always modelled where an operation *came from* — `SourceRef.kind` is
 * a source-document format. It never modelled what a call to it must *look like
 * on the wire*, and those are not the same question. Every non-REST adapter
 * lowers its source into a synthetic OpenAPI `paths` object by inventing a path
 * and hardcoding `post` (wsdl.ts, graphql.ts, grpc.ts), `normalize.ts` copies
 * that fiction into `sourceRef`, and the runtime executes it literally: JSON
 * over HTTP to a coordinate no server has ever served.
 *
 * That is not a SOAP bug. It is a missing concept, and its absence is why every
 * gate downstream agreed: the generated mock is built from the same `sourceRef`,
 * so the hermetic lanes confirm the bundle is faithful to a model that is itself
 * unfaithful to reality. A SOAP bundle with `servers: []` certified 38/38.
 *
 * This module is the concept. It is *derived*, never stored, for two reasons:
 * a derived fact cannot be spoofed by a hand-edited `air.json`, and it adds no
 * field to `AirDocument`, so `contractHash` is unchanged and no stored
 * certification expires on the day the concept arrives.
 */
export const WIRE_PROTOCOLS = [
  "http_json",
  "soap",
  "graphql",
  "graphql_sse",
  "grpc",
  "mcp_tool",
  "queue_request_reply",
] as const;
export type WireProtocol = (typeof WIRE_PROTOCOLS)[number];

/**
 * The one protocol Anvil's runtime — and therefore the CLI, the MCP server, and
 * all four generated SDKs, which share its decision core — can construct a
 * request for. `packages/runtime/src/executor.ts` builds `method`/`url` from
 * `sourceRef`; the body is encoded per its declared content type (see
 * `body-encoding.ts`), and a content type with no encoding is refused.
 */
export const RUNTIME_WIRE_PROTOCOL = "http_json" as const satisfies WireProtocol;

const PROTOCOL_BY_SOURCE_KIND: Record<SourceKind, WireProtocol> = {
  openapi: "http_json",
  swagger: "http_json",
  discovery: "http_json",
  postman: "http_json",
  odata: "http_json",
  har: "http_json",
  wsdl: "soap",
  graphql: "graphql",
  protobuf: "grpc",
  mcp: "mcp_tool",
};

/**
 * What a real call to this operation must speak. Total over `SourceKind`, so
 * there is no "unknown" case to fall through: a source format Anvil can parse
 * is a source format whose wire protocol Anvil knows.
 *
 * A REST facade in front of a SOAP or gRPC service does not change this answer.
 * The protocol is a property of the *service the spec describes*; a facade is a
 * property of the *deployment*, declared by an operator (see `WireExecutability`)
 * rather than inferred from a document that cannot know about it.
 *
 * The one thing that *does* change the answer is the source document declaring
 * its own HTTP mapping. A proto method carrying `google.api.http` names the
 * verb and path a gateway serves, the compiler lowers the operation to exactly
 * that route, and what goes on the wire is then JSON over HTTP with nothing
 * gRPC about it. That is not a facade being assumed — it is the spec being
 * read, the same standing as a WSDL's `soap:address`. Answering from the
 * binding here is what lets every surface inherit it at once: the runtime
 * resolves the ordinary JSON codec, all four SDKs take their existing
 * `http_json` path, and certification stops reporting it as unreachable —
 * without one line of per-protocol branching in any of them.
 */
export function wireProtocolFor(source: SourceRef): WireProtocol {
  if (source.binding?.protocol === "grpc" && source.binding.transport === "http_rule") {
    return RUNTIME_WIRE_PROTOCOL;
  }
  // A GraphQL *subscription* is a different wire from a query against the same
  // endpoint — Server-Sent Events rather than one JSON response — so the
  // binding names it and the source format does not.
  if (source.binding?.protocol === "graphql_sse") return "graphql_sse";
  // A queue request/reply binding has no `SourceKind` of its own — nothing in
  // `PROTOCOL_BY_SOURCE_KIND` maps to it, because legacy candidates do not
  // compile through the ordinary spec pipeline this table describes. The
  // binding alone is the fact, same as `graphql_sse` above.
  if (source.binding?.protocol === "queue_request_reply") return "queue_request_reply";
  return PROTOCOL_BY_SOURCE_KIND[source.kind];
}

/**
 * What a refusal is *about*, which decides whether a declared protocol facade
 * can answer it.
 *
 * `coordinates`: Anvil knows exactly what the call is and only lacks an address
 * that serves it over HTTP+JSON — a gRPC method with an assumed transcoder, a
 * queue request/reply exchange behind a bridge. An operator can point the base
 * URL at such a translator and say so.
 *
 * `framing`: the compiler declined to encode the call at all — a streaming
 * RPC, an rpc/encoded SOAP binding, a subscription with no bound, a tool with
 * no path or method. There is no request for a translator to receive, so a
 * facade has nothing to declare and must not be allowed to.
 */
export type WireRefusalScope = "coordinates" | "framing";

export type WireExecutability =
  | { ok: true }
  | {
      ok: false;
      protocol: WireProtocol;
      scope: WireRefusalScope;
      reason: string;
      nextAction: string;
    };

const WHY_NOT: Record<Exclude<WireProtocol, "http_json">, string> = {
  soap:
    "Anvil speaks SOAP, but only for a document/literal binding whose messages " +
    "are described by element. This operation carries no wire binding, which " +
    "means its WSDL declared a shape Anvil declines to encode rather than " +
    "encode wrongly — check the compile diagnostics for which",
  graphql:
    "Anvil speaks GraphQL for a query or a mutation over one JSON response, " +
    "and for a subscription over a bounded Server-Sent Events window. The " +
    "compiler records a wire binding for every root field it lowers — there " +
    "is no GraphQL shape it declines — so an operation without one was not " +
    "compiled from its SDL by this compiler: it was hand-written, or produced " +
    "before wire bindings existed. Recompile from the SDL rather than editing " +
    "a binding in by hand",
  grpc:
    "unlike the other protocols, this path is real — it is gRPC's own :path — " +
    "but a native call is length-prefixed protobuf over HTTP/2 with the status " +
    "in trailers, and Anvil cannot emit that from four zero-dependency clients " +
    "because Python's standard library has no HTTP/2 client. Two things do " +
    "work. If the proto method carries a `google.api.http` option, Anvil reads " +
    "it and calls the declared route with no further ceremony, so an operation " +
    "still refusing here means the proto declared no rule — or declared one " +
    "Anvil would have had to guess at, which the compile diagnostics name. " +
    "Failing that, a JSON transcoder (grpc-gateway, Envoy's gRPC-JSON filter) " +
    "accepts JSON on this exact path and speaks protobuf onward — declare one " +
    "and Anvil calls it",
  graphql_sse:
    "a GraphQL subscription is observed through a bounded window — the call " +
    "collects events until the stream contract's event or time bound and " +
    "returns them. This operation carries no such contract, so there is " +
    "nothing to make it terminate, and a call that never returns is not a " +
    "call. Note that only the runtime reads this wire: the generated clients " +
    "are request/response and refuse it by design, which is them agreeing it " +
    "is unreachable from a stateless client rather than disagreeing about it",
  mcp_tool:
    "an adopted MCP tool is invoked by a tools/call over the MCP transport; it " +
    "has no path and no method, which the runtime would silently degrade to " +
    "GET on the base URL",
  queue_request_reply:
    "this operation is a reviewed legacy capability bridged over a message " +
    "queue — a request published to one destination and a reply correlated " +
    "back from another. There is no URL or verb in that exchange for a JSON " +
    "codec to construct, so Anvil never speaks it directly; a deployment-local " +
    "bridge (@anvil/legacy-bridge) that actually performs the request/reply " +
    "exchange and answers over HTTP+JSON is the one legitimate way onward",
};

const NEXT_ACTION =
  "Point ANVIL_BASE_URL at a facade that really does serve these coordinates " +
  "over HTTP+JSON (Anvil's own generated mock is one such facade, which is why " +
  "the hermetic lanes pass), and declare it in words — `--protocol-facade " +
  "<reason>` on the generated CLI, ANVIL_PROTOCOL_FACADE on the generated " +
  "servers — so the assumption is recorded rather than assumed.";

const FRAMING_NEXT_ACTION =
  "No protocol facade can supply this: the refusal is about how the call is " +
  "framed, not where it is sent, so declaring one is refused too. Fix the " +
  "source document the compile diagnostics name and recompile.";

/**
 * The scope of a refusal for a protocol that has no executable binding. A
 * binding the compiler *recorded* but the runtime cannot speak natively is a
 * coordinates problem; a binding the compiler *declined to record* is framing.
 */
function refusalScope(op: Operation, protocol: WireProtocol): WireRefusalScope {
  const binding = op.sourceRef.binding;
  if (protocol === "grpc") {
    // A recorded `json_transcoded` binding is the compiler's own statement that
    // a translator is assumed. No binding at all means the proto declared a
    // stream, or an HTTP rule Anvil would have had to guess at.
    return binding?.protocol === "grpc" ? "coordinates" : "framing";
  }
  if (protocol === "queue_request_reply") return "coordinates";
  return "framing";
}

/**
 * Whether the HTTP/JSON runtime can put a faithful request for this operation
 * on the wire. The refusal carries its own next action, because a refusal an
 * operator cannot act on is just a different way of being unhelpful.
 */
export function wireExecutability(op: Operation): WireExecutability {
  const protocol = wireProtocolFor(op.sourceRef);
  if (protocol === RUNTIME_WIRE_PROTOCOL) return { ok: true };
  // SOAP is executable exactly when the compiler recovered a wire binding from
  // the source document. A binding is absent for the shapes the WSDL adapter
  // declines to encode — rpc, encoded, or a message described by type rather
  // than element — so those keep refusing rather than being encoded on a guess.
  // A protocol is executable exactly when the compiler recovered a binding for
  // it. A binding is absent for the shapes each adapter declines to encode —
  // an rpc/encoded SOAP binding, a GraphQL subscription — so those keep
  // refusing rather than being encoded on a guess.
  if (protocol === "soap" && op.sourceRef.binding?.protocol === "soap") return { ok: true };
  if (protocol === "graphql" && op.sourceRef.binding?.protocol === "graphql") return { ok: true };
  // A subscription is executable exactly when it is *bounded*: the stream
  // contract is what turns "listen forever" into one call with one result.
  if (
    protocol === "graphql_sse" &&
    op.sourceRef.binding?.protocol === "graphql_sse" &&
    op.stream !== undefined
  ) {
    return { ok: true };
  }
  const scope = refusalScope(op, protocol);
  return {
    ok: false,
    protocol,
    scope,
    reason: WHY_NOT[protocol],
    nextAction: scope === "coordinates" ? NEXT_ACTION : FRAMING_NEXT_ACTION,
  };
}

/**
 * Whether a declared protocol facade may carry this operation over HTTP+JSON.
 * True for an operation the runtime speaks anyway (the facade is then merely
 * recorded) and for a coordinates refusal; false for a framing refusal, which
 * no address can answer. Read by the runtime's gate and its codec resolution
 * together, so the gate can never let through what the codec then encodes as
 * JSON on a guess.
 */
export function protocolFacadeApplies(op: Operation): boolean {
  const verdict = wireExecutability(op);
  return verdict.ok || verdict.scope === "coordinates";
}

/**
 * Why the HTTP/JSON runtime cannot encode this operation's request body, or
 * undefined when it can (or when another codec owns the framing). A body is
 * refused on its declared content type alone: the codec that would have
 * labelled JSON as a form is the one this check exists to keep off the wire.
 */
export function bodyContentTypeIssue(op: Operation): string | undefined {
  const body = op.input.body;
  if (!body || wireProtocolFor(op.sourceRef) !== RUNTIME_WIRE_PROTOCOL) return undefined;
  if (bodyEncodingFor(body.contentType)) return undefined;
  return (
    `its request body is declared as '${body.contentType}', which Anvil's HTTP/JSON runtime ` +
    `does not encode — only ${SUPPORTED_BODY_CONTENT_TYPES} bodies are put on the wire`
  );
}

/** The approved operations whose request body the runtime cannot encode. */
export function unencodableBodyOperations(operations: readonly Operation[]): Operation[] {
  return operations.filter(
    (op) => op.state === "approved" && bodyContentTypeIssue(op) !== undefined,
  );
}

/** The approved operations whose wire protocol the runtime cannot speak. The
 *  filter is `approved` because an unapproved operation is already refused by
 *  the approval gate — this asks the next question, of the surface that is
 *  actually exposed. */
export function unexecutableWireOperations(operations: readonly Operation[]): Operation[] {
  return operations.filter((op) => op.state === "approved" && !wireExecutability(op).ok);
}

/**
 * The refusal lines both certification engines report, grouped by protocol so a
 * fifty-operation WSDL yields one line and not fifty copies of the same
 * paragraph. Shared rather than restated: a check that re-derives what a
 * protocol means is a check that can disagree with the runtime about it.
 */
export function unexecutableWireFailures(operations: readonly Operation[]): string[] {
  const byProtocol = new Map<WireProtocol, { ids: string[]; nextAction: string }>();
  for (const op of unexecutableWireOperations(operations)) {
    const verdict = wireExecutability(op);
    if (verdict.ok) continue;
    const group = byProtocol.get(verdict.protocol) ?? { ids: [], nextAction: verdict.nextAction };
    group.ids.push(op.id);
    byProtocol.set(verdict.protocol, group);
  }
  const lines = [...byProtocol].map(([protocol, { ids, nextAction }]) => {
    const reason = WHY_NOT[protocol as Exclude<WireProtocol, "http_json">];
    return (
      `${ids.length} approved operation(s) speak ${protocol}, which this runtime cannot ` +
      `put on the wire — ${reason}. Affected: ${ids.join(", ")}. ${nextAction}`
    );
  });
  // A body the runtime cannot encode is the same class of fact as a protocol
  // it cannot speak: the call would be refused before a credential is read.
  // Reported through the same seam so both certification engines see it.
  const byContentType = new Map<string, string[]>();
  for (const op of unencodableBodyOperations(operations)) {
    const contentType = op.input.body?.contentType ?? "";
    const ids = byContentType.get(contentType) ?? [];
    ids.push(op.id);
    byContentType.set(contentType, ids);
  }
  for (const [contentType, ids] of byContentType) {
    lines.push(
      `${ids.length} approved operation(s) declare a '${contentType}' request body, which this ` +
        `runtime does not encode — only ${SUPPORTED_BODY_CONTENT_TYPES} bodies are put on the ` +
        `wire. Affected: ${ids.join(", ")}. Re-declare the body in an encodable content type, ` +
        "or leave the operation unapproved.",
    );
  }
  return lines;
}
