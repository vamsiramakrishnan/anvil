import type { Operation } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { graphqlSseCodec, sseDataFrames } from "./codec-graphql-sse.js";
import { FetchTransport } from "./transport.js";

/**
 * The bounded observation window — what makes a subscription a call.
 *
 * Both bounds are tested against a real streaming body rather than a string,
 * because both bugs that reached the live run were invisible to a string. A
 * burst delivers hundreds of events in a single socket read, so a loop that
 * checks its counter between reads has already buffered them all; and a server
 * holding an idle connection open sends comment frames, which are frames on the
 * wire and not events to anyone.
 */

/**
 * A response whose body yields these chunks, then optionally stays open.
 *
 * It honours the abort signal, which matters more than it looks: a mock that
 * ignores it cannot exercise anything about timeouts at all, because the real
 * `fetch` surfaces an abort by *erroring the body read* mid-stream. A helper
 * that quietly kept yielding would make every timeout control untestable while
 * looking like it passed.
 */
function streamingFetch(chunks: string[], options: { close?: boolean } = {}): typeof fetch {
  return ((_url: string, init?: { signal?: AbortSignal }) =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            // Leaving it open is the normal case for a subscription: the server
            // has no reason to end a stream the caller has not left.
            if (options.close !== false) {
              controller.close();
              return;
            }
            init?.signal?.addEventListener("abort", () => {
              const error = new Error("This operation was aborted");
              error.name = "AbortError";
              try {
                controller.error(error);
              } catch {
                // Already closed; nothing left to abort.
              }
            });
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    )) as unknown as typeof fetch;
}

const event = (n: number) =>
  `event: next\ndata: ${JSON.stringify({ data: { ticks: { seq: n } } })}\n\n`;

const KEEP_ALIVE = ": ping\n\n";

function subscription(maxEvents = 100, maxSeconds = 30): Operation {
  return {
    id: "svc.ticks.list",
    sourceRef: {
      kind: "graphql",
      path: "/graphql/Subscription/ticks",
      method: "post",
      binding: {
        protocol: "graphql_sse",
        document: "subscription Anvil_Ticks { ticks { seq } }",
        operationName: "Anvil_Ticks",
        rootField: "ticks",
      },
    },
    stream: { transport: "graphql_sse", delivery: "at_most_once", maxEvents, maxSeconds },
    input: { params: [] },
  } as unknown as Operation;
}

describe("the event bound", () => {
  it("holds even when every event arrives in one socket read", async () => {
    // The bug the live run found. A burst is one chunk, so by the time the loop
    // re-checks its counter the buffer already holds all 400 — the bound has to
    // be applied to the bytes that leave, not only to the loop condition.
    const chunks = [Array.from({ length: 400 }, (_, i) => event(i + 1)).join("")];
    const res = await new FetchTransport(streamingFetch(chunks)).send({
      method: "POST",
      url: "https://svc.example.com/graphql",
      headers: {},
      streamBound: { maxEvents: 100, maxSeconds: 30 },
    });
    const events = graphqlSseCodec.decode(subscription(), res) as Array<{ seq: number }>;
    expect(events).toHaveLength(100);
    expect(events[0]?.seq).toBe(1);
    expect(events[99]?.seq).toBe(100);
  });

  it("does not spend the window on keep-alive comments", async () => {
    // An idle service sends `: ping` frames. Counting them would let it exhaust
    // a hundred-event window having published nothing at all.
    const chunks = [KEEP_ALIVE.repeat(50) + event(1) + KEEP_ALIVE.repeat(50) + event(2)];
    const res = await new FetchTransport(streamingFetch(chunks)).send({
      method: "POST",
      url: "https://svc.example.com/graphql",
      headers: {},
      streamBound: { maxEvents: 3, maxSeconds: 30 },
    });
    expect(graphqlSseCodec.decode(subscription(), res)).toEqual([{ seq: 1 }, { seq: 2 }]);
  });

  it("returns what arrived when the server closes first", async () => {
    const res = await new FetchTransport(streamingFetch([event(1), event(2)])).send({
      method: "POST",
      url: "https://svc.example.com/graphql",
      headers: {},
      streamBound: { maxEvents: 100, maxSeconds: 30 },
    });
    expect(graphqlSseCodec.decode(subscription(), res)).toEqual([{ seq: 1 }, { seq: 2 }]);
  });
});

