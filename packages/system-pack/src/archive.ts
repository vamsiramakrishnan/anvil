/**
 * The deterministic archive. A pack plus its artifact bytes serialize into one
 * canonical, path-sorted envelope whose digest is a pure function of content —
 * no timestamps, no filesystem ordering. The physical container (tar/zip via a
 * streaming library) can back this later without changing identity: identity is
 * the envelope digest, and this is the reference serialization of it.
 */
import { contentDigest } from "./digest.js";
import type { AgentSystemPack } from "./model.js";

/** Pack-relative path → verbatim artifact bytes. */
export type PackContents = ReadonlyMap<string, Uint8Array>;

export interface PackArchive {
  /** The canonical serialized bytes of the whole pack (pack + entries). */
  bytes: Uint8Array;
  /** sha256 hex of `bytes` — the archive's content identity. */
  digest: string;
}

/** One archive entry: a path and the content digest of its bytes. */
interface ArchiveEntry {
  path: string;
  contentDigest: string;
  /** base64 of the bytes, so the envelope is self-contained and verifiable. */
  base64: string;
}

/**
 * Produce the deterministic archive for a pack. Entries are path-sorted and the
 * envelope is canonical JSON, so the same pack + same bytes always yield the same
 * archive bytes and digest.
 */
export function archivePack(pack: AgentSystemPack, contents: PackContents): PackArchive {
  const entries: ArchiveEntry[] = [...contents.entries()]
    .map(([path, bytes]) => ({
      path,
      contentDigest: contentDigest(bytes),
      base64: Buffer.from(bytes).toString("base64"),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const envelope = { pack, entries };
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(envelope)));
  return { bytes, digest: contentDigest(bytes) };
}

/** Read the pack + contents back out of an archive's bytes. */
export function readArchive(bytes: Uint8Array): {
  pack: AgentSystemPack;
  contents: Map<string, Uint8Array>;
} {
  const envelope = JSON.parse(new TextDecoder().decode(bytes)) as {
    pack: AgentSystemPack;
    entries: ArchiveEntry[];
  };
  const contents = new Map<string, Uint8Array>();
  for (const entry of envelope.entries) {
    contents.set(entry.path, new Uint8Array(Buffer.from(entry.base64, "base64")));
  }
  return { pack: envelope.pack, contents };
}

/** Recursively key-sort so the serialized envelope is canonical. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
