import type {
  AuthRequirement,
  AuthType,
  ErrorSpec,
  HttpMethod,
  JsonSchema,
  Operation,
  Param,
  ParamLocation,
  RequestBody,
} from "@anvil/air";
import { classifyAuth, classifyConfirmation, classifyEffect, classifyRetry } from "./classify.js";
import { deriveNames, singularize } from "./naming.js";
import type { OpenApiDocument, ParsedSpec, SecurityScheme } from "./parse.js";

const HTTP_METHODS: HttpMethod[] = ["get", "put", "post", "delete", "patch", "head"];

interface RawParam {
  name: string;
  in: string;
  required?: boolean;
  schema?: JsonSchema;
  description?: string;
  example?: unknown;
}

interface RawOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: RawParam[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: JsonSchema }>;
  };
  responses?: Record<
    string,
    { description?: string; content?: Record<string, { schema?: JsonSchema }> }
  >;
  security?: Array<Record<string, string[]>>;
}

function toParam(raw: RawParam): Param | null {
  const loc = raw.in as ParamLocation;
  if (!["path", "query", "header", "cookie"].includes(loc)) return null;
  return {
    name: raw.name,
    in: loc,
    required: raw.in === "path" ? true : Boolean(raw.required),
    schema: raw.schema ?? { type: "string" },
    description: raw.description,
    example: raw.example,
    inferred: false,
  };
}

const SCALAR_TYPES = new Set(["string", "integer", "number", "boolean"]);

/** A body field is flag-projectable when it is a scalar (or an enum of scalars). */
function isScalarField(schema: JsonSchema): boolean {
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf) || Array.isArray(schema.allOf)) {
    return false;
  }
  if (Array.isArray(schema.enum)) return true;
  if (schema.const !== undefined) return true;
  return typeof schema.type === "string" && SCALAR_TYPES.has(schema.type);
}

/**
 * Build the preserved request body plus its surface projection (spec: "preserve
 * the body as a body, derive the CLI projection separately"). The body schema is
 * kept verbatim; a flat object of scalars is additionally projected into
 * per-field flags, while anything richer (nesting, arrays, unions) is surfaced
 * whole so nothing is lost.
 */
function buildRequestBody(
  content: Record<string, { schema?: JsonSchema }> | undefined,
  required: boolean,
): RequestBody | undefined {
  if (!content) return undefined;
  const contentType = content["application/json"]
    ? "application/json"
    : (Object.keys(content)[0] ?? "application/json");
  const schema = content["application/json"]?.schema ?? Object.values(content)[0]?.schema;
  if (!schema) return undefined;

  const props = schema.properties as Record<string, JsonSchema> | undefined;
  const requiredList = (schema.required as string[] | undefined) ?? [];
  const noCompositor =
    !Array.isArray(schema.oneOf) && !Array.isArray(schema.anyOf) && !Array.isArray(schema.allOf);
  const flat =
    schema.type === "object" &&
    props !== undefined &&
    noCompositor &&
    Object.values(props).every(isScalarField);

  if (flat && props) {
    return {
      contentType,
      required,
      schema,
      projection: "fields",
      fields: Object.entries(props).map(([name, propSchema]) => ({
        name,
        required: requiredList.includes(name),
        schema: propSchema,
        description: propSchema.description as string | undefined,
      })),
    };
  }
  return { contentType, required, schema, projection: "whole", fields: [] };
}

function jsonSchemaOf(content?: Record<string, { schema?: JsonSchema }>): JsonSchema | undefined {
  if (!content) return undefined;
  return content["application/json"]?.schema ?? Object.values(content)[0]?.schema;
}

const STATUS_TO_CODE: Record<string, ErrorSpec["code"]> = {
  "400": "validation_error",
  "401": "auth_required",
  "403": "permission_denied",
  "404": "not_found",
  "409": "conflict",
  "422": "validation_error",
  "429": "rate_limited",
  "500": "unknown_upstream_error",
  "502": "upstream_unavailable",
  "503": "upstream_unavailable",
  "504": "upstream_timeout",
};

