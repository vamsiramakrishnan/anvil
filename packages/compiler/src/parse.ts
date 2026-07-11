import { posix } from "node:path";
import type { Diagnostic, SourceKind } from "@anvil/air";
import { dereference, load } from "@scalar/openapi-parser";
import { convertObj } from "swagger2openapi";
import { bundleDocument, DEFAULT_MAX_SCHEMA_DEPTH } from "./decycle.js";
import { adaptProtocol, type ProtocolFormat, type ProtoImportResolver } from "./protocols/index.js";
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
  /** Diagnostics raised while parsing (e.g. self-referential schemas truncated). */
  diagnostics: Diagnostic[];
}

/**
 * Full `$ref` dereferencing turns a self-referential schema into a genuine
 * circular object graph, and a densely cross-referential one (Stripe's
 * ~860 schemas is the case that found this) into a combinatorial blowup when
 * naively inlined (spec §2.4 conservatism applies to structure, not just
 * safety: never hand the rest of the pipeline a document it cannot serialize
 * or that takes minutes to). `bundleDocument` fixes this at the source —
 * every named schema is processed once and referenced by `$ref` everywhere
 * else, the same way the real spec (and every real SDK generator) already
 * represents cross-referential types — rather than truncating a naively
 * inlined tree after the fact. A cycle among named schemas needs no special
 * handling at all (it's just a `$ref` back to a name); only genuinely deep
 * *anonymous* structure can still hit the depth bound, which stays as a rare
 * backstop, never silent: a `schema_cycle_truncated` diagnostic per
 * occurrence (structurally significant), and one aggregate
 * `schema_depth_truncated` diagnostic if the backstop fires at all.
 */
function decycle(document: OpenApiDocument): {
  document: OpenApiDocument;
  diagnostics: Diagnostic[];
} {
  const { document: bundled, truncatedAt, depthLimitedAt } = bundleDocument(document);
  const diagnostics: Diagnostic[] = truncatedAt.map((path) => ({
    level: "warning",
    code: "schema_cycle_truncated",
    message: `Schema at ${path} is a self-referential anonymous structure; the recursive nesting was truncated to a shallow stub so the compiled bundle stays JSON-safe. Review the source spec if the full recursive shape matters to callers.`,
    path,
  }));
  if (depthLimitedAt.length > 0) {
    const sample = depthLimitedAt.slice(0, 5).join(", ");
    diagnostics.push({
      level: "info",
      code: "schema_depth_truncated",
      message:
        `${depthLimitedAt.length} anonymous (unnamed) nested structure(s) beyond the ${DEFAULT_MAX_SCHEMA_DEPTH}-level ` +
        `expansion bound were truncated to a shallow stub (e.g. ${sample}${depthLimitedAt.length > 5 ? ", …" : ""}). ` +
        `Named component schemas are unaffected by this bound — they are referenced by $ref, not inlined. This does ` +
        `not affect any operation's classified safety, only how deep an unnamed/inline payload shape nests.`,
    });
  }
  return { document: bundled, diagnostics };
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

/** EntrypointFormat values that are non-REST protocols lowered by an adapter. */
const PROTOCOL_FORMATS: Record<string, { format: ProtocolFormat; kind: SourceKind }> = {
  graphql: { format: "graphql", kind: "graphql" },
  protobuf: { format: "protobuf", kind: "protobuf" },
  wsdl: { format: "wsdl", kind: "wsdl" },
  discovery: { format: "discovery", kind: "discovery" },
};

/**
 * Resolve a proto `import "a/b/c.proto"` to another file *in the same
 * snapshot* — never the network or an ambient host path, matching the OpenAPI
 * multi-file contract. Tries the import path verbatim, then its basename, so a
 * snapshot that preserves the import's directory structure OR just carries the
 * sibling `.proto` files flat both resolve. A missing import returns undefined
 * and the proto adapter degrades that type gracefully.
 */
function protoImportResolver(source: CompilerSource): ProtoImportResolver {
  const decoder = new TextDecoder("utf-8");
  const byBasename = new Map<string, Uint8Array>();
  for (const [path, bytes] of source.files) {
    const base = path.split("/").pop();
    if (base && !byBasename.has(base)) byBasename.set(base, bytes);
  }
  return (importPath: string): string | undefined => {
    const direct = source.files.get(importPath) ?? source.files.get(posix.normalize(importPath));
    if (direct) return decoder.decode(direct);
    const base = importPath.split("/").pop();
    const byBase = base ? byBasename.get(base) : undefined;
    return byBase ? decoder.decode(byBase) : undefined;
  };
}

/**
 * Stamp each adapter-produced named schema with `title: <componentKey>` when it
 * has none. Titles are good display metadata for downstream artifacts (docs,
 * skills, examples) — but they are NOT load-bearing for schema identity:
 * `bundleDocument` (decycle.ts) re-collapses an inlined copy back to a `$ref`
 * by structural canonical hashing, which never depends on vendor-supplied
 * names. (Historically this stamp was what let title-based matching collapse
 * GitHub's real 1,752-type GraphQL schema instead of hanging the compile;
 * structural identity now handles untitled schemas by construction, and this
 * stamp remains purely cosmetic.)
 */
function stampSchemaTitles(doc: OpenApiDocument): void {
  const schemas = doc.components?.schemas;
  if (!schemas) return;
  for (const [name, schema] of Object.entries(schemas)) {
    if (schema !== null && typeof schema === "object" && !Array.isArray(schema)) {
      const s = schema as Record<string, unknown>;
      if (typeof s.title !== "string") s.title = name;
    }
  }
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
 * @scalar/openapi-parser. Non-REST protocols (GraphQL/gRPC/SOAP) are lowered by
 * an adapter into a pre-dereference OpenAPI 3.0 document first. Multi-file
 * external $refs are supported for OpenAPI 3.x; a Swagger 2.0 entrypoint that
 * spans files is rejected rather than silently dropping references.
 */
export async function parseSource(source: CompilerSource): Promise<ParsedSpec> {
  // Non-REST protocols (GraphQL, gRPC/proto, SOAP/WSDL) are lowered into a
  // pre-dereference OpenAPI 3.0 document, then run through the identical
  // dereference + normalize path — so one internal model serves every format.
  const protocol = PROTOCOL_FORMATS[source.entrypoint.format];
  if (protocol) {
    const bytes = source.files.get(source.entrypoint.path);
    if (bytes === undefined) {
      throw new Error(
        `Entrypoint bytes are not represented in the snapshot: ${source.entrypoint.path}`,
      );
    }
    const text = new TextDecoder("utf-8").decode(bytes);
    let lowered: OpenApiDocument;
    try {
      lowered = adaptProtocol(protocol.format, text, undefined, protoImportResolver(source));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse ${protocol.format} source: ${detail}`);
    }
    stampSchemaTitles(lowered);
    const { schema, errors } = await dereference(lowered as Record<string, unknown>);
    if (!schema) throw failure(errors);
    const decycled = decycle(schema as OpenApiDocument);
    return { kind: protocol.kind, ...decycled };
  }

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
    const decycled = decycle(schema as OpenApiDocument);
    return { kind: "swagger", ...decycled };
  }

  const { schema, errors } = await dereference(filesystem);
  if (!schema) throw failure(errors);
  const decycled = decycle(schema as OpenApiDocument);
  return { kind: "openapi", ...decycled };
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
