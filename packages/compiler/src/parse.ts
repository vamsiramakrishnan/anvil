import { posix } from "node:path";
import type { Diagnostic, SourceKind } from "@anvil/air";
import { dereference, load } from "@scalar/openapi-parser";
import { convertObj } from "swagger2openapi";
import { bundleDocument, DEFAULT_MAX_SCHEMA_DEPTH } from "./decycle.js";
import { adaptProtocol, type ProtocolFormat, type ProtoImportResolver } from "./protocols/index.js";
import { type CompilerSource, ephemeralCompilerSource } from "./source/compiler-source.js";
import { bundleSwaggerExternalRefs } from "./swagger-bundle.js";

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
  const { document: bundled, truncatedAt, depthLimitedAt, synthesized } = bundleDocument(document);
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
  if (synthesized.length > 0) {
    const sample = synthesized
      .slice(0, 5)
      .map((s) => s.name)
      .join(", ");
    diagnostics.push({
      level: "info",
      code: "schema_structure_hoisted",
      message:
        `${synthesized.length} large repeated anonymous structure(s) were hoisted into synthesized ` +
        `components.schemas entries (e.g. ${sample}${synthesized.length > 5 ? ", …" : ""}) so repeats become ` +
        `$ref pointers and the compiled bundle stays proportional to unique structure. Content is unchanged — ` +
        `only where it is defined.`,
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
  /**
   * OpenAPI 3.1 top-level `webhooks:` — a map of name → Path Item Object,
   * structurally identical to `paths:` (OpenAPI §4.8.20's Webhooks Object is
   * typed exactly like the Paths Object). Optional because it is a 3.1-only
   * keyword; a 3.0.x document (or one with no inbound-push surface at all)
   * simply omits it. See `protocols/webhooks.ts` for how this is lowered
   * into the same `Operation` compilation path as `paths:`.
   */
  webhooks?: Record<string, Record<string, unknown>>;
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
  flows?: Record<
    string,
    {
      scopes?: Record<string, string>;
      authorizationUrl?: string;
      tokenUrl?: string;
      refreshUrl?: string;
    }
  >;
  /** Swagger 2 OAuth flow fields (retained by some parser paths). */
  flow?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  openIdConnectUrl?: string;
}

/** EntrypointFormat values that are non-REST protocols lowered by an adapter. */
const PROTOCOL_FORMATS: Record<string, { format: ProtocolFormat; kind: SourceKind }> = {
  graphql: { format: "graphql", kind: "graphql" },
  protobuf: { format: "protobuf", kind: "protobuf" },
  wsdl: { format: "wsdl", kind: "wsdl" },
  discovery: { format: "discovery", kind: "discovery" },
  postman: { format: "postman", kind: "postman" },
  odata: { format: "odata", kind: "odata" },
  har: { format: "har", kind: "har" },
};

/**
 * Resolve a proto `import "a/b/c.proto"` — or a WSDL/XSD import location the
 * adapter has already joined against the importing file's directory — to
 * another file *in the same snapshot*: never the network or an ambient host
 * path, matching the OpenAPI multi-file contract. Tries the import path
 * verbatim, then its basename, so a snapshot that preserves the import's
 * directory structure OR just carries the sibling files flat both resolve. A
 * missing import returns undefined and the adapter degrades gracefully.
 */
/** SDL file extensions, matched case-insensitively. */
const SDL_EXTENSIONS = [".graphql", ".gql", ".graphqls"];

/**
 * Every SDL document in the snapshot, entrypoint first, then the rest in a
 * stable order so the composed schema is byte-identical across compiles.
 *
 * Each part is prefixed with its path as a comment. That costs nothing — a `#`
 * line is a GraphQL comment — and means a schema error reported against the
 * composed document can still be traced back to the file it came from.
 */
function composeGraphqlSdl(source: CompilerSource): string {
  const decoder = new TextDecoder("utf-8");
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (path: string): void => {
    if (seen.has(path)) return;
    const bytes = source.files.get(path);
    if (bytes === undefined) return;
    seen.add(path);
    parts.push(`# ${path}\n${decoder.decode(bytes)}`);
  };
  // The entrypoint leads: if more than one file declares a `schema { ... }`
  // block, the one the operator pointed at is the one that should win.
  push(source.entrypoint.path);
  for (const path of [...source.files.keys()].sort()) {
    if (SDL_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext))) push(path);
  }
  return parts.join("\n\n");
}

function snapshotImportResolver(source: CompilerSource): ProtoImportResolver {
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
 * external $refs are supported for OpenAPI 3.x and for Swagger 2.0 alike; a 2.0
 * source that spans files has its references resolved before conversion, since
 * the converter itself cannot follow them.
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
    // A GraphQL schema is the one protocol source routinely written as several
    // files — `schema.graphql` plus a `types/` directory, or a base type and the
    // `extend type Query` blocks that add to it. SDL has no import statement, so
    // there is nothing for a resolver to follow: composition IS concatenation,
    // and the schema only exists once the pieces are put together. Reading the
    // entrypoint alone would compile a schema whose Query type is missing most
    // of its fields.
    const text =
      protocol.format === "graphql"
        ? composeGraphqlSdl(source)
        : new TextDecoder("utf-8").decode(bytes);
    let lowered: OpenApiDocument;
    // Findings the adapter raises while lowering — carried out with the parse
    // result rather than dropped, so a lossy lowering is visible to an operator.
    const adapterDiagnostics: Diagnostic[] = [];
    try {
      const resolveImport = snapshotImportResolver(source);
      lowered = adaptProtocol(
        protocol.format,
        text,
        undefined,
        {
          proto: resolveImport,
          wsdl: resolveImport,
          sourcePath: source.entrypoint.path,
        },
        adapterDiagnostics,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse ${protocol.format} source: ${detail}`);
    }
    stampSchemaTitles(lowered);
    const { schema, errors } = await dereference(lowered as Record<string, unknown>);
    if (!schema) throw failure(errors);
    const decycled = decycle(schema as OpenApiDocument);
    return {
      kind: protocol.kind,
      ...decycled,
      diagnostics: [...adapterDiagnostics, ...decycled.diagnostics],
    };
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
    // Swagger conversion owns the whole 2.0 field mapping, so for a single
    // document it runs before dereference exactly as it always has — that
    // ordering is what every existing 2.0 fixture is checked against.
    //
    // `swagger2openapi` cannot follow external files, which is why a multi-file
    // 2.0 source used to be rejected outright. It does not have to be: `$ref`
    // resolution is @scalar/openapi-parser's job in this pipeline, and running
    // it first hands the converter a self-contained 2.0 document — still with
    // its `definitions`, `parameters`, `responses`, and `securityDefinitions`
    // intact, which is everything the 2.0 field mapping reads. Nothing is lost
    // by resolving first, because `ParsedSpec` is a fully dereferenced document
    // either way; only the order changes, and only for the case that used to be
    // a hard failure.
    let resolved = entrypoint as OpenApiDocument;
    if (filesystem.length > 1) {
      const bundled = bundleSwaggerExternalRefs(filesystem);
      if (bundled.unresolved.length > 0) {
        throw new Error(
          `Failed to resolve Swagger 2.0 references from the snapshot: ${bundled.unresolved.join(", ")}`,
        );
      }
      resolved = bundled.document as OpenApiDocument;
    }
    const converted = await convertSwagger(resolved);
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
