import { randomBytes } from "node:crypto";
import {
  bodyEncodingFor,
  isBinaryFieldSchema,
  type JsonSchema,
  mediaTypeOf,
  type Operation,
  SUPPORTED_BODY_CONTENT_TYPES,
} from "@anvil/air";
import { AnvilError } from "./errors.js";
import type { HttpRequest } from "./transport.js";

/**
 * Request body encoding for the HTTP/JSON codec.
 *
 * `RequestBody.contentType` used to reach the wire only as a header: the body
 * beneath it was `JSON.stringify`ed whatever the header said. This module makes
 * the header and the bytes agree — a form is a form, a multipart upload is a
 * multipart upload — and refuses, with the runtime's own error code, any content
 * type it has no encoding for. The refusal is raised while the request is being
 * built, which is before a credential is resolved, so an unencodable body never
 * costs a secret read.
 */
export interface EncodedBody {
  contentType: string;
  body: string | Uint8Array;
}

const CRLF = "\r\n";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is string | number | boolean | bigint {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean" || t === "bigint";
}

/** The refusal for a declared content type the runtime does not encode. */
function bodyEncodingRefusal(op: Operation, contentType: string, traceId: string): AnvilError {
  return new AnvilError({
    code: "unsupported_operation",
    message:
      `Operation '${op.id}' declares a '${contentType}' request body, which this runtime does not ` +
      `encode. Only ${SUPPORTED_BODY_CONTENT_TYPES} bodies are put on the wire; a body encoded ` +
      "as JSON under another content type would be a well-formed lie, so it is refused instead.",
    operation: op.id,
    traceId,
    retryable: false,
    details: {
      body_content_type: contentType,
      required_action: "re-declare the body in an encodable content type",
    },
  });
}

function unencodableField(
  op: Operation,
  contentType: string,
  field: string,
  reason: string,
  traceId: string,
) {
  return new AnvilError({
    code: "unsupported_operation",
    message:
      `Operation '${op.id}' cannot encode body field '${field}' as ${mediaTypeOf(contentType)}: ${reason}. ` +
      "Anvil refuses rather than sending a value the encoding cannot carry.",
    operation: op.id,
    traceId,
    retryable: false,
    details: { body_content_type: contentType, field, reason },
  });
}

/** The body-field schema, from the preserved body schema first, then the projection. */
function fieldSchema(op: Operation, name: string): JsonSchema | undefined {
  const body = op.input.body;
  if (!body) return undefined;
  const props = body.schema.properties as Record<string, JsonSchema> | undefined;
  return props?.[name] ?? body.fields.find((f) => f.name === name)?.schema;
}

/**
 * `application/x-www-form-urlencoded`, with `URLSearchParams` semantics: an
 * array repeats its key, and anything nested has no form encoding at all.
 */
function encodeForm(op: Operation, value: unknown, contentType: string, traceId: string): string {
  if (!isRecord(value)) {
    throw unencodableField(
      op,
      contentType,
      "body",
      "a form body must be an object of fields",
      traceId,
    );
  }
  const form = new URLSearchParams();
  for (const [name, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    if (isPrimitive(item)) {
      form.append(name, String(item));
    } else if (Array.isArray(item) && item.every(isPrimitive)) {
      for (const entry of item) form.append(name, String(entry));
    } else {
      throw unencodableField(
        op,
        contentType,
        name,
        "a nested object (or an array of objects) has no form-urlencoded representation",
        traceId,
      );
    }
  }
  return form.toString();
}

interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  bytes: Uint8Array;
}

const BASE64 = /^[A-Za-z0-9+/\s]*={0,2}\s*$/;

