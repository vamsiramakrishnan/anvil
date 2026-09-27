/**
 * The state-provider seam.
 *
 * The simulator owns the *surface* of a contract: which operations exist, who
 * may call them, what a refusal looks like, how a key replays, how a page is
 * enveloped, which faults fire. It does not have to own the *data*. A
 * `StateProvider` receives each call that survived every surface gate, as one
 * normalized request, and answers with records or a typed domain error. Anvil
 * then shapes that answer back onto the contract.
 *
 * Without a provider the simulator serves its built-in seeded store, exactly as
 * before this seam existed. See ADR-0028 and docs/simulator-state-providers.md.
 */
import {
  type AirDocument,
  agentPropKey,
  contractHash,
  type ErrorCode,
  ErrorCode as ErrorCodeEnum,
  isModeledIdempotencyCarrierInput,
  isODataPaging,
  type Operation,
  type OperationAction,
  resolveIdempotencyCarrier,
  wireProtocolFor,
} from "@anvil/air";
import type { SimResult } from "./runtime.js";
import { isRecord } from "./synthesize.js";

/** Bumped only when a message shape changes incompatibly. */
export const PROVIDER_PROTOCOL_VERSION = 1;

/** The simulator package version, reported to a provider in `initialize`. */
const SIMULATOR_VERSION = "0.1.0";

/**
 * What an operation does, in the coarse vocabulary a data backend routes on.
 * Derived from AIR's effect classification, never from the HTTP verb.
 */
export type OperationKind = "read" | "list" | "search" | "create" | "update" | "delete" | "action";

/** Whether an operation is served as a page of items rather than one result. */
export function servesItems(op: Operation): boolean {
  return op.effect.action === "list" || op.pagination !== undefined;
}

export function operationKind(op: Operation): OperationKind {
  const action = op.effect.action;
  if (op.effect.kind === "read") {
    if (action === "search") return "search";
    return servesItems(op) ? "list" : "read";
  }
  if (action === "create") return "create";
  if (action === "update" || action === "replace") return "update";
  if (action === "delete") return "delete";
  return "action";
}

/** One call, after auth, confirmation, idempotency and fault gates have passed. */
export interface ProviderRequest {
  /** Deterministic per simulator run: `r<call index>`. */
  requestId: string;
  capabilityId: string;
  operationId: string;
  toolName: string;
  kind: OperationKind;
  /** AIR's finer action verb (`get`, `send`, `approve`, ...). */
  action: OperationAction;
  resource: string | null;
  /** The contract's own wire coordinates, for providers that route on them. */
  method: string | null;
  pathTemplate: string | null;
  /** Parameters by their wire names, split by location. */
  params: {
    path: Record<string, unknown>;
    query: Record<string, unknown>;
    header: Record<string, unknown>;
    /** Declared cookie parameters (added within protocol version 1; see the docs). */
    cookie: Record<string, unknown>;
  };
  /** The request body as the contract names its fields; `null` when absent. */
  body: unknown;
  /** Present only for paged operations (`kind` list/search with pagination). */
  page: { cursor: string | null; size: number } | null;
  principal: { id: string; role: string; scopes: string[] } | null;
  tenantId: string | null;
  idempotencyKey: string | null;
}

/** A typed domain error a provider raises instead of a result. */
export interface ProviderError {
  /** One of Anvil's `ErrorCode` values; anything else becomes `unknown_upstream_error`. */
  code: string;
  message?: string;
  /** The vendor's own error code, matched against the contract's declared errors. */
  upstreamCode?: string;
  /** Override the HTTP status; otherwise the declared (or conventional) one is used. */
  status?: number;
  /** A vendor error body to serve verbatim over HTTP. */
  body?: unknown;
}

/**
 * Provider metadata: anything a provider wants recorded about how it answered
 * (the query it ran, rows scanned, a fixture id, timing). It is written to the
 * trace, in the `provider` entry, and never reaches a response: not the body,
 * not a header, not the status. Added within protocol version 1.
 */
export type ProviderMeta = Record<string, unknown>;

