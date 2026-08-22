import {
  type AirDocument,
  agentPropKey,
  camelCase,
  effectiveAuthCarrier,
  isModeledIdempotencyCarrierInput,
  type JsonSchema,
  type Operation,
  operationInputSchema,
  operationSafetyInputKeys,
  pascalCase,
  resolveAsyncContract,
  resolveIdempotencyCarrier,
  snakeCase,
} from "@anvil/air";

/**
 * The SDK plan — a language-neutral projection of AIR that every emitter reads.
 *
 * The point of Anvil is that surfaces cannot drift, and four hand-written
 * emitters are four chances to drift. So no emitter reads AIR: they read this,
 * and this is derived once. A method that exists in Go exists in Java with the
 * same wire coordinates, the same safety gate, and the same retry posture,
 * because all four render the same rows.
 */

/** Neutral scalar family; each emitter maps it onto its own type system. */
export type SdkTypeKind = "string" | "integer" | "number" | "boolean" | "array" | "object" | "any";

export interface SdkField {
  /** Exact on-wire coordinate. Never rewritten for ergonomics. */
  wireName: string;
  /** The key an agent/caller supplies (snake_case of the agent name). */
  key: string;
  required: boolean;
  type: SdkTypeKind;
  description?: string;
  enumValues?: string[];
}

export interface SdkParam extends SdkField {
  in: "path" | "query" | "header" | "cookie" | "body";
}

export interface SdkIdempotency {
  mode: "natural" | "key_supported" | "client_id" | "required" | "none";
  keyDerivation: "request_fingerprint" | "client_supplied" | "none";
  /** True when the caller MUST supply a key before the SDK will send anything. */
  callerKeyRequired: boolean;
  /** Where a resolved key is placed on the wire; absent when the mode carries none. */
  carrier?:
    | { mechanism: "header" | "query" | "path"; key: string }
    | { mechanism: "body"; key: string; path: string[] };
}

export interface SdkRetry {
  /** `safe` may auto-retry transient conditions; `none` never retries. */
  mode: "safe" | "none";
  maxAttempts: number;
  backoff: "none" | "fixed" | "exponential" | "exponential_jitter";
  baseDelayMs: number;
  maxDelayMs: number;
  /** Retryable HTTP statuses, already resolved from the AIR retry conditions. */
  retryStatuses: number[];
  /** Whether transport-level failures (connect/timeout) are retryable. */
  retryTransport: boolean;
}

export interface SdkPagination {
  style: "cursor" | "page" | "offset" | "link";
  cursorParam?: string;
  cursorKey?: string;
  nextField?: string;
  itemsField?: string;
  pageSizeParam?: string;
  pageSizeKey?: string;
  maxPageSize?: number;
}

export interface SdkAsync {
  /** Absent for a webhook-only contract — there is nothing to poll. */
  statusOperationId?: string;
  statusMethodBase?: string;
  statusJobIdKey?: string;
  jobIdField: string;
  stateField?: string;
  terminalStates: string[];
  pendingStates: string[];
  pollIntervalSeconds: number;
  instruction: string;
}

export interface SdkOperation {
  id: string;
  canonicalName: string;
  displayName: string;
  description: string;
  /** Uppercase HTTP method. */
  httpMethod: string;
  /** Path template with `{wire_name}` placeholders, exactly as AIR carries it. */
  path: string;
  effect: "read" | "mutation";
  action: string;
  risk: string;
  reversible: boolean;
  deprecated: boolean;
  /** Method identifiers, precomputed per language so the four never disagree. */
  names: { snake: string; camel: string; pascal: string };
  params: SdkParam[];
  body?: {
    required: boolean;
    contentType: string;
    projection: "fields" | "whole";
    fields: SdkField[];
  };
  idempotency: SdkIdempotency;
  retry: SdkRetry;
  confirmation: { required: boolean; humanApproval: boolean; reason?: string };
  auth: { type: string; scopes: string[] };
  pagination?: SdkPagination;
  async?: SdkAsync;
  /** The aligned bindings on the other surfaces, carried for cross-surface docs. */
  cliCommand: string;
  mcpToolName: string;
  /** Documented upstream error codes, for the doc comment. */
  errorCodes: string[];
  /**
   * The caller-facing names of the two safety controls, allocated by AIR's own
   * allocator so a language that flattens them into the argument list (Python's
   * keyword arguments) names them exactly as the CLI and MCP surfaces do — and
   * so a business field genuinely called `confirm` can never shadow the gate.
   */
  safetyKeys: { confirm: string; idempotencyKey: string };
}

