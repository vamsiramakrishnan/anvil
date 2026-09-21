import type { JsonSchema } from "./schema.js";

/**
 * Request body encodings — which declared content types Anvil can actually turn
 * into bytes.
 *
 * `RequestBody.contentType` has always been carried verbatim from the source
 * and set on the `content-type` header, while the body itself was
 * `JSON.stringify`ed unconditionally. A form endpoint therefore received JSON
 * labelled as a form, and a multipart upload received JSON labelled as
 * multipart: a well-formed request no server could parse, sent with a
 * credential attached. This module names the encodings the runtime does speak,
 * so a body it does not is refused at compile time and again before any
 * credential is read, on every surface, from one table.
 */
export const BODY_ENCODINGS = ["json", "form_urlencoded", "multipart"] as const;
export type BodyEncoding = (typeof BODY_ENCODINGS)[number];

/** Prose for a diagnostic or a refusal: the content types Anvil encodes. */
export const SUPPORTED_BODY_CONTENT_TYPES =
  "application/json (or any +json type), application/x-www-form-urlencoded, and multipart/form-data";

/** The media type of a content-type value, lower-cased and without parameters. */
export function mediaTypeOf(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * The encoding a declared content type maps to, or undefined when Anvil has
 * none. Undefined is a refusal, never a fallback to JSON: the fallback is
 * exactly the silent divergence this table exists to prevent.
 */
export function bodyEncodingFor(contentType: string): BodyEncoding | undefined {
  const media = mediaTypeOf(contentType);
  if (media === "application/json" || media.endsWith("+json")) return "json";
  if (media === "application/x-www-form-urlencoded") return "form_urlencoded";
  if (media === "multipart/form-data") return "multipart";
  return undefined;
}

/**
 * Whether a body field's schema describes bytes rather than text: OpenAPI's
 * `type: string, format: binary` or JSON Schema's `contentEncoding: base64`.
 * Such a field travels as a multipart *file* part, decoded from the base64 the
 * agent supplied, rather than as a text part carrying the base64 itself.
 */
export function isBinaryFieldSchema(schema: JsonSchema | undefined): boolean {
  if (!schema) return false;
  const raw = schema.type;
  const type = Array.isArray(raw) ? raw.find((t) => t !== "null") : raw;
  if (type !== "string" && type !== undefined) return false;
  return (
    schema.format === "binary" || schema.format === "byte" || schema.contentEncoding === "base64"
  );
}
