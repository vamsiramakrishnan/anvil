import { describe, expect, it } from "vitest";
import { QueueBrokerTransportError } from "./broker.js";
import { InProcessBrokerDouble } from "./broker-double.js";

describe("InProcessBrokerDouble", () => {
  it("invokes the handler once and returns its reply", async () => {
    const double = new InProcessBrokerDouble((body) => `reply:${body}`);
    const reply = await double.requestReply({
      requestDestination: "q.a",
      correlationField: "cid",
      idempotencyKey: "k1",
      body: "hello",
    });
    expect(reply.body).toBe("reply:hello");
    expect(double.handlerInvocations).toBe(1);
    expect(double.sendAttempts).toBe(1);
    expect(double.requestDestinations).toEqual(["q.a"]);
  });

  it("replays a cached reply for a repeated idempotency key without re-invoking the handler", async () => {
    let calls = 0;
    const double = new InProcessBrokerDouble(() => {
      calls += 1;
      return `call-${calls}`;
    });
    const first = await double.requestReply({
      requestDestination: "q.a",
      correlationField: "cid",
      idempotencyKey: "same-key",
      body: "x",
    });
    const second = await double.requestReply({
      requestDestination: "q.a",
      correlationField: "cid",
      idempotencyKey: "same-key",
      body: "x",
    });
    expect(first.body).toBe(second.body);
    expect(double.handlerInvocations).toBe(1);
    expect(double.sendAttempts).toBe(2);
  });

  it("throws a transport error for a refused destination, counting the attempt", async () => {
    const double = new InProcessBrokerDouble(() => "never reached", {
      refusedDestinations: new Set(["q.refused"]),
    });
    await expect(
      double.requestReply({
        requestDestination: "q.refused",
        correlationField: "cid",
        idempotencyKey: "k",
        body: "x",
      }),
    ).rejects.toBeInstanceOf(QueueBrokerTransportError);
    expect(double.sendAttempts).toBe(1);
    expect(double.handlerInvocations).toBe(0);
  });

  it("never resolves for a silent destination — the caller's own timeout is the only clock", async () => {
    const double = new InProcessBrokerDouble(() => "never reached", {
      silentDestinations: new Set(["q.silent"]),
    });
    const pending = double.requestReply({
      requestDestination: "q.silent",
      correlationField: "cid",
      idempotencyKey: "k",
      body: "x",
    });
    const raced = await Promise.race([
      pending.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("still-pending"), 50)),
    ]);
    expect(raced).toBe("still-pending");
    expect(double.handlerInvocations).toBe(0);
  });
});
