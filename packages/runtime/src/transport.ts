import type { RetryCondition } from "@anvil/air";
import { DEFAULT_UPSTREAM_TIMEOUT_MS } from "./config.js";

export const MAX_UPSTREAM_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs?: number;
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
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
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
        body = await boundedResponseText(res, MAX_UPSTREAM_RESPONSE_BYTES);
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
