/**
 * The immutable snapshot store. Layout on disk:
 *
 *   <root>/<snapshotId>/source.json   the locked record
 *   <root>/<snapshotId>/raw/<path>    verbatim byte-for-byte copies
 *
 * Creation is atomic: everything is written into a hidden temp sibling
 * (raw/ first, source.json last) and renamed into place, so a crashed or
 * failed import can never leave a half-written snapshot that looks real.
 * Snapshot ids are content-derived, so re-creating the same content is an
 * idempotent success and different content can never overwrite a slot.
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { computeSourceHash, type SourceInputFile, sha256Hex } from "./hash.js";
import { parseSourceSnapshot, type SourceDiagnostic, type SourceSnapshot } from "./model.js";

/** What creating a snapshot produced. Failure is data, not a throw. */
export type CreateSnapshotResult =
  | {
      ok: true;
      dir: string /** false when the identical snapshot already existed. */;
      created: boolean;
    }
  | { ok: false; diagnostics: SourceDiagnostic[] };

export interface LoadSnapshotResult {
  snapshot?: SourceSnapshot;
  /** The snapshot's directory, present whenever the id resolves to one. */
  dir?: string;
  diagnostics: SourceDiagnostic[];
}

export interface SnapshotListing {
  snapshots: SourceSnapshot[];
  /** Directories whose source.json is unreadable — reported, never skipped. */
  corrupt: { snapshotId: string; diagnostics: SourceDiagnostic[] }[];
}

export interface ReadFilesResult {
  snapshot?: SourceSnapshot;
  /** The verbatim raw/ bytes; absent when the snapshot does not resolve. */
  files?: SourceInputFile[];
  diagnostics: SourceDiagnostic[];
}

/** The storage contract Layer 0 services depend on. */
export interface SourceSnapshotStore {
  /** Atomically persist a snapshot and its verbatim files. */
  create(snapshot: SourceSnapshot, files: SourceInputFile[]): Promise<CreateSnapshotResult>;
  load(snapshotId: string): Promise<LoadSnapshotResult>;
  /** The verbatim raw/ bytes of a snapshot — what the compiler reads from. */
  readFiles(snapshotId: string): Promise<ReadFilesResult>;
  list(): Promise<SnapshotListing>;
  /** Re-hash raw/ against the locked record: added/missing/changed files. */
  verify(snapshotId: string): Promise<{ ok: boolean; diagnostics: SourceDiagnostic[] }>;
}

export class FileSystemSourceSnapshotStore implements SourceSnapshotStore {
  /** @param root the sources directory, e.g. `<workspace>/.anvil/sources`. */
  constructor(private readonly root: string) {}

