import { type QueueRequestReplyWireBinding, WireBinding } from "@anvil/air";
import type { LegacyCapabilityBinding } from "@anvil/compiler/legacy";

/** Refused when a reviewed binding's transport cannot become a queue
 *  request/reply wire binding — never silently coerced. */
export class LegacyBridgeShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyBridgeShapeError";
  }
}

/**
 * Derive the AIR `QueueRequestReplyWireBinding` a reviewed legacy binding
 * executes. This is the seam between the two halves of deliverable 1: the
 * schema in `@anvil/air` names the shape, and this is the one place a
 * concrete value is built for it — always from a reviewed
 * `LegacyCapabilityBinding`, never authored by hand, so
 * `legacyBindingContentHash` is always the true content hash of what it was
 * derived from rather than a value a caller could spoof.
 */
export function buildQueueWireBinding(
  binding: LegacyCapabilityBinding,
): QueueRequestReplyWireBinding {
  if (binding.transport.kind !== "message") {
    throw new LegacyBridgeShapeError(
      `binding '${binding.bindingId}' has transport kind '${binding.transport.kind}', not 'message' — ` +
        "the queue bridge only executes a message transport.",
    );
  }
  const { reply } = binding.transport;
  if (reply.mode === "none") {
    throw new LegacyBridgeShapeError(
      `binding '${binding.bindingId}' declares no reply strategy — a request/reply bridge needs one.`,
    );
  }
  if (reply.mode === "poll_status") {
    throw new LegacyBridgeShapeError(
      `binding '${binding.bindingId}' completes by polling status, not a correlated reply — ` +
        "that is a different interaction pattern than this bridge executes.",
    );
  }
  if (!reply.correlationField) {
    throw new LegacyBridgeShapeError(
      `binding '${binding.bindingId}' declares no reply correlation field.`,
    );
  }

  const wireBinding = WireBinding.parse({
    protocol: "queue_request_reply",
    legacyBindingContentHash: binding.contentHash,
    requestDestination: binding.transport.target,
    reply:
      reply.mode === "reply_to"
        ? {
            mode: "reply_to",
            ...(reply.target ? { destination: reply.target } : {}),
            correlationField: reply.correlationField,
          }
        : {
            mode: "fixed_destination",
            destination: reply.target ?? "",
            correlationField: reply.correlationField,
          },
    // No per-field schema refs are captured on the reviewed binding today —
    // the operation's own inputSchema/outputSchema (LegacyBusinessOperation)
    // are the reviewed contract, referenced by this fixed pointer convention
    // rather than duplicated onto the wire binding.
    requestSchemaRef: "#/operation/inputSchema",
    responseSchemaRef: "#/operation/outputSchema",
    timeoutMs: binding.semantics.timeoutMs,
    // Both the facade and the in-process double correlate and dedup on the
    // same value (see broker.ts), so `correlation_id` is the honest answer
    // regardless of the reviewed idempotency mode — there is no case in this
    // implementation where a message id is tracked separately from it.
    idempotency: { carrier: "correlation_id" },
  }) as QueueRequestReplyWireBinding;

  if (
    reply.mode === "fixed_destination" &&
    (wireBinding.reply as { destination?: string }).destination === ""
  ) {
    throw new LegacyBridgeShapeError(
      `binding '${binding.bindingId}' uses a fixed reply destination but declares none.`,
    );
  }
  return wireBinding;
}

/**
 * The coherence check deliverable 1 exists for: refuse to serve a wire
 * binding whose reviewed content hash does not match the binding actually
 * supplied. `buildQueueWireBinding` above always derives a matching one, so
 * this only fires when a caller hand-assembles or persists a wire binding
 * separately from the binding it claims to execute — exactly the case a
 * deployment-local process restarting from disk must guard against.
 */
export function assertWireBindingMatchesLegacyBinding(
  wireBinding: QueueRequestReplyWireBinding,
  binding: LegacyCapabilityBinding,
): void {
  if (wireBinding.legacyBindingContentHash !== binding.contentHash) {
    throw new LegacyBridgeShapeError(
      `wire binding is bound to content hash '${wireBinding.legacyBindingContentHash}', which does ` +
        `not match the supplied binding's content hash '${binding.contentHash}' — refusing to serve ` +
        "an unreviewed or since-changed candidate.",
    );
  }
}
