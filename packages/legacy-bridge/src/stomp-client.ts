/**
 * A zero-dependency STOMP 1.2 client over `node:net`.
 *
 * Protocol choice, and why it is written by hand rather than pulled in:
 * Anvil's four generated client SDKs are zero-dependency by contract
 * (CLAUDE.md), and the rest of this workspace follows the same discipline
 * wherever an in-repo implementation is genuinely feasible rather than
 * reaching for a package the moment one exists — see `packages/air/src/wire.ts`
 * choosing `graphql-sse` over `graphql-ws` for exactly this reason (no
 * WebSocket client in Python's or Go's standard library). AMQP 0-9-1 and AMQP
 * 1.0 are binary, framed, negotiated protocols with enough surface area
 * (channels, exchanges, content headers, connection tuning) that a correct
 * from-scratch client is a real undertaking, not an afternoon. STOMP 1.2 is
 * the opposite: a text protocol with roughly a dozen commands, each a line of
 * headers and a NUL-terminated body — the same shape HTTP/1.1 has, which is
 * exactly the complexity budget a hand-written zero-dependency client can
 * meet honestly. It is also a real wire format every mainstream broker this
 * package's estates use already speaks (ActiveMQ/Artemis natively; RabbitMQ
 * and IBM MQ via a STOMP plugin/gateway), so choosing it costs nothing in
 * reach. That is the whole tradeoff this file is declaring: STOMP over AMQP,
 * hand-rolled over a peer dependency, because the honest zero-dependency
 * client is the STOMP one.
 *
 * What is and is not exercised by this package's tests: `encodeStompFrame`
 * and `parseStompFrames` are pure functions with no I/O, and are unit tested
 * directly. `StompClient.connect`/`requestReply`, which open a real
 * `node:net` socket, are NEVER called by any test in this package — per the
 * lane's own rule, nothing here connects to a real broker, ever, including a
 * locally spun-up fake one. `broker-double.ts`'s `InProcessBrokerDouble` is
 * what conformance and the facade actually run against; this class exists so
 * a real deployment has a genuine transport to configure, not so a test can
 * exercise it.
 */
import { Socket } from "node:net";
import {
  type QueueBrokerClient,
  QueueBrokerTransportError,
  type QueueReply,
  type QueueRequestReplyOptions,
} from "./broker.js";

export interface StompFrame {
  command: string;
  headers: Record<string, string>;
  body: string;
}

const NUL = "\0";

/** Escape header values per the STOMP 1.2 spec (§3.3.2). Applied to every
 *  header this client writes, including ones sourced from a reviewed binding
 *  — a destination or correlation id is operator data, never agent input, but
 *  escaping it is what keeps a literal colon or newline from being read as a
 *  second header rather than part of the value. */
function escapeHeaderValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/:/g, "\\c");
}

function unescapeHeaderValue(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === "n") {
        out += "\n";
        i += 1;
        continue;
      }
      if (next === "r") {
        out += "\r";
        i += 1;
        continue;
      }
      if (next === "c") {
        out += ":";
        i += 1;
        continue;
      }
      if (next === "\\") {
        out += "\\";
        i += 1;
        continue;
      }
    }
    out += value[i];
  }
  return out;
}

/** Encode one STOMP frame. `content-length` is always stated explicitly
 *  (never inferred by a NUL scan on the receiving end) so a body that happens
 *  to contain a NUL byte — vendor binary payloads exist — round-trips intact. */
export function encodeStompFrame(
  command: string,
  headers: Readonly<Record<string, string>>,
  body = "",
): string {
  const bodyBytes = Buffer.byteLength(body, "utf8");
  const lines = [command];
  for (const [key, value] of Object.entries(headers)) {
    lines.push(`${escapeHeaderValue(key)}:${escapeHeaderValue(value)}`);
  }
  lines.push(`content-length:${bodyBytes}`);
  return `${lines.join("\n")}\n\n${body}${NUL}`;
}

/**
 * Parse as many complete frames as `buffer` holds. Returns the frames found
 * and whatever incomplete tail remains, so a caller can keep accumulating
 * bytes across several socket `data` events — a STOMP frame has no length
 * prefix of its own; only `content-length` inside it does, so the terminator
 * search has to happen after headers are already parsed.
 */
export function parseStompFrames(buffer: string): { frames: StompFrame[]; remaining: string } {
  const frames: StompFrame[] = [];
  let cursor = 0;
  for (;;) {
    // Heartbeat: a lone newline between frames, per spec §2.2. Consume and
    // continue rather than treating it as a malformed frame.
    while (buffer[cursor] === "\n") cursor += 1;
    if (cursor >= buffer.length) break;
    const headerEnd = buffer.indexOf("\n\n", cursor);
    if (headerEnd === -1) break;
    const headerBlock = buffer.slice(cursor, headerEnd);
    const headerLines = headerBlock.split("\n");
    const command = headerLines[0] ?? "";
    const headers: Record<string, string> = {};
    for (const line of headerLines.slice(1)) {
      const sep = line.indexOf(":");
      if (sep === -1) continue;
      const key = unescapeHeaderValue(line.slice(0, sep));
      // First occurrence wins (spec §3.3.2) — a resent header is a correction
      // attempt, not an override.
      if (!(key in headers)) headers[key] = unescapeHeaderValue(line.slice(sep + 1));
    }
    const bodyStart = headerEnd + 2;
    const declaredLength = headers["content-length"];
    let bodyEnd: number;
    if (declaredLength !== undefined && /^\d+$/.test(declaredLength)) {
      bodyEnd = bodyStart + Number(declaredLength);
      if (buffer[bodyEnd] !== NUL) break; // incomplete or malformed; wait for more
    } else {
      bodyEnd = buffer.indexOf(NUL, bodyStart);
      if (bodyEnd === -1) break;
    }
    if (bodyEnd > buffer.length) break;
    frames.push({ command, headers, body: buffer.slice(bodyStart, bodyEnd) });
    cursor = bodyEnd + 1;
  }
  return { frames, remaining: buffer.slice(cursor) };
}

