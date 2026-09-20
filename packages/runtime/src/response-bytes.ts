import { mediaTypeOf } from "@anvil/air";
import type { HttpResponse } from "./transport.js";

/**
 * Response bodies that are bytes, not text.
 *
 * The transport used to run every response through `TextDecoder`, so a PDF or
 * an image came back as a string of replacement characters — well-formed
 * nonsense an agent would faithfully relay. A response whose content type is
 * not textual now travels base64-encoded with its metadata, and the codec hands
 * the agent a structured value that says what it is. The byte cap is unchanged:
 * a base64 body is at most the same 8 MiB of upstream bytes, re-encoded.
 */

/** Media types (or families) whose bodies are text even without a charset. */
function isTextualMediaType(media: string): boolean {
  if (media.startsWith("text/")) return true;
  if (media === "application/json" || media.endsWith("+json")) return true;
  if (media === "application/xml" || media.endsWith("+xml")) return true;
  if (media === "application/javascript" || media === "application/ecmascript") return true;
  if (media === "application/x-www-form-urlencoded") return true;
  if (media === "application/graphql") return true;
  return false;
}

/**
 * Whether a response with this content type should be decoded as text. An
 * absent content type is treated as text, which is what every caller before
 * this module assumed; a declared charset is the upstream saying "text" in so
 * many words, whatever the media type.
 */
export function isTextualContentType(contentType: string | undefined | null): boolean {
  if (!contentType) return true;
  if (/;\s*charset=/i.test(contentType)) return true;
  return isTextualMediaType(mediaTypeOf(contentType));
}

/** The body fields of an `HttpResponse` for these upstream bytes. */
export function materializeResponseBody(
  bytes: Uint8Array,
  contentType: string | undefined | null,
): Pick<HttpResponse, "body" | "bodyEncoding"> {
  if (isTextualContentType(contentType)) return { body: new TextDecoder().decode(bytes) };
  return { body: Buffer.from(bytes).toString("base64"), bodyEncoding: "base64" };
}

/** What the codec returns for a non-textual 2xx body. */
export interface BinaryResult {
  contentType: string;
  encoding: "base64";
  /** The upstream bytes, base64-encoded. */
  data: string;
  /** The decoded size, so a caller can decide before decoding. */
  bytes: number;
}

function base64ByteLength(data: string): number {
  const stripped = data.replace(/\s+/g, "");
  const padding = stripped.endsWith("==") ? 2 : stripped.endsWith("=") ? 1 : 0;
  return Math.floor((stripped.length * 3) / 4) - padding;
}

export function binaryResult(res: HttpResponse): BinaryResult {
  return {
    contentType: res.headers["content-type"] ?? "application/octet-stream",
    encoding: "base64",
    data: res.body,
    bytes: base64ByteLength(res.body),
  };
}

export function isBinaryResult(value: unknown): value is BinaryResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.encoding === "base64" &&
    typeof v.contentType === "string" &&
    typeof v.data === "string" &&
    typeof v.bytes === "number"
  );
}

/**
 * One line a human or an agent can act on, in place of megabytes of base64 in
 * a text channel. The bytes themselves stay in the structured result.
 */
export function describeBinaryResult(value: BinaryResult): string {
  return (
    `Binary response: ${value.contentType} (${value.bytes} bytes), base64-encoded in the ` +
    `structured result's "data" field.`
  );
}
