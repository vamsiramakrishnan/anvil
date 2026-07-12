import type {
  AuthRequirement,
  AuthType,
  Diagnostic,
  ErrorSpec,
  HttpMethod,
  JsonSchema,
  Operation,
  Param,
  ParamLocation,
  RequestBody,
} from "@anvil/air";
import { classifyAuth, classifyConfirmation, classifyEffect, classifyRetry } from "./classify.js";
import { materializeSchema } from "./decycle.js";
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
  /** Vendor extension: the spec author declares a repeat call is a no-op. */
  "x-idempotent"?: unknown;
  /**
   * Vendor extension: a protocol adapter's explicit effect assertion. The
   * adapters lower everything to the one truthful wire method (SOAP, GraphQL
   * and gRPC are all POST-on-the-wire), so "this is a read" arrives as this
   * extension instead of a fake GET that could never carry the required body.
   */
  "x-anvil-effect"?: unknown;
  /** Vendor extension: which GraphQL root the operation came from (adapter). */
  "x-graphql-operation"?: unknown;
}

/**
 * OpenAPI 3 mandates that header parameters named Accept, Content-Type, or
 * Authorization SHALL be ignored — those headers belong to the runtime (content
 * negotiation, body encoding, auth binding), never to the input contract.
 * Modeling them as inputs would make every surface (CLI flag, MCP schema, mock
 * validation) fight the executor's own header values on the wire.
 */
const IGNORED_HEADER_PARAMS = new Set(["accept", "content-type", "authorization"]);

/**
 * Merge path-item-level parameters into an operation's own (OpenAPI: shared
 * parameters on the path item apply to every method; an operation-level
 * parameter with the same name+location overrides, never duplicates).
 */
function mergeParams(pathLevel: RawParam[], opLevel: RawParam[]): RawParam[] {
  const overridden = (p: RawParam) => opLevel.some((o) => o.name === p.name && o.in === p.in);
  return [...pathLevel.filter((p) => !overridden(p)), ...opLevel];
}

