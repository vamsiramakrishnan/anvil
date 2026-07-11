import type { SourceKind } from "@anvil/air";
import { dereference } from "@scalar/openapi-parser";
import { convertObj } from "swagger2openapi";
import { parse as parseYaml } from "yaml";

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
 * Parse + dereference an API description into an OpenAPI 3.x document. Each
 * format is owned by the library dedicated to it (spec: library-maximal):
 * Swagger 2.0 goes through swagger2openapi's converter, and everything then
 * flows through @scalar/openapi-parser for $ref resolution. No hand-written
 * Swagger field mapping exists in Anvil.
 */
export async function parseSpec(text: string): Promise<ParsedSpec> {
  const raw = parseYaml(text) as OpenApiDocument;
  const isSwagger = typeof raw.swagger === "string" && raw.swagger.startsWith("2");
  const document = isSwagger ? await convertSwagger(raw) : raw;
  const { schema, errors } = await dereference(document);
  if (!schema) {
    const detail = (errors ?? []).map((e) => e.message).join("; ");
    throw new Error(`Failed to parse OpenAPI document: ${detail || "unknown error"}`);
  }
  return { kind: isSwagger ? "swagger" : "openapi", document: schema as OpenApiDocument };
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
