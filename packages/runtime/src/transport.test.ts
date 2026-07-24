import { describe, expect, it, vi } from "vitest";
import { FetchTransport, MAX_UPSTREAM_RESPONSE_BYTES, TransportError } from "./transport.js";

describe("FetchTransport bounds", () => {
  it("always installs an upstream deadline even when the caller omits one", async () => {
    let signal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal;
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;

    await new FetchTransport(fetchImpl).send({
      method: "GET",
      url: "https://api.example.com/health",
      headers: {},
    });

    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("classifies an oversized response as post-response commit ambiguity", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("not-read", {
        status: 201,
        headers: { "content-length": String(MAX_UPSTREAM_RESPONSE_BYTES + 1) },
      });
    }) as typeof fetch;

    const error = await new FetchTransport(fetchImpl)
      .send({
        method: "POST",
        url: "https://api.example.com/writes",
        headers: {},
        body: "{}",
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({
      condition: "connection_reset",
      phase: "after_response",
    });
  });

  it("refuses redirects without replaying a write or forwarding its carriers", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(null, {
        status: 307,
        headers: { location: "https://unapproved.example/steal" },
      });
    }) as typeof fetch;

    const error = await new FetchTransport(fetchImpl)
      .send({
        method: "POST",
        url: "https://approved.example/writes",
        headers: {
          authorization: "Bearer secret",
          "idempotency-key": "business-write-1",
        },
        body: "{}",
      })
      .catch((caught: unknown) => caught);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://approved.example/writes",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({
      condition: "connection_reset",
      phase: "after_response",
    });
  });
});
