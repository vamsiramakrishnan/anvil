/**
 * SourceService — the one Layer 0 entry point callers (CLI, agentify, sync)
 * compose: import a source graph, freeze it into a snapshot, and persist it
 * atomically. The CLI parses options and renders; everything that decides
 * lives here or below. Constructed with { importer, store, clock } so every
 * piece is injectable in tests.
 */
import { deriveSnapshotId, sha256Hex } from "./hash.js";
import type { SourceImporter, SourceImportResult } from "./import.js";
import type { SourceDiagnostic, SourceOriginKind, SourceSnapshot, SourceStatus } from "./model.js";
import type { LoadSnapshotResult, SnapshotListing, SourceSnapshotStore } from "./store.js";

export interface SourceServiceDeps {
  importer: SourceImporter;
  store: SourceSnapshotStore;
  /** Injectable clock so tests are deterministic. Feeds importedAt only. */
  clock?: () => Date;
}

export interface AddSourceOptions {
  /** Optional human label. Never identity, never a filesystem path. */
  name?: string;
  /** Declare a gateway-export origin that discovery cannot infer. */
  originKind?: SourceOriginKind;
  metadata?: SourceSnapshot["metadata"];
}

export interface AddSourceResult {
  /** Absent only when nothing could be read at all. */
  snapshot?: SourceSnapshot;
  /** Where the snapshot was locked; absent when the store refused. */
  dir?: string;
  /** False when the identical content was already locked (idempotent hit). */
  created?: boolean;
  /** Import diagnostics plus any store failure. Also inside the snapshot. */
  diagnostics: SourceDiagnostic[];
}

export class SourceService {
  private readonly importer: SourceImporter;
  private readonly store: SourceSnapshotStore;
  private readonly clock: () => Date;

  constructor(deps: SourceServiceDeps) {
    this.importer = deps.importer;
    this.store = deps.store;
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * Import, freeze, and lock a source. If at least one file was readable a
   * snapshot exists — even an invalid or unclassified one — with the
   * diagnostics inside it; only a completely unreadable target produces none.
   */
  async add(targets: string[], options: AddSourceOptions = {}): Promise<AddSourceResult> {
    const imported = await this.importer.import(targets);
    const snapshot = snapshotFromImport(imported, {
      originUri: originUriFor(targets, imported),
      originKind: options.originKind,
      name: options.name,
      metadata: options.metadata,
      clock: this.clock,
    });
    if (!snapshot) return { diagnostics: imported.diagnostics };
    const stored = await this.store.create(snapshot, imported.files);
    if (!stored.ok) {
      return { snapshot, diagnostics: [...snapshot.diagnostics, ...stored.diagnostics] };
    }
    return {
      snapshot,
      dir: stored.dir,
      created: stored.created,
      diagnostics: snapshot.diagnostics,
    };
  }

  async list(): Promise<SnapshotListing> {
    return this.store.list();
  }

  async show(snapshotId: string): Promise<LoadSnapshotResult> {
    return this.store.load(snapshotId);
  }

  async validate(snapshotId: string): Promise<{ ok: boolean; diagnostics: SourceDiagnostic[] }> {
    return this.store.verify(snapshotId);
  }
}

export interface SnapshotFromImportOptions {
  originUri: string;
  originKind?: SourceOriginKind;
  name?: string;
  metadata?: SourceSnapshot["metadata"];
  clock?: () => Date;
}

/**
 * Freeze an import into an immutable snapshot. Pure: identity comes from the
 * content hash, status from what discovery observed, and the clock feeds
 * provenance only. Returns undefined when the import read nothing.
 */
export function snapshotFromImport(
  imported: SourceImportResult,
  options: SnapshotFromImportOptions,
): SourceSnapshot | undefined {
  if (imported.files.length === 0 || imported.sourceHash === undefined) return undefined;
  const now = options.clock ?? (() => new Date());
  return {
    schemaVersion: 1,
    snapshotId: deriveSnapshotId(imported.sourceHash),
    name: options.name,
    origin: { kind: options.originKind ?? "filesystem", uri: options.originUri },
    status: statusFor(imported),
    importedAt: now().toISOString(),
    sourceHash: imported.sourceHash,
    entrypoints: imported.entrypoints,
    files: imported.files.map((f) => ({
      path: f.path,
      sha256: sha256Hex(f.bytes),
      bytes: f.bytes.byteLength,
      syntax: f.syntax,
      role: f.role,
    })),
    diagnostics: imported.diagnostics,
    metadata: options.metadata ?? {},
  };
}

/** valid needs an entrypoint and a clean import; errors trump everything. */
function statusFor(imported: SourceImportResult): SourceStatus {
  if (imported.diagnostics.some((d) => d.level === "error")) return "invalid";
  if (imported.entrypoints.length === 0) return "unclassified";
  return "valid";
}

/** The provenance URI: the single target as given, else the discovered root. */
function originUriFor(targets: string[], imported: SourceImportResult): string {
  if (targets.length === 1) return targets[0] as string;
  return imported.rootDir ?? targets.join(" ");
}