describe("the time bound", () => {
  it("closes a stream that publishes nothing, and calls that a result", async () => {
    // The second live bug: an ordinary request treats a deadline as failure,
    // and that turned a subscription which legitimately saw nothing into a
    // timeout — then retried it, because a read is retry-safe.
    const started = Date.now();
    const res = await new FetchTransport(streamingFetch([KEEP_ALIVE], { close: false })).send({
      method: "POST",
      url: "https://svc.example.com/graphql",
      headers: {},
      streamBound: { maxEvents: 100, maxSeconds: 1 },
    });
    expect(res.status).toBe(200);
    expect(graphqlSseCodec.decode(subscription(), res)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("outlives a request timeout shorter than the window", async () => {
    // The control the live run proved and a short window cannot: the abort is
    // the backstop *behind* the window, never in front of it. With the ordinary
    // timeout in force a 30-second window against a 30-second default aborted
    // first — reporting a timeout for a subscription that had simply seen
    // nothing yet, and then retrying it, because a read is retry-safe.
    const res = await new FetchTransport(streamingFetch([KEEP_ALIVE], { close: false })).send({
      method: "POST",
      url: "https://svc.example.com/graphql",
      headers: {},
      // Deliberately far shorter than the window it is supposed to sit behind.
      timeoutMs: 300,
      streamBound: { maxEvents: 100, maxSeconds: 2 },
    });
    expect(res.status).toBe(200);
    expect(graphqlSseCodec.decode(subscription(), res)).toEqual([]);
  });

  it("keeps the events it did see when the window closes on time", async () => {
    const res = await new FetchTransport(
      streamingFetch([event(7), KEEP_ALIVE], { close: false }),
    ).send({
      method: "POST",
      url: "https://svc.example.com/graphql",
      headers: {},
      streamBound: { maxEvents: 100, maxSeconds: 1 },
    });
    expect(graphqlSseCodec.decode(subscription(), res)).toEqual([{ seq: 7 }]);
  });
});

describe("the SSE codec", () => {
  it("asks for a stream, and carries the operation's bound to the transport", () => {
    const req = graphqlSseCodec.encode(subscription(25, 5), {
      path: "/graphql/Subscription/ticks",
      query: new URLSearchParams(),
      headers: {},
      body: { room: "a" },
      hasBody: true,
      baseUrl: "https://svc.example.com/graphql",
    });
    expect(req.headers.accept).toBe("text/event-stream");
    expect(req.streamBound).toEqual({ maxEvents: 25, maxSeconds: 5 });
    expect(JSON.parse(req.body as string)).toEqual({
      query: "subscription Anvil_Ticks { ticks { seq } }",
      operationName: "Anvil_Ticks",
      variables: { room: "a" },
    });
  });

  it("reports no events as an empty array, never as a single null", () => {
    // A window that saw nothing is a real answer. Collapsing it would let a
    // caller write code that breaks the first time the service is busy.
    expect(graphqlSseCodec.decode(subscription(), { status: 200, headers: {}, body: "" })).toEqual(
      [],
    );
  });

  it("ignores a frame it never saw the end of, even when its JSON is whole", () => {
    // The subtle half: a frame cut *after* its closing brace parses perfectly.
    // Dropping it must depend on the missing boundary, not on a parse failure,
    // or the window silently reports an event it never saw the end of.
    const partial = `${event(1)}event: next\ndata: ${JSON.stringify({
      data: { ticks: { seq: 2 } },
    })}`;
    expect(sseDataFrames(partial)).toHaveLength(1);
    expect(
      graphqlSseCodec.decode(subscription(), { status: 200, headers: {}, body: partial }),
    ).toEqual([{ seq: 1 }]);
  });

  it("fails the call when the first frame is an error", () => {
    // A subscription that never started is a failed call.
    const body = `event: next\ndata: ${JSON.stringify({
      errors: [{ message: "not subscribed", extensions: { code: "FORBIDDEN" } }],
    })}\n\n`;
    const fault = graphqlSseCodec.faultIn?.(subscription(), { status: 200, headers: {}, body });
    expect(fault).toMatchObject({ code: "FORBIDDEN", retryable: false });
    expect(fault?.message).toContain("not subscribed");
  });

  it("keeps a window that delivered, when a later frame carries an error", () => {
    // One bad event inside a window that otherwise delivered is not a failed
    // call, and failing it would discard good events already paid for.
    const body =
      event(1) +
      `event: next\ndata: ${JSON.stringify({ errors: [{ message: "transient" }] })}\n\n` +
      event(2);
    expect(
      graphqlSseCodec.faultIn?.(subscription(), { status: 200, headers: {}, body }),
    ).toBeUndefined();
    expect(graphqlSseCodec.decode(subscription(), { status: 200, headers: {}, body })).toEqual([
      { seq: 1 },
      { seq: 2 },
    ]);
  });
});
