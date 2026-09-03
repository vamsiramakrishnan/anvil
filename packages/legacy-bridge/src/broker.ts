/**
 * The broker seam.
 *
 * `@anvil/legacy-bridge` never talks to a queue directly — every place that
 * needs to send a request and wait for a correlated reply goes through this
 * one interface. That is what makes the real client (`stomp-client.ts`) and
 * the deterministic test double (`broker-double.ts`) interchangeable: the
 * facade (`facade.ts`) and the conformance runner (`conformance.ts`) are
 * written once, against `QueueBrokerClient`, and never learn which one they
 * were handed.
 */

/** One request/reply exchange, already reduced to what any broker needs. */
export interface QueueRequestReplyOptions {
  /** Where the request message is published. */
  requestDestination: string;
  /** The message header the reply is correlated on — carried through so a
   *  real client can set it; the in-process double ignores it (it correlates
   *  by `idempotencyKey` directly, having no wire to lose the association
   *  over). */
  correlationField: string;
  /** The value carried as the message id or correlation id, per the reviewed
   *  binding's `idempotency.carrier`. Doubles as the replay dedup key: two
   *  exchanges with the same value are the same logical send. */
  idempotencyKey: string;
  /** The request message body, forwarded byte-for-byte. */
  body: string;
}

export interface QueueReply {
  /** The reply message body, forwarded byte-for-byte. */
  body: string;
}

/** What any broker transport must do: publish one request, return one reply. */
export interface QueueBrokerClient {
  requestReply(options: QueueRequestReplyOptions): Promise<QueueReply>;
}

/** A queue transport failure — connection refused, channel closed, malformed
 *  frame. Never thrown for "no reply arrived in time"; that is
 *  `QueueBrokerTimeoutError`, a different failure a caller must map to a
 *  different structured error. */
export class QueueBrokerTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueBrokerTransportError";
  }
}

export class QueueBrokerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueBrokerTimeoutError";
  }
}

/**
 * Enforce the reviewed timeout around any `QueueBrokerClient`, uniformly.
 *
 * The timeout is bridge-side by design: a broker client (real or double) only
 * has to answer "did a reply arrive," never "how long is too long" — that is
 * a reviewed fact about the *operation* (`LegacyOperationalSemantics.timeoutMs`),
 * not about the transport, and belongs with the caller that knows it. This is
 * also the one and only place a timeout is enforced, so `facade.ts` and the
 * conformance runner can never disagree about what "timed out" means.
 */
export async function requestReplyWithTimeout(
  client: QueueBrokerClient,
  options: QueueRequestReplyOptions,
  timeoutMs: number,
): Promise<QueueReply> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new QueueBrokerTimeoutError(
          `no reply from '${options.requestDestination}' within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  try {
    return await Promise.race([client.requestReply(options), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