export type ProviderResponse =
  | {
      ok: true;
      result?: unknown;
      items?: unknown[];
      nextCursor?: string | null;
      /**
       * How many items the whole paged query holds, when the provider knows.
       * Served only where the contract reports a total (a page-numbered
       * `paging` block). Added within protocol version 1.
       */
      total?: number;
      meta?: ProviderMeta;
    }
  | { ok: false; error: ProviderError; meta?: ProviderMeta };

/** An external owner of simulator state. */
export interface StateProvider {
  invoke(request: ProviderRequest): ProviderResponse | Promise<ProviderResponse>;
  close?(): void | Promise<void>;
}

/** Sent once, before any `invoke`, so a provider can refuse a contract it was not built for. */
export interface ProviderInitializeParams {
  protocolVersion: number;
  simulator: { name: string; version: string };
  serviceId: string;
  capabilityId: string;
  /** `contractHash` of the AIR document being served. */
  contractDigest: string;
  /** The surface-signature digest the simulator stamps (ADR-0015). */
  surfaceDigest: string;
  seed: number;
  operations: Array<{
    operationId: string;
    toolName: string;
    kind: OperationKind;
    action: OperationAction;
    resource: string | null;
    method: string | null;
    pathTemplate: string | null;
    paged: boolean;
  }>;
}

export function initializeParams(
  air: AirDocument,
  ops: readonly Operation[],
  capabilityId: string,
  surfaceDigest: string,
  seed: number,
): ProviderInitializeParams {
  return {
    protocolVersion: PROVIDER_PROTOCOL_VERSION,
    simulator: { name: "@anvil/simulator", version: SIMULATOR_VERSION },
    serviceId: air.service.id,
    capabilityId,
    contractDigest: contractHash(air),
    surfaceDigest,
    seed,
    operations: ops.map((op) => ({
      operationId: op.id,
      toolName: op.mcp.toolName,
      kind: operationKind(op),
      action: op.effect.action,
      resource: op.effect.resource ?? null,
      method: op.sourceRef.method?.toUpperCase() ?? null,
      pathTemplate: op.sourceRef.path ?? null,
      paged: servesItems(op),
    })),
  };
}

/** Split an agent-keyed input into wire-named path/query/header/cookie params and a body. */
export function wireParams(
  op: Operation,
  input: Record<string, unknown>,
): { params: ProviderRequest["params"]; body: unknown } {
  const params: ProviderRequest["params"] = { path: {}, query: {}, header: {}, cookie: {} };
  for (const p of op.input.params) {
    const value = input[agentPropKey(p)];
    if (value === undefined || value === null) continue;
    if (p.in !== "body") params[p.in][p.name] = value;
  }
  const declared = op.input.body;
  let body: unknown = null;
  if (declared?.projection === "fields") {
    const fields: Record<string, unknown> = {};
    for (const f of declared.fields) {
      const value = input[agentPropKey(f)];
      if (value !== undefined && value !== null) fields[f.name] = value;
    }
    if (Object.keys(fields).length > 0) body = fields;
  } else if (declared && input.body !== undefined && input.body !== null) {
    body = input.body;
  }
  return { params, body };
}

/**
 * The conventional HTTP status for an Anvil error code, used when the contract
 * declares none for it. Chosen so the runtime's own `httpStatusToErrorCode`
 * maps each status back to the same code wherever the two taxonomies overlap.
 */
const STATUS_FOR: Record<ErrorCode, number> = {
  validation_error: 400,
  auth_required: 401,
  permission_denied: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  upstream_timeout: 504,
  upstream_unavailable: 503,
  unsafe_retry_blocked: 409,
  confirmation_required: 400,
  idempotency_required: 400,
  idempotency_ledger_unavailable: 503,
  schema_mismatch: 502,
  unsupported_operation: 404,
  policy_denied: 403,
  unknown_upstream_error: 500,
};

/**
 * The HTTP status of a success. The contract's declared codes win over any
 * convention, but only where a vendor declared them: HTTP+JSON operations.
 * `204` is served when it is declared and the call has no body to return (or
 * nothing else is declared), else the first body-bearing declared code. With
 * nothing declared, the convention: 201 for a create and 200 otherwise.
 */