export interface StompClientOptions {
  host: string;
  port: number;
  /** STOMP virtual host — required by the spec's CONNECT frame (§3.2). */
  vhost: string;
  login?: string;
  passcode?: string;
  connectTimeoutMs?: number;
  /** Destination this client subscribes to for correlated replies. A real
   *  deployment names a queue/topic scoped to this bridge instance; nothing
   *  here invents one — it is reviewed transport configuration. */
  replyDestination: string;
}

/**
 * A real STOMP 1.2 request/reply client. Constructing one is safe (no I/O);
 * `connect()` and `requestReply()` open and use a real socket and are never
 * called by this package's own tests — see the file header.
 */
export class StompClient implements QueueBrokerClient {
  private socket: Socket | undefined;
  private buffer = "";
  private readonly pending = new Map<
    string,
    { resolve: (reply: QueueReply) => void; reject: (error: Error) => void }
  >();
  private connected = false;

  constructor(private readonly options: StompClientOptions) {}

  async connect(): Promise<void> {
    const timeoutMs = this.options.connectTimeoutMs ?? 10_000;
    await new Promise<void>((resolve, reject) => {
      const socket = new Socket();
      this.socket = socket;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new QueueBrokerTransportError(`STOMP connect to ${this.options.host} timed out`));
      }, timeoutMs);
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(new QueueBrokerTransportError(`STOMP transport error: ${err.message}`));
      });
      socket.once("connect", () => {
        socket.write(
          encodeStompFrame("CONNECT", {
            "accept-version": "1.2",
            host: this.options.vhost,
            ...(this.options.login ? { login: this.options.login } : {}),
            ...(this.options.passcode ? { passcode: this.options.passcode } : {}),
          }),
        );
      });
      socket.on("data", (chunk) => this.onData(chunk, resolve, reject, timer));
      socket.connect(this.options.port, this.options.host);
    });
  }

  private onData(
    chunk: Buffer,
    onConnected: () => void,
    onConnectError: (err: Error) => void,
    connectTimer: ReturnType<typeof setTimeout>,
  ): void {
    this.buffer += chunk.toString("utf8");
    const { frames, remaining } = parseStompFrames(this.buffer);
    this.buffer = remaining;
    for (const frame of frames) {
      if (frame.command === "CONNECTED" && !this.connected) {
        this.connected = true;
        clearTimeout(connectTimer);
        this.socket?.write(
          encodeStompFrame("SUBSCRIBE", {
            id: "legacy-bridge-replies",
            destination: this.options.replyDestination,
            ack: "auto",
          }),
        );
        onConnected();
        continue;
      }
      if (frame.command === "ERROR" && !this.connected) {
        clearTimeout(connectTimer);
        onConnectError(new QueueBrokerTransportError(frame.body || "STOMP CONNECT refused"));
        continue;
      }
      if (frame.command === "MESSAGE") {
        const correlationId = frame.headers["correlation-id"];
        const waiter = correlationId ? this.pending.get(correlationId) : undefined;
        if (waiter) {
          this.pending.delete(correlationId as string);
          waiter.resolve({ body: frame.body });
        }
        continue;
      }
      if (frame.command === "ERROR") {
        const correlationId = frame.headers["correlation-id"];
        const waiter = correlationId ? this.pending.get(correlationId) : undefined;
        if (waiter) {
          this.pending.delete(correlationId as string);
          waiter.reject(new QueueBrokerTransportError(frame.body || "STOMP broker reported ERROR"));
        }
      }
    }
  }

  async requestReply(options: QueueRequestReplyOptions): Promise<QueueReply> {
    if (!this.socket || !this.connected) {
      throw new QueueBrokerTransportError("STOMP client is not connected");
    }
    const socket = this.socket;
    return new Promise<QueueReply>((resolve, reject) => {
      this.pending.set(options.idempotencyKey, { resolve, reject });
      socket.write(
        encodeStompFrame(
          "SEND",
          {
            destination: options.requestDestination,
            "reply-to": this.options.replyDestination,
            [options.correlationField]: options.idempotencyKey,
            "correlation-id": options.idempotencyKey,
            "content-type": "application/json",
          },
          options.body,
        ),
      );
    });
  }

  close(): void {
    this.socket?.end();
    this.socket = undefined;
    this.connected = false;
  }
}
