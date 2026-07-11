/**
 * The compiler's input contract. A CompilerSource is the immutable,
 * self-contained filesystem the compiler reads from: verbatim bytes keyed by
 * snapshot-relative posix path, one chosen entrypoint, and the provenance that
 * binds the resulting AIR to the exact source it came from.
 *
 * This is the join the whole pipeline is built around: the compiler never
 * reads an ambient host path. Every byte it parses — including every local
 * $ref target — comes out of `files`, so the AIR is cryptographically bound to
 * the snapshot it was compiled from and cannot drift from it between lock and
 * compile.
 */
import { basename } from "node:path";
import { detectDeclaredFormat, parseSourceText } from "./detect.js";
import { computeSourceHash, deriveSnapshotId, type SourceInputFile } from "./hash.js";
import type { SourceDiagnostic, SourceEntrypoint, SourceOrigin, SourceSnapshot } from "./model.js";

export interface CompilerSource {
  /** Content-derived snapshot identity (synthetic for ephemeral sources). */
  snapshotId: string;
  /** sha256 over the whole file set — the AIR's binding to these bytes. */
  sourceHash: string;
  origin: SourceOrigin;
  /** The one document compilation starts from. */
  entrypoint: SourceEntrypoint;
  /** Snapshot-relative posix path → verbatim bytes. The entire compile FS. */
  files: ReadonlyMap<string, Uint8Array>;
}

export interface CompilerSourceResult {
  /** Absent when the snapshot cannot be turned into a compiler input. */
  source?: CompilerSource;
  diagnostics: SourceDiagnostic[];
}

/**
 * Bind a locked snapshot's raw bytes to a chosen entrypoint. This is the real
 * Layer 0 → Layer 1 join: the compiler consumes the immutable snapshot instead
 * of re-reading the original path. Only `valid` snapshots may be compiled.
 */
export function compilerSourceFromSnapshot(
  snapshot: SourceSnapshot,
  files: SourceInputFile[],
  entrypointPath?: string,
): CompilerSourceResult {
  if (snapshot.status !== "valid") {
    return {
      diagnostics: [
        {
          level: "error",
          code: "source/not_compilable",
          message: `Snapshot ${snapshot.snapshotId} is ${snapshot.status}; only 'valid' snapshots may be compiled.`,
        },
      ],
    };
  }

  const selected = selectEntrypoint(snapshot, entrypointPath);
  if ("error" in selected) return { diagnostics: [selected.error] };

  const map = new Map<string, Uint8Array>(files.map((f) => [f.path, f.bytes]));
  if (!map.has(selected.entrypoint.path)) {
    return {
      diagnostics: [
        {
          level: "error",
          code: "source/missing_content",
          path: selected.entrypoint.path,
          message: "The snapshot records this entrypoint but no bytes were supplied for it.",
        },
      ],
    };
  }

  return {
    source: {
      snapshotId: snapshot.snapshotId,
      sourceHash: snapshot.sourceHash,
      origin: snapshot.origin,
      entrypoint: selected.entrypoint,
      files: map,
    },
    diagnostics: [],
  };
}

/** Pick the entrypoint: the named one, the sole one, else an ambiguity error. */
function selectEntrypoint(
  snapshot: SourceSnapshot,
  entrypointPath?: string,
): { entrypoint: SourceEntrypoint } | { error: SourceDiagnostic } {
  const { entrypoints } = snapshot;
  const available = entrypoints.map((e) => e.path).join(", ");
  if (entrypointPath !== undefined) {
    const found = entrypoints.find((e) => e.path === entrypointPath);
    if (!found) {
      return {
        error: {
          level: "error",
          code: "source/unknown_entrypoint",
          path: entrypointPath,
          message: `No entrypoint '${entrypointPath}' in snapshot ${snapshot.snapshotId}. Available: ${available}.`,
        },
      };
    }
    return { entrypoint: found };
  }
  if (entrypoints.length === 1) return { entrypoint: entrypoints[0] as SourceEntrypoint };
  if (entrypoints.length === 0) {
    return {
      error: {
        level: "error",
        code: "source/no_entrypoint",
        message: `Snapshot ${snapshot.snapshotId} declares no entrypoint; nothing to compile.`,
      },
    };
  }
  return {
    error: {
      level: "error",
      code: "source/ambiguous_entrypoint",
      message: `Snapshot ${snapshot.snapshotId} has ${entrypoints.length} entrypoints; choose one with --entrypoint (${available}).`,
    },
  };
}

/**
 * Wrap raw spec text as a single-file ephemeral source. The compatibility path
 * for `compile({ spec })`: callers that only have a string still flow through
 * the one `compileSource` pipeline, over an in-memory one-file filesystem whose
 * identity is derived from the text exactly as a real snapshot's would be.
 */
export function ephemeralCompilerSource(spec: string, sourceUri?: string): CompilerSource {
  const path = ephemeralEntrypointName(sourceUri);
  const bytes = new TextEncoder().encode(spec);
  const inputs: SourceInputFile[] = [{ path, bytes }];
  const sourceHash = computeSourceHash(inputs);
  const detected = detectEphemeralFormat(spec);
  return {
    snapshotId: deriveSnapshotId(sourceHash),
    sourceHash,
    origin: { kind: "filesystem", uri: sourceUri ?? path },
    entrypoint: { path, format: detected.format, version: detected.version },
    files: new Map([[path, bytes]]),
  };
}

/** A clean snapshot-relative name for an ephemeral entrypoint. */
function ephemeralEntrypointName(sourceUri?: string): string {
  if (sourceUri === undefined) return "spec.yaml";
  const base = basename(sourceUri);
  return base.length > 0 && !base.includes("\0") ? base : "spec.yaml";
}

/**
 * Best-effort format claim for an ephemeral source (provenance only). A broken
 * spec that declares nothing falls back to openapi/unknown; the real parse in
 * `compileSource` still produces the meaningful error.
 */
function detectEphemeralFormat(spec: string): {
  format: SourceEntrypoint["format"];
  version: string;
} {
  const parsed = parseSourceText(spec);
  const detected = parsed.doc === undefined ? undefined : detectDeclaredFormat(parsed.doc);
  return detected ?? { format: "openapi", version: "unknown" };
}