function errorSpecs(responses?: RawOperation["responses"]): ErrorSpec[] {
  if (!responses) return [];
  const out: ErrorSpec[] = [];
  for (const [status, res] of Object.entries(responses)) {
    const code = STATUS_TO_CODE[status];
    if (!code) continue;
    out.push({ code, upstream: { httpStatus: Number(status) }, message: res.description });
  }
  return out;
}

const SCHEME_TO_AUTH: Record<string, AuthType> = {
  apiKey: "api_key",
  oauth2: "oauth2_client_credentials",
  openIdConnect: "oauth2_authorization_code",
  mutualTLS: "mtls",
};

function resolveAuth(
  doc: OpenApiDocument,
  opSecurity: Array<Record<string, string[]>> | undefined,
): AuthRequirement {
  const schemes = doc.components?.securitySchemes ?? {};
  const security = opSecurity ?? doc.security ?? [];
  const first = security[0];
  if (!first || Object.keys(first).length === 0) {
    const { principal, secretSource } = classifyAuth("none");
    return { type: "none", scopes: [], principal, secretSource };
  }
  const [schemeName, scopes] = Object.entries(first)[0] as [string, string[]];
  const scheme: SecurityScheme | undefined = schemes[schemeName];
  let type: AuthType = "custom_header";
  if (scheme?.type === "http") type = scheme.scheme === "basic" ? "basic" : "jwt_bearer";
  else if (scheme?.type) type = SCHEME_TO_AUTH[scheme.type] ?? "custom_header";
  const { principal, secretSource } = classifyAuth(type);
  return { type, scopes: scopes ?? [], principal, secretSource };
}

/** Normalize a parsed OpenAPI document into AIR operations (classifier applied). */
export function normalize(serviceId: string, parsed: ParsedSpec): Operation[] {
  const doc = parsed.document;
  const paths = doc.paths ?? {};
  const operations: Operation[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const raw = pathItem[method] as RawOperation | undefined;
      if (!raw) continue;

      // Naming is a first-class pass: derive names with a confidence, and let
      // the collision pass (compile) disambiguate any clashes with meaningful
      // tokens instead of a silent `_2`.
      const names = deriveNames(serviceId, path, method, raw);
      const id = names.id;

      const segments = path.split("/").filter(Boolean);
      const endsWithParam =
        segments.length > 0 && (segments[segments.length - 1] as string).startsWith("{");
      const signal = `${raw.operationId ?? ""} ${raw.summary ?? ""} ${path}`;
      const { effect, idempotency } = classifyEffect(method, signal, endsWithParam);
      effect.resource = singularize(names.resource);
      const retries = classifyRetry(effect, idempotency);
      const confirmation = classifyConfirmation(effect, idempotency);

      const params: Param[] = [];
      for (const rp of raw.parameters ?? []) {
        const p = toParam(rp);
        if (p) params.push(p);
      }
      const body = buildRequestBody(raw.requestBody?.content, raw.requestBody?.required ?? false);

      const successRes =
        raw.responses?.["200"] ?? raw.responses?.["201"] ?? raw.responses?.["202"] ?? undefined;

      operations.push({
        id,
        canonicalName: names.canonicalName,
        displayName: names.displayName,
        description: raw.description ?? raw.summary ?? "",
        tags: raw.tags ?? [],
        sourceRef: { kind: parsed.kind, path, method, operationId: raw.operationId },
        effect,
        input: { params, body },
        output: { schema: jsonSchemaOf(successRes?.content), description: successRes?.description },
        errors: errorSpecs(raw.responses),
        idempotency,
        retries,
        confirmation,
        auth: resolveAuth(doc, raw.security),
        streaming: false,
        longRunning: false,
        deprecated: Boolean(raw.deprecated),
        cli: { command: names.cliCommand, aliases: [] },
        mcp: { toolName: names.toolName },
        skill: { intentExamples: [] },
        state: "generated",
        reviewNotes: [],
        evidence: {
          items: [
            { kind: "spec", ref: `${method.toUpperCase()} ${path}`, confidence: 0.7 },
            {
              kind: "inferred",
              note: "effect/idempotency inferred from HTTP method",
              confidence: 0.5,
            },
            {
              kind: "inferred",
              ref: "naming",
              note: names.signals.join("; "),
              confidence: names.confidence,
            },
          ],
          confidence: 0.6,
        },
      });
    }
  }

  return operations;
}
