import { posix } from "node:path";
import type { SourceKind } from "@anvil/air";
import { dereference, load } from "@scalar/openapi-parser";
import { convertObj } from "swagger2openapi";
import { type CompilerSource, ephemeralCompilerSource } from "./source/compiler-source.js";

/**
 * The scalar loader-plugin contract (not re-exported by the package root, so we
 * mirror the fields we use). A plugin turns a reference into content and does
 * the path arithmetic for resolving the next relative reference.
 */
interface LoadPlugin {
  check: (value?: unknown) => boolean;
  get: (value: string) => string;
  resolvePath?: (value: string, reference: string) => string;
  getDir?: (value: string) => string;
  getFilename?: (value: string) => string;
}

export interface ParsedSpec {
  kind: SourceKind;
  /** Fully dereferenced OpenAPI 3.x document. */
  document: OpenApiDocument;
}

/** The subset of OpenAPI we read. Kept loose — the library owns validation. */
export interface OpenApiDocument {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string; [k: string]: unknown };
  servers?: Array<{ url: string; description?: string }>;
  paths?: Record<string, Record<string, unknown>>;
  components?: {
    securitySchemes?: Record<string, SecurityScheme>;
    schemas?: Record<string, unknown>;
  };
  security?: Array<Record<string, string[]>>;
  [k: string]: unknown;
}

export interface SecurityScheme {
  type?: string;
  scheme?: string;
  in?: string;
  name?: string;
  flows?: Record<string, { scopes?: Record<string, string> }>;
}

/**
 * Parse the entrypoint of a CompilerSource into an OpenAPI 3.x document,
 * resolving every LOCAL $ref against the snapshot's virtual filesystem — never
 * an ambient host path. A reference that points at bytes not represented in the
 * snapshot is a hard failure, so the compiler can never read a file the
 * snapshot does not vouch for.
 *
 * Format ownership is unchanged (spec: library-maximal): Swagger 2.0 goes
 * through swagger2openapi's converter, and $ref resolution flows through
 * @scalar/openapi-parser. Multi-file external $refs are supported for
 * OpenAPI 3.x; a Swagger 2.0 entrypoint that spans files is rejected rather
 * than silently dropping the references the converter cannot see.
 */
export async function parseSource(source: CompilerSource): Promise<ParsedSpec> {
  const entry = source.entrypoint.path;
  // Load the entrypoint and every reachable external file into one filesystem,
  // reading exclusively from the snapshot's bytes via the virtual plugin.
  const { filesystem, errors: loadErrors } = await load(entry, {
    plugins: [virtualFilePlugin(source.files)],
    filename: entry,
  });
  if (loadErrors !== undefined && loadErrors.length > 0) {
    const detail = loadErrors.map((e) => e.message).join("; ");
    throw new Error(`Failed to resolve source references from the snapshot: ${detail}`);
  }

  const entrypoint = filesystem.find((f) => f.isEntrypoint)?.specification as
    | OpenApiDocument
    | undefined;
  const isSwagger = typeof entrypoint?.swagger === "string" && entrypoint.swagger.startsWith("2");

  if (isSwagger) {
    // Swagger conversion owns the whole 2.0 field mapping and must see the raw
    // document, so it runs before dereference exactly as it always has. The
    // converter cannot follow external files, so a multi-file 2.0 source is a
    // structured error rather than a partial compile.
    if (filesystem.length > 1) {
      throw new Error(
        "Multi-file Swagger 2.0 sources are not supported; bundle the definition into a single document.",
      );
    }
    const converted = await convertSwagger(entrypoint as OpenApiDocument);
    const { schema, errors } = await dereference(converted);
    if (!schema) throw failure(errors);
    return { kind: "swagger", document: schema as OpenApiDocument };
  }

  const { schema, errors } = await dereference(filesystem);
  if (!schema) throw failure(errors);
  return { kind: "openapi", document: schema as OpenApiDocument };
}

/**
 * Parse + dereference a single spec string. Compatibility convenience: wraps
 * the text as an ephemeral one-file source and runs the one `parseSource` path,
 * so string callers and snapshot callers share identical parsing semantics.
 */
export async function parseSpec(text: string): Promise<ParsedSpec> {
  return parseSource(ephemeralCompilerSource(text));
}

/** Turn dereference errors into the one parse-failure message shape. */
function failure(errors: { message: string }[] | undefined): Error {
  const detail = (errors ?? []).map((e) => e.message).join("; ");
  return new Error(`Failed to parse OpenAPI document: ${detail || "unknown error"}`);
}

/**
 * A scalar loader plugin backed by the snapshot's in-memory filesystem. It
 * resolves relative $ref targets by posix path arithmetic and reads bytes only
 * from `files`; a target outside the snapshot throws, which the loader records
 * as an unresolved reference.
 */
function virtualFilePlugin(files: ReadonlyMap<string, Uint8Array>): LoadPlugin {
  const decoder = new TextDecoder("utf-8");
  const key = (value: string): string => posix.normalize(stripFragment(value)).replace(/^\.\//, "");
  return {
    check(value?: unknown) {
      if (typeof value !== "string") return false;
      if (value.startsWith("http://") || value.startsWith("https://")) return false;
      if (value.includes("\n")) return false;
      return true;
    },
    get(value) {
      const bytes = files.get(key(value));
      if (bytes === undefined) {
        throw new Error(`reference is not represented in the snapshot: ${key(value)}`);
      }
      return decoder.decode(bytes);
    },
    resolvePath(value, reference) {
      const dir = posix.dirname(key(value));
      return posix.normalize(posix.join(dir, stripFragment(reference))).replace(/^\.\//, "");
    },
    getDir(value) {
      return posix.dirname(key(value));
    },
    getFilename(value) {
      return key(value).split("/").pop() ?? value;
    },
  };
}

function stripFragment(value: string): string {
  const hash = value.indexOf("#");
  return hash >= 0 ? value.slice(0, hash) : value;
}

/**
 * Swagger 2.0 → OpenAPI 3.0 via the dedicated converter. It owns the whole
 * field mapping — host/basePath/schemes→servers, body/formData→requestBody
 * (requiredness included), definitions/parameters→components, consumes/
 * produces→content, securityDefinitions→securitySchemes, collectionFormat→
 * style/explode — with vendor extensions carried through. `patch` fixes minor
 * source slips (e.g. a null info field); anything non-patchable is a genuine
 * authoring error and surfaces as a parse failure, never a silent rewrite.
 */
async function convertSwagger(raw: OpenApiDocument): Promise<OpenApiDocument> {
  try {
    const result = await convertObj(raw as Parameters<typeof convertObj>[0], { patch: true });
    return result.openapi as unknown as OpenApiDocument;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to convert Swagger 2.0 document: ${detail}`);
  }
}
