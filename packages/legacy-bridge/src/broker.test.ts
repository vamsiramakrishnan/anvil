import { afterEach, describe, expect, it, vi } from "vitest";
import { QueueBrokerTimeoutError, requestReplyWithTimeout } from "./broker.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("requestReplyWithTimeout", () => {
  it("rearms a timer that fires before the monotonic deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    let settled = false;
    const result = requestReplyWithTimeout(
      { requestReply: () => new Promise(() => {}) },
      { requestDestination: "q.a", correlationField: "cid", idempotencyKey: "k", body: "x" },
      200,
    ).catch((error: unknown) => {
      settled = true;
      return error;
    });

    clock.mockReturnValue(199);
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(false);

    clock.mockReturnValue(200);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeInstanceOf(QueueBrokerTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline when a reply arrives", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reply = await requestReplyWithTimeout(
      { requestReply: async () => ({ body: "reply" }) },
      { requestDestination: "q.a", correlationField: "cid", idempotencyKey: "k", body: "x" },
      200,
    );
    expect(reply.body).toBe("reply");
    expect(vi.getTimerCount()).toBe(0);
  });
});
