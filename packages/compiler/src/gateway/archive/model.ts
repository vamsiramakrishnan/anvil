/**
 * The offline gateway-import harness models. Vendor exports arrive as archives
 * (ZIP/tar) full of untrusted paths and bytes. This layer decodes them into
 * byte-preserving `NormalizedFile`s behind a hard security battery — zip-slip,
 * path traversal, symlink escape, size/depth/count limits — so a vendor adapter
 * only ever sees safe, in-bounds files it can cite with evidence coordinates.
 *
 * Decoding the container format itself is behind `ArchiveDecoder` (a real ZIP
 * backend — fflate — is the composition shell; an in-memory decoder drives tests).
 * The security normalization is here, format-agnostic and fully testable.
 */

/** A raw entry as a decoder yields it, before any safety check. */
export interface ArchiveEntry {
  path: string;
  bytes: Uint8Array;
  /** Whether the entry is a symlink (rejected outright — escape defence). */
  isSymlink?: boolean;
}

/** A decoded, safety-checked file: a normalized path and its verbatim bytes. */
export interface NormalizedFile {
  path: string;
  bytes: Uint8Array;
}

/** Decodes a container's bytes into raw entries. Pluggable per format. */
export interface ArchiveDecoder {
  decode(bytes: Uint8Array): ArchiveEntry[];
}

/** Bounds on what an archive may expand to. */
export interface ArchiveLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxExpandedBytes: number;
  maxDepth: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxFiles: 10_000,
  maxFileBytes: 25 * 1024 * 1024,
  maxExpandedBytes: 200 * 1024 * 1024,
  maxDepth: 32,
};

export interface ArchiveDiagnostic {
  level: "error" | "warning";
  code:
    | "archive/unsafe_path"
    | "archive/symlink_rejected"
    | "archive/duplicate_path"
    | "archive/file_too_large"
    | "archive/too_many_files"
    | "archive/expanded_too_large"
    | "archive/too_deep"
    | "archive/invalid_encoding";
  path?: string;
  message: string;
}

export interface ReadArchiveResult {
  ok: boolean;
  files: NormalizedFile[];
  diagnostics: ArchiveDiagnostic[];
}
