/**
 * An in-process STOMP 1.2 *server* double over `node:net`.
 *
 * `InProcessBrokerDouble` (broker-double.ts) stands in for a broker at the
 * `QueueBrokerClient` seam, which proves the facade and the conformance
 * runner but leaves `StompClient`'s own socket path — framing across chunk
 * boundaries, CONNECT negotiation, subscription, reply correlation under
 * concurrency, ERROR-then-close, credential refusal — entirely untested.
 * This double stands in one layer lower: it speaks enough of the STOMP 1.2
 * wire protocol (CONNECT/CONNECTED, SUBSCRIBE/UNSUBSCRIBE, SEND with
 * `reply-to` and correlation, DISCONNECT/RECEIPT, ERROR, heartbeats) that the
 * real client can be driven end to end through a real socket, on a loopback
 * port that exists only while one test runs.
 *
 * It is a double, not a broker: no persistence, no transactions, no ACK
 * modes, no destination semantics beyond "deliver a MESSAGE to whoever
 * subscribed to the `reply-to` destination." The same two properties that
 * make the in-process double a fixture rather than a toy carry over —
 * replay dedup on `correlation-id`, and call accounting a test can assert on
 * — so the conformance runner can run its three invariants against either.
 */
import { createServer, type Server, type Socket } from "node:net";
import type { LegacyBrokerHandler } from "./broker-double.js";
import { encodeStompFrame, parseStompFrames, type StompFrame } from "./stomp-client.js";

export interface StompServerDoubleOptions {
  /** See `LegacyBrokerHandler` — a deterministic, non-business reply. */
  handler: LegacyBrokerHandler;
  /** Destinations that never reply — a SEND to one is accounted for and
   *  then dropped on the floor, so `requestReplyWithTimeout` is what gives up. */
  silentDestinations?: ReadonlySet<string>;
  /** Destinations the broker refuses: the SEND is answered with an ERROR
   *  frame carrying the request's `correlation-id`, and the connection is
   *  then closed, exactly as the spec (§4.2) says a server must after ERROR. */
  refusedDestinations?: ReadonlySet<string>;
  /** When set, a CONNECT must carry exactly these `login`/`passcode` headers
   *  or it is refused with ERROR and closed. */
  credentials?: { login: string; passcode: string };
  /** When positive, the double writes a lone LF heartbeat to every connected
   *  session on this interval — the client must consume them as heartbeats,
   *  not frames. */
  heartbeatMs?: number;
}

/** Headers the double copies from a SEND onto the correlated MESSAGE — the
 *  reviewed correlation field is not known here, so every non-routing header
 *  is carried, which is what a real broker does with user headers too. */
const SEND_ROUTING_HEADERS = new Set([
  "destination",
  "reply-to",
  "content-length",
  "content-type",
  "receipt",
  "transaction",
]);

interface Session {
  socket: Socket;
  buffer: Buffer;
  connected: boolean;
  /** subscription id → destination */
  subscriptions: Map<string, string>;
}

export class StompServerDouble {
  private server: Server | undefined;
  private readonly sessions = new Set<Session>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly replies = new Map<string, string>();
  private readonly destinationsSeen: string[] = [];
  private readonly sendHeadersSeen: Array<Record<string, string>> = [];
  private _sendAttempts = 0;
  private _handlerInvocations = 0;
  private _connectAttempts = 0;
  private _undeliveredReplies = 0;
  private messageSequence = 0;

  constructor(private readonly options: StompServerDoubleOptions) {}

  /** Every SEND received, including replays and refused ones. */
  get sendAttempts(): number {
    return this._sendAttempts;
  }

  /** Distinct handler executions — replays do not increment this. */
  get handlerInvocations(): number {
    return this._handlerInvocations;
  }

  /** Destinations SENT to, in arrival order. */
  get requestDestinations(): readonly string[] {
    return this.destinationsSeen;
  }

  /** The full header block of every SEND, in arrival order, so a test can
   *  assert what the client actually put on the wire. */
  get sendHeaders(): ReadonlyArray<Readonly<Record<string, string>>> {
    return this.sendHeadersSeen;
  }

  /** CONNECT frames received, accepted or refused. */
  get connectAttempts(): number {
    return this._connectAttempts;
  }

  /** Replies produced with no subscriber on the `reply-to` destination. */
  get undeliveredReplies(): number {
    return this._undeliveredReplies;
  }

  /** Sessions currently open (CONNECTED and not yet closed). */
  get openSessions(): number {
    return [...this.sessions].filter((session) => session.connected).length;
  }

  /** Bind to an ephemeral loopback port. Never any other interface. */
  async listen(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error("StompServerDouble is already listening");
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server double has no port");
    if (this.options.heartbeatMs && this.options.heartbeatMs > 0) {
      this.heartbeat = setInterval(() => {
        for (const session of this.sessions) {
          if (session.connected && !session.socket.destroyed) session.socket.write("\n");
        }
      }, this.options.heartbeatMs);
    }
    return { host: "127.0.0.1", port: address.port };
  }

