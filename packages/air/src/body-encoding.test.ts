import { describe, expect, it } from "vitest";
import { bodyEncodingFor, isBinaryFieldSchema, mediaTypeOf } from "./body-encoding.js";

describe("request body encodings", () => {
  it("maps the content types the runtime encodes, and nothing else", () => {
    expect(bodyEncodingFor("application/json")).toBe("json");
    expect(bodyEncodingFor("Application/JSON; charset=utf-8")).toBe("json");
    expect(bodyEncodingFor("application/vnd.api+json")).toBe("json");
    expect(bodyEncodingFor("application/x-www-form-urlencoded")).toBe("form_urlencoded");
    expect(bodyEncodingFor("multipart/form-data; boundary=abc")).toBe("multipart");
    // Undefined is a refusal, never a fallback to JSON.
    for (const contentType of [
      "application/octet-stream",
      "text/plain",
      "application/xml",
      "text/xml",
      "multipart/mixed",
      "image/png",
      "",
    ]) {
      expect(bodyEncodingFor(contentType)).toBeUndefined();
    }
  });

  it("reads the media type without its parameters", () => {
    expect(mediaTypeOf("Text/Plain; charset=utf-8")).toBe("text/plain");
    expect(mediaTypeOf("")).toBe("");
  });

  it("recognizes a field that carries bytes rather than text", () => {
    expect(isBinaryFieldSchema({ type: "string", format: "binary" })).toBe(true);
    expect(isBinaryFieldSchema({ type: "string", format: "byte" })).toBe(true);
    expect(isBinaryFieldSchema({ type: "string", contentEncoding: "base64" })).toBe(true);
    expect(isBinaryFieldSchema({ type: ["string", "null"], format: "binary" })).toBe(true);
    expect(isBinaryFieldSchema({ type: "string" })).toBe(false);
    expect(isBinaryFieldSchema({ type: "integer", format: "binary" })).toBe(false);
    expect(isBinaryFieldSchema(undefined)).toBe(false);
  });
});
