import { afterEach, describe, expect, it } from "vitest";
import {
  QueueBrokerTimeoutError,
  QueueBrokerTransportError,
  requestReplyWithTimeout,
} from "./broker.js";
import { StompClient } from "./stomp-client.js";
import { StompServerDouble, type StompServerDoubleOptions } from "./stomp-server-double.js";

/**
 * `StompClient.connect`/`requestReply` over a real `node:net` socket, against
 * the in-process STOMP 1.2 server double. Every server here binds an
 * ephemeral loopback port for one test and is torn down after it; nothing
 * reaches outside the process — see the header of stomp-client.ts.
 */

const REQUEST = "/queue/PAY.REFUND.REQUEST";
const REPLIES = "/queue/legacy-bridge.replies";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function boot(
  options: Partial<StompServerDoubleOptions> = {},
  clientOverrides: Partial<ConstructorParameters<typeof StompClient>[0]> = {},
): Promise<{ double: StompServerDouble; client: StompClient }> {
  const double = new StompServerDouble({ handler: (body) => body, ...options });
  const { host, port } = await double.listen();
  cleanups.push(() => double.close());
  const client = new StompClient({
    host,
    port,
    vhost: host,
    replyDestination: REPLIES,
    ...clientOverrides,
  });
  cleanups.push(() => client.close());
  return { double, client };
}

function exchange(key: string, body: string) {
  return {
    requestDestination: REQUEST,
    correlationField: "JMSCorrelationID",
    idempotencyKey: key,
    body,
  };
}