  /** Close every session (as a broker going away would) and stop listening. */
  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const session of this.sessions) session.socket.destroy();
    this.sessions.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Close every open session without stopping the listener — a broker
   *  restart as the client sees it. */
  dropSessions(): void {
    for (const session of this.sessions) session.socket.destroy();
    this.sessions.clear();
  }

  private accept(socket: Socket): void {
    const session: Session = {
      socket,
      buffer: Buffer.alloc(0),
      connected: false,
      subscriptions: new Map(),
    };
    this.sessions.add(session);
    socket.on("data", (chunk: Buffer) => {
      session.buffer = Buffer.concat([session.buffer, chunk]);
      const { frames, remaining } = parseStompFrames(session.buffer);
      session.buffer = remaining;
      for (const frame of frames) void this.handleFrame(session, frame);
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      session.connected = false;
      this.sessions.delete(session);
    });
  }

  private write(session: Session, frame: string): void {
    if (!session.socket.destroyed) session.socket.write(frame);
  }

  private fail(session: Session, message: string, headers: Record<string, string> = {}): void {
    this.write(session, encodeStompFrame("ERROR", { ...headers, message }, message));
    session.connected = false;
    session.socket.end();
  }

  private async handleFrame(session: Session, frame: StompFrame): Promise<void> {
    if (!session.connected) {
      if (frame.command === "CONNECT" || frame.command === "STOMP") {
        this.handleConnect(session, frame);
        return;
      }
      this.fail(session, `frame '${frame.command}' before CONNECT`);
      return;
    }
    switch (frame.command) {
      case "SUBSCRIBE": {
        const id = frame.headers.id;
        const destination = frame.headers.destination;
        if (!id || !destination) {
          this.fail(session, "SUBSCRIBE requires id and destination headers");
          return;
        }
        session.subscriptions.set(id, destination);
        return;
      }
      case "UNSUBSCRIBE": {
        if (frame.headers.id) session.subscriptions.delete(frame.headers.id);
        return;
      }
      case "SEND":
        await this.handleSend(session, frame);
        return;
      case "DISCONNECT": {
        if (frame.headers.receipt) {
          this.write(session, encodeStompFrame("RECEIPT", { "receipt-id": frame.headers.receipt }));
        }
        session.connected = false;
        session.socket.end();
        return;
      }
      default:
        this.fail(session, `unsupported frame '${frame.command}'`);
    }
  }

  private handleConnect(session: Session, frame: StompFrame): void {
    this._connectAttempts += 1;
    const versions = (frame.headers["accept-version"] ?? "1.0").split(",");
    if (!versions.includes("1.2")) {
      this.fail(session, "only STOMP 1.2 is supported", { version: "1.2" });
      return;
    }
    if (!frame.headers.host) {
      this.fail(session, "CONNECT requires a host header");
      return;
    }
    const required = this.options.credentials;
    if (
      required &&
      (frame.headers.login !== required.login || frame.headers.passcode !== required.passcode)
    ) {
      // The reason names neither the expected nor the supplied value.
      this.fail(session, "CONNECT refused: invalid login or passcode");
      return;
    }
    session.connected = true;
    this.write(
      session,
      encodeStompFrame("CONNECTED", {
        version: "1.2",
        "heart-beat": `${this.options.heartbeatMs ?? 0},0`,
      }),
    );
  }

  private async handleSend(session: Session, frame: StompFrame): Promise<void> {
    const destination = frame.headers.destination ?? "";
    this._sendAttempts += 1;
    this.destinationsSeen.push(destination);
    this.sendHeadersSeen.push({ ...frame.headers });
    const correlationId = frame.headers["correlation-id"];

    if (this.options.refusedDestinations?.has(destination)) {
      this.fail(
        session,
        `destination '${destination}' refused`,
        correlationId ? { "correlation-id": correlationId } : {},
      );
      return;
    }
    if (this.options.silentDestinations?.has(destination)) return;

    const replyTo = frame.headers["reply-to"];
    if (!replyTo) {
      // Fire-and-forget: accepted, nothing to correlate a reply to.
      return;
    }
    let replyBody: string;
    const cached = correlationId ? this.replies.get(correlationId) : undefined;
    if (cached !== undefined) {
      replyBody = cached;
    } else {
      this._handlerInvocations += 1;
      replyBody = await this.options.handler(frame.body, destination);
      if (correlationId) this.replies.set(correlationId, replyBody);
    }
    this.deliver(replyTo, frame.headers, replyBody);
  }

  private deliver(destination: string, sendHeaders: Record<string, string>, body: string): void {
    let delivered = false;
    for (const session of this.sessions) {
      if (!session.connected) continue;
      for (const [subscriptionId, subscribed] of session.subscriptions) {
        if (subscribed !== destination) continue;
        const carried: Record<string, string> = {};
        for (const [key, value] of Object.entries(sendHeaders)) {
          if (!SEND_ROUTING_HEADERS.has(key)) carried[key] = value;
        }
        this.messageSequence += 1;
        this.write(
          session,
          encodeStompFrame(
            "MESSAGE",
            {
              ...carried,
              destination,
              subscription: subscriptionId,
              "message-id": `m-${this.messageSequence}`,
              "content-type": sendHeaders["content-type"] ?? "text/plain",
            },
            body,
          ),
        );
        delivered = true;
      }
    }
    if (!delivered) this._undeliveredReplies += 1;
  }
}
