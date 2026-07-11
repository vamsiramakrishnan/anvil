/**
 * An in-memory archive decoder for tests and fixtures. It carries entries verbatim
 * so a test can build a "vendor export" — including deliberately hostile entries
 * (traversal, symlink, oversized) — without a real ZIP file. The real ZIP backend
 * (fflate) implements the same `ArchiveDecoder` interface at the shell.
 */
import type { ArchiveDecoder, ArchiveEntry } from "./model.js";

const enc = (s: string) => new TextEncoder().encode(s);

/** Build archive entries from a `{ path: content }` map plus optional hostile entries. */
export function archiveEntries(
  files: Record<string, string>,
  extra: ArchiveEntry[] = [],
): ArchiveEntry[] {
  return [
    ...Object.entries(files).map(([path, content]) => ({ path, bytes: enc(content) })),
    ...extra,
  ];
}

/** A decoder that returns pre-built entries verbatim. */
export class InMemoryArchiveDecoder implements ArchiveDecoder {
  constructor(private readonly entries: ArchiveEntry[]) {}
  decode(): ArchiveEntry[] {
    return this.entries;
  }
}
