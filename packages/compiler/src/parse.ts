import type { SourceKind } from "@anvil/air";
import { dereference, upgrade } from "@scalar/openapi-parser";
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
 * Parse + dereference an OpenAPI 3.x or Swagger 2.0 document. We do NOT
 * hand-roll parsing (spec: library-maximal) — @scalar/openapi-parser resolves
 * $refs and upgrades Swagger 2.0 to 3.x for us.
 */
export async function parseSpec(text: string): Promise<ParsedSpec> {
  const raw = parseYaml(text) as OpenApiDocument;
  const isSwagger = typeof raw.swagger === "string" && raw.swagger.startsWith("2");
  // Collected before upgrade() so we read the original 2.0 shape, not whatever
  // the upgrader leaves behind.
  const requiredFormBodies = isSwagger ? collectRequiredFormDataBodies(raw) : new Set<string>();
  const upgraded = isSwagger ? (upgrade(raw).specification as OpenApiDocument) : raw;
  if (requiredFormBodies.size > 0) restoreFormDataRequired(upgraded, requiredFormBodies);
  const { schema, errors } = await dereference(upgraded);
  if (!schema) {
    const detail = (errors ?? []).map((e) => e.message).join("; ");
    throw new Error(`Failed to parse OpenAPI document: ${detail || "unknown error"}`);
  }
  return { kind: isSwagger ? "swagger" : "openapi", document: schema as OpenApiDocument };
}

/**
 * The 2.0→3.x upgrader keeps `required` on a converted `in: body` parameter but
 * drops it for `formData` parameters — yet a required formData field means the
 * request body itself must be sent. Track those operations so the upgraded
 * document normalizes identically to an equivalent OpenAPI 3.x source.
 */
function collectRequiredFormDataBodies(raw: OpenApiDocument): Set<string> {
  const keys = new Set<string>();
  for (const [path, item] of Object.entries(raw.paths ?? {})) {
    for (const [method, op] of Object.entries(item ?? {})) {
      const params = (op as { parameters?: Array<{ in?: string; required?: boolean }> })
        ?.parameters;
      if (!Array.isArray(params)) continue;
      if (params.some((p) => p?.in === "formData" && p.required === true)) {
        keys.add(`${method} ${path}`);
      }
    }
  }
  return keys;
}

function restoreFormDataRequired(doc: OpenApiDocument, keys: Set<string>): void {
  for (const key of keys) {
    const [method, path] = key.split(" ") as [string, string];
    const op = doc.paths?.[path]?.[method] as { requestBody?: { required?: boolean } } | undefined;
    if (op?.requestBody && op.requestBody.required === undefined) op.requestBody.required = true;
  }
}
