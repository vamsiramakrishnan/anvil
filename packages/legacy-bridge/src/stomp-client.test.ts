import { describe, expect, it } from "vitest";
import { encodeStompFrame, parseStompFrames } from "./stomp-client.js";

/** `encodeStompFrame` returns a string (what `socket.write` takes); the
 *  parser takes the raw bytes a socket actually delivers, so tests encode to
 *  a UTF-8 `Buffer` before parsing — exactly what `StompClient.onData` does
 *  with each `Socket` `data` chunk. */
function toBuffer(frame: string): Buffer {
  return Buffer.from(frame, "utf8");
}

describe("STOMP frame codec (pure — no socket, per this file's own rule)", () => {
  it("round-trips a SEND frame with headers and a body", () => {
    const encoded = encodeStompFrame(
      "SEND",
      { destination: "PAY.REFUND.REQUEST", "correlation-id": "abc-123" },
      '{"refundId":"r-1"}',
    );
    const { frames, remaining } = parseStompFrames(toBuffer(encoded));
    expect(remaining.length).toBe(0);
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
    const { frames } = parseStompFrames(toBuffer(encoded));
    expect(frames[0]?.headers.destination).toBe("a:b\\c\nreply");
  });

  it("keeps a NUL byte inside the body intact when content-length is stated", () => {
    const bodyWithNul = "before\0after";
    const encoded = encodeStompFrame("MESSAGE", { "correlation-id": "x" }, bodyWithNul);
    const { frames } = parseStompFrames(toBuffer(encoded));
    expect(frames[0]?.body).toBe(bodyWithNul);
  });

  it("parses several frames accumulated across simulated socket chunks", () => {
    const first = encodeStompFrame("CONNECTED", { version: "1.2" });
    const second = encodeStompFrame("MESSAGE", { "correlation-id": "k1" }, "reply-one");
    const combined = toBuffer(first + second);
    // Simulate a chunk boundary landing mid-frame.
    const splitAt = Math.floor(combined.length / 2);
    const firstPass = parseStompFrames(combined.subarray(0, splitAt));
    expect(firstPass.frames.length).toBeLessThanOrEqual(1);
    const secondPass = parseStompFrames(
      Buffer.concat([firstPass.remaining, combined.subarray(splitAt)]),
    );
    const allFrames = [...firstPass.frames, ...secondPass.frames];
    expect(allFrames.map((f) => f.command)).toEqual(["CONNECTED", "MESSAGE"]);
    expect(secondPass.remaining.length).toBe(0);
  });

  it("waits for more bytes rather than parsing an incomplete frame", () => {
    const encoded = toBuffer(
      encodeStompFrame("MESSAGE", { "correlation-id": "k1" }, "hello world"),
    );
    const truncated = encoded.subarray(0, encoded.length - 3);
    const { frames, remaining } = parseStompFrames(truncated);
    expect(frames).toHaveLength(0);
    expect(remaining).toEqual(truncated);
  });

  it("consumes heartbeat newlines between frames without producing a frame for them", () => {
    const encoded = `\n\n${encodeStompFrame("MESSAGE", { "correlation-id": "k1" }, "x")}`;
    const { frames, remaining } = parseStompFrames(toBuffer(encoded));
    expect(frames).toHaveLength(1);
    expect(remaining.length).toBe(0);
  });

  it("locates the body terminator by byte offset, not string index, for a multibyte UTF-8 body", () => {
    // "café ünïcode ✓" has fewer UTF-16 code units than UTF-8 bytes (é, ü, ï
    // each encode to 2 bytes, ✓ to 3), so content-length (a byte count) is
    // larger than the body's string length. A parser that walks that count as
    // a string index rather than a byte offset lands short of the real NUL
    // terminator and never finds it — the frame stays buffered forever.
    const body = '{"name":"café ünïcode ✓"}';
    const encoded = encodeStompFrame("MESSAGE", { "correlation-id": "k1" }, body);
    const { frames, remaining } = parseStompFrames(toBuffer(encoded));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.body).toBe(body);
    expect(remaining.length).toBe(0);
  });

  it("finds the next frame after a multibyte body rather than treating it as still-incomplete", () => {
    const first = encodeStompFrame("MESSAGE", { "correlation-id": "k1" }, "café ünïcode ✓");
    const second = encodeStompFrame("MESSAGE", { "correlation-id": "k2" }, "plain-ascii");
    const { frames, remaining } = parseStompFrames(toBuffer(first + second));
    expect(frames.map((f) => f.body)).toEqual(["café ünïcode ✓", "plain-ascii"]);
    expect(remaining.length).toBe(0);
  });
});