export interface SdkPlan {
  service: {
    id: string;
    version: string;
    displayName: string;
    description: string;
    baseUrl: string;
    /** Identifier-safe forms of the service id, precomputed per language. */
    names: { snake: string; camel: string; pascal: string };
  };
  auth: {
    type: string;
    /** Where the credential goes on the wire; absent when the API needs none. */
    carrier?: { in: "header" | "query"; name: string; scheme?: string };
    /** Environment variable an SDK reads when no credential is passed. */
    envVar: string;
  };
  operations: SdkOperation[];
  /** The full Anvil error taxonomy, so every language enumerates the same codes. */
  errorCodes: string[];
}

/** The Anvil error taxonomy (spec §10) — mirrored verbatim into every SDK. */
export const SDK_ERROR_CODES = [
  "validation_error",
  "auth_required",
  "permission_denied",
  "not_found",
  "conflict",
  "rate_limited",
  "upstream_timeout",
  "upstream_unavailable",
  "unsafe_retry_blocked",
  "confirmation_required",
  "idempotency_required",
  "schema_mismatch",
  "unsupported_operation",
  "policy_denied",
  "unknown_upstream_error",
] as const;

const RETRY_CONDITION_STATUS: Record<string, number> = {
  http_408: 408,
  http_429: 429,
  http_500: 500,
  http_502: 502,
  http_503: 503,
  http_504: 504,
};

const TRANSPORT_CONDITIONS = new Set(["timeout", "connection_reset", "dns_failure"]);

function typeKind(schema: JsonSchema | undefined): SdkTypeKind {
  const raw = schema?.type;
  const type = Array.isArray(raw) ? raw.find((t) => t !== "null") : raw;
  switch (type) {
    case "string":
      return "string";
    case "integer":
      return "integer";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    case "object":
      return "object";
    default:
      return "any";
  }
}

function enumValues(schema: JsonSchema | undefined): string[] | undefined {
  const values = schema?.enum;
  if (!Array.isArray(values) || values.length === 0) return undefined;
  if (!values.every((v) => typeof v === "string")) return undefined;
  return values as string[];
}

