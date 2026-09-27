/**
 * Decoding and format detection for Layer 0. Bytes are decoded strictly
 * (invalid UTF-8 is a diagnostic, not a crash). A well-formed document is
 * read on the fast path (`JSON.parse`, or js-yaml under the YAML 1.2 core
 * schema); anything the fast path declines goes through the `yaml` document
 * parser, whose structured errors carry line/column positions.
 */
import { extname } from "node:path";
import { parseDocument } from "yaml";
import { fastParseSpecText } from "./fast-parse.js";
import type { EntrypointFormat, SourceDiagnostic, SpecSyntax } from "./model.js";

/** Strict UTF-8 decode: verbatim bytes in, text or a structured failure out. */
export function decodeUtf8(bytes: Uint8Array): { text: string } | { error: string } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { error: "File is not valid UTF-8." };
  }
}

export interface ParsedSourceText {
  /** The document's plain-JS value; absent when parsing failed. */
  doc?: unknown;
  /** Parse errors with 1-based line/column positions where available. */
  errors: { message: string; line?: number; column?: number }[];
}

/**
 * Parse a source document. The fast path reads a well-formed document (see
 * `fast-parse.ts`); when it declines, the `yaml` document parser runs, so
 * every syntax error in either dialect comes back with the parser's
 * line/column instead of a JSON.parse guess.
 */
export function parseSourceText(text: string): ParsedSourceText {
  const fast = fastParseSpecText(text);
  if (fast.ok) return { doc: fast.value, errors: [] };
  const doc = parseDocument(text, { prettyErrors: true, strict: true });
  if (doc.errors.length > 0) {
    return {
      errors: doc.errors.map((err) => ({
        message: err.message,
        line: err.linePos?.[0]?.line,
        column: err.linePos?.[0]?.col,
      })),
    };
  }
  return { doc: doc.toJS(), errors: [] };
}

export interface DetectedFormat {
  format: EntrypointFormat;
  /** Normalized to the major.minor family ("2.0", "3.0", "3.1"). */
  version: string;
}

/**
 * Read the format a document claims for itself — `openapi: 3.x` vs
 * `swagger: 2.0` — without compiling or dereferencing anything.
 */
export function detectDeclaredFormat(doc: unknown): DetectedFormat | undefined {
  if (typeof doc !== "object" || doc === null) return undefined;
  const d = doc as Record<string, unknown>;
  if (typeof d.openapi === "string") {
    const family = d.openapi.match(/^(\d+\.\d+)/)?.[1];
    return { format: "openapi", version: family ?? d.openapi };
  }
  if (typeof d.swagger === "string" && d.swagger.startsWith("2")) {
    return { format: "swagger", version: "2.0" };
  }
  return undefined;
}

/**
 * The wire syntax label for a captured file. The parser no longer needs the
 * distinction (one YAML path covers both), so this is honest bookkeeping from
 * the extension: .json is JSON, everything else that decoded is YAML.
 */
export function syntaxForPath(path: string): SpecSyntax {
  return extname(path).toLowerCase() === ".json" ? "json" : "yaml";
}

/** Adapt one parse failure into the snapshot's diagnostic shape. */
export function unparseableDiagnostic(
  path: string,
  error: { message: string; line?: number; column?: number },
): SourceDiagnostic {
  return {
    level: "error",
    code: "source/unparseable",
    path,
    line: error.line,
    column: error.column,
    message: error.message,
  };
}
