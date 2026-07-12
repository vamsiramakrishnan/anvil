/**
 * Protocol adapters: lower non-OpenAPI API specifications (GraphQL, gRPC/proto3,
 * SOAP/WSDL, Google Discovery, Postman Collection v2.x) into the one internal
 * shape the Anvil compiler understands — a
 * (pre-dereference) OpenAPI 3.0 document. The rest of the pipeline
 * (normalize → classify → validate → generate) is protocol-agnostic; every
 * format meets it here.
 *
 * Detection is deliberately cheap and text-based (extension first, then a
 * content sniff) so Layer 0 can recognize these formats without a full parse.
 * The heavy lifting happens in `adaptProtocol`, called from `parse.ts`.
 */
import type { OpenApiDocument } from "../parse.js";
import { adaptDiscovery, isDiscoveryDocument } from "./discovery.js";
import { adaptGraphql } from "./graphql.js";
import { adaptProto, type ProtoImportResolver } from "./grpc.js";
import { adaptPostman, isPostmanCollection, postmanSchemaVersion } from "./postman.js";
import { adaptWsdl, type WsdlImportResolver } from "./wsdl.js";

/** The non-REST source formats Anvil can lower. Aligns with AIR's SourceKind. */
export type ProtocolFormat = "graphql" | "protobuf" | "wsdl" | "discovery" | "postman";

export interface DetectedProtocol {
  format: ProtocolFormat;
  version: string;
}

const EXT_FORMAT: Record<string, ProtocolFormat> = {
  graphql: "graphql",
  gql: "graphql",
  graphqls: "graphql",
  proto: "protobuf",
  wsdl: "wsdl",
  // Google Discovery and Postman collections are `.json`; detected by content
  // (Postman also honors its `.postman_collection.json` filename convention).
};

function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Detect a protocol format from a file's path and/or contents. Extension is
 * authoritative when present; otherwise a conservative content sniff is used so
 * an ephemeral string (no filename) is still routed correctly.
 */
export function detectProtocolFormat(path: string, text: string): DetectedProtocol | undefined {
  const ext = extensionOf(path);
  if (EXT_FORMAT[ext])
    return {
      format: EXT_FORMAT[ext] as ProtocolFormat,
      version: versionFor(EXT_FORMAT[ext] as ProtocolFormat, text),
    };

  // Postman's export convention names files `*.postman_collection.json`. The
  // convention alone is not authoritative (a v1 export shares it), so the
  // content discriminator must still agree — but checking it here documents
  // the convention and keeps detection cheap for the common case.
  if (path.toLowerCase().endsWith(".postman_collection.json") && isPostmanCollection(text)) {
    return { format: "postman", version: postmanSchemaVersion(text) };
  }

  const sniff = sniffContent(text);
  return sniff;
}

function versionFor(format: ProtocolFormat, text: string): string {
  if (format === "protobuf") return /proto3/.test(text) ? "proto3" : "proto2";
  if (format === "wsdl") return /wsdl\/2/.test(text) ? "2.0" : "1.1";
  return "1.0";
}

/** Content-only detection for sources that arrive without a filename. */
function sniffContent(text: string): DetectedProtocol | undefined {
  const head = text.slice(0, 4000);
  // Google API Discovery document: identified by its `kind` discriminator.
  if (isDiscoveryDocument(text)) return { format: "discovery", version: "v1" };
  // Postman Collection v2.x: identified by its `info.schema` discriminator.
  if (isPostmanCollection(text)) return { format: "postman", version: postmanSchemaVersion(text) };
  // proto3: a syntax pragma, or a service/message with an rpc.
  if (/^\s*syntax\s*=\s*["']proto[23]["']/m.test(head)) {
    return { format: "protobuf", version: /proto3/.test(head) ? "proto3" : "proto2" };
  }
  // WSDL: an XML <definitions> root, optionally namespaced.
  if (/<(\w+:)?definitions[\s>]/.test(head) && /wsdl/.test(head)) {
    return { format: "wsdl", version: /wsdl\/2/.test(head) ? "2.0" : "1.1" };
  }
  // GraphQL SDL: a root schema block, or a named type/input/interface opening a
  // field block. Kept strict (requires the `{` or `implements`) so an OpenAPI
  // YAML/JSON document is never misread as SDL.
  const looksGraphql =
    /\bschema\s*\{[^}]*\b(query|mutation|subscription)\s*:/.test(head) ||
    /\b(type|input|interface)\s+\w+\s*(\{|implements\b)/.test(head) ||
    /\benum\s+\w+\s*\{/.test(head);
  if (looksGraphql) return { format: "graphql", version: "1.0" };
  return undefined;
}

/** Cross-file resolution context for the adapters that span files. */
export interface AdaptImports {
  /** Resolves a proto `import "path"` to the imported file's text. */
  proto?: ProtoImportResolver;
  /** Resolves a wsdl:import / xsd:include / xsd:import location to text. */
  wsdl?: WsdlImportResolver;
  /** Snapshot path of the entry document — the base for relative WSDL/XSD locations. */
  sourcePath?: string;
}

/**
 * Lower a protocol source's text into a pre-dereference OpenAPI 3.0 document.
 * `parse.ts` then runs it through the same dereferencer as the OpenAPI path.
 * `imports` resolves cross-file references from the snapshot — proto `import`s
 * and WSDL/XSD import/include locations — so cross-file types expand to their
 * real fields instead of opaque stubs.
 */
export function adaptProtocol(
  format: ProtocolFormat,
  text: string,
  title?: string,
  imports: AdaptImports = {},
): OpenApiDocument {
  switch (format) {
    case "graphql":
      return adaptGraphql(text, title);
    case "protobuf":
      return adaptProto(text, title, imports.proto);
    case "wsdl":
      return adaptWsdl(text, imports.wsdl, imports.sourcePath);
    case "discovery":
      return adaptDiscovery(text);
    case "postman":
      return adaptPostman(text);
  }
}

export type { ProtoImportResolver } from "./grpc.js";
export type { WsdlImportResolver } from "./wsdl.js";
export { adaptDiscovery, adaptGraphql, adaptPostman, adaptProto, adaptWsdl };