function toParam(raw: RawParam, namedSchemas: Record<string, unknown>): Param | null {
  const loc = raw.in as ParamLocation;
  if (!["path", "query", "header", "cookie"].includes(loc)) return null;
  const schema = raw.schema
    ? (materializeSchema(raw.schema, namedSchemas).schema as JsonSchema)
    : { type: "string" };
  return {
    name: raw.name,
    in: loc,
    required: raw.in === "path" ? true : Boolean(raw.required),
    schema,
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
  namedSchemas: Record<string, unknown>,
): RequestBody | undefined {
  if (!content) return undefined;
  const contentType = content["application/json"]
    ? "application/json"
    : (Object.keys(content)[0] ?? "application/json");
  const rawSchema = content["application/json"]?.schema ?? Object.values(content)[0]?.schema;
  if (!rawSchema) return undefined;
  // `bundleDocument` (decycle.ts) left named-schema references as `$ref`
  // pointers so the whole spec's schema graph is only ever walked once; this
  // is the one place a body needs its own fields directly inspectable
  // (`.properties`, `.type`), so resolve back to a small, self-contained
  // schema scoped to just this operation before doing anything else with it.
  const schema = materializeSchema(rawSchema, namedSchemas).schema as JsonSchema;

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

function jsonSchemaOf(
  content: Record<string, { schema?: JsonSchema }> | undefined,
  namedSchemas: Record<string, unknown>,
): JsonSchema | undefined {
  if (!content) return undefined;
  const raw = content["application/json"]?.schema ?? Object.values(content)[0]?.schema;
  if (!raw) return undefined;
  return materializeSchema(raw, namedSchemas).schema as JsonSchema;
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

export interface NormalizeResult {
  operations: Operation[];
  diagnostics: Diagnostic[];
}

/** Normalize a parsed OpenAPI document into AIR operations (classifier applied). */
export function normalize(serviceId: string, parsed: ParsedSpec): NormalizeResult {
  const doc = parsed.document;
  const paths = doc.paths ?? {};
  // `bundleDocument` (decycle.ts) left named-schema references as `$ref`
  // pointers into `components.schemas` so the whole spec's schema graph is
  // only ever walked once; everything below that needs a schema's own fields
  // directly (`.properties`, `.type`) resolves back through this bag,
  // per-operation, via `materializeSchema`.
  const namedSchemas = doc.components?.schemas ?? {};
  const operations: Operation[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    // Path-item-level parameters apply to every method below (this is how
    // Asana/Zendesk declare their path params; dropping them severs the URL
    // template from the input contract).
    const pathParams = (pathItem.parameters as RawParam[] | undefined) ?? [];
    for (const method of HTTP_METHODS) {
      const raw = pathItem[method] as RawOperation | undefined;
      if (!raw) continue;

      // An adapter-asserted effect (see RawOperation) is authoritative over the
      // HTTP-method default. Only protocol adapters set it; REST paths never do.
      const effectHint = raw["x-anvil-effect"] === "read" ? ("read" as const) : undefined;
      // A GraphQL query/subscription is definitionally a read; the SOAP/gRPC
      // assertions come from an operation-name heuristic, so their evidence
      // confidence stays at the method-heuristic grade.
      const definitionalRead =
        raw["x-graphql-operation"] === "query" || raw["x-graphql-operation"] === "subscription";

      // Naming is a first-class pass: derive names with a confidence, and let
      // the collision pass (compile) disambiguate any clashes with meaningful
      // tokens instead of a silent `_2`.
      // Naming parity: the derivation reads GET as its "this is a read" steer
      // (get/list default action, no create/postVerb path). An adapter-asserted
      // read must steer identically, or truthful POST wire methods would rename
      // every lowered read (`…list` → `…create`) — the wire method changed,
      // the operation's meaning did not.
      const names = deriveNames(serviceId, path, effectHint === "read" ? "get" : method, raw);
      const id = names.id;

      const segments = path.split("/").filter(Boolean);
      const endsWithParam =
        segments.length > 0 && (segments[segments.length - 1] as string).startsWith("{");
      const signal = `${raw.operationId ?? ""} ${raw.summary ?? ""} ${path}`;
      const { effect, idempotency } = classifyEffect(method, signal, endsWithParam, effectHint);
      effect.resource = singularize(names.resource);
      // `x-idempotent: true` is a spec-level declaration (Swagger 2.0 and 3.x
      // alike) that repeating the call is a no-op. Honor it as natural
      // idempotency so retries become provably safe — confirmation still
      // applies to risky mutations, so this never loosens the approval gate.
      const declaredIdempotent = raw["x-idempotent"] === true;
      if (declaredIdempotent && idempotency.mode === "none") idempotency.mode = "natural";
      const retries = classifyRetry(effect, idempotency);
      const confirmation = classifyConfirmation(effect, idempotency);

      const params: Param[] = [];
      for (const rp of mergeParams(pathParams, raw.parameters ?? [])) {
        if (rp.in === "header" && IGNORED_HEADER_PARAMS.has(rp.name.toLowerCase())) {
          diagnostics.push({
            level: "info",
            code: "header_param_ignored",
            message:
              `${method.toUpperCase()} ${path} declares header parameter "${rp.name}"; ` +
              "OpenAPI mandates Accept/Content-Type/Authorization header parameters be ignored " +
              "(the runtime owns those headers), so it is not part of the input contract.",
            operationId: id,
          });
          continue;
        }
        const p = toParam(rp, namedSchemas);
        if (p) params.push(p);
      }
      const body = buildRequestBody(
        raw.requestBody?.content,
        raw.requestBody?.required ?? false,
        namedSchemas,
      );

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
        output: {
          schema: jsonSchemaOf(successRes?.content, namedSchemas),
          description: successRes?.description,
        },
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
          claims: [
            {
              subject: id,
              predicate: "exists",
              value: true,
              source: "spec",
              sourceRef: `${method.toUpperCase()} ${path}`,
              method: "declared",
              confidence: 0.7,
            },
            effectHint !== undefined
              ? {
                  subject: id,
                  predicate: "effect.kind",
                  value: effect.kind,
                  source: "spec" as const,
                  sourceRef: `${method.toUpperCase()} ${path} x-anvil-effect`,
                  method: "protocol_adapter_assertion",
                  note: definitionalRead
                    ? "effect asserted by the protocol adapter (definitional for this operation kind)"
                    : "effect asserted by the protocol adapter (operation-name heuristic)",
                  confidence: definitionalRead ? 0.9 : 0.5,
                }
              : {
                  subject: id,
                  predicate: "effect.kind",
                  value: effect.kind,
                  source: "inferred" as const,
                  method: "http_method_heuristic",
                  note: "effect/idempotency inferred from HTTP method",
                  confidence: 0.5,
                },
            ...(declaredIdempotent
              ? [
                  {
                    subject: id,
                    predicate: "idempotency.mode",
                    value: idempotency.mode,
                    source: "spec" as const,
                    sourceRef: `${method.toUpperCase()} ${path} x-idempotent`,
                    method: "declared",
                    confidence: 0.8,
                  },
                ]
              : []),
            {
              subject: id,
              predicate: "name.quality",
              value: names.canonicalName,
              source: "inferred",
              sourceRef: "naming",
              method: "naming_pass",
              note: names.signals.join("; "),
              confidence: names.confidence,
            },
          ],
        },
      });
    }
  }

  return { operations, diagnostics };
}
