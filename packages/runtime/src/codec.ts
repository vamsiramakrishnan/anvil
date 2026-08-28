import { type Operation, type WireProtocol, wireProtocolFor } from "@anvil/air";
import { graphqlCodec } from "./codec-graphql.js";
import { graphqlSseCodec } from "./codec-graphql-sse.js";
import { soapCodec } from "./codec-soap.js";
import type { HttpRequest, HttpResponse } from "./transport.js";

/**
 * The wire codec seam.
 *
 * `buildRequest` binds AIR's params and body against validated input, and then
 * has to turn that into bytes. Until this existed those last ten lines were the
 * whole of Anvil's transport knowledge: a URL concatenation, a content type,
 * and an unconditional `JSON.stringify`. Every non-REST source reached them
 * with a coordinate Anvil had invented and was serialized as if it were REST.
 *
 * The seam is deliberately here and not in `Transport`. `Transport.send` takes
 * an already-built `HttpRequest`, so a codec installed there would have to
 * reverse-engineer structured data back out of a JSON string. A codec needs the
 * operation and the bound values, which exist only at this point.
 *
 * Encoding and decoding are one interface on purpose: a protocol that wraps its
 * request in an envelope also wraps its response in one, and splitting them
 * invites a bundle that can ask a question it cannot read the answer to.
 */
export interface WireParts {
  /** Path template with placeholders already substituted. */
  path: string;
  query: URLSearchParams;
  /** Headers bound from AIR params, plus the runtime's own `accept`. */
  headers: Record<string, string>;
  /** The assembled request body, or undefined when the operation sends none. */
  body: unknown;
  hasBody: boolean;
  baseUrl: string;
}

export interface WireCodec {
  readonly protocol: WireProtocol;
  encode(op: Operation, parts: WireParts): HttpRequest;
  /**
   * Turn a 2xx response body into the value the operation's output contract
   * describes. Returning the raw text is a legitimate answer for a protocol
   * with no envelope; inventing structure is not.
   */
  decode(op: Operation, res: HttpResponse): unknown;
}

/**
 * Whether a decoded response is an application-level failure the transport
 * reported as success. HTTP says a 500 is an error and a 200 is not; SOAP
 * disagrees — a `soap:Fault` is a legitimately-delivered failure that must not
 * reach an agent as a result. Codecs that have no such notion return undefined.
 */
export interface WireFault {
  code: string;
  message: string;
  retryable: boolean;
}

export interface FaultAwareCodec extends WireCodec {
  faultIn(op: Operation, res: HttpResponse): WireFault | undefined;
}

export function isFaultAware(codec: WireCodec): codec is FaultAwareCodec {
  return typeof (codec as FaultAwareCodec).faultIn === "function";
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * HTTP with a JSON body — the protocol Anvil has always spoken, now stated
 * rather than assumed. Lifted verbatim from `buildRequest` so the refactor that
 * introduced this seam changed no bytes on the wire.
 */
const httpJsonCodec: WireCodec = {
  protocol: "http_json",
  encode(op, parts) {
    const base = parts.baseUrl.replace(/\/$/, "");
    const qs = parts.query.toString();
    const method = (op.sourceRef.method ?? "get").toUpperCase();
    const req: HttpRequest = {
      method,
      url: `${base}${parts.path}${qs ? `?${qs}` : ""}`,
      headers: parts.headers,
    };
    if (parts.hasBody) {
      req.headers["content-type"] = op.input.body?.contentType ?? "application/json";
      req.body = JSON.stringify(parts.body);
    }
    return req;
  },
  decode(_op, res) {
    return res.body ? safeJson(res.body) : null;
  },
};

/**
 * Registered at module load rather than by a caller. A runtime that can speak a
 * protocol but has not been told to would refuse calls it is perfectly able to
 * make, and that refusal would be indistinguishable from a real limitation.
 *
 * `codec-soap` imports only types from this module, so the value edge runs one
 * way and there is no cycle.
 */
const CODECS = new Map<WireProtocol, WireCodec>([
  [httpJsonCodec.protocol, httpJsonCodec],
  [soapCodec.protocol, soapCodec],
  [graphqlCodec.protocol, graphqlCodec],
  [graphqlSseCodec.protocol, graphqlSseCodec],
]);

/**
 * The codec for this operation, or undefined when the runtime has none. A
 * missing codec is never a reason to fall back to HTTP/JSON: that fallback is
 * precisely the bug this seam exists to make impossible.
 *
 * A declared protocol facade is the one case where the source protocol is not
 * the wire protocol. The operator is stating that the base URL is a translator
 * which really does serve these coordinates over HTTP+JSON — so the call on
 * *this* wire is HTTP+JSON, whatever the service behind the facade speaks.
 * Anvil's own generated mock is exactly such a translator, which is why the
 * hermetic lanes drive SOAP bundles through the JSON codec and are right to.
 *
 * A facade is a claim about *coordinates*, never about *framing*, so it does
 * not touch a subscription. `graphql_sse` reads a bounded event-stream window
 * and answers with an array; routing it through the JSON codec would drop the
 * `accept: text/event-stream` request, drop the stream bound that makes the
 * call terminate, and hand back one object where every other configuration of
 * the same operation hands back an array — the same operation meaning two
 * different things depending on an environment variable, which is the exact
 * divergence this codebase exists to prevent.
 */
export function codecFor(op: Operation, facadeDeclared = false): WireCodec | undefined {
  const protocol = wireProtocolFor(op.sourceRef);
  if (protocol === "graphql_sse") return graphqlSseCodec;
  if (facadeDeclared) return httpJsonCodec;
  return CODECS.get(protocol);
}
