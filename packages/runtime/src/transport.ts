import type { ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { RetryCondition } from "@anvil/air";
import { DEFAULT_UPSTREAM_TIMEOUT_MS } from "./config.js";

export const MAX_UPSTREAM_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Client-certificate material for an outbound mTLS connection. PEM text. */
export interface TlsClientMaterial {
  cert: string;
  key: string;
  ca?: string;
}

/** How much longer than its own window a stream request may live before the
 *  transport aborts it outright. Enough to close cleanly, not enough to hold a
 *  socket open for a service that has stopped answering. */
const STREAM_TIMEOUT_GRACE_SECONDS = 5;

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Read a *stream* to a bound instead of waiting for the server to close.
   *
   * Present only for a `stream_source` operation. It inverts what reaching the
   * deadline means: for an ordinary request a timeout is a failure, because the
   * response never arrived; for a bounded window it is the success case, because
   * the window is the thing that was asked for. Whatever arrived is the result.
   */
  streamBound?: { maxEvents: number; maxSeconds: number };
  /**
   * A client certificate to present on this connection (`mtls` auth). Present
   * only after `applyAuth` merges resolved `AuthMaterial.tls` on; its presence
   * is what routes the request through `node:https` instead of `fetch` (Node's
   * global fetch has no client-cert seam without reaching for undici's Agent).
   */
  tls?: TlsClientMaterial;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** A transport-level failure, classified for retry and commit ambiguity. */
export class TransportError extends Error {
  readonly condition: RetryCondition;
  /**
   * `after_response` means the upstream accepted the request and began a
   * response, so a write may already have committed even though its body could
   * not be safely consumed.
   */
  readonly phase: "before_response" | "after_response";
  constructor(
    condition: RetryCondition,
    message: string,
    phase: "before_response" | "after_response" = "before_response",
  ) {
    super(message);
    this.name = "TransportError";
    this.condition = condition;
    this.phase = phase;
  }
}

/** Pluggable transport so the executor can be driven against mocks in tests. */
export interface Transport {
  send(req: HttpRequest): Promise<HttpResponse>;
}

/** Production transport over the platform `fetch` (undici on Node 22). */
export class FetchTransport implements Transport {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async send(req: HttpRequest): Promise<HttpResponse> {
    // A client certificate has no seam on the global fetch; node:https is the
    // only path that can present one. Everything else keeps using fetch,
    // unchanged — this is a routing decision, not a rewrite of either path.
    if (req.tls) return sendHttps(req, req.tls);
    const controller = new AbortController();
    // A stream's own window is its deadline; the request timeout is only the
    // backstop behind it. Left at the ordinary value, the abort would fire
    // first on any window at or past it — turning a subscription that
    // legitimately saw nothing into a timeout, and a retry-safe read into a
    // second connection that will do exactly the same thing.
    const streamCeilingMs = req.streamBound
      ? (req.streamBound.maxSeconds + STREAM_TIMEOUT_GRACE_SECONDS) * 1000
      : 0;
    const timeoutMs = Math.max(req.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS, streamCeilingMs);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
        // Never let fetch repeat a mutation or forward its idempotency/auth
        // carriers to a redirect target that has not passed host policy.
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400) {
        throw new TransportError(
          "connection_reset",
          "The upstream returned a redirect, which Anvil refused to follow.",
          // The original upstream received the request. For a mutation, its
          // state is therefore ambiguous even though no redirect was followed.
          "after_response",
        );
      }
      let body: string;
      try {
        body = req.streamBound
          ? await boundedStreamText(res, req.streamBound, MAX_UPSTREAM_RESPONSE_BYTES)
          : await boundedResponseText(res, MAX_UPSTREAM_RESPONSE_BYTES);
      } catch (err) {
        if (err instanceof TransportError) throw err;
        throw new TransportError(
          "connection_reset",
          "The upstream response body could not be consumed safely.",
          "after_response",
        );
      }
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return { status: res.status, headers, body };
    } catch (err) {
      if (err instanceof TransportError) throw err;
      throw classifyFetchError(err);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * The `node:https` path for a request carrying client-certificate material.
 * Same `HttpRequest`/`HttpResponse` contract, same byte cap
 * (`MAX_UPSTREAM_RESPONSE_BYTES`), same redirect refusal, and the same
 * `TransportError` conditions as `FetchTransport.send` — a caller cannot tell
 * which path served a call from its result. A `streamBound` request over this
 * path still gets the wider stream timeout ceiling and the byte cap, but does
 * not truncate at `maxEvents`/`maxSeconds` mid-stream the way the fetch/SSE
 * path does: mTLS + `stream_source` together is not this lane's target case,
 * and the byte cap plus timeout keep it safe rather than unbounded.
 */
function sendHttps(req: HttpRequest, tls: TlsClientMaterial): Promise<HttpResponse> {
  const url = new URL(req.url);
  const streamCeilingMs = req.streamBound
    ? (req.streamBound.maxSeconds + STREAM_TIMEOUT_GRACE_SECONDS) * 1000
    : 0;
  const timeoutMs = Math.max(req.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS, streamCeilingMs);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const nodeReq: ClientRequest = httpsRequest(
      {
        method: req.method,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers: req.headers,
        cert: tls.cert,
        key: tls.key,
        ca: tls.ca,
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          finish(() =>
            reject(
              new TransportError(
                "connection_reset",
                "The upstream returned a redirect, which Anvil refused to follow.",
                "after_response",
              ),
            ),
          );
          return;
        }
        const declaredLength = Number(res.headers["content-length"]);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_RESPONSE_BYTES) {
          res.destroy();
          finish(() =>
            reject(
              new TransportError(
                "connection_reset",
                "The upstream response exceeds the runtime byte limit.",
                "after_response",
              ),
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_UPSTREAM_RESPONSE_BYTES) {
            res.destroy();
            finish(() =>
              reject(
                new TransportError(
                  "connection_reset",
                  "The upstream response exceeds the runtime byte limit.",
                  "after_response",
                ),
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(", ");
          }
          finish(() => resolve({ status, headers, body: Buffer.concat(chunks).toString("utf8") }));
        });
        res.on("error", () => {
          finish(() =>
            reject(
              new TransportError(
                "connection_reset",
                "The upstream response body could not be consumed safely.",
                "after_response",
              ),
            ),
          );
        });
      },
    );
    nodeReq.on("timeout", () => {
      timedOut = true;
      nodeReq.destroy();
    });
    nodeReq.on("error", (err: Error) => {
      finish(() =>
        reject(
          timedOut
            ? new TransportError("timeout", "Request timed out before a response was received.")
            : classifyNodeHttpsError(err),
        ),
      );
    });
    if (req.body) nodeReq.write(req.body);
    nodeReq.end();
  });
}

