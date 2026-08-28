import { type Operation, wireExecutability } from "@anvil/air";
import { AnvilError } from "./errors.js";

/**
 * The transport gate: the runtime refuses to execute an operation whose wire
 * protocol it cannot speak.
 *
 * Until this existed, a WSDL-, GraphQL-, or proto-sourced operation reached
 * `buildRequest` like any other and was posted as JSON to a coordinate Anvil
 * had invented. Nothing refused, because nothing downstream could tell an
 * invented coordinate from a real one — see `@anvil/air`'s `wire.ts` for why
 * that is a missing concept rather than a per-protocol bug.
 *
 * It lives on the hot path, before the request is built, so the refusal is
 * structural: the CLI, the MCP server, and all four generated SDKs share this
 * executor, so none of them can send the lie by taking a different route.
 *
 * There is exactly one legitimate way past it, and it is a *declaration*, not
 * an inference: a protocol facade that genuinely serves the synthesized
 * coordinates over HTTP+JSON. Anvil's own generated mock is such a facade,
 * which is precisely why every hermetic lane passed a bundle that could never
 * make a real call. Declaring it names the assumption and records it on the
 * execution record; it does not make the refusal quieter.
 */
export function wireGateError(
  op: Operation,
  traceId: string,
  facade: string | undefined,
): AnvilError | undefined {
  const verdict = wireExecutability(op);
  if (verdict.ok) return undefined;
  // A facade declares that the base URL serves the synthesized *coordinates*
  // over HTTP+JSON. A subscription refuses for a different reason — no wire
  // binding, or no bound to make the window terminate — and neither is a fact
  // about coordinates, so no facade can supply it. Letting one through would
  // hand the SSE codec an operation with nothing to post.
  const facadeApplies = verdict.protocol !== "graphql_sse";
  if (facade !== undefined && facadeApplies) return undefined;
  return new AnvilError({
    code: "unsupported_operation",
    message:
      `Operation '${op.id}' speaks ${verdict.protocol}, which this runtime cannot put on the wire: ` +
      `${verdict.reason}. ${facadeApplies ? verdict.nextAction : ""}`.trimEnd(),
    operation: op.id,
    traceId,
    retryable: false,
    details: {
      wire_protocol: verdict.protocol,
      runtime_wire_protocol: "http_json",
      required_action: facadeApplies
        ? "declare a protocol facade, or deploy against a service this runtime can speak to"
        : "recompile the subscription so it carries a wire binding and a stream contract; a facade cannot bound a stream",
    },
  });
}

/** The audit line for a call that proceeded only because an operator declared a
 *  facade. A silent escape hatch would be worse than no gate at all: it would
 *  move the same untrue assumption behind a flag nobody can see afterwards. */
export function wireFacadeDecision(op: Operation, facade: string): string | undefined {
  const verdict = wireExecutability(op);
  if (verdict.ok) return undefined;
  return `protocol_facade_declared:${verdict.protocol}:${facade}`;
}
