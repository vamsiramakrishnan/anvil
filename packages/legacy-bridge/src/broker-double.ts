import {
  type QueueBrokerClient,
  QueueBrokerTransportError,
  type QueueReply,
  type QueueRequestReplyOptions,
} from "./broker.js";

/**
 * The far end of a request/reply exchange: whatever function stands in for
 * "the legacy system processed this message and produced a reply." A
 * conformance run supplies a small, deterministic, non-business handler (an
 * echo or a canned acknowledgement) — never a re-implementation of the
 * reviewed operation, which this package has no evidence for and no license
 * to invent.
 */
export type LegacyBrokerHandler = (
  requestBody: string,
  destination: string,
) => string | Promise<string>;

export interface InProcessBrokerDoubleOptions {
  /** Destinations that never reply — not "reply slowly," genuinely never.
   *  This is what lets a conformance case exercise the timeout path
   *  deterministically: the double does not need to know the reviewed
   *  timeout, because `requestReplyWithTimeout` is what gives up, not this. */
  silentDestinations?: ReadonlySet<string>;
  /** Destinations that reject the send outright — a broker-level transport
   *  failure, distinct from a timeout. */
  refusedDestinations?: ReadonlySet<string>;
}

/**
 * A deterministic, in-process stand-in for a message broker. It never opens a
 * socket, a port, or a connection to anything — this is the whole reason
 * `anvil legacy bridge conformance` can run in CI without ever touching a
 * real broker.
 *
 * Two properties make it useful as a conformance fixture rather than a toy:
 *
 * 1. **Replay dedup.** A second exchange carrying an `idempotencyKey` already
 *    seen returns the exact cached reply without invoking the handler again
 *    — the same guarantee a real broker's message-id dedup or the bridge's
 *    own correlation cache would have to provide, proven here without either.
 * 2. **Call accounting.** `sendAttempts` and `handlerInvocations` are exposed
 *    so a test can assert *how many times* something happened — not just that
 *    it eventually succeeded. That is what makes "never auto-retried"
 *    checkable: a passing reply proves nothing about whether it took one
 *    attempt or five.
 */
export class InProcessBrokerDouble implements QueueBrokerClient {
  private readonly replies = new Map<string, string>();
  private readonly destinationsSeen: string[] = [];
  private _sendAttempts = 0;
  private _handlerInvocations = 0;

  constructor(
    private readonly handler: LegacyBrokerHandler,
    private readonly options: InProcessBrokerDoubleOptions = {},
  ) {}

  /** Every `requestReply` call this double received, including replays. */
  get sendAttempts(): number {
    return this._sendAttempts;
  }

  /** Distinct business executions — replays do not increment this. */
  get handlerInvocations(): number {
    return this._handlerInvocations;
  }

  /** Destinations sent to, in call order, including replays. */
  get requestDestinations(): readonly string[] {
    return this.destinationsSeen;
  }

  async requestReply(options: QueueRequestReplyOptions): Promise<QueueReply> {
    this._sendAttempts += 1;
    this.destinationsSeen.push(options.requestDestination);

    if (this.options.refusedDestinations?.has(options.requestDestination)) {
      throw new QueueBrokerTransportError(
        `broker refused a send to '${options.requestDestination}'`,
      );
    }

    const cached = this.replies.get(options.idempotencyKey);
    if (cached !== undefined) return { body: cached };

    if (this.options.silentDestinations?.has(options.requestDestination)) {
      // A destination that never produces a reply. Deliberately not "a very
      // long timer" — an unresolved promise, so nothing here decides what
      // "too long" means. `requestReplyWithTimeout` is the only clock.
      return new Promise<never>(() => {});
    }

    this._handlerInvocations += 1;
    const replyBody = await this.handler(options.body, options.requestDestination);
    this.replies.set(options.idempotencyKey, replyBody);
    return { body: replyBody };
  }
}
