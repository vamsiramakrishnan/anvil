/**
 * Caller-initiated cancellation of an in-flight execution.
 *
 * An `ExecuteContext.signal` is the caller's abort signal — over MCP, the one
 * the SDK trips when the client sends `notifications/cancelled` for the
 * request that is running this operation. The executor threads it onto the
 * wire request (`HttpRequest.signal`) so the transport can tear the upstream
 * connection down, and reads it at exactly two points in the retry loop: before
 * an attempt is sent, and when an attempt fails. A cancelled call is never
 * retried, because the caller has already said it no longer wants the answer.
 *
 * What this module owns is the REFUSAL a cancellation produces; its position
 * in the executor's gauntlet stays in the executor, like every other gate's.
 *
 * The code is the closed taxonomy's `policy_denied` — a local decision not to
 * proceed, never an upstream verdict — with the stable sub-code
 * `request/cancelled` in `details.code`, the same shape the fleet refusals use
 * rather than a seventeenth wire code every SDK would have to mirror. Whether
 * the request had already left is what an operator needs most, and it is the
 * one fact the runtime can state honestly: `details.upstream_outcome` is
 * `not_sent` when the abort landed before the attempt, and `unknown` when it
 * landed mid-flight — a mutation aborted after the bytes left may have
 * committed, which is why a cancelled mutation is never marked safe to retry.
 */
import type { Operation } from "@anvil/air";
import { AnvilError } from "./errors.js";
import { TransportError } from "./transport.js";

export const REQUEST_CANCELLED_CODE = "request/cancelled";

/** A cancellation observed BEFORE an attempt reached the transport. */
class CancelledBeforeSend extends TransportError {
  constructor() {
    super("connection_reset", "The caller cancelled the request before it was sent.");
    this.name = "CancelledBeforeSend";
  }
}

/** Refuse before an attempt leaves when the caller has already cancelled. */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CancelledBeforeSend();
}

/**
 * The terminal error for a failed attempt that will not be retried: a
 * cancellation refusal when the caller aborted, else the transport failure
 * the executor has always reported.
 */
export function transportFailureError(params: {
  op: Operation;
  traceId: string;
  err: TransportError;
  retrySafe: boolean;
  signal: AbortSignal | undefined;
}): AnvilError {
  const { op, traceId, err, retrySafe, signal } = params;
  if (signal?.aborted) {
    const sent = !(err instanceof CancelledBeforeSend);
    return new AnvilError({
      code: "policy_denied",
      message: sent
        ? `The caller cancelled ${op.id} after the request was sent; the upstream outcome is unknown.`
        : `The caller cancelled ${op.id} before the request was sent.`,
      operation: op.id,
      traceId,
      retryable: false,
      safeToRetry: sent ? false : retrySafe,
      details: { code: REQUEST_CANCELLED_CODE, upstream_outcome: sent ? "unknown" : "not_sent" },
    });
  }
  return new AnvilError({
    code: err.condition === "timeout" ? "upstream_timeout" : "upstream_unavailable",
    message: retrySafe
      ? `Upstream transport failed for ${op.id}.`
      : `Upstream transport failed for ${op.id} and this operation is not safe to auto-retry.`,
    operation: op.id,
    traceId,
    retryable: true,
    safeToRetry: retrySafe,
  });
}