describe("StompClient over a STOMP 1.2 server double (real loopback socket)", () => {
  it("connects, subscribes to the reply destination, and round-trips one request/reply", async () => {
    const { double, client } = await boot({ handler: (body) => `reply:${body}` });
    await client.connect();
    expect(client.isConnected).toBe(true);
    expect(double.connectAttempts).toBe(1);

    const reply = await client.requestReply(exchange("k-1", '{"refundId":"r-1"}'));
    expect(reply.body).toBe('reply:{"refundId":"r-1"}');
    expect(double.sendAttempts).toBe(1);
    expect(double.handlerInvocations).toBe(1);
    expect(double.requestDestinations).toEqual([REQUEST]);
    expect(double.undeliveredReplies).toBe(0);
  });

  it("puts reply-to, correlation-id, and the reviewed correlation field on the SEND frame", async () => {
    const { double, client } = await boot();
    await client.connect();
    await client.requestReply(exchange("corr-42", "{}"));
    const headers = double.sendHeaders[0];
    expect(headers).toMatchObject({
      destination: REQUEST,
      "reply-to": REPLIES,
      "correlation-id": "corr-42",
      JMSCorrelationID: "corr-42",
      "content-type": "application/json",
    });
  });

  it("correlates concurrent replies that arrive out of order", async () => {
    const { client } = await boot({
      // A is slow, B is fast: the reply for B lands first on the same socket.
      handler: async (body) => {
        const delay = body.includes('"A"') ? 60 : 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return body;
      },
    });
    await client.connect();
    const [a, b] = await Promise.all([
      client.requestReply(exchange("key-a", '{"marker":"A"}')),
      client.requestReply(exchange("key-b", '{"marker":"B"}')),
    ]);
    expect(JSON.parse(a.body).marker).toBe("A");
    expect(JSON.parse(b.body).marker).toBe("B");
  });

  it("round-trips a multibyte UTF-8 body across the socket intact", async () => {
    const { client } = await boot();
    await client.connect();
    const body = '{"name":"café ünïcode ✓ — 日本語"}';
    const reply = await client.requestReply(exchange("k-utf8", body));
    expect(reply.body).toBe(body);
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(body.length);
  });

  it("times out on a silent destination through requestReplyWithTimeout, not by itself", async () => {
    const { double, client } = await boot({ silentDestinations: new Set([REQUEST]) });
    await client.connect();
    await expect(
      requestReplyWithTimeout(client, exchange("k-silent", "{}"), 80),
    ).rejects.toBeInstanceOf(QueueBrokerTimeoutError);
    // The send reached the broker exactly once; nothing was re-attempted.
    expect(double.sendAttempts).toBe(1);
    expect(client.isConnected).toBe(true);
  });

  it("maps a broker ERROR frame to a transport error and treats the close that follows as final", async () => {
    const { client } = await boot({ refusedDestinations: new Set([REQUEST]) });
    await client.connect();
    await expect(client.requestReply(exchange("k-refused", "{}"))).rejects.toThrow(
      QueueBrokerTransportError,
    );
    // Spec §4.2: the server closes after ERROR. The client does not reconnect.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.isConnected).toBe(false);
    await expect(client.requestReply(exchange("k-after", "{}"))).rejects.toThrow(/not connected/);
    await expect(client.connect()).rejects.toThrow(/never reconnects/);
  });

  it("rejects every in-flight exchange when the broker drops the connection", async () => {
    const { double, client } = await boot({ silentDestinations: new Set([REQUEST]) });
    await client.connect();
    const inFlight = client.requestReply(exchange("k-dropped", "{}"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    double.dropSessions();
    await expect(inFlight).rejects.toThrow(/closed by the broker/);
    expect(client.isConnected).toBe(false);
  });

  it("refuses a second connect() on a live client and a connect() after close()", async () => {
    const { client } = await boot();
    await client.connect();
    await expect(client.connect()).rejects.toThrow(/already connected/);
    client.close();
    await expect(client.connect()).rejects.toThrow(/never reconnects/);
    await expect(client.requestReply(exchange("k", "{}"))).rejects.toThrow(/not connected/);
  });

  it("is refused by a broker that requires credentials it was not given, without echoing them", async () => {
    const credentials = { login: "bridge", passcode: "s3cret-passcode" };
    const { double, client } = await boot({ credentials });
    await expect(client.connect()).rejects.toThrow(/invalid login or passcode/);
    expect(double.openSessions).toBe(0);
    let message = "";
    try {
      await client.connect();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(credentials.passcode);
  });

  it("connects when it carries the credentials the broker requires", async () => {
    const credentials = { login: "bridge", passcode: "s3cret-passcode" };
    const { double, client } = await boot({ credentials }, credentials);
    await client.connect();
    expect(double.openSessions).toBe(1);
    const reply = await client.requestReply(exchange("k-auth", '{"ok":true}'));
    expect(reply.body).toBe('{"ok":true}');
  });

  it("consumes server heartbeats between and around frames without confusing them for frames", async () => {
    const { client } = await boot({ heartbeatMs: 5 });
    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const first = await client.requestReply(exchange("hb-1", '{"n":1}'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await client.requestReply(exchange("hb-2", '{"n":2}'));
    expect(first.body).toBe('{"n":1}');
    expect(second.body).toBe('{"n":2}');
  });

  it("returns the cached reply for a replayed correlation id without re-executing the handler", async () => {
    let executions = 0;
    const { double, client } = await boot({
      handler: () => {
        executions += 1;
        return JSON.stringify({ executions });
      },
    });
    await client.connect();
    const first = await client.requestReply(exchange("replay", "{}"));
    const second = await client.requestReply(exchange("replay", "{}"));
    expect(second.body).toBe(first.body);
    expect(double.handlerInvocations).toBe(1);
    expect(double.sendAttempts).toBe(2);
  });

  it("fails connect() with a transport error when nothing is listening", async () => {
    const probe = new StompServerDouble({ handler: (body) => body });
    const { host, port } = await probe.listen();
    await probe.close();
    const client = new StompClient({ host, port, vhost: host, replyDestination: REPLIES });
    await expect(client.connect()).rejects.toThrow(QueueBrokerTransportError);
    expect(client.isConnected).toBe(false);
  });

  it("drops the waiter when the caller gives up, and refuses a duplicate key in flight", async () => {
    // Two failures a correlation map invites: a timed-out exchange whose
    // waiter is never removed (one leaked closure per timeout, for the life of
    // the connection), and a second request reusing a live key, which would
    // overwrite the first waiter and hand its reply to the wrong call.
    const { client } = await boot({ silentDestinations: new Set([REQUEST]) });
    await client.connect();
    const request = exchange("k-abandoned", "{}");

    const first = requestReplyWithTimeout(client, request, 40);
    await expect(client.requestReply(request)).rejects.toThrow(/already in flight/);
    await expect(first).rejects.toBeInstanceOf(QueueBrokerTimeoutError);

    // Released, so the same key is usable again rather than refused forever.
    await expect(requestReplyWithTimeout(client, request, 40)).rejects.toBeInstanceOf(
      QueueBrokerTimeoutError,
    );
  });
});
