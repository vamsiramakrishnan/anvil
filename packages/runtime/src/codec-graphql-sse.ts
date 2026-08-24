import type { GraphqlSseBinding, Operation } from "@anvil/air";
import type { FaultAwareCodec, WireFault, WireParts } from "./codec.js";
import type { HttpRequest, HttpResponse } from "./transport.js";

/**
 * GraphQL subscriptions over Server-Sent Events (`graphql-sse`).
 *
 * The request is the same one a query makes — the compiled document plus the
 * caller's validated variables — with one header changed: `accept:
 * text/event-stream` is what asks the server for a subscription rather than a
 * single answer. Everything upstream of here (approval, host policy, auth,
 * the execution record) is identical, which is the point: a subscription is not
 * a second kind of call, it is the same call read to a bound.
 *
 * The transport hands this codec whatever arrived inside that bound, so decoding
 * is parsing frames out of a buffer rather than driving a live socket. That
 * keeps the streaming concern in exactly one place — `boundedStreamText` — and
 * leaves this a pure function of bytes, testable without a server.
 */

const SSE_CONTENT_TYPE = "application/json";

function bindingOf(op: Operation): GraphqlSseBinding {
  const binding = op.sourceRef.binding;
  if (binding?.protocol !== "graphql_sse") {
    // Unreachable through the executor — `wireExecutability` refuses a
    // subscription with no binding before a request is built.
    throw new Error(`operation '${op.id}' reached the SSE codec with no subscription binding`);
  }
  return binding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `data:` payloads of every complete frame, in order.
 *
 * Only complete frames — one terminated by a blank line. A window that closes
 * mid-frame leaves a partial JSON fragment in the buffer, and returning that as
 * an event would hand a caller a truncated object indistinguishable from a real
 * one. A frame Anvil did not see the end of is a frame it does not report.
 *
 * `event:`, `id:`, and `retry:` fields are skipped rather than surfaced. Only
 * `data` carries the payload in graphql-sse, and an `id` would only matter for
 * resumption, which this contract explicitly does not offer.
 */
export function sseDataFrames(body: string): string[] {
  // Normalise CRLF so a frame boundary is one shape, per the SSE grammar.
  const text = body.replace(/\r\n/g, "\n");
  const parts = text.split("\n\n");
  // Whatever follows the final boundary is a frame only if the buffer ended on
  // one. Otherwise it is a fragment the window cut mid-frame, and dropping it
  // must not depend on its JSON happening to be unparseable — a frame cut after
  // its closing brace parses perfectly and is still an event Anvil never saw
  // the end of.
  if (!text.endsWith("\n\n")) parts.pop();

  const frames: string[] = [];
  for (const raw of parts) {
    const lines = raw.split("\n").filter((line) => line.startsWith("data:"));
    if (lines.length === 0) continue;
    // A frame may carry several `data:` lines, joined with newlines.
    frames.push(lines.map((line) => line.slice(5).replace(/^ /, "")).join("\n"));
  }
  return frames;
}

/** Parse one frame's payload, or `undefined` when it is not JSON at all —
 *  a keep-alive comment or a server's own framing noise. */
function parseFrame(payload: string): Record<string, unknown> | undefined {
  if (payload.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(payload);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export const graphqlSseCodec: FaultAwareCodec = {
  protocol: "graphql_sse",

  encode(op: Operation, parts: WireParts): HttpRequest {
    const binding = bindingOf(op);
    const bound = op.stream;
    return {
      method: "POST",
      url: parts.baseUrl.replace(/\/$/, "") || "/",
      headers: {
        ...parts.headers,
        "content-type": SSE_CONTENT_TYPE,
        // The one header that makes this a subscription rather than a query.
        accept: "text/event-stream",
        // A proxy that buffers an event stream defeats the whole exchange: the
        // window would close having seen nothing, and report an idle service.
        "cache-control": "no-cache",
      },
      body: JSON.stringify({
        query: binding.document,
        operationName: binding.operationName,
        variables: isRecord(parts.body) ? parts.body : {},
      }),
      // Absent only if an operation reached here without a contract, which the
      // transport gate refuses upstream. Bounded either way — never unbounded.
      ...(bound
        ? { streamBound: { maxEvents: bound.maxEvents, maxSeconds: bound.maxSeconds } }
        : {}),
    };
  },

  /**
   * The events observed in the window, as an array.
   *
   * Always an array, including when it holds one element or none. A window that
   * saw a single event is not the same fact as a query that returned one object,
   * and collapsing them would let a caller write code that breaks the first time
   * the service is busy. An empty array is a real answer: nothing was published
   * while Anvil was listening.
   */
  decode(op: Operation, res: HttpResponse): unknown {
    if (!res.body) return [];
    const binding = op.sourceRef.binding;
    const root = binding?.protocol === "graphql_sse" ? binding.rootField : undefined;
    const events: unknown[] = [];
    for (const frame of sseDataFrames(res.body)) {
      const parsed = parseFrame(frame);
      if (!parsed) continue;
      // graphql-sse wraps each payload in the same `{data, errors}` envelope a
      // query answers with, so the root field is unwrapped exactly as there.
      const data = parsed.data;
      if (!isRecord(data)) continue;
      events.push(root !== undefined && root in data ? data[root] : data);
    }
    return events;
  },

  /**
   * A subscription reports failure the same way a query does — an `errors`
   * array — and it means the same thing here: the events in this window cannot
   * be trusted to be the events that occurred.
   *
   * Deliberately only the *first* frame is inspected. An error in frame one is
   * the subscription failing to start, which is a failed call. An error partway
   * through is one bad event inside a window that otherwise delivered, and
   * failing the whole call for it would discard good events the caller already
   * paid for — so those are dropped by `decode` and the window still returns.
   */
  faultIn(_op: Operation, res: HttpResponse): WireFault | undefined {
    if (!res.body) return undefined;
    const first = sseDataFrames(res.body)[0];
    if (first === undefined) return undefined;
    const parsed = parseFrame(first);
    if (!parsed) return undefined;
    const errors = parsed.errors;
    if (!Array.isArray(errors) || errors.length === 0) return undefined;

    const head = errors[0];
    const message =
      isRecord(head) && typeof head.message === "string"
        ? head.message
        : "the service refused the subscription";
    const extensions = isRecord(head) ? head.extensions : undefined;
    const code =
      isRecord(extensions) && typeof extensions.code === "string"
        ? extensions.code
        : "graphql_subscription_error";

    // Never retryable, for the same reason a GraphQL error never is: nothing in
    // the protocol distinguishes a transient failure from a permanent one, and
    // re-opening a subscription that already emitted is how a caller sees an
    // event twice under an at-most-once contract.
    return {
      code,
      message: errors.length > 1 ? `${message} (and ${errors.length - 1} more)` : message,
      retryable: false,
    };
  },
};