  async create(snapshot: SourceSnapshot, files: SourceInputFile[]): Promise<CreateSnapshotResult> {
    const finalDir = join(this.root, snapshot.snapshotId);
    const existing = this.idempotentHit(snapshot, finalDir);
    if (existing) return existing;

    const bytesByPath = new Map(files.map((f) => [f.path, f.bytes]));
    // Hidden temp sibling on the same filesystem, so the final rename is atomic.
    const tmp = join(this.root, `.tmp-${snapshot.snapshotId}-${randomBytes(4).toString("hex")}`);
    try {
      // raw/ first, source.json last: a record only ever exists over complete bytes.
      mkdirSync(join(tmp, "raw"), { recursive: true });
      for (const file of snapshot.files) {
        const bytes = bytesByPath.get(file.path);
        if (bytes === undefined) {
          return {
            ok: false,
            diagnostics: [
              {
                level: "error",
                code: "source/missing_content",
                path: file.path,
                message: "Snapshot records this file but no bytes were supplied for it.",
              },
            ],
          };
        }
        const target = join(tmp, "raw", file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      }
      writeFileSync(join(tmp, "source.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      try {
        renameSync(tmp, finalDir);
      } catch (err) {
        // Lost a race to a concurrent import of the same content: still fine
        // if (and only if) what won the slot is the same source.
        const raced = this.idempotentHit(snapshot, finalDir);
        if (raced) return raced;
        throw err;
      }
      return { ok: true, dir: finalDir, created: true };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async load(snapshotId: string): Promise<LoadSnapshotResult> {
    const dir = join(this.root, snapshotId);
    const path = join(dir, "source.json");
    if (!existsSync(path)) {
      return {
        diagnostics: [
          {
            level: "error",
            code: "source/not_found",
            message: `No locked source '${snapshotId}'. Run \`anvil source list\`.`,
          },
        ],
      };
    }
    const { snapshot, diagnostics } = parseSourceSnapshot(readFileSync(path, "utf8"));
    return { snapshot, dir, diagnostics };
  }

  async readFiles(snapshotId: string): Promise<ReadFilesResult> {
    const { snapshot, dir, diagnostics } = await this.load(snapshotId);
    if (!snapshot || !dir) return { diagnostics };
    const rawDir = join(dir, "raw");
    const files = existsSync(rawDir) ? readTree(rawDir) : [];
    return { snapshot, files, diagnostics };
  }

  async list(): Promise<SnapshotListing> {
    const listing: SnapshotListing = { snapshots: [], corrupt: [] };
    if (!existsSync(this.root)) return listing;
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      // Hidden entries are in-flight temp dirs, not (even corrupt) snapshots.
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(this.root, entry.name, "source.json");
      if (!existsSync(path)) {
        listing.corrupt.push({
          snapshotId: entry.name,
          diagnostics: [
            {
              level: "error",
              code: "source/invalid_snapshot",
              message: "Snapshot directory has no source.json.",
            },
          ],
        });
        continue;
      }
      const { snapshot, diagnostics } = parseSourceSnapshot(readFileSync(path, "utf8"));
      if (snapshot) listing.snapshots.push(snapshot);
      else listing.corrupt.push({ snapshotId: entry.name, diagnostics });
    }
    listing.snapshots.sort((a, b) => (a.snapshotId < b.snapshotId ? -1 : 1));
    listing.corrupt.sort((a, b) => (a.snapshotId < b.snapshotId ? -1 : 1));
    return listing;
  }

  async verify(snapshotId: string): Promise<{ ok: boolean; diagnostics: SourceDiagnostic[] }> {
    const { snapshot, dir, diagnostics } = await this.load(snapshotId);
    if (!snapshot || !dir) return { ok: false, diagnostics };
    const rawDir = join(dir, "raw");
    const files: SourceInputFile[] = existsSync(rawDir) ? readTree(rawDir) : [];
    return verifySnapshot(snapshot, files);
  }

  /** The idempotent path: the slot exists and already holds this content. */
  private idempotentHit(
    snapshot: SourceSnapshot,
    finalDir: string,
  ): CreateSnapshotResult | undefined {
    if (!existsSync(finalDir)) return undefined;
    const stored = existsSync(join(finalDir, "source.json"))
      ? parseSourceSnapshot(readFileSync(join(finalDir, "source.json"), "utf8")).snapshot
      : undefined;
    if (stored && stored.sourceHash === snapshot.sourceHash) {
      return { ok: true, dir: finalDir, created: false };
    }
    return {
      ok: false,
      diagnostics: [
        {
          level: "error",
          code: "source/id_collision",
          message: `Snapshot slot '${snapshot.snapshotId}' already exists with different content; refusing to overwrite.`,
        },
      ],
    };
  }
}

/**
 * Confirm a raw file set still matches a locked snapshot. Reports missing,
 * added, and changed files individually; the whole-set hash check catches a
 * tampered source.json even when every file matches its own record.
 */
export function verifySnapshot(
  snapshot: SourceSnapshot,
  files: SourceInputFile[],
): { ok: boolean; diagnostics: SourceDiagnostic[] } {
  const diagnostics: SourceDiagnostic[] = [];
  const actual = new Map(files.map((f) => [f.path, f]));
  for (const rec of snapshot.files) {
    const file = actual.get(rec.path);
    if (!file) {
      diagnostics.push({
        level: "error",
        code: "source/file_missing",
        path: rec.path,
        message: "File recorded in source.json is missing from raw/.",
      });
      continue;
    }
    actual.delete(rec.path);
    const sha = sha256Hex(file.bytes);
    if (sha !== rec.sha256) {
      diagnostics.push({
        level: "error",
        code: "source/file_changed",
        path: rec.path,
        message: `Content hash ${sha.slice(0, 12)}… does not match the locked ${rec.sha256.slice(0, 12)}….`,
      });
    }
  }
  for (const path of actual.keys()) {
    diagnostics.push({
      level: "error",
      code: "source/file_added",
      path,
      message: "File present in raw/ but not recorded in source.json.",
    });
  }
  if (diagnostics.length === 0) {
    const recomputed = computeSourceHash(files);
    if (recomputed !== snapshot.sourceHash) {
      diagnostics.push({
        level: "error",
        code: "source/hash_mismatch",
        message: `Recomputed ${recomputed} does not match the locked ${snapshot.sourceHash}.`,
      });
    }
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

/** Every file under a directory, verbatim, as store-relative posix paths. */
function readTree(root: string): SourceInputFile[] {
  const out: SourceInputFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        out.push({ path: relative(root, full).replaceAll("\\", "/"), bytes: readFileSync(full) });
    }
  };
  walk(root);
  return out;
}