export function successStatus(op: Operation | undefined, output: unknown): number {
  const declared =
    op && wireProtocolFor(op.sourceRef) === "http_json" ? (op.output.successStatuses ?? []) : [];
  const withBody = declared.filter((status) => status !== 204);
  const empty = output === undefined || output === null;
  if (declared.includes(204) && (empty || withBody.length === 0)) return 204;
  if (withBody[0] !== undefined) return withBody[0];
  return op && operationKind(op) === "create" ? 201 : 200;
}

/** The HTTP projection of a simulator error: the status and vendor body the contract implies. */
export interface WireError {
  status: number;
  body: unknown;
}

/**
 * Map a domain error onto the operation's declared error contract.
 *
 * A provider-named vendor code wins (it is the most specific statement), then
 * the Anvil code. The declared entry supplies the HTTP status and the vendor
 * code a caller's runtime will match on; the body is the provider's own when it
 * sent one, else `{ error: { code, message } }`, the shape Anvil's runtime
 * reads a domain code out of.
 */
export function mapDomainError(
  op: Operation | undefined,
  error: ProviderError,
): { code: ErrorCode; message: string; wire: WireError } {
  const parsed = ErrorCodeEnum.safeParse(error.code);
  const anvilCode: ErrorCode = parsed.success ? parsed.data : "unknown_upstream_error";
  const declared =
    (error.upstreamCode !== undefined
      ? op?.errors.find((e) => e.upstream?.code === error.upstreamCode)
      : undefined) ?? op?.errors.find((e) => e.code === anvilCode);
  const code = declared?.code ?? anvilCode;
  const message = error.message ?? declared?.message ?? code;
  const upstreamCode = error.upstreamCode ?? declared?.upstream?.code;
  const status = error.status ?? declared?.upstream?.httpStatus ?? STATUS_FOR[code];
  const body = error.body ?? { error: { code: upstreamCode ?? code, message } };
  return { code, message, wire: { status, body } };
}

/** The first required input the call is missing, as a message; `undefined` when complete. */
export function missingRequired(op: Operation, input: Record<string, unknown>): string | undefined {
  const carrier = resolveIdempotencyCarrier(op);
  const binding = carrier.ok ? carrier.binding : undefined;
  const absent = (v: unknown) => v === undefined || v === null;
  for (const p of op.input.params) {
    if (!p.required || isModeledIdempotencyCarrierInput(binding, p.in, p.name)) continue;
    if (absent(input[agentPropKey(p)])) return `Missing required parameter '${p.name}'.`;
  }
  const body = op.input.body;
  if (body?.projection === "fields") {
    for (const f of body.fields) {
      if (!f.required || isModeledIdempotencyCarrierInput(binding, "body", f.name)) continue;
      if (absent(input[agentPropKey(f)])) return `Missing required body field '${f.name}'.`;
    }
  } else if (body?.required && absent(input.body)) {
    return "Missing required request body.";
  }
  return undefined;
}

/**
 * Turn a provider's answer into a simulator result. A paged operation gets the
 * same `{ items }` envelope and `nextCursor` the built-in store serves; a page
 * larger than the one asked for is refused rather than silently cut, because
 * cutting it would drop records with no cursor to reach them.
 */
export function shapeProviderResponse(
  op: Operation,
  request: ProviderRequest,
  raw: ProviderResponse,
): SimResult {
  const malformed = (why: string): SimResult => ({
    ok: false,
    error: { code: "schema_mismatch", message: `State provider answered ${op.id}: ${why}` },
  });
  if (!isRecord(raw) || typeof raw.ok !== "boolean") {
    return malformed("expected an object with a boolean 'ok'.");
  }
  if (!raw.ok) {
    if (!isRecord(raw.error) || typeof raw.error.code !== "string") {
      return malformed("an error needs 'error.code'.");
    }
    const mapped = mapDomainError(op, raw.error);
    return { ok: false, error: { code: mapped.code, message: mapped.message, wire: mapped.wire } };
  }
  if (request.page) {
    if (!Array.isArray(raw.items)) return malformed("a paged operation needs an 'items' array.");
    if (raw.items.length > request.page.size) {
      return malformed(
        `returned ${raw.items.length} items for a page of ${request.page.size}; honour page.size and return a nextCursor.`,
      );
    }
    const total = raw.total;
    if (total !== undefined && !(Number.isInteger(total) && total >= 0)) {
      return malformed("'total' must be a non-negative integer.");
    }
    const next = raw.nextCursor;
    return {
      ok: true,
      output: { items: raw.items },
      ...(typeof next === "string" && next !== "" ? { nextCursor: next } : {}),
      ...(total !== undefined ? { total } : {}),
    };
  }
  return { ok: true, output: raw.result === undefined ? null : raw.result };
}

