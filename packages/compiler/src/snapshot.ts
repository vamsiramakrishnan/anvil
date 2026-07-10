/**
 * Layer 0 — the source snapshot. Before Anvil compiles anything, it locks what
 * the customer actually supplied: verbatim file contents, a content-derived
 * hash, and the detected wire format. Deliberately pre-AIR: a snapshot must
 * exist even when compilation would fail, so provenance never depends on a
 * clean parse. This module is pure — model + detection + hashing over file
 * contents. Callers own the filesystem, mirroring the compile()/writeBundle
 * split.
 */
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** Where a snapshot came from. Detection covers openapi/swagger; gateway
 * export kinds (apigee, mulesoft, …) are declared by the importer. */
export const SourceSnapshotKind = z.enum([
  "openapi",
  "swagger",
  "apigee",
  "mulesoft",
  "kong",
  "api_connect",
  "wso2",
]);
export type SourceSnapshotKind = z.infer<typeof SourceSnapshotKind>;

/** The wire syntax a file was written in, independent of the spec format. */
export const SpecSyntax = z.enum(["yaml", "json"]);
export type SpecSyntax = z.infer<typeof SpecSyntax>;

/** What a file declared itself to be, read without compiling it. Version is
 * normalized to the major.minor family ("2.0", "3.0", "3.1"). */
export const DetectedFormat = z.object({
  kind: z.enum(["openapi", "swagger"]),
  version: z.string(),
});
export type DetectedFormat = z.infer<typeof DetectedFormat>;

export const SourceFile = z.object({
  /** Path relative to the import root, always posix-separated. */
  path: z.string(),
  /** sha256 hex digest of the verbatim content. */
  sha256: z.string(),
  bytes: z.number().int().nonnegative(),
  syntax: SpecSyntax,
  /** Absent for supporting files ($ref targets, shared components). */
  detected: DetectedFormat.optional(),
});
export type SourceFile = z.infer<typeof SourceFile>;

export const SourceSnapshot = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  kind: SourceSnapshotKind,
  sourceUri: z.string(),
  /** Provenance metadata only — never part of the hash. */
  importedAt: z.string(),
  /** Content-derived: sha256 over the sorted (path, content-hash) file set. */
  sourceHash: z.string(),
  files: z.array(SourceFile),
  metadata: z
    .object({
      environment: z.string().optional(),
      gatewayProduct: z.string().optional(),
      organization: z.string().optional(),
      workspace: z.string().optional(),
    })
    .default({}),
});
export type SourceSnapshot = z.infer<typeof SourceSnapshot>;

/** Structured diagnostics for broken input. User errors are data, not throws. */
export const SourceDiagnostic = z.object({
  level: z.enum(["error", "warning", "info"]),
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
});
export type SourceDiagnostic = z.infer<typeof SourceDiagnostic>;

export interface SnapshotFileInput {
  /** Relative, posix-separated path within the import. */
  path: string;
  /** Verbatim file content. */
  content: string;
}

export interface CreateSnapshotInput {
  files: SnapshotFileInput[];
  sourceUri: string;
  /** Override the derived, content-addressed id. */
  id?: string;
  /** Declare a gateway-export kind that detection cannot infer. */
  kind?: SourceSnapshotKind;
  metadata?: SourceSnapshot["metadata"];
  /** Injectable clock so tests are deterministic. Feeds importedAt only. */
  now?: () => Date;
}

export interface SnapshotResult {
  /** Absent when any error-level diagnostic was produced. */
  snapshot?: SourceSnapshot;
  diagnostics: SourceDiagnostic[];
}

/**
 * Build a locked snapshot from in-memory file contents. Pure and total: broken
 * input yields diagnostics, never a throw. The file set is sorted by path so
 * the snapshot (and its hash) is independent of the order files were read.
 */
