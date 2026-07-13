/**
 * The real ZIP backend for the offline gateway-import harness — the shell that
 * ADR-0020 deferred. `ZipArchiveDecoder` implements `ArchiveDecoder` over
 * fflate (pure JS, no native deps), so JAR/CAR/plain-ZIP vendor exports decode
 * into raw `ArchiveEntry`s that `normalizeArchive` then puts through the full
 * security battery.
 *
 * fflate's `unzipSync` inflates content but drops per-entry attributes, and the
 * symlink defence NEEDS them: a symlink smuggled in a unix-made zip is only
 * visible in the central directory's external attributes (mode high bits =
 * S_IFLNK). So this decoder walks the central directory itself for entry modes
 * and lets fflate do the inflation — the security-relevant metadata never rides
 * on a library's convenience API.
 *
 * Malformed containers throw `ArchiveDecodeError` (a typed refusal); everything
 * after decode is `normalizeArchive`'s job.
 */
import { unzipSync } from "fflate";
import type { ArchiveDecoder, ArchiveEntry } from "./model.js";

/** A container that cannot be decoded at all — distinct from unsafe entries. */
export class ArchiveDecodeError extends Error {
  readonly code = "archive/undecodable";
  constructor(message: string) {
    super(message);
    this.name = "ArchiveDecodeError";
  }
}

/** The container formats the shell can sniff from magic bytes. */
export type ArchiveFormat = "zip" | "tar" | "gzip" | "unknown";

/**
 * Sniff the container format from magic bytes. JAR, CAR, and most vendor
 * "bundles" are ZIP under a different extension, so extension is never
 * consulted. `tar`/`gzip` are recognized (so the refusal can say what the file
 * IS) but not yet decoded — per ADR-0020 those land as further thin decoders.
 */
export function sniffArchiveFormat(bytes: Uint8Array): ArchiveFormat {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // PK\x03\x04 (local file), PK\x05\x06 (empty archive), PK\x07\x08 (spanned)
    const b2 = bytes[2];
    const b3 = bytes[3];
    if ((b2 === 3 && b3 === 4) || (b2 === 5 && b3 === 6) || (b2 === 7 && b3 === 8)) return "zip";
  }
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
  // POSIX tar: "ustar" at offset 257.
  if (bytes.length >= 262) {
    const u = bytes.subarray(257, 262);
    if (u[0] === 0x75 && u[1] === 0x73 && u[2] === 0x74 && u[3] === 0x61 && u[4] === 0x72) {
      return "tar";
    }
  }
  return "unknown";
}

const CENTRAL_DIR_SIG = 0x02014b50;
/** Unix file-type bits in the external-attributes high word. */
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;
/** version-made-by high byte 3 = UNIX (attribute word is a unix mode). */
const OS_UNIX = 3;

/**
 * Walk the central directory and return each entry's unix mode (0 when the
 * making OS wasn't unix — no symlink bits exist to trust then). Best-effort by
 * design: a truncated central directory yields fewer records, and content
 * decoding never depends on this walk.
 */
function centralDirectoryModes(bytes: Uint8Array): Map<string, number> {
  const modes = new Map<string, number>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let i = 0;
  while (i + 46 <= bytes.length) {
    if (view.getUint32(i, true) !== CENTRAL_DIR_SIG) {
      i += 1;
      continue;
    }
    const madeBy = view.getUint16(i + 4, true);
    const nameLen = view.getUint16(i + 28, true);
    const extraLen = view.getUint16(i + 30, true);
    const commentLen = view.getUint16(i + 32, true);
    const externalAttrs = view.getUint32(i + 38, true);
    const nameStart = i + 46;
    if (nameStart + nameLen > bytes.length) break;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLen));
    const mode = madeBy >> 8 === OS_UNIX ? (externalAttrs >>> 16) & 0xffff : 0;
    modes.set(name, mode);
    i = nameStart + nameLen + extraLen + commentLen;
  }
  return modes;
}

/** Decode a ZIP container into raw entries (directories skipped, symlinks flagged). */
export class ZipArchiveDecoder implements ArchiveDecoder {
  decode(bytes: Uint8Array): ArchiveEntry[] {
    const format = sniffArchiveFormat(bytes);
    if (format !== "zip") {
      throw new ArchiveDecodeError(
        format === "unknown"
          ? "not a ZIP container (magic bytes do not match)"
          : `container is ${format}, which has no decoder yet — supply a ZIP/JAR export`,
      );
    }
    let unzipped: Record<string, Uint8Array>;
    try {
      unzipped = unzipSync(bytes);
    } catch (err) {
      throw new ArchiveDecodeError(
        `ZIP decode failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const modes = centralDirectoryModes(bytes);
    const entries: ArchiveEntry[] = [];
    for (const [path, content] of Object.entries(unzipped)) {
      if (path.endsWith("/")) continue; // directory entries carry no bytes
      const mode = modes.get(path) ?? 0;
      entries.push({
        path,
        bytes: content,
        isSymlink: (mode & S_IFMT) === S_IFLNK,
      });
    }
    return entries;
  }
}