/** What `normalizeRequest` needs from the simulator besides the operation and input. */
interface NormalizeContext {
  requestId: string;
  capabilityId: string;
  principal: { id: string; role: string; scopes: string[] } | undefined;
  tenantId: string | undefined;
  idempotencyKey: string | undefined;
  cursor: string | undefined;
  fallbackPageSize: number;
}

/** Build the request a provider receives for one admitted call. */
export function normalizeRequest(
  op: Operation,
  input: Record<string, unknown>,
  ctx: NormalizeContext,
): ProviderRequest {
  const { params, body } = wireParams(op, input);
  const principal = ctx.principal;
  return {
    requestId: ctx.requestId,
    capabilityId: ctx.capabilityId,
    operationId: op.id,
    toolName: op.mcp.toolName,
    kind: operationKind(op),
    action: op.effect.action,
    resource: op.effect.resource ?? null,
    method: op.sourceRef.method?.toUpperCase() ?? null,
    pathTemplate: op.sourceRef.path ?? null,
    params,
    body,
    page: servesItems(op) ? providerPage(op, input, ctx) : null,
    principal: principal
      ? { id: principal.id, role: principal.role, scopes: [...principal.scopes] }
      : null,
    tenantId: ctx.tenantId ?? null,
    idempotencyKey: ctx.idempotencyKey ?? null,
  };
}

/**
 * The page a provider is asked for. The cursor is the context's, else the
 * contract's own cursor parameter; the size is the caller's request clamped
 * to the declared maximum, else the size every other surface derives.
 */
function providerPage(
  op: Operation,
  input: Record<string, unknown>,
  ctx: NormalizeContext,
): { cursor: string | null; size: number } {
  const inputFor = (name: string | undefined) => pagingInput(op, input, name);
  const rawCursor =
    ctx.cursor ??
    inputFor(op.pagination?.cursorParam) ??
    (isODataPaging(op.pagination) ? inputFor("$skip") : undefined);
  const cursor = rawCursor === undefined || rawCursor === null ? null : String(rawCursor);
  const asked = Number(inputFor(op.pagination?.pageSizeParam));
  let size = Number.isInteger(asked) && asked > 0 ? asked : ctx.fallbackPageSize;
  const max = op.pagination?.maxPageSize;
  if (max !== undefined) size = Math.min(size, max);
  return { cursor, size };
}

/**
 * The value an agent-keyed input holds for a paging control named by its wire
 * name: a declared parameter by its agent key, a body field (projected, or
 * inside a whole body) when the contract pages in the body, else the raw name.
 */
export function pagingInput(
  op: Operation,
  input: Record<string, unknown>,
  name: string | undefined,
): unknown {
  if (name === undefined) return undefined;
  if (op.pagination?.in === "body") {
    const body = op.input.body;
    if (body?.projection === "fields") {
      const field = body.fields.find((f) => f.name === name);
      return field ? input[agentPropKey(field)] : undefined;
    }
    return isRecord(input.body) ? input.body[name] : undefined;
  }
  const param = op.input.params.find((p) => p.name === name);
  return input[param ? agentPropKey(param) : name];
}

/** Ask the provider, turning a transport failure into a surface error. */
export async function askProvider(
  provider: StateProvider,
  op: Operation,
  request: ProviderRequest,
): Promise<{ raw: ProviderResponse | { transportError: string }; result: SimResult }> {
  let raw: ProviderResponse;
  try {
    raw = await provider.invoke(request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code: ErrorCode =
      err instanceof Error && err.name === "ProviderTimeoutError"
        ? "upstream_timeout"
        : "upstream_unavailable";
    return {
      raw: { transportError: message },
      result: { ok: false, error: { code, message: `State provider failed: ${message}` } },
    };
  }
  return { raw, result: shapeProviderResponse(op, request, raw) };
}
