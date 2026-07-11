/**
 * Layer 0 model — the immutable source snapshot. Before Anvil compiles
 * anything, it captures what the customer actually supplied: verbatim bytes,
 * a content-derived identity, the discovered entrypoints, and structured
 * diagnostics. Deliberately pre-AIR: a snapshot exists even when compilation
 * would fail, so provenance never depends on a clean parse.
 */
import { z } from "zod";

/**
 * Where a source came from — the system of origin, never the spec format.
 * A gateway export (apigee, mulesoft, …) can still contain OpenAPI 3.1 or
 * Swagger 2.0 documents; per-entrypoint format lives in `entrypoints`.
 */
export const SourceOriginKind = z.enum([
  "filesystem",
  "apigee",
  "mulesoft",
  "kong",
  "api_connect",
  "wso2",
  // The in-repo fake gateway used to prove the adapter pipeline without a vendor.
  "fixture",
]);
export type SourceOriginKind = z.infer<typeof SourceOriginKind>;

export const SourceOrigin = z.object({
  kind: SourceOriginKind,
  /** The import target as supplied (a path for filesystem imports). */
  uri: z.string(),
});
export type SourceOrigin = z.infer<typeof SourceOrigin>;

/** The wire syntax a file was written in, independent of the spec format. */
export const SpecSyntax = z.enum(["yaml", "json"]);
export type SpecSyntax = z.infer<typeof SpecSyntax>;

/**
 * The spec format one entrypoint declares for itself. `openapi`/`swagger` are
 * REST/JSON; `graphql`, `protobuf` (gRPC), and `wsdl` (SOAP) are non-REST
 * protocols lowered into the same internal model by the protocol adapters.
 */
export const EntrypointFormat = z.enum(["openapi", "swagger", "graphql", "protobuf", "wsdl"]);
export type EntrypointFormat = z.infer<typeof EntrypointFormat>;

/**
 * Why a snapshot did or did not become compilable input:
 *   valid        — at least one entrypoint, no error-level diagnostics
 *   invalid      — something was readable but broken (parse error, bad UTF-8,
 *                  a reference escaping the import root, …)
 *   unclassified — readable, but nothing declares itself OpenAPI/Swagger
 * Only `valid` snapshots may be compiled.
 */
export const SourceStatus = z.enum(["valid", "invalid", "unclassified"]);
export type SourceStatus = z.infer<typeof SourceStatus>;

/** How a file entered the snapshot's graph. */
export const SourceFileRole = z.enum([
  /** A document that declares a spec format; compilation starts here. */
  "entrypoint",
  /** Reached from an entrypoint through a local $ref. */
  "reference",
  /** Captured verbatim but carrying no format claim of its own. */
  "supporting",
]);
export type SourceFileRole = z.infer<typeof SourceFileRole>;

/**
 * Why a snapshot path is unacceptable, or undefined when it is fine. Paths are
 * identity inside the snapshot AND become filenames under raw/, so they must be
 * clean relative POSIX paths that cannot climb out of the snapshot directory.
 */
export function invalidPathReason(path: string): string | undefined {
  if (path.length === 0) return "must not be empty";
  if (path.includes("\0")) return "must not contain NUL";
  if (path.includes("\\")) return "must use POSIX separators";
  if (path.startsWith("/")) return "must be relative, not absolute";
  if (/^[A-Za-z]:/.test(path)) return "must not carry a Windows drive";
  const segments = path.split("/");
  if (segments.includes("..")) return "must not contain '..'";
  if (segments.some((s) => s === "" || s === ".")) return "must not contain empty or '.' segments";
  return undefined;
}

/** A validated snapshot-relative path (see invalidPathReason for the rules). */
export const SourcePath = z.string().superRefine((path, ctx) => {
  const reason = invalidPathReason(path);
  if (reason) ctx.addIssue({ code: "custom", message: `path ${reason}` });
});

export const SourceFile = z.object({
  /** Path relative to the import root, always posix-separated. */
  path: SourcePath,
  /** sha256 hex digest of the verbatim bytes. */
  sha256: z.string(),
  bytes: z.number().int().nonnegative(),
  /** Absent when the file could not even be decoded as UTF-8. */
  syntax: SpecSyntax.optional(),
  role: SourceFileRole,
});
export type SourceFile = z.infer<typeof SourceFile>;

/** One compilable document and the format family it declares ("2.0", "3.0", "3.1"). */
export const SourceEntrypoint = z.object({
  path: SourcePath,
  format: EntrypointFormat,
  version: z.string(),
});
export type SourceEntrypoint = z.infer<typeof SourceEntrypoint>;

/** Structured diagnostics for broken input. User errors are data, not throws. */
export const SourceDiagnostic = z.object({
  level: z.enum(["error", "warning", "info"]),
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
  /** 1-based position inside `path`, when the parser could pin one down. */
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
});
export type SourceDiagnostic = z.infer<typeof SourceDiagnostic>;

export const SourceSnapshot = z.object({
  schemaVersion: z.literal(1),
  /** Content-derived identity; the storage directory name. Never user-chosen. */
  snapshotId: z.string(),
  /** Optional human label. Metadata only — never identity, never a path. */
  name: z.string().optional(),
  origin: SourceOrigin,
  status: SourceStatus,
  /** Provenance metadata only — never part of the hash. */
  importedAt: z.string(),
  /** Content-derived: sha256 over the sorted (path, content-hash) file set. */
  sourceHash: z.string(),
  entrypoints: z.array(SourceEntrypoint),
  files: z.array(SourceFile),
  /** What import observed — parse errors, escapes, external refs, exclusions. */
  diagnostics: z.array(SourceDiagnostic),
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

/** The result shape shared by everything that can fail into diagnostics. */
export interface SnapshotResult {
  /** Absent when nothing readable was supplied. */
  snapshot?: SourceSnapshot;
  diagnostics: SourceDiagnostic[];
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
