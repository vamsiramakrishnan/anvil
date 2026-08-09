import { createHash } from "node:crypto";
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
import { resolveAsyncContract, snakeCase } from "@anvil/air";
import type { AsyncResponseSignals, LongRunningDetection } from "./classify.js";
import {
  classifyArchetype,
  classifyAsyncContract,
  classifyAuth,
  classifyConfirmation,
  classifyEffect,
  classifyLongRunning,
  classifyPagination,
  classifyRetry,
  findJobHandleField,
  findStateField,
} from "./classify.js";
import { materializeSchema } from "./decycle.js";
import { deriveNames, singularize } from "./naming.js";
import type { OpenApiDocument, ParsedSpec, SecurityScheme } from "./parse.js";
import { callbackWebhookLink, webhookPathItems } from "./protocols/webhooks.js";

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
    {
      description?: string;
      content?: Record<string, { schema?: JsonSchema }>;
      /**
       * Declared response headers. AIR keeps none of these, yet they carry the
       * clearest declared evidence that a call finishes after it returns
       * (`Operation-Location`, `Location` on a 202), so they are read here and
       * handed to the classifier. OAS3 nests the value under `schema`; Swagger
       * 2.0 puts `type`/`default` directly on the header object, so both
       * spellings are accepted.
       */
      headers?: Record<string, { schema?: JsonSchema; default?: unknown }>;
    }
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
  /**
   * Vendor extension stamped by `protocols/webhooks.ts`: this operation was
   * compiled from the spec's own `webhooks:` map, not `paths:`. Read here to
   * force `archetype: "webhook_receiver"` unconditionally — structurally
   * certain from provenance, never inferred from the operation's shape.
   */
  "x-anvil-webhook"?: unknown;
  /**
   * OpenAPI `callbacks:` — an operation's own declaration of an inbound
   * request the upstream will make later. Read only to recover an explicit,
   * compile-time-certain link to a `webhooks:` entry (`callbackWebhookLink`);
   * never parsed for any other purpose, and never used to guess a link by name.
   */
  callbacks?: unknown;
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