function multipartParts(
  op: Operation,
  value: unknown,
  contentType: string,
  traceId: string,
): MultipartPart[] {
  if (!isRecord(value)) {
    throw unencodableField(
      op,
      contentType,
      "body",
      "a multipart body must be an object of fields",
      traceId,
    );
  }
  const parts: MultipartPart[] = [];
  const text = (name: string, item: unknown): void => {
    parts.push({ name, bytes: Buffer.from(String(item), "utf8") });
  };
  for (const [name, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    const schema = fieldSchema(op, name);
    if (isBinaryFieldSchema(schema)) {
      // The agent hands bytes as base64 (the only way JSON can carry them); the
      // wire gets the decoded bytes as a file part, never the base64 text.
      if (typeof item !== "string" || !BASE64.test(item)) {
        throw new AnvilError({
          code: "validation_error",
          message: `Body field '${name}' of operation '${op.id}' carries file bytes and must be a base64 string.`,
          operation: op.id,
          traceId,
          retryable: false,
          details: { field: name, expected: "base64" },
        });
      }
      const partType =
        typeof schema?.contentMediaType === "string" ? schema.contentMediaType : undefined;
      parts.push({
        name,
        filename: name,
        contentType: partType ?? "application/octet-stream",
        bytes: Buffer.from(item.replace(/\s+/g, ""), "base64"),
      });
    } else if (isPrimitive(item)) {
      text(name, item);
    } else if (Array.isArray(item) && item.every(isPrimitive)) {
      for (const entry of item) text(name, entry);
    } else {
      // OpenAPI's default for an object inside multipart is a JSON part.
      parts.push({
        name,
        contentType: "application/json",
        bytes: Buffer.from(JSON.stringify(item), "utf8"),
      });
    }
  }
  return parts;
}

/** A header-safe rendering of a part or file name (RFC 7578 §4.2). */
function quoted(name: string): string {
  return name.replace(/[\r\n]/g, "").replace(/"/g, "%22");
}

/** `multipart/form-data` (RFC 7578) with a random boundary, as real bytes. */
function encodeMultipart(
  op: Operation,
  value: unknown,
  contentType: string,
  traceId: string,
): EncodedBody {
  const parts = multipartParts(op, value, contentType, traceId);
  const boundary = `----AnvilFormBoundary${randomBytes(16).toString("hex")}`;
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    let head = `--${boundary}${CRLF}Content-Disposition: form-data; name="${quoted(part.name)}"`;
    if (part.filename !== undefined) head += `; filename="${quoted(part.filename)}"`;
    head += CRLF;
    if (part.contentType) head += `Content-Type: ${part.contentType}${CRLF}`;
    head += CRLF;
    chunks.push(Buffer.from(head, "utf8"), part.bytes, Buffer.from(CRLF, "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, "utf8"));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(chunks) };
}

/**
 * Encode the bound body value for the operation's declared content type. The
 * returned content type is the one to put on the header: for multipart it
 * carries the boundary the bytes were written with.
 */
export function encodeRequestBody(op: Operation, value: unknown, traceId: string): EncodedBody {
  const contentType = op.input.body?.contentType ?? "application/json";
  switch (bodyEncodingFor(contentType)) {
    case "json":
      return { contentType, body: JSON.stringify(value) };
    case "form_urlencoded":
      return { contentType, body: encodeForm(op, value, contentType, traceId) };
    case "multipart":
      return encodeMultipart(op, value, contentType, traceId);
    default:
      throw bodyEncodingRefusal(op, contentType, traceId);
  }
}

/** The byte length of a request body, whichever representation it took. */
export function requestByteLength(body: string | Uint8Array | undefined): number {
  if (body === undefined) return 0;
  return typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.byteLength;
}

/**
 * The body as a dry-run plan shows it: JSON decoded back to a value, a form as
 * its encoded text, and multipart bytes as their size and content type (the
 * boundary is random per request, so the bytes themselves are not a plan).
 */
export function describeRequestBody(req: HttpRequest): unknown {
  if (req.body === undefined) return undefined;
  const contentType = req.headers["content-type"] ?? "";
  if (typeof req.body !== "string") {
    return { content_type: contentType, bytes: req.body.byteLength };
  }
  if (bodyEncodingFor(contentType) !== "json") return req.body;
  try {
    return JSON.parse(req.body);
  } catch {
    return req.body;
  }
}
