import { describe, expect, it } from "vitest";
import { encodeStompFrame, parseStompFrames } from "./stomp-client.js";

describe("STOMP frame codec (pure — no socket, per this file's own rule)", () => {
  it("round-trips a SEND frame with headers and a body", () => {
    const encoded = encodeStompFrame(
      "SEND",
      { destination: "PAY.REFUND.REQUEST", "correlation-id": "abc-123" },
      '{"refundId":"r-1"}',
    );
    const { frames, remaining } = parseStompFrames(encoded);
    expect(remaining).toBe("");
    expect(frames).toHaveLength(1);
    const [frame] = frames;
    expect(frame?.command).toBe("SEND");
    expect(frame?.headers.destination).toBe("PAY.REFUND.REQUEST");
    expect(frame?.headers["correlation-id"]).toBe("abc-123");
    expect(frame?.headers["content-length"]).toBe("18");
    expect(frame?.body).toBe('{"refundId":"r-1"}');
  });

  it("escapes and unescapes colon, backslash, and newline in header values", () => {
    const encoded = encodeStompFrame("SEND", { destination: "a:b\\c\nreply" }, "");
    const { frames } = parseStompFrames(encoded);
    expect(frames[0]?.headers.destination).toBe("a:b\\c\nreply");
  });

  it("keeps a NUL byte inside the body intact when content-length is stated", () => {
    const bodyWithNul = "before\0after";
    const encoded = encodeStompFrame("MESSAGE", { "correlation-id": "x" }, bodyWithNul);
    const { frames } = parseStompFrames(encoded);
    expect(frames[0]?.body).toBe(bodyWithNul);
  });

  it("parses several frames accumulated across simulated socket chunks", () => {
    const first = encodeStompFrame("CONNECTED", { version: "1.2" });
    const second = encodeStompFrame("MESSAGE", { "correlation-id": "k1" }, "reply-one");
    const combined = first + second;
    // Simulate a chunk boundary landing mid-frame.
    const splitAt = Math.floor(combined.length / 2);
    const firstPass = parseStompFrames(combined.slice(0, splitAt));
    expect(firstPass.frames.length).toBeLessThanOrEqual(1);
    const secondPass = parseStompFrames(firstPass.remaining + combined.slice(splitAt));
    const allFrames = [...firstPass.frames, ...secondPass.frames];
    expect(allFrames.map((f) => f.command)).toEqual(["CONNECTED", "MESSAGE"]);
    expect(secondPass.remaining).toBe("");
  });

  it("waits for more bytes rather than parsing an incomplete frame", () => {
    const encoded = encodeStompFrame("MESSAGE", { "correlation-id": "k1" }, "hello world");
    const truncated = encoded.slice(0, encoded.length - 3);
    const { frames, remaining } = parseStompFrames(truncated);
    expect(frames).toHaveLength(0);
    expect(remaining).toBe(truncated);
  });

  it("consumes heartbeat newlines between frames without producing a frame for them", () => {
    const encoded = `\n\n${encodeStompFrame("MESSAGE", { "correlation-id": "k1" }, "x")}`;
    const { frames, remaining } = parseStompFrames(encoded);
    expect(frames).toHaveLength(1);
    expect(remaining).toBe("");
  });
});