export function createSnapshot(input: CreateSnapshotInput): SnapshotResult {
  const diagnostics: SourceDiagnostic[] = [];
  if (input.files.length === 0) {
    return {
      diagnostics: [
        {
          level: "error",
          code: "source/empty",
          message: `No spec files found at '${input.sourceUri}'. Expected .yaml, .yml, or .json files.`,
        },
      ],
    };
  }

  const files: SourceFile[] = [];
  for (const f of sortByPath(input.files)) {
    const parsed = parseDocument(f.content);
    if ("error" in parsed) {
      diagnostics.push({
        level: "error",
        code: "source/unparseable",
        path: f.path,
        message: parsed.error,
      });
      continue;
    }
    const detected = detectDeclaredFormat(parsed.doc);
    if (!detected) {
      // Supporting files ($ref targets, shared components) are legitimate in a
      // directory import — captured verbatim, but they carry no format claim.
      diagnostics.push({
        level: "info",
        code: "source/no_declared_format",
        path: f.path,
        message: "Not a recognized OpenAPI/Swagger document; captured as a supporting file.",
      });
    }
    files.push({
      path: f.path,
      sha256: sha256Hex(f.content),
      bytes: Buffer.byteLength(f.content, "utf8"),
      syntax: parsed.syntax,
      detected,
    });
  }

  if (diagnostics.some((d) => d.level === "error")) return { diagnostics };

  const specs = files.filter((f) => f.detected);
  if (specs.length === 0) {
    diagnostics.push({
      level: "error",
      code: "source/unknown_format",
      message:
        'No OpenAPI/Swagger document detected: no file declares `openapi:` (3.x) or `swagger: "2.0"`.',
    });
    return { diagnostics };
  }

  // A mixed directory is snapshotted under its most modern format family.
  const kind =
    input.kind ?? (specs.some((f) => f.detected?.kind === "openapi") ? "openapi" : "swagger");
  const sourceHash = computeSourceHash(input.files);
  const now = input.now ?? (() => new Date());
  const snapshot: SourceSnapshot = {
    schemaVersion: 1,
    id: input.id ?? deriveSnapshotId(input.sourceUri, sourceHash),
    kind,
    sourceUri: input.sourceUri,
    importedAt: now().toISOString(),
    sourceHash,
    files,
    metadata: input.metadata ?? {},
  };
  return { snapshot, diagnostics };
}

/**
 * The deterministic content hash: sha256 over the path-sorted (path,
 * content-hash) pairs. Re-importing unchanged content yields the same hash;
 * importedAt and metadata never feed it.
 */
export function computeSourceHash(files: SnapshotFileInput[]): string {
  const h = createHash("sha256");
  for (const f of sortByPath(files)) {
    h.update(f.path);
    h.update("\0");
    h.update(sha256Hex(f.content));
    h.update("\0");
  }
  return `sha256:${h.digest("hex")}`;
}

/**
 * Confirm a raw file set still matches a locked snapshot. Reports missing,
 * added, and changed files individually; the whole-set hash check catches a
 * tampered source.json even when every file matches its own record.
 */
export function verifySnapshot(
  snapshot: SourceSnapshot,
  files: SnapshotFileInput[],
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
    const sha = sha256Hex(file.content);
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

/** Parse a stored source.json into a snapshot, or into diagnostics. */
export function parseSourceSnapshot(text: string): SnapshotResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      diagnostics: [
        {
          level: "error",
          code: "source/unparseable",
          message: `source.json is not valid JSON: ${(err as Error).message}`,
        },
      ],
    };
  }
  const parsed = SourceSnapshot.safeParse(raw);
  if (!parsed.success) {
    return {
      diagnostics: [
        {
          level: "error",
          code: "source/invalid_snapshot",
          message: parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; "),
        },
      ],
    };
  }
  return { snapshot: parsed.data, diagnostics: [] };
}

/* --------------------------------- internals ------------------------------- */

/** Syntax detection first (is it JSON or YAML at all?), format second. */
function parseDocument(content: string): { syntax: SpecSyntax; doc: unknown } | { error: string } {
  const head = content.trimStart();
  if (head.startsWith("{") || head.startsWith("[")) {
    try {
      return { syntax: "json", doc: JSON.parse(content) };
    } catch (err) {
      return { error: `Invalid JSON: ${(err as Error).message}` };
    }
  }
  try {
    return { syntax: "yaml", doc: parseYaml(content) };
  } catch (err) {
    return { error: `Invalid YAML: ${(err as Error).message}` };
  }
}

/**
 * Read the format a document claims for itself — `openapi: 3.x` vs
 * `swagger: 2.0` — without compiling or dereferencing anything.
 */
function detectDeclaredFormat(doc: unknown): DetectedFormat | undefined {
  if (typeof doc !== "object" || doc === null) return undefined;
  const d = doc as Record<string, unknown>;
  if (typeof d.openapi === "string") {
    const family = d.openapi.match(/^(\d+\.\d+)/)?.[1];
    return { kind: "openapi", version: family ?? d.openapi };
  }
  if (typeof d.swagger === "string" && d.swagger.startsWith("2")) {
    return { kind: "swagger", version: "2.0" };
  }
  return undefined;
}

/** Content-addressed default id: a readable stem plus a hash prefix, so the
 * same content re-imported from the same place lands in the same slot. */
function deriveSnapshotId(sourceUri: string, sourceHash: string): string {
  const base = sourceUri.replace(/\/+$/, "").split("/").pop() ?? "source";
  const stem =
    base
      .replace(/\.(yaml|yml|json)$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "source";
  return `${stem}-${sourceHash.replace(/^sha256:/, "").slice(0, 12)}`;
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Codepoint order (not locale-sensitive) so hashing is stable everywhere. */
function sortByPath<T extends { path: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
