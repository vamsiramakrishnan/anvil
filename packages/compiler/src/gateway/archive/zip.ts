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
import { Unzip, UnzipInflate } from "fflate";
import {
  type ArchiveDecoder,
  type ArchiveEntry,
  type ArchiveLimits,
  DEFAULT_ARCHIVE_LIMITS,
} from "./model.js";

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
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;
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
interface CentralDirectorySummary {
  modes: Map<string, number[]>;
  fileCount: number;
}

function decodeZipName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return value;
}

/** Validate the standard central directory before any payload is inflated. */
function inspectCentralDirectory(
  bytes: Uint8Array,
  limits: ArchiveLimits,
): CentralDirectorySummary {
  const modes = new Map<string, number[]>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const earliest = Math.max(0, bytes.byteLength - 65_558);
  for (let offset = bytes.byteLength - 22; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIR_SIG) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveDecodeError("ZIP has no intact end-of-central-directory record.");
  const entryCount = view.getUint16(eocd + 10, true);
  const centralBytes = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ArchiveDecodeError(
      "ZIP64 containers are not accepted by the bounded gateway decoder; provide an export below the configured limits.",
    );
  }
  if (centralOffset + centralBytes > eocd) {
    throw new ArchiveDecodeError("ZIP central directory points outside the container.");
  }

  let i = centralOffset;
  let fileCount = 0;
  let advertisedExpandedBytes = 0;
  for (let record = 0; record < entryCount; record += 1) {
    if (i + 46 > eocd || view.getUint32(i, true) !== CENTRAL_DIR_SIG) {
      throw new ArchiveDecodeError("ZIP central directory is truncated or inconsistent.");
    }
    const madeBy = view.getUint16(i + 4, true);
    const flags = view.getUint16(i + 8, true);
    if ((flags & 0x1) !== 0) {
      throw new ArchiveDecodeError("Encrypted ZIP entries are not accepted.");
    }
    const originalSize = view.getUint32(i + 24, true);
    const nameLen = view.getUint16(i + 28, true);
    const extraLen = view.getUint16(i + 30, true);
    const commentLen = view.getUint16(i + 32, true);
    const externalAttrs = view.getUint32(i + 38, true);
    const nameStart = i + 46;
    const next = nameStart + nameLen + extraLen + commentLen;
    if (next > eocd) throw new ArchiveDecodeError("ZIP central-directory entry is truncated.");
    const name = decodeZipName(
      bytes.subarray(nameStart, nameStart + nameLen),
      (flags & 0x800) !== 0,
    );
    const mode = madeBy >> 8 === OS_UNIX ? (externalAttrs >>> 16) & 0xffff : 0;
    modes.set(name, [...(modes.get(name) ?? []), mode]);
    if (!name.endsWith("/")) {
      fileCount += 1;
      if (fileCount > limits.maxFiles) {
        throw new ArchiveDecodeError(`ZIP exceeds ${limits.maxFiles} files.`);
      }
      if (originalSize > limits.maxFileBytes) {
        throw new ArchiveDecodeError(
          `ZIP entry '${name}' advertises ${originalSize} expanded bytes, above the ${limits.maxFileBytes} byte file limit.`,
        );
      }
      advertisedExpandedBytes += originalSize;
      if (advertisedExpandedBytes > limits.maxExpandedBytes) {
        throw new ArchiveDecodeError(
          `ZIP advertises more than ${limits.maxExpandedBytes} expanded bytes.`,
        );
      }
    }
    i = next;
  }
  if (i !== centralOffset + centralBytes) {
    throw new ArchiveDecodeError("ZIP central-directory size does not match its entries.");
  }
  return { modes, fileCount };
}

/** Decode a ZIP container into raw entries (directories skipped, symlinks flagged). */
export class ZipArchiveDecoder implements ArchiveDecoder {
  decode(bytes: Uint8Array, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): ArchiveEntry[] {
    const format = sniffArchiveFormat(bytes);
    if (format !== "zip") {
      throw new ArchiveDecodeError(
        format === "unknown"
          ? "not a ZIP container (magic bytes do not match)"
          : `container is ${format}, which has no decoder yet — supply a ZIP/JAR export`,
      );
    }
    const central = inspectCentralDirectory(bytes, limits);
    const modes = central.modes;
    const entries: ArchiveEntry[] = [];
    let fileCount = 0;
    let advertisedExpandedBytes = 0;
    let expandedBytes = 0;
    try {
      const unzip = new Unzip((file) => {
        const path = file.name;
        const mode = modes.get(path)?.shift() ?? 0;
        if (path.endsWith("/")) {
          file.ondata = (err) => {
            if (err) throw err;
          };
          file.start();
          return;
        }

        fileCount += 1;
        if (fileCount > limits.maxFiles) {
          throw new ArchiveDecodeError(
            `ZIP exceeds ${limits.maxFiles} files before inflation completed.`,
          );
        }
        if (file.originalSize !== undefined) {
          if (file.originalSize > limits.maxFileBytes) {
            throw new ArchiveDecodeError(
              `ZIP entry '${path}' advertises ${file.originalSize} expanded bytes, above the ${limits.maxFileBytes} byte file limit.`,
            );
          }
          advertisedExpandedBytes += file.originalSize;
          if (advertisedExpandedBytes > limits.maxExpandedBytes) {
            throw new ArchiveDecodeError(
              `ZIP advertises more than ${limits.maxExpandedBytes} expanded bytes.`,
            );
          }
        }

        const chunks: Uint8Array[] = [];
        let fileBytes = 0;
        file.ondata = (err, chunk, final) => {
          if (err) throw err;
          if (chunk && chunk.byteLength > 0) {
            fileBytes += chunk.byteLength;
            expandedBytes += chunk.byteLength;
            if (fileBytes > limits.maxFileBytes) {
              throw new ArchiveDecodeError(
                `ZIP entry '${path}' expanded beyond the ${limits.maxFileBytes} byte file limit.`,
              );
            }
            if (expandedBytes > limits.maxExpandedBytes) {
              throw new ArchiveDecodeError(
                `ZIP expanded beyond the ${limits.maxExpandedBytes} byte archive limit.`,
              );
            }
            chunks.push(chunk);
          }
          if (final) {
            const content = new Uint8Array(fileBytes);
            let offset = 0;
            for (const chunk of chunks) {
              content.set(chunk, offset);
              offset += chunk.byteLength;
            }
            entries.push({
              path,
              bytes: content,
              isSymlink: (mode & S_IFMT) === S_IFLNK,
            });
          }
        };
        file.start();
      });
      unzip.register(UnzipInflate);
      // Small input pushes bound the amount a single inflate callback can
      // produce before the counters above can stop a dishonest ZIP header.
      const chunkBytes = 64 * 1024;
      for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
        const end = Math.min(bytes.byteLength, offset + chunkBytes);
        unzip.push(bytes.subarray(offset, end), end === bytes.byteLength);
      }
      if (entries.length !== central.fileCount) {
        throw new ArchiveDecodeError(
          `ZIP decoded ${entries.length} files but its central directory records ${central.fileCount}.`,
        );
      }
    } catch (err) {
      if (err instanceof ArchiveDecodeError) throw err;
      throw new ArchiveDecodeError(
        `ZIP decode failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return entries;
  }
}