/** One line of prose, safe to embed in any language's comment syntax. */
export function commentLine(text: string | undefined, fallback = ""): string {
  const value = (text ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > 0 ? value : fallback;
}

function names(source: string): { snake: string; camel: string; pascal: string } {
  return { snake: snakeCase(source), camel: camelCase(source), pascal: pascalCase(source) };
}

/**
 * Whether the SDK must refuse until the caller supplies a key.
 *
 * `required` mode with a derivable key is not a refusal — the SDK derives the
 * same `anvil-<fingerprint>` the runtime does. `required` without derivation is,
 * because sending an unkeyed mutation upstream would silently forfeit the
 * dedup the contract says exists.
 */
function callerKeyRequired(op: Operation): boolean {
  return (
    op.idempotency.mode === "required" && op.idempotency.keyDerivation !== "request_fingerprint"
  );
}

/** The resolved carrier binding, or undefined when the contract carries none. */
function carrierBinding(op: Operation) {
  const resolution = resolveIdempotencyCarrier(op);
  return resolution.ok ? resolution.binding : undefined;
}

function idempotencyOf(op: Operation): SdkIdempotency {
  const base: SdkIdempotency = {
    mode: op.idempotency.mode,
    keyDerivation: op.idempotency.keyDerivation,
    callerKeyRequired: callerKeyRequired(op),
  };
  const binding = carrierBinding(op);
  if (!binding) return base;
  return {
    ...base,
    carrier:
      binding.mechanism === "body"
        ? { mechanism: "body", key: binding.key, path: binding.path }
        : { mechanism: binding.mechanism, key: binding.key },
  };
}

function retryOf(op: Operation): SdkRetry {
  const statuses = op.retries.retryOn
    .map((condition) => RETRY_CONDITION_STATUS[condition])
    .filter((status): status is number => status !== undefined)
    .sort((a, b) => a - b);
  return {
    mode: op.retries.mode,
    maxAttempts: op.retries.maxAttempts,
    backoff: op.retries.backoff,
    baseDelayMs: op.retries.baseDelayMs,
    maxDelayMs: op.retries.maxDelayMs,
    retryStatuses: [...new Set(statuses)],
    retryTransport: op.retries.retryOn.some((condition) => TRANSPORT_CONDITIONS.has(condition)),
  };
}

function paramsOf(op: Operation): SdkParam[] {
  const binding = carrierBinding(op);
  return op.input.params
    .filter((param) => !isModeledIdempotencyCarrierInput(binding, param.in, param.name))
    .map((param) => ({
      wireName: param.name,
      key: agentPropKey(param),
      required: param.required,
      in: param.in,
      type: typeKind(param.schema),
      description: commentLine(param.description) || undefined,
      enumValues: enumValues(param.schema),
    }));
}

function bodyOf(op: Operation): SdkOperation["body"] {
  const body = op.input.body;
  if (!body) return undefined;
  const binding = carrierBinding(op);
  return {
    required: body.required,
    contentType: body.contentType,
    projection: body.projection,
    fields:
      body.projection === "fields"
        ? body.fields
            .filter((field) => !isModeledIdempotencyCarrierInput(binding, "body", field.name))
            .map((field) => ({
              wireName: field.name,
              key: agentPropKey(field),
              required: field.required,
              type: typeKind(field.schema),
              description: commentLine(field.description) || undefined,
              enumValues: enumValues(field.schema),
            }))
        : [],
  };
}

function paginationOf(op: Operation): SdkPagination | undefined {
  if (!op.pagination) return undefined;
  const page = op.pagination;
  const keyFor = (wire: string | undefined): string | undefined => {
    if (wire === undefined) return undefined;
    const param = op.input.params.find((p) => p.name === wire);
    return param ? agentPropKey(param) : snakeCase(wire);
  };
  return {
    style: page.style,
    cursorParam: page.cursorParam,
    cursorKey: keyFor(page.cursorParam),
    nextField: page.nextField,
    itemsField: page.itemsField,
    pageSizeParam: page.pageSizeParam,
    pageSizeKey: keyFor(page.pageSizeParam),
    maxPageSize: page.maxPageSize,
  };
}

/**
 * The completion coordinates, only when the contract fully resolves.
 *
 * `resolveAsyncContract` is the one authority here, and its all-or-nothing rule
 * carries straight through: a half-resolved contract publishes nothing, because
 * an SDK that hands a caller a `waitFor…` helper pointing at a method that does
 * not exist is worse than one that hands them nothing.
 */
function asyncOf(op: Operation, byId: Map<string, Operation>): SdkAsync | undefined {
  const resolution = resolveAsyncContract(op, byId);
  if (!resolution.ok) return undefined;
  const contract = resolution.contract;
  const status = resolution.statusOperation;
  const instruction = commentLine(
    status
      ? `Returns before the work completes. Poll ${status.canonicalName} with the handle from '${contract.jobIdField}' until '${contract.stateField ?? "state"}' reaches one of: ${contract.terminalStates.join(", ")}.`
      : `Returns before the work completes. Completion arrives by webhook; the handle is '${contract.jobIdField}'.`,
  );
  const statusJobIdParam = contract.statusJobIdParam;
  const statusParam = status?.input.params.find((p) => p.name === statusJobIdParam);
  return {
    ...(status
      ? {
          statusOperationId: status.id,
          statusMethodBase: status.canonicalName,
          statusJobIdKey: statusParam
            ? agentPropKey(statusParam)
            : snakeCase(statusJobIdParam ?? ""),
        }
      : {}),
    jobIdField: contract.jobIdField,
    stateField: contract.stateField,
    terminalStates: contract.terminalStates,
    pendingStates: contract.pendingStates,
    pollIntervalSeconds: contract.pollIntervalSeconds ?? 2,
    instruction,
  };
}

/**
 * Operations an SDK may expose: approved, and not a webhook receiver.
 *
 * The same predicate the runtime hot-path manifest applies. An SDK is a
 * generated surface like any other, so "only approved operations are exposed"
 * is not advice here — it is the filter, applied in exactly one place.
 */
export function sdkOperations(air: AirDocument): Operation[] {
  return air.operations.filter(
    (op) => op.state === "approved" && op.archetype !== "webhook_receiver",
  );
}

/** Project AIR onto the language-neutral SDK plan. Pure and deterministic. */
export function sdkPlan(air: AirDocument): SdkPlan {
  const byId = new Map(air.operations.map((op) => [op.id, op]));
  const serviceNames = names(air.service.id);
  // Auth is a service-level concern in every SDK we emit: the carrier is
  // resolved from the first approved operation that declares one, and
  // certification refuses a bundle whose approved operations disagree.
  const authOperation = sdkOperations(air).find((op) => op.auth.type !== "none");
  const auth = authOperation?.auth ?? air.service.auth;
  const carrier = effectiveAuthCarrier(auth);
  return {
    service: {
      id: air.service.id,
      version: air.service.version,
      displayName: air.service.displayName ?? air.service.id,
      description: `Generated client for ${air.service.displayName ?? air.service.id} (${air.service.id} ${air.service.version}).`,
      baseUrl: air.service.servers[0]?.url ?? "",
      names: serviceNames,
    },
    auth: {
      type: auth.type,
      ...(carrier
        ? { carrier: { in: carrier.in, name: carrier.name, scheme: carrier.scheme } }
        : {}),
      envVar: `${serviceNames.snake.toUpperCase()}_TOKEN`,
    },
    operations: sdkOperations(air).map((op) => ({
      id: op.id,
      canonicalName: op.canonicalName,
      displayName: op.displayName,
      description: commentLine(op.description, op.displayName),
      httpMethod: (op.sourceRef.method ?? "get").toUpperCase(),
      path: op.sourceRef.path ?? "/",
      effect: op.effect.kind,
      action: op.effect.action,
      risk: op.effect.risk,
      reversible: op.effect.reversible,
      deprecated: op.deprecated,
      names: names(op.canonicalName),
      params: paramsOf(op),
      body: bodyOf(op),
      idempotency: idempotencyOf(op),
      retry: retryOf(op),
      confirmation: {
        required: op.confirmation.required,
        humanApproval: op.confirmation.humanApproval === true,
        reason: commentLine(op.confirmation.reason) || undefined,
      },
      auth: { type: op.auth.type, scopes: op.auth.scopes },
      pagination: paginationOf(op),
      async: asyncOf(op, byId),
      safetyKeys: operationSafetyInputKeys(op),
      cliCommand: op.cli.command,
      mcpToolName: op.mcp.toolName,
      errorCodes: [...new Set(op.errors.map((error) => error.code))].sort(),
    })),
    errorCodes: [...SDK_ERROR_CODES],
  };
}

/** The assembled input JSON Schema for an operation, for SDK-side documentation. */
export function sdkInputSchema(op: Operation): JsonSchema {
  return op.input.schema ?? operationInputSchema(op);
}
