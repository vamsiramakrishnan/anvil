/**
 * Content hashing for Layer 0. Everything hashes the verbatim BYTES the
 * customer supplied — a CRLF, a BOM, or a re-encoded string is a different
 * source. Identity is derived from content only; names, clocks, and metadata
 * never feed a hash.
 */
import { createHash } from "node:crypto";

/** A file as import read it: a snapshot-relative path and its verbatim bytes. */
export interface SourceInputFile {
  path: string;
  bytes: Uint8Array;
}

/** sha256 hex digest of verbatim bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The deterministic content hash: sha256 over the path-sorted (path,
 * content-hash) pairs. Re-importing unchanged bytes yields the same hash;
 * importedAt, name, and metadata never feed it.
 */
export function computeSourceHash(files: SourceInputFile[]): string {
  const h = createHash("sha256");
  for (const f of sortByPath(files)) {
    h.update(f.path);
    h.update("\0");
    h.update(sha256Hex(f.bytes));
    h.update("\0");
  }
  return `sha256:${h.digest("hex")}`;
}

/**
 * The snapshot's identity and storage directory name: a prefix of its content
 * hash. Purely content-derived, so the same bytes always land in the same slot
 * and no user-supplied name can steer (or overwrite) a filesystem path.
 */
export function deriveSnapshotId(sourceHash: string): string {
  return `src-${sourceHash.replace(/^sha256:/, "").slice(0, 16)}`;
}

/** Codepoint order (not locale-sensitive) so hashing is stable everywhere. */
export function sortByPath<T extends { path: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
