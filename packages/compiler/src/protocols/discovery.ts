/**
 * Google API Discovery Document (`discovery#restDescription`) → OpenAPI 3.0
 * adapter. Every Google Workspace / Cloud API (Gmail, Calendar, Drive, Sheets,
 * BigQuery, …) is published in this format, not OpenAPI — a nested
 * `resources.<r>.methods.<m>` tree with bare `$ref: "TypeName"` schema
 * references, rather than flat `paths` and `#/components/schemas/…` pointers.
 *
 * The lowering is mechanical and faithful: each method becomes one operation
 * (its `path` + `httpMethod`), Discovery `parameters` become OpenAPI
 * parameters (`location` → `in`, `repeated` → array), `request`/`response`
 * `$ref`s become a JSON request body / 200 response, every `schemas` entry
 * becomes a `components.schemas` entry, and every bare `$ref: "Name"` is
 * rewritten to `$ref: "#/components/schemas/Name"` so the shared dereferencer
 * resolves it exactly like any OpenAPI source. Effect/idempotency/naming are
 * then inferred by the same protocol-agnostic pipeline as every other format.
 */
import type { Diagnostic } from "@anvil/air";
import type { OpenApiDocument } from "../parse.js";

interface DiscoveryParam {
  type?: string;
  format?: string;
  description?: string;
  location?: "path" | "query";
  required?: boolean;
  repeated?: boolean;
  default?: unknown;
  enum?: string[];
  $ref?: string;
}

interface DiscoveryMethod {
  id?: string;
  path?: string;
  flatPath?: string;
  httpMethod?: string;
  description?: string;
  parameters?: Record<string, DiscoveryParam>;
  request?: { $ref?: string };
  response?: { $ref?: string };
  scopes?: string[];
}

interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>;
  resources?: Record<string, DiscoveryResource>;
}

interface DiscoveryDoc {
  kind?: string;
  title?: string;
  name?: string;
  version?: string;
  description?: string;
  rootUrl?: string;
  baseUrl?: string;
  servicePath?: string;
  documentationLink?: string;
  resources?: Record<string, DiscoveryResource>;
  methods?: Record<string, DiscoveryMethod>;
  parameters?: Record<string, DiscoveryParam>;
  schemas?: Record<string, unknown>;
  auth?: { oauth2?: { scopes?: Record<string, { description?: string }> } };
}

/** Recognize a Discovery document by its `kind` discriminator (very reliable). */
export function isDiscoveryDocument(text: string): boolean {
  // Cheap text sniff first so we don't JSON.parse a large non-Discovery file.
  if (!text.includes("discovery#restDescription")) return false;
  try {
    return (JSON.parse(text) as DiscoveryDoc).kind === "discovery#restDescription";
  } catch {
    return false;
  }
}

/** Rewrite every bare Discovery `$ref: "Name"` to an OpenAPI component pointer. */
function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "$ref" && typeof v === "string" && !v.startsWith("#/")) {
        out.$ref = `#/components/schemas/${v}`;
      } else {
        out[k] = rewriteRefs(v);
      }
    }
    return out;
  }
  return node;
}

/** One Discovery parameter → one OpenAPI parameter object. */
function toOpenApiParam(name: string, p: DiscoveryParam): Record<string, unknown> {
  const inLoc = p.location === "path" ? "path" : "query";
  const base: Record<string, unknown> = { type: p.type ?? "string" };
  if (p.format) base.format = p.format;
  if (p.enum) base.enum = p.enum;
  if (p.default !== undefined) {
    // Discovery serializes scalar defaults as strings, including booleans and
    // numbers. JSON Schema defaults must retain the declared value's type.
    let value = p.default;
    if (typeof value === "string") {
      if (p.type === "boolean" && /^(true|false)$/.test(value)) value = value === "true";
      else if (
        (p.type === "integer" || p.type === "number") &&
        value.trim() !== "" &&
        Number.isFinite(Number(value))
      )
        value = Number(value);
    }
    base.default = value;
  }
  // Discovery marks a list-valued param with `repeated: true`, not an array type.
  const schema = p.repeated ? { type: "array", items: base } : base;
  return {
    name,
    in: inLoc,
    // Path params are always required; query params honor the declared flag.
    required: inLoc === "path" ? true : Boolean(p.required),
    description: p.description,
    schema,
  };
}

/** Walk the nested resource tree, emitting `[path, method, methodDef]` triples. */
function* eachMethod(
  resources: Record<string, DiscoveryResource> | undefined,
): Generator<DiscoveryMethod> {
  if (!resources) return;
  for (const resource of Object.values(resources)) {
    for (const method of Object.values(resource.methods ?? {})) yield method;
    yield* eachMethod(resource.resources);
  }
}