/** A positive integer, in either of the two places a header can declare one. */
function declaredPositiveInteger(header: {
  schema?: JsonSchema;
  default?: unknown;
}): number | undefined {
  // A schema `default` is the contract stating the value the server uses; a
  // schema `example` is illustrative and is deliberately ignored, because
  // `AsyncContract.pollIntervalSeconds` may only ever hold a number the service
  // actually stated — a guessed interval is a self-inflicted rate limit or a
  // stampede, never a neutral default.
  const value = header.schema?.default ?? header.default;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Quote what an operation's declared responses say about asynchrony, for
 * `classifyLongRunning` to judge. Extraction only: no decision is taken here, so
 * the "is this long-running" rule lives in exactly one place (classify.ts) and
 * this function stays a faithful reading of the document.
 */
function asyncResponseSignals(responses: RawOperation["responses"]): AsyncResponseSignals {
  const headersByStatus: Record<string, string[]> = {};
  let retryAfterDefaultSeconds: number | undefined;
  for (const [status, response] of Object.entries(responses ?? {})) {
    const headers = response.headers;
    if (!headers) continue;
    // Header names are case-insensitive on the wire and specs spell them every
    // way ("Operation-Location", "operation-location", "Retry-After"), so match
    // on the same snake_cased form the rest of the compiler compares names in.
    headersByStatus[status] = Object.keys(headers).map((name) => snakeCase(name));
    if (status !== "202") continue;
    for (const [name, header] of Object.entries(headers)) {
      if (snakeCase(name) === "retry_after") {
        retryAfterDefaultSeconds = declaredPositiveInteger(header);
      }
    }
  }
  return {
    headersByStatus,
    statusCodes: Object.keys(responses ?? {}),
    ...(retryAfterDefaultSeconds !== undefined ? { retryAfterDefaultSeconds } : {}),
  };
}

/**
 * Second pass: link each long-running operation to the operation an agent polls.
 *
 * Detection (`classifyLongRunning`) reads only an operation's own responses, so
 * it runs inline. The contract cannot: its status operation may be declared
 * later in the document than the call that starts the job — `POST /jobs` above
 * `GET /jobs/{jobId}` is the common ordering, but `paths` order is arbitrary and
 * a spec may put either first. Resolving against the finished operation array
 * makes the outcome identical whichever way the document is written, which is
 * the determinism guarantee the rest of the compiler depends on.
 *
 * Every attached contract is self-checked through `resolveAsyncContract` — the
 * same function certification and the serving path use — so the compiler can
 * never emit a contract those layers would reject. The single exception is
 * `status_operation_not_approved`: approval is a *later* lifecycle stage
 * (`approveOperations` runs after normalization, from the manifest), so at this
 * point nothing in the document is approved yet and treating that as fatal would
 * delete every contract ever built. It is safe to defer precisely because it is
 * re-checked: consumers re-resolve at serve time and drop the contract if the
 * status operation is still unapproved, so the agent is never pointed at a tool
 * it cannot call. Every other issue is structural and final here.
 */
function attachAsyncContracts(
  operations: Operation[],
  detections: ReadonlyMap<Operation, LongRunningDetection>,
): void {
  if (detections.size === 0) return;
  const byId = new Map(operations.map((op) => [op.id, op]));
  for (const op of operations) {
    const detection = detections.get(op);
    if (!detection) continue;
    const contract = classifyAsyncContract(op, operations, detection.pollIntervalSeconds);
    if (!contract) continue;
    // Resolve a probe rather than the operation itself, so a contract that fails
    // the check is never momentarily attached to a live operation.
    const resolution = resolveAsyncContract({ ...op, asyncContract: contract }, byId);
    if (!resolution.ok && resolution.issue !== "status_operation_not_approved") continue;
    op.asyncContract = contract;
    op.evidence.claims.push({
      subject: op.id,
      predicate: "asyncContract",
      value: contract.statusOperationId,
      source: "inferred",
      sourceRef: `${op.sourceRef.method?.toUpperCase() ?? ""} ${op.sourceRef.path ?? ""}`.trim(),
      method: "async_contract_linkage",
      note:
        `polls '${contract.statusOperationId}' with '${contract.statusJobIdParam}' from ` +
        `'${contract.jobIdField}'; terminal states declared: ${contract.terminalStates.join(", ")}`,
      // Structure-derived, but every coordinate is a declared fact of the
      // document (a named field, a named parameter, a declared enum) — higher
      // than a naming heuristic, below anything the service itself demonstrated.
      confidence: 0.6,
    });
  }
}

/**
 * Third pass: recover an explicit `callbacks:` → `webhooks:` link for each
 * `longRunning` operation (§10 of the async design doc).
 *
 * Deliberately NOT symmetrical with `attachAsyncContracts`: that pass writes a
 * complete, self-checked `AsyncContract` because every coordinate it needs
 * (a status operation, a parameter, a declared terminal-state enum) is
 * derivable from the document alone. A webhook link can never reach that bar
 * on spec evidence alone — `signatureVerification` has no OpenAPI keyword in
 * any real vendor spec this project has evidence for (§11: Stripe, GitHub,
 * Twilio, Shopify, PayPal all require it out-of-band), so a compiler pass can
 * derive everything BUT the one field `WebhookContract` requires. Writing an
 * `AsyncContract.webhook` with a fabricated or blank signature scheme would be
 * exactly the "half a contract" this codebase's doctrine forbids — worse than
 * no contract, because it would look complete.
 *
 * So this pass records what it CAN prove — which `webhooks:` operation the
 * spec's own `callbacks:` names, and (best-effort, same heuristic as
 * `jobIdField`/`stateField`) which of its payload fields look like the job
 * handle and state — as evidence a human reads before writing the
 * `async_contract.webhook` manifest patch (`manifest.ts`) that supplies the
 * one thing only a human can: how to verify the sender. It never writes
 * `op.asyncContract.webhook` itself.
 */
function attachWebhookLinks(
  operations: Operation[],
  callbacksByOperation: ReadonlyMap<Operation, unknown>,
  webhooks: Record<string, Record<string, unknown>> | undefined,
): void {
  if (!webhooks || Object.keys(webhooks).length === 0) return;
  for (const op of operations) {
    if (!op.longRunning) continue;
    const raw = callbacksByOperation.get(op);
    if (raw === undefined) continue;
    const webhookName = callbackWebhookLink(raw, webhooks);
    if (!webhookName) continue;
    const webhookOp = operations.find((o) => o.sourceRef.path === `/webhooks/${webhookName}`);
    if (!webhookOp) continue; // structurally shouldn't happen: every webhooks: entry is compiled

    const webhookJobIdField = findJobHandleField(webhookOp.input.body?.schema);
    const webhookStateField = findStateField(webhookOp.input.body?.schema)?.path;

    op.evidence.claims.push({
      subject: op.id,
      predicate: "asyncContract.webhook",
      value: webhookOp.id,
      source: "spec",
      sourceRef:
        `${op.sourceRef.method?.toUpperCase() ?? ""} ${op.sourceRef.path ?? ""} callbacks`.trim(),
      method: "callback_webhook_linkage",
      note:
        `the operation's own callbacks: names webhooks: entry '${webhookName}' ` +
        `(compiled as '${webhookOp.id}')` +
        (webhookJobIdField ? `; candidate webhookJobIdField '${webhookJobIdField}'` : "") +
        (webhookStateField ? `; candidate webhookStateField '${webhookStateField}'` : "") +
        `. No AsyncContract.webhook was attached: signatureVerification cannot be derived from ` +
        `OpenAPI structure for any real vendor, so it requires a human-authored ` +
        `async_contract.webhook manifest patch to complete the contract.`,
      // Structure-derived (an exact, content-matched callbacks: reference) but
      // deliberately below the poll-linkage confidence: it names a real
      // operation, not a usable contract, and half of what would make it
      // usable is not something evidence can raise.
      confidence: 0.5,
    });
  }
}

interface AuthResolution {
  auth: AuthRequirement;
  issue?: { code: string; message: string; blocked?: boolean };
}

function authOf(
  type: AuthType,
  scopes: string[],
  provider?: AuthRequirement["provider"],
  credentialProfile?: string,
): AuthRequirement {
  const { principal, secretSource } = classifyAuth(type);
  return {
    type,
    scopes,
    principal,
    secretSource,
    ...(provider ? { provider } : {}),
    ...(credentialProfile ? { credentialProfile } : {}),
  };
}

function credentialProfileFor(schemeName: string): string {
  const normalized = snakeCase(schemeName) || "scheme";
  const rooted = /^[a-z]/.test(normalized) ? normalized : `scheme_${normalized}`;
  // Always retain a cryptographic suffix. Distinct source names such as
  // `Partner-OAuth` and `partner_oauth` normalize to the same readable slug;
  // aliasing those schemes would make them share upstream secrets.
  const digest = createHash("sha256").update(schemeName).digest("hex").slice(0, 32);
  const prefix = rooted.slice(0, 31).replace(/_+$/, "") || "scheme";
  return `${prefix}_${digest}`;
}

function unresolvedAuth(
  scopes: string[],
  code: string,
  message: string,
  blocked = false,
  credentialProfile?: string,
): AuthResolution {
  return {
    auth: authOf("custom_header", scopes, undefined, credentialProfile),
    issue: { code, message, blocked },
  };
}

function oauthAuth(schemeName: string, scheme: SecurityScheme, scopes: string[]): AuthResolution {
  const credentialProfile = credentialProfileFor(schemeName);
  const flows = Object.entries(scheme.flows ?? {}).filter(([, flow]) => flow !== undefined);
  if (flows.length === 0 && scheme.flow) {
    flows.push([
      scheme.flow,
      {
        tokenUrl: scheme.tokenUrl,
        authorizationUrl: scheme.authorizationUrl,
      },
    ]);
  }
  if (flows.length !== 1) {
    return unresolvedAuth(
      scopes,
      "auth/oauth_flow_ambiguous",
      `OAuth security declares ${flows.length} flows; AIR requires one explicit principal/grant. Select it in the manifest before approval.`,
      true,
      credentialProfile,
    );
  }
  const [name, flow] = flows[0] as [string, NonNullable<SecurityScheme["flows"]>[string]];
  const tokenEndpoint = flow.tokenUrl ?? scheme.tokenUrl;
  if (name === "clientCredentials" || name === "application") {
    return {
      auth: authOf(
        "oauth2_client_credentials",
        scopes,
        {
          grant: "client_credentials",
          ...(tokenEndpoint ? { tokenEndpoint } : {}),
        },
        credentialProfile,
      ),
    };
  }
  if (name === "authorizationCode" || name === "accessCode" || name === "implicit") {
    return {
      auth: authOf(
        "oauth2_authorization_code",
        scopes,
        tokenEndpoint ? { tokenEndpoint } : undefined,
        credentialProfile,
      ),
      issue: {
        code: "auth/end_user_flow_unexecutable",
        message:
          "End-user OAuth cannot use one shared runtime token. To unblock, model per-caller " +
          "delegation in the manifest — `auth: { type: oauth2_on_behalf_of }` — and the runtime " +
          "will exchange each caller's inbound token (RFC 8693 token exchange; the imported " +
          "token endpoint is preserved). Then set the operation state and approve.",
        blocked: true,
      },
    };
  }
  return unresolvedAuth(
    scopes,
    "auth/oauth_flow_unsupported",
    `OAuth flow "${name}" is not executable by the runtime. Enrich an explicit supported auth type/provider before approval.`,
    true,
    credentialProfile,
  );
}

function resolveAuth(
  doc: OpenApiDocument,
  opSecurity: Array<Record<string, string[]>> | undefined,
): AuthResolution {
  const security = opSecurity ?? doc.security ?? [];
  if (security.length > 1) return resolveAlternatives(doc, security);
  return resolveSingleRequirement(doc, security[0]);
}

/**
 * OR'd security alternatives. AIR still refuses to *guess* between authorities,
 * but when every credentialed alternative resolves cleanly to the SAME
 * principal class — e.g. Stripe's basic-OR-bearer for one API key, Coupa's
 * client-credentials-OR-api-key service identity — the choice carries no
 * safety weight: whichever carrier is used, the call runs under the same
 * authority. Selecting the first alternative then trades a wholesale-blocked
 * estate for a review_required one with an explicit note, and the human
 * approving the operation sees exactly what was picked and what was bypassed.
 * Any disagreement in principal, or any alternative that does not itself
 * resolve cleanly, keeps the conservative block.
 */
function resolveAlternatives(
  doc: OpenApiDocument,
  security: Array<Record<string, string[]>>,
): AuthResolution {
  const credentialed = security.filter((s) => Object.keys(s).length > 0);
  if (credentialed.length === 0) return { auth: authOf("none", []) };
  const anonymousAllowed = credentialed.length < security.length;
  const resolutions = credentialed.map((s) => resolveSingleRequirement(doc, s));
  const principals = new Set(resolutions.map((r) => r.auth.principal));
  const equivalent = resolutions.every((r) => !r.issue) && principals.size === 1;
  if (!equivalent) {
    return unresolvedAuth(
      [],
      "auth/alternatives_unmodeled",
      `OpenAPI declares ${security.length} alternative security requirements (OR). AIR cannot safely select one implicitly; choose an explicit auth contract in the manifest.`,
      true,
    );
  }
  const chosen = resolutions[0] as AuthResolution;
  const names = credentialed.map((s) => Object.keys(s).join("+"));
  const bypassed = names.slice(1).map((n) => `"${n}"`);
  return {
    auth: chosen.auth,
    issue: {
      code: "auth/alternative_selected",
      message:
        `OpenAPI declares ${security.length} alternative security requirements (OR) that all ` +
        `carry ${chosen.auth.principal} authority and differ only in credential carrier. ` +
        `Compiled the first ("${names[0]}"), bypassing ${bypassed.join(", ")}` +
        `${anonymousAllowed ? " and an anonymous alternative" : ""}. ` +
        `Override auth in the manifest to select a different carrier.`,
    },
  };
}

function resolveSingleRequirement(
  doc: OpenApiDocument,
  requirement: Record<string, string[]> | undefined,
): AuthResolution {
  const schemes = doc.components?.securitySchemes ?? {};
  const first = requirement;
  if (!first || Object.keys(first).length === 0) {
    return { auth: authOf("none", []) };
  }
  const entries = Object.entries(first);
  if (entries.length > 1) {
    return unresolvedAuth(
      [...new Set(entries.flatMap(([, scopes]) => scopes))],
      "auth/composite_unmodeled",
      `OpenAPI requires ${entries.length} security schemes together (AND). AIR currently models one credential; enrich a composite auth contract before approval.`,
      true,
    );
  }
  const [schemeName, scopes] = entries[0] as [string, string[]];
  const credentialProfile = credentialProfileFor(schemeName);
  const scheme: SecurityScheme | undefined = schemes[schemeName];
  if (!scheme) {
    return unresolvedAuth(
      scopes ?? [],
      "auth/scheme_missing",
      `Security scheme "${schemeName}" is referenced but not defined.`,
      false,
      credentialProfile,
    );
  }
  if (scheme.type === "http") {
    if (scheme.scheme === "basic") {
      return { auth: authOf("basic", scopes ?? [], undefined, credentialProfile) };
    }
    if (scheme.scheme === "bearer") {
      return { auth: authOf("jwt_bearer", scopes ?? [], undefined, credentialProfile) };
    }
    return unresolvedAuth(
      scopes ?? [],
      "auth/http_scheme_unsupported",
      `HTTP auth scheme "${scheme.scheme ?? "unknown"}" is not modeled.`,
      false,
      credentialProfile,
    );
  }
  if (scheme.type === "apiKey") {
    if ((scheme.in === "header" || scheme.in === "query") && scheme.name) {
      return {
        auth: authOf(
          "api_key",
          scopes ?? [],
          {
            apiKey: { in: scheme.in, name: scheme.name },
          },
          credentialProfile,
        ),
      };
    }
    return unresolvedAuth(
      scopes ?? [],
      "auth/api_key_carrier_missing",
      `API key scheme "${schemeName}" does not declare a supported header/query carrier.`,
      false,
      credentialProfile,
    );
  }
  if (scheme.type === "oauth2") return oauthAuth(schemeName, scheme, scopes ?? []);
  if (scheme.type === "openIdConnect") {
    return {
      auth: authOf("oauth2_authorization_code", scopes ?? [], undefined, credentialProfile),
      issue: {
        code: "auth/end_user_flow_unexecutable",
        message:
          "OpenID Connect end-user auth needs per-caller token propagation/exchange; a shared " +
          "runtime bearer is forbidden. To unblock, model per-caller delegation in the manifest " +
          "— `auth: { type: oauth2_on_behalf_of, provider: { token_endpoint: <STS URL> } }` — " +
          "and the runtime will exchange each caller's inbound token (RFC 8693). Then set the " +
          "operation state and approve.",
        blocked: true,
      },
    };
  }
  if (scheme.type === "mutualTLS") {
    return { auth: authOf("mtls", scopes ?? [], undefined, credentialProfile) };
  }
  return unresolvedAuth(
    scopes ?? [],
    "auth/scheme_unsupported",
    `Security scheme "${schemeName}" has unsupported type "${scheme.type ?? "unknown"}".`,
    false,
    credentialProfile,
  );
}

export interface NormalizeResult {
  operations: Operation[];
  diagnostics: Diagnostic[];
}

/** Normalize a parsed OpenAPI document into AIR operations (classifier applied). */
export function normalize(serviceId: string, parsed: ParsedSpec): NormalizeResult {
  const doc = parsed.document;
  // OpenAPI 3.1's `webhooks:` map is structurally identical to `paths:` (see
  // `protocols/webhooks.ts`), so it is merged straight into the loop below
  // rather than walked a second time — only the two vendor extensions
  // `webhookPathItems` stamps distinguish a webhook receiver from an ordinary
  // path, and every rule from here down (Effect/input/output inference,
  // naming, evidence) applies identically to both.
  const paths = { ...(doc.paths ?? {}), ...webhookPathItems(doc) };
  // `bundleDocument` (decycle.ts) left named-schema references as `$ref`
  // pointers into `components.schemas` so the whole spec's schema graph is
  // only ever walked once; everything below that needs a schema's own fields
  // directly (`.properties`, `.type`) resolves back through this bag,
  // per-operation, via `materializeSchema`.
  const namedSchemas = doc.components?.schemas ?? {};
  const operations: Operation[] = [];
  const diagnostics: Diagnostic[] = [];
  // Long-running detections carried to the second pass that links each one to
  // the operation an agent polls.
  const asyncDetections = new Map<Operation, LongRunningDetection>();
  // Each longRunning operation's own raw `callbacks:` object, carried to the
  // third pass (`attachWebhookLinks`) that recovers an explicit link to a
  // `webhooks:` entry. Keyed by operation OBJECT for the same reason
  // `asyncDetections` is: ids are not yet unique at this point.
  const rawCallbacks = new Map<Operation, unknown>();

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
      // Structurally certain from provenance (compiled from `webhooks:`, not
      // `paths:`) — see `classify.ts#classifyArchetype`.
      const isWebhookReceiver = raw["x-anvil-webhook"] === true;
      // A GraphQL query/subscription is definitionally a read; so is a webhook
      // receiver (it never calls upstream at all). The SOAP/gRPC assertions
      // come from an operation-name heuristic instead, so their evidence
      // confidence stays at the method-heuristic grade.
      const definitionalRead =
        raw["x-graphql-operation"] === "query" ||
        raw["x-graphql-operation"] === "subscription" ||
        isWebhookReceiver;

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
      const declaredIntentSignals = [raw.operationId, raw.summary].filter(
        (value): value is string => Boolean(value),
      );
      const { effect, idempotency } = classifyEffect(
        method,
        signal,
        endsWithParam,
        effectHint,
        declaredIntentSignals,
      );
      effect.resource = singularize(names.resource);
      // `x-idempotent: true` is a spec-level declaration (Swagger 2.0 and 3.x
      // alike) that repeating the call is a no-op. Honor it as natural
      // idempotency so retries become provably safe — confirmation still
      // applies to risky mutations, so this never loosens the approval gate.
      const declaredIdempotent = raw["x-idempotent"] === true;
      if (declaredIdempotent && idempotency.mode === "none") idempotency.mode = "natural";
      const retries = classifyRetry(effect, idempotency);
      const confirmation = classifyConfirmation(effect, idempotency);
      // Whether the call finishes after it returns, from the operation's OWN
      // declared responses (a 202, an Operation-Location header, a Location on
      // the 202). Local by construction, so it is decided here and the operation
      // field and the archetype input stay tied to one value, as before — they
      // can never disagree. The *contract* for finishing the job needs the whole
      // document and is linked in a second pass (`attachAsyncContracts`).
      const longRunningDetection = classifyLongRunning(effect, asyncResponseSignals(raw.responses));
      const longRunning = longRunningDetection !== undefined;

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

      const archetype = classifyArchetype(
        effect,
        effect.action,
        longRunning,
        params,
        body,
        isWebhookReceiver,
      );

      const successRes =
        raw.responses?.["200"] ?? raw.responses?.["201"] ?? raw.responses?.["202"] ?? undefined;
      const outputSchema = jsonSchemaOf(successRes?.content, namedSchemas);
      const pagination = classifyPagination(effect, effect.action, params, outputSchema);
      const auth = resolveAuth(doc, raw.security);
      if (auth.issue) {
        diagnostics.push({
          level: "warning",
          code: auth.issue.code,
          message: `${method.toUpperCase()} ${path}: ${auth.issue.message}`,
          operationId: id,
        });
      }

      const operation: Operation = {
        id,
        canonicalName: names.canonicalName,
        displayName: names.displayName,
        description: raw.description ?? raw.summary ?? "",
        tags: raw.tags ?? [],
        sourceRef: { kind: parsed.kind, path, method, operationId: raw.operationId },
        effect,
        input: { params, body },
        output: {
          schema: outputSchema,
          description: successRes?.description,
        },
        errors: errorSpecs(raw.responses),
        idempotency,
        retries,
        confirmation,
        auth: auth.auth,
        streaming: false,
        longRunning,
        archetype,
        ...(pagination ? { pagination } : {}),
        deprecated: Boolean(raw.deprecated),
        cli: { command: names.cliCommand, aliases: [] },
        mcp: { toolName: names.toolName },
        skill: { intentExamples: [] },
        state: auth.issue?.blocked ? "blocked" : auth.issue ? "review_required" : "generated",
        reviewNotes: auth.issue ? [auth.issue.message] : [],
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
            ...(longRunningDetection
              ? [
                  {
                    subject: id,
                    predicate: "longRunning",
                    value: true,
                    source: "spec" as const,
                    sourceRef: `${method.toUpperCase()} ${path} responses`,
                    method: "declared",
                    note: `the document ${longRunningDetection.signals.join("; ")}`,
                    // Declared status codes and response headers are facts of
                    // the contract, so this ranks with `x-idempotent` rather
                    // than with the method heuristics above.
                    confidence: 0.8,
                  },
                ]
              : []),
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
      };
      operations.push(operation);
      // Keyed by the operation OBJECT, not its id: ids are not yet unique at
      // this point (the collision pass runs later, in compile), and keying by a
      // duplicated id would hand one operation's async detection to its twin —
      // attaching a poll contract to a synchronous call.
      if (longRunningDetection) asyncDetections.set(operation, longRunningDetection);
      if (raw.callbacks !== undefined) rawCallbacks.set(operation, raw.callbacks);
    }
  }

  attachAsyncContracts(operations, asyncDetections);
  attachWebhookLinks(operations, rawCallbacks, doc.webhooks);

  return { operations, diagnostics };
}
