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
export const WIRE_PROTOCOLS = ["http_json", "soap", "graphql", "grpc", "mcp_tool"] as const;
export type WireProtocol = (typeof WIRE_PROTOCOLS)[number];

/**
 * The one protocol Anvil's runtime — and therefore the CLI, the MCP server, and
 * all four generated SDKs, which share its decision core — can construct a
 * request for. `packages/runtime/src/executor.ts` builds `method`/`url` from
 * `sourceRef` and serializes the body with `JSON.stringify`, unconditionally.
 */
export const RUNTIME_WIRE_PROTOCOL = "http_json" as const satisfies WireProtocol;

const PROTOCOL_BY_SOURCE_KIND: Record<SourceKind, WireProtocol> = {
  openapi: "http_json",
  swagger: "http_json",
  discovery: "http_json",
  postman: "http_json",
  odata: "http_json",
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
  return PROTOCOL_BY_SOURCE_KIND[source.kind];
}

export type WireExecutability =
  | { ok: true }
  | { ok: false; protocol: WireProtocol; reason: string; nextAction: string };

const WHY_NOT: Record<Exclude<WireProtocol, "http_json">, string> = {
  soap:
    "Anvil speaks SOAP, but only for a document/literal binding whose messages " +
    "are described by element. This operation carries no wire binding, which " +
    "means its WSDL declared a shape Anvil declines to encode rather than " +
    "encode wrongly — check the compile diagnostics for which",
  graphql:
    "Anvil speaks GraphQL, but only for a query or mutation. This operation " +
    "carries no wire binding, which means it is a subscription — a long-lived " +
    "stream rather than a request and response, and Anvil has no streaming " +
    "client to hold one open",
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
  mcp_tool:
    "an adopted MCP tool is invoked by a tools/call over the MCP transport; it " +
    "has no path and no method, which the runtime would silently degrade to " +
    "GET on the base URL",
};

const NEXT_ACTION =
  "Point ANVIL_BASE_URL at a facade that really does serve these coordinates " +
  "over HTTP+JSON (Anvil's own generated mock is one such facade, which is why " +
  "the hermetic lanes pass), and declare it in words — `--protocol-facade " +
  "<reason>` on the generated CLI, ANVIL_PROTOCOL_FACADE on the generated " +
  "servers — so the assumption is recorded rather than assumed.";

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
  return {
    ok: false,
    protocol,
    reason: WHY_NOT[protocol],
    nextAction: NEXT_ACTION,
  };
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
  const byProtocol = new Map<WireProtocol, string[]>();
  for (const op of unexecutableWireOperations(operations)) {
    const verdict = wireExecutability(op);
    if (verdict.ok) continue;
    const ids = byProtocol.get(verdict.protocol) ?? [];
    ids.push(op.id);
    byProtocol.set(verdict.protocol, ids);
  }
  return [...byProtocol].map(([protocol, ids]) => {
    const reason = WHY_NOT[protocol as Exclude<WireProtocol, "http_json">];
    return (
      `${ids.length} approved operation(s) speak ${protocol}, which this runtime cannot ` +
      `put on the wire — ${reason}. Affected: ${ids.join(", ")}. ${NEXT_ACTION}`
    );
  });
}
