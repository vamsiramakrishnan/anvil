/**
 * The archive security normalizer. Given raw entries (from any decoder), apply the
 * full defensive battery and return byte-preserving files plus diagnostics. A
 * rejected entry never reaches an adapter; the reason is always reported (silent
 * truncation would read as "we imported everything" when we did not).
 */
import { sha256Hex } from "../../source/hash.js";
import {
  type ArchiveDecoder,
  type ArchiveDiagnostic,
  type ArchiveEntry,
  type ArchiveLimits,
  DEFAULT_ARCHIVE_LIMITS,
  type NormalizedFile,
  type ReadArchiveResult,
} from "./model.js";

/** True for a path that must never be extracted (zip-slip / traversal / absolute). */
function isUnsafePath(path: string): boolean {
  if (path.length === 0) return true;
  if (path.startsWith("/")) return true; // absolute POSIX
  if (/^[a-zA-Z]:[\\/]/.test(path)) return true; // Windows drive
  if (path.includes("\\")) return true; // backslash separator
  if (path.includes("\0")) return true; // NUL
  const segments = path.split("/");
  if (segments.some((s) => s === "..")) return true; // traversal
  return false;
}

function depthOf(path: string): number {
  return path.split("/").filter((s) => s.length > 0).length;
}

/**
 * Normalize raw archive entries into safe files. Enforces (in order): path safety,
 * symlink rejection, per-file size, depth, duplicate-conflict detection, and the
 * cumulative file-count / expanded-size caps. `ok` is false if any error-level
 * diagnostic fired; accepted files are still returned so a caller can proceed with
 * the safe subset if it chooses.
 */
export function normalizeArchive(
  entries: readonly ArchiveEntry[],
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): ReadArchiveResult {
  const diagnostics: ArchiveDiagnostic[] = [];
  const accepted = new Map<string, NormalizedFile>();
  const hashes = new Map<string, string>();
  let expandedBytes = 0;

  for (const entry of entries) {
    if (accepted.size >= limits.maxFiles) {
      diagnostics.push({
        level: "error",
        code: "archive/too_many_files",
        message: `Archive exceeds ${limits.maxFiles} files; refusing the rest.`,
      });
      break;
    }
    if (entry.isSymlink) {
      diagnostics.push({
        level: "error",
        code: "archive/symlink_rejected",
        path: entry.path,
        message: `Symlink '${entry.path}' rejected (escape defence).`,
      });
      continue;
    }
    if (isUnsafePath(entry.path)) {
      diagnostics.push({
        level: "error",
        code: "archive/unsafe_path",
        path: entry.path,
        message: `Unsafe archive path '${entry.path}' (absolute, traversal, or backslash).`,
      });
      continue;
    }
    if (depthOf(entry.path) > limits.maxDepth) {
      diagnostics.push({
        level: "error",
        code: "archive/too_deep",
        path: entry.path,
        message: `Path '${entry.path}' exceeds depth ${limits.maxDepth}.`,
      });
      continue;
    }
    if (entry.bytes.byteLength > limits.maxFileBytes) {
      diagnostics.push({
        level: "error",
        code: "archive/file_too_large",
        path: entry.path,
        message: `File '${entry.path}' (${entry.bytes.byteLength} B) exceeds ${limits.maxFileBytes} B.`,
      });
      continue;
    }

    const hash = sha256Hex(entry.bytes);
    const prior = hashes.get(entry.path);
    if (prior !== undefined) {
      // Same path twice: identical content dedupes; different content is a conflict.
      if (prior !== hash) {
        diagnostics.push({
          level: "error",
          code: "archive/duplicate_path",
          path: entry.path,
          message: `Conflicting duplicate path '${entry.path}'.`,
        });
      }
      continue;
    }

    if (expandedBytes + entry.bytes.byteLength > limits.maxExpandedBytes) {
      diagnostics.push({
        level: "error",
        code: "archive/expanded_too_large",
        message: `Archive expands beyond ${limits.maxExpandedBytes} B; refusing the rest.`,
      });
      break;
    }

    expandedBytes += entry.bytes.byteLength;
    hashes.set(entry.path, hash);
    accepted.set(entry.path, { path: entry.path, bytes: entry.bytes });
  }

  const files = [...accepted.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return { ok: !diagnostics.some((d) => d.level === "error"), files, diagnostics };
}

/** Decode a container's bytes, then normalize the entries. */
export function readArchive(
  bytes: Uint8Array,
  decoder: ArchiveDecoder,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): ReadArchiveResult {
  return normalizeArchive(decoder.decode(bytes), limits);
}

/** Decode UTF-8 text from a normalized file, rejecting invalid encodings. */
export function decodeArchiveText(
  file: NormalizedFile,
): { ok: true; text: string } | { ok: false; code: "archive/invalid_encoding" } {
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(file.bytes) };
  } catch {
    return { ok: false, code: "archive/invalid_encoding" };
  }
}