/** Best-effort classification of a thrown `node:https` error into a retry condition. */
function classifyNodeHttpsError(err: unknown): TransportError {
  const e = err as { code?: string; message?: string };
  switch (e?.code) {
    case "ECONNRESET":
      return new TransportError("connection_reset", "The upstream connection was reset.");
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return new TransportError("dns_failure", "Upstream host could not be resolved.");
    case "ETIMEDOUT":
      return new TransportError("timeout", "The upstream connection timed out.");
    default:
      return new TransportError(
        "connection_reset",
        e?.message ?? "The upstream transport failed before a response.",
      );
  }
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new TransportError(
      "connection_reset",
      "The upstream response exceeds the runtime byte limit.",
      "after_response",
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new TransportError(
        "connection_reset",
        "The upstream response exceeds the runtime byte limit.",
        "after_response",
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Read a Server-Sent Events body until the window closes, and return what
 * arrived.
 *
 * Three things end it: the declared number of events, the declared elapsed
 * time, or the server closing the stream itself. None of them is an error —
 * that is the whole difference from `boundedResponseText`, which is reading
 * toward an end the server decides.
 *
 * The reader is always cancelled on the way out. A stream left open is a socket
 * held for the life of the process, and a server that keeps publishing into one
 * nobody reads is the leak this bound exists to prevent.
 */
async function boundedStreamText(
  response: Response,
  bound: { maxEvents: number; maxSeconds: number },
  maxBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const deadline = Date.now() + bound.maxSeconds * 1000;
  const decoder = new TextDecoder();
  let text = "";
  let events = 0;
  try {
    while (events < bound.maxEvents && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      // Race the read against the remaining window. Without this a silent
      // stream would block here until the socket died, long past the bound.
      const next = await Promise.race([
        reader.read(),
        new Promise<"deadline">((resolve) => {
          const timer = setTimeout(() => resolve("deadline"), remaining);
          // Never hold the event loop open for a window nobody is waiting on.
          timer.unref?.();
        }),
      ]);
      if (next === "deadline") break;
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
      if (text.length > maxBytes) {
        throw new TransportError(
          "connection_reset",
          "The upstream stream exceeds the runtime byte limit.",
          "after_response",
        );
      }
      // An SSE event is terminated by a blank line, so completed events are
      // countable without parsing them here — the codec owns their meaning.
      events = countSseEvents(text);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  // The loop condition alone does not enforce the bound: a burst can deliver
  // hundreds of events in a single socket read, so by the time the count is
  // checked the buffer already holds them all. The window is a promise about
  // what the caller receives, so it is applied to the bytes that leave here.
  return truncateToEvents(text, bound.maxEvents);
}

/** The prefix of an SSE buffer holding at most `maxEvents` complete events. */
function truncateToEvents(text: string, maxEvents: number): string {
  let seen = 0;
  for (const frame of sseFrames(text)) {
    if (!frame.isEvent) continue;
    seen += 1;
    if (seen === maxEvents) return text.slice(0, frame.end);
  }
  return text;
}

/**
 * The end offset of every *complete* frame in an SSE buffer, and whether each
 * one carries an event.
 *
 * Only a frame with a `data:` line is an event. A server holding an idle
 * subscription open sends keep-alive comments (`: ping`), which are frames on
 * the wire and nothing at all to a caller — counting them would let a silent
 * service exhaust a hundred-event window having published none. A trailing
 * partial frame has no boundary yet and is not counted either way.
 */
function sseFrames(text: string): Array<{ end: number; isEvent: boolean }> {
  const out: Array<{ end: number; isEvent: boolean }> = [];
  // Both line endings, because the SSE grammar allows either and a server that
  // sends CRLF would otherwise look like one endless frame.
  const boundary = /\r?\n\r?\n/g;
  let start = 0;
  let match = boundary.exec(text);
  while (match !== null) {
    const frame = text.slice(start, match.index);
    out.push({ end: match.index + match[0].length, isEvent: /(^|\n)data:/.test(frame) });
    start = match.index + match[0].length;
    match = boundary.exec(text);
  }
  return out;
}

function countSseEvents(text: string): number {
  return sseFrames(text).filter((f) => f.isEvent).length;
}

/** Best-effort classification of a thrown fetch error into a retry condition. */
export function classifyFetchError(err: unknown): TransportError {
  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string } };
  const code = e?.code ?? e?.cause?.code;
  if (e?.name === "AbortError" || e?.name === "TimeoutError") {
    return new TransportError("timeout", "Request timed out before a response was received.");
  }
  switch (code) {
    case "ECONNRESET":
      return new TransportError("connection_reset", "The upstream connection was reset.");
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return new TransportError("dns_failure", "Upstream host could not be resolved.");
    case "ETIMEDOUT":
      return new TransportError("timeout", "The upstream connection timed out.");
    default:
      return new TransportError(
        "connection_reset",
        e?.message ?? "The upstream transport failed before a response.",
      );
  }
}

/** In-memory transport for tests and mock scenarios. */
export type MockHandler = (req: HttpRequest, attempt: number) => HttpResponse | TransportError;

export class MockTransport implements Transport {
  private attempt = 0;
  readonly requests: HttpRequest[] = [];
  constructor(private readonly handler: MockHandler) {}

  async send(req: HttpRequest): Promise<HttpResponse> {
    this.attempt += 1;
    this.requests.push(req);
    const result = this.handler(req, this.attempt);
    if (result instanceof TransportError) throw result;
    return result;
  }
}
