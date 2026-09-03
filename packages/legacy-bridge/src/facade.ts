import { randomUUID } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { QueueRequestReplyWireBinding } from "@anvil/air";
import type { LegacyCapabilityBinding } from "@anvil/compiler/legacy";
import {
  type QueueBrokerClient,
  QueueBrokerTimeoutError,
  QueueBrokerTransportError,
  requestReplyWithTimeout,
} from "./broker.js";
import { assertWireBindingMatchesLegacyBinding } from "./wire-binding.js";

const MAX_BODY_BYTES = 1 * 1024 * 1024;

export interface LegacyBridgeTelemetryRecord {
  operation: string;
  target: string;
  outcome: "success" | "timeout" | "transport_error";
  latencyMs: number;
}

export interface LegacyBridgeFacadeOptions {
  /** The approved binding this facade serves. Never proxied through — every
   *  response is shaped from this and the wire binding, never from a caller
   *  argument. */
  binding: LegacyCapabilityBinding;
  wireBinding: QueueRequestReplyWireBinding;
  client: QueueBrokerClient;
  /** Structured, payload-free execution telemetry — see `wireBinding`'s own
   *  case in `LegacyBridgePlan.conformance` ("telemetry") for why no body or
   *  header value is ever a field here. */
  onTelemetry?: (record: LegacyBridgeTelemetryRecord) => void;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Build the HTTP facade for one approved binding.
 *
 * This is the "protocol facade" `@anvil/air`'s `wire.ts` already documents
 * for a gRPC JSON transcoder: the runtime's existing HTTP/JSON codec speaks
 * to it unmodified once an operator declares `--protocol-facade` (or
 * `ANVIL_PROTOCOL_FACADE`), so nothing in `packages/runtime` has to change
 * for this to be callable. What this function returns is a plain
 * `http.RequestListener` — the runtime, and this package's own conformance
 * runner, both drive it the same way.
 *
 * The whole request handler makes **exactly one** `client.requestReply` call
 * per HTTP request, unconditionally — there is no retry loop, no backoff, no
 * "try again on a transient failure" anywhere in this file. That is not an
 * oversight to fix later; it is the property the lane's third safety proof
 * depends on. Whether a *caller* retries (the runtime, bound by the
 * operation's own `retries` policy) is a decision this facade has no part in
 * and no visibility into.
 */
export function createLegacyBridgeFacade(options: LegacyBridgeFacadeOptions): RequestListener {
  // Refuses to even start serving a wire binding that isn't provably the one
  // reviewed binding it claims to execute (deliverable 1's coherence rule).
  assertWireBindingMatchesLegacyBinding(options.wireBinding, options.binding);
  const { binding, wireBinding, client, onTelemetry } = options;

  return (req, res) => {
    void handle(req, res);
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/readyz") {
      // No live discovery in this deployment-local process — see docs. Ready
      // means "constructed with a coherent binding and a broker client,"
      // never "the broker is reachable," which nothing here can observe.
      sendJson(res, 200, { ready: true, operation: binding.operation.name });
      return;
    }
    if (url.pathname !== "/invoke") {
      sendJson(res, 404, { code: "not_found", message: `No route for '${url.pathname}'.` });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, {
        code: "unsupported_operation",
        message: "Only POST /invoke is served.",
      });
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 413, {
        code: "validation_error",
        message: err instanceof Error ? err.message : "invalid request body",
      });
      return;
    }

    // The caller's own inbound `Idempotency-Key` (Anvil's runtime sends the
    // reviewed idempotency carrier as a header when the mode requires one —
    // see @anvil/air's idempotency-carrier.ts) becomes the message
    // correlation/dedup value. Its absence is not refused: a read or a
    // naturally-idempotent operation carries no key, and every call still
    // needs *some* value to correlate its own reply, so one is generated —
    // it just can never collide with a caller-supplied key across calls,
    // which is exactly what replay is supposed to do for a repeated one.
    const idempotencyKey = req.headers["idempotency-key"];
    const key =
      typeof idempotencyKey === "string" && idempotencyKey.length > 0
        ? idempotencyKey
        : randomUUID();

    const start = performance.now();
    try {
      const reply = await requestReplyWithTimeout(
        client,
        {
          requestDestination: wireBinding.requestDestination,
          correlationField: wireBinding.reply.correlationField,
          idempotencyKey: key,
          body,
        },
        wireBinding.timeoutMs,
      );
      onTelemetry?.({
        operation: binding.operation.name,
        target: wireBinding.requestDestination,
        outcome: "success",
        latencyMs: performance.now() - start,
      });
      const text = reply.body;
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(text, "utf8"),
      });
      res.end(text);
    } catch (err) {
      const latencyMs = performance.now() - start;
      if (err instanceof QueueBrokerTimeoutError) {
        onTelemetry?.({
          operation: binding.operation.name,
          target: wireBinding.requestDestination,
          outcome: "timeout",
          latencyMs,
        });
        // 504: the one status the runtime's own `httpStatusToRetryCondition`
        // and `httpStatusToErrorCode` (packages/runtime) already map to
        // `upstream_timeout` — nothing about that mapping needed to change
        // for this facade to report through it correctly.
        sendJson(res, 504, {
          code: "upstream_timeout",
          message: `No reply for '${binding.operation.name}' within ${wireBinding.timeoutMs}ms.`,
          operation: binding.operation.name,
          retryable: false,
        });
        return;
      }
      const transportMessage =
        err instanceof QueueBrokerTransportError
          ? "The broker refused or failed this exchange."
          : "The bridge failed to complete this exchange.";
      onTelemetry?.({
        operation: binding.operation.name,
        target: wireBinding.requestDestination,
        outcome: "transport_error",
        latencyMs,
      });
      sendJson(res, 502, {
        code: "upstream_unavailable",
        message: transportMessage,
        operation: binding.operation.name,
        retryable: false,
      });
    }
  }
}