export function adaptDiscovery(text: string, diagnostics?: Diagnostic[]): OpenApiDocument {
  let doc: DiscoveryDoc;
  try {
    doc = JSON.parse(text) as DiscoveryDoc;
  } catch (err) {
    throw new Error(`Invalid Google Discovery JSON: ${err instanceof Error ? err.message : err}`);
  }

  const paths: Record<string, Record<string, unknown>> = {};
  const commonParameters = { ...doc.parameters };
  if (Object.keys(doc.auth?.oauth2?.scopes ?? {}).length > 0) {
    // These are alternative credential carriers. The OAuth security scheme
    // below supplies auth; do not project tokens into ordinary agent inputs.
    for (const name of ["access_token", "oauth_token", "key"]) delete commonParameters[name];
  }
  for (const method of [...Object.values(doc.methods ?? {}), ...eachMethod(doc.resources)]) {
    // Discovery's `path` uses RFC 6570 level-2 reserved expansion (`{+projectId}`)
    // for segments that may contain slashes, and its placeholder names ARE the
    // declared parameter names (`projectId`, `datasetId`, …). Normalize the `+`
    // away so `{+projectId}` → `{projectId}` matches its param. Do NOT prefer
    // `flatPath`: for reserved-expansion methods Google fills flatPath with
    // synthetic pluralized names (`{projectsId}`, `{datasetsId}`) that DON'T match
    // the parameters, so it would leave every path variable unsubstituted. A
    // `{+name}` (or flatPath's mismatched name) that never binds leaks into the
    // wire URL, and the CLI and MCP surfaces then encode the leftover braces
    // differently (`{+projectId}` vs `%7B+projectId%7D`) — a silent CLI↔MCP
    // divergence the conformance gate catches.
    const rawPath = (method.path ?? method.flatPath)?.replace(/\{\+([^{}]+)\}/g, "{$1}");
    if (!rawPath || !method.httpMethod) continue;
    const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    const verb = method.httpMethod.toLowerCase();

    const parameters = Object.entries({ ...commonParameters, ...method.parameters }).map(
      ([name, p]) => toOpenApiParam(name, p),
    );

    const operation: Record<string, unknown> = {
      operationId: method.id,
      summary: method.description,
      parameters,
      responses: {
        "200": {
          description: "Successful response.",
          ...(method.response?.$ref
            ? {
                content: {
                  "application/json": {
                    schema: { $ref: `#/components/schemas/${method.response.$ref}` },
                  },
                },
              }
            : {}),
        },
      },
    };
    if (method.request?.$ref) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": { schema: { $ref: `#/components/schemas/${method.request.$ref}` } },
        },
      };
    }
    // Per-method OAuth scopes → a per-operation security requirement, so the
    // pipeline's auth resolution sees each method's REAL scopes (Gmail's send
    // needs gmail.send; its list needs only readonly). Without this every
    // operation inherited the document-level `oauth2: []` and lost its scopes
    // in the generated AIR (finding #27, external review).
    if (method.scopes && method.scopes.length > 0) {
      operation.security = [{ oauth2: method.scopes }];
    }

    const pathItem = paths[path] ?? {};
    // Reserved resource templates can denote different operations at the same
    // verb/path (Places get and photos.getMedia both publish v1/{+name}). The
    // OpenAPI path map cannot express that distinction. Refuse the lossy
    // conversion instead of overwriting whichever method appeared first.
    if (pathItem[verb]) {
      const previous = pathItem[verb] as Record<string, unknown>;
      const message = `Discovery methods '${previous.operationId}' and '${method.id}' share ${verb.toUpperCase()} ${path}. Their resource templates require distinct bindings; conversion would lose an operation.`;
      if (!diagnostics) throw new Error(message);
      diagnostics.push({ level: "error", code: "discovery_endpoint_collision", message, path });
      continue;
    }
    pathItem[verb] = operation;
    paths[path] = pathItem;
  }

  const schemas = (rewriteRefs(doc.schemas ?? {}) as Record<string, unknown>) ?? {};

  // OAuth2 with the document's declared scopes — Google APIs are OAuth2, and
  // per-operation scopes exist too but the pipeline reads the scheme type here.
  const scopeMap = doc.auth?.oauth2?.scopes ?? {};
  const oauthScopes: Record<string, string> = {};
  for (const [scope, meta] of Object.entries(scopeMap)) oauthScopes[scope] = meta.description ?? "";

  // Method paths are relative to rootUrl + servicePath (= baseUrl), NOT bare
  // rootUrl. Gmail's servicePath is "" so either works there, but Drive-shaped
  // documents (rootUrl "https://www.googleapis.com/", servicePath "drive/v3/",
  // method path "files") would compile to calls against "/files" instead of
  // "/drive/v3/files" (finding #26, external review). Prefer the document's
  // own precomputed baseUrl; reconstruct it from the parts when absent.
  const server = (
    doc.baseUrl ?? `${doc.rootUrl ?? "https://www.googleapis.com/"}${doc.servicePath ?? ""}`
  ).replace(/\/$/, "");

  return {
    openapi: "3.0.0",
    info: {
      title: doc.title ?? doc.name ?? "google-api",
      version: doc.version ?? "v1",
      description: doc.description,
    },
    servers: [{ url: server }],
    paths,
    components: {
      schemas,
      ...(Object.keys(oauthScopes).length > 0
        ? {
            securitySchemes: {
              oauth2: {
                type: "oauth2",
                flows: {
                  authorizationCode: {
                    authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
                    tokenUrl: "https://oauth2.googleapis.com/token",
                    scopes: oauthScopes,
                  },
                },
              },
            },
          }
        : {}),
    },
    ...(Object.keys(oauthScopes).length > 0 ? { security: [{ oauth2: [] }] } : {}),
  } as OpenApiDocument;
}
