import type { RetryCondition } from "@anvil/air";

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

/** A transport-level (pre-response) failure, classified for the retry engine. */
export class TransportError extends Error {
  readonly condition: RetryCondition;
  constructor(condition: RetryCondition, message: string) {
    super(message);
    this.name = "TransportError";
    this.condition = condition;
  }
}

/** Pluggable transport so the executor can be driven against mocks in tests. */
export interface Transport {
  send(req: HttpRequest): Promise<HttpResponse>;
}

/** Production transport over the platform `fetch` (undici on Node 22). */
export class FetchTransport implements Transport {
  async send(req: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timeout = req.timeoutMs ? setTimeout(() => controller.abort(), req.timeoutMs) : undefined;
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
      });
      const body = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return { status: res.status, headers, body };
    } catch (err) {
      throw classifyFetchError(err);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
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
