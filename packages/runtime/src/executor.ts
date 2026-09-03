import { randomUUID } from "node:crypto";
import {
  agentPropKey,
  FLEET_POLICY_CODE,
  type IdempotencyCarrierBinding,
  idempotencyKeyMatchesOperation,
  isModeledIdempotencyCarrierInput,
  MAX_RETRY_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
  type Operation,
  operationSafetyInputKeys,
  propKey,
  resolveIdempotencyCarrier,
} from "@anvil/air";
import { checkQuery, lexicalFamily, renderTemplate } from "@anvil/grammar";
import {
  type AuthMaterial,
  applyAuth,
  type CredentialResolver,
  credentialProfileName,
} from "./auth.js";
import { codecFor, isFaultAware } from "./codec.js";
import {
  hostIsAllowed,
  MAX_UPSTREAM_TIMEOUT_MS,
  MIN_UPSTREAM_TIMEOUT_MS,
  normalizeEnv,
} from "./config.js";
import { AnvilError, type ErrorEnvelope } from "./errors.js";
import { httpResponseError } from "./http-error.js";
import {
  type IdempotencyLedger,
  idempotencyKeyIsTransportSafe,
  MAX_IDEMPOTENCY_KEY_BYTES,
  requestFingerprint,
  resolveIdempotencyKey,
} from "./idempotency.js";
import type { InboundIdentity } from "./inbound-identity.js";
import { checkLimits, type LimitsGate } from "./limits.js";
import { type ExecutionRecord, noopObserver, type Observer } from "./observability.js";
import {
  missingScopes,
  type PolicyContext,
  type PolicyHook,
  type PolicyHooks,
  type Principal,
  resolvePrincipal,
} from "./policy.js";
import { applyAgentProjection } from "./response-projection.js";
import {
  computeBackoffMs,
  conditionIsRetryable,
  httpStatusToRetryCondition,
  resolveRetryDelay,
  retryAfterFromHeaders,
  retryIsSafe,
} from "./retry.js";
import {
  type HttpRequest,
  type HttpResponse,
  type Transport,
  TransportError,
} from "./transport.js";
import { wireFacadeDecision, wireGateError } from "./wire-gate.js";

export interface DryRunPlan {
  operation: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  idempotencyKeyPresent: boolean;
  retryPlan: { enabled: boolean; maxAttempts: number };
  confirmationRequired: boolean;
}

export type ExecuteResult =
  | { outcome: "success"; status: number; data: unknown; record: ExecutionRecord }
  | { outcome: "error"; envelope: ErrorEnvelope; record: ExecutionRecord }
  | { outcome: "dry_run"; plan: DryRunPlan; record: ExecutionRecord };

export interface ExecuteContext {
  transport: Transport;
  /** Stable AIR service identity used to namespace replay protection. */
  serviceId: string;
  baseUrl: string;
  credentials?: CredentialResolver;
  authProfile?: string;
  /**
   * The validated inbound caller identity for THIS request, when the serving
   * entrypoint verified a bearer token. Threaded to the credential resolver as
   * the `subject_token` for delegated / on-behalf-of (RFC 8693) exchange.
   */
  inbound?: InboundIdentity;
  policy?: PolicyHooks;
  /**
   * WHO is calling this execution, resolved once per MCP session
   * (`@anvil/mcp-runtime`'s fleet server, or a bearer/`ANVIL_PRINCIPAL`
   * resolution a single-bundle server opts into). Absent — the default for
   * every serving path that does not resolve one — is the anonymous,
   * every-scope principal, so behaviour is byte-identical unless a caller
   * configures principals.
   */
  principal?: Principal;
  /** Per-principal rate/spend limits (fleet runtime). Absent = unlimited. */
  limits?: LimitsGate;
  observer?: Observer;
  ledger?: IdempotencyLedger;
  allowedHosts?: string[];
  env?: string;
  traceId?: string;
  rng?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  /** Set false to force single-attempt execution regardless of policy. */
  retries?: boolean;
  /**
   * An operator's stated reason that `baseUrl` is a protocol facade serving
   * the synthesized coordinates of a non-HTTP/JSON source over HTTP+JSON.
   * The only way past the transport gate, and recorded when used.
   */
  protocolFacade?: string;
}

export interface ExecuteInput {
  input: Record<string, unknown>;
  confirm?: boolean;
  idempotencyKey?: string;
  dryRun?: boolean;
}

const REDACT = new Set(["authorization", "x-api-key", "proxy-authorization", "cookie"]);

/**
 * The structured refusal for an operation outside the approved surface. Shared
 * by the executor's own gate and by CLI-layer catalog gating so every surface
 * refuses with the same code, message, and next action (spec §17).
 */
export function unapprovedOperationError(op: Operation, traceId: string): AnvilError {
  return new AnvilError({
    code: "unsupported_operation",
    message:
      `Operation '${op.id}' is not approved for execution (state: ${op.state}). ` +
      `Only approved operations are exposed. Review it with \`anvil inspect <bundle>\`, ` +
      `then expose it with \`anvil approve <bundle> ${op.id}\` and regenerate the bundle.`,
    operation: op.id,
    traceId,
    retryable: false,
    details: { state: op.state, required_action: `anvil approve <bundle> ${op.id}` },
  });
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = REDACT.has(k.toLowerCase()) ? "***" : v;
  }
  return out;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function modeledCarrierSurfaceKey(
  op: Operation,
  binding: IdempotencyCarrierBinding,
): string | undefined {
  const rawName = binding.mechanism === "body" ? binding.path[0] : binding.key;
  if (!rawName) return undefined;
  const key = propKey(rawName);
  const modeled =
    op.input.params.some((parameter) =>
      isModeledIdempotencyCarrierInput(binding, parameter.in, parameter.name),
    ) ||
    (binding.mechanism === "body" &&
      op.input.body?.projection === "fields" &&
      op.input.body.fields.some((field) =>
        isModeledIdempotencyCarrierInput(binding, "body", field.name),
      ));
  if (!modeled) return undefined;

  const businessCollision =
    op.input.params.some(
      (parameter) =>
        !isModeledIdempotencyCarrierInput(binding, parameter.in, parameter.name) &&
        agentPropKey(parameter) === key,
    ) ||
    (op.input.body?.projection === "fields" &&
      op.input.body.fields.some(
        (field) =>
          !isModeledIdempotencyCarrierInput(binding, "body", field.name) &&
          agentPropKey(field) === key,
      ));
  return businessCollision ? undefined : key;
}

function carrierInputValue(
  op: Operation,
  input: Record<string, unknown>,
  binding: IdempotencyCarrierBinding | undefined,
): unknown {
  if (!binding) return undefined;
  if (binding.mechanism !== "body") {
    const key = modeledCarrierSurfaceKey(op, binding);
    return key ? input[key] : undefined;
  }

  const legacyOrProjected =
    binding.path.length === 1 &&
    (op.input.params.some(
      (parameter) =>
        parameter.in === "body" &&
        isModeledIdempotencyCarrierInput(binding, "body", parameter.name),
    ) ||
      op.input.body?.projection === "fields");
  if (!legacyOrProjected) return valueAtPath(input.body, binding.path);
  const key = modeledCarrierSurfaceKey(op, binding);
  return key ? input[key] : undefined;
}

function bodyCarrierContainerIssue(
  op: Operation,
  input: Record<string, unknown>,
  binding: IdempotencyCarrierBinding | undefined,
): string | undefined {
  if (binding?.mechanism !== "body" || op.input.body?.projection !== "whole") return undefined;
  const current = input.body;
  if (current === undefined || current === null) return undefined;
  if (!isRecord(current)) return "The request body must be an object to carry the idempotency key.";
  let container: Record<string, unknown> = current;
  for (const segment of binding.path.slice(0, -1)) {
    const next = container[segment];
    if (next === undefined || next === null) return undefined;
    if (!isRecord(next)) {
      return `Body field '${segment}' must be an object to carry the idempotency key.`;
    }
    container = next;
  }
  return undefined;
}

function withBodyCarrier(
  value: unknown,
  path: readonly string[],
  key: string,
): Record<string, unknown> {
  const root = isRecord(value) ? structuredClone(value) : {};
  let current = root;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (isRecord(next)) {
      current = next;
    } else {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
    }
  }
  current[path[path.length - 1] as string] = key;
  return root;
}

function removeNestedCarrier(root: Record<string, unknown>, path: readonly string[]): void {
  let current = root;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (!isRecord(next)) return;
    current = next;
  }
  delete current[path[path.length - 1] as string];
}

/**
 * Fingerprints business input, not the surface-specific safety controls used to
 * deliver the same request. A CLI flag and an MCP/HTTP modeled carrier must
 * therefore resolve to one replay identity.
 */
function replayFingerprintInput(
  op: Operation,
  input: Record<string, unknown>,
  binding: IdempotencyCarrierBinding | undefined,
): Record<string, unknown> {
  const normalized = structuredClone(input);
  const safetyKeys = operationSafetyInputKeys(op);
  if (op.confirmation.required) delete normalized[safetyKeys.confirm];
  if (!binding) return normalized;
  delete normalized[safetyKeys.idempotencyKey];

  if (binding.mechanism !== "body") {
    const modeledKey = modeledCarrierSurfaceKey(op, binding);
    if (modeledKey) delete normalized[modeledKey];
    return normalized;
  }

  const usesFlatInput =
    binding.path.length === 1 &&
    (op.input.params.some(
      (parameter) =>
        parameter.in === "body" &&
        isModeledIdempotencyCarrierInput(binding, "body", parameter.name),
    ) ||
      op.input.body?.projection === "fields");
  if (usesFlatInput) {
    const modeledKey = modeledCarrierSurfaceKey(op, binding);
    if (modeledKey) delete normalized[modeledKey];
    return normalized;
  }

  // A whole-body carrier always creates an object on the wire, even when the
  // caller supplied the key through a CLI flag. Retain that empty container so
  // `{--idempotency-key K}` and `{body:{carrier:K}}` normalize identically.
  const body = isRecord(normalized.body) ? normalized.body : {};
  normalized.body = body;
  removeNestedCarrier(body, binding.path);
  return normalized;
}

/** Build the upstream HTTP request from AIR + snake_cased input. */
function buildRequest(
  op: Operation,
  input: Record<string, unknown>,
  baseUrl: string,
  binding: IdempotencyCarrierBinding | undefined,
  idempotencyKey: string | undefined,
  facadeDeclared: boolean,
): HttpRequest {
  let path = op.sourceRef.path ?? "/";
  const query = new URLSearchParams();
  const headers: Record<string, string> = { accept: "application/json" };
  const body: Record<string, unknown> = {};
  let hasBody = false;

  // Grammar guard (parse-then-police): when the operation declares a
  // `queryPolicy`, the value the agent supplied for the query param is tokenized
  // and validated BEFORE any wire request. Anything the policy cannot prove safe
  // — a non-SELECT statement, a stacked second statement, a comment, an
  // unbounded read, an off-allowlist table, or a query that will not even
  // tokenize — is refused here. Fail closed: a parse failure is a refusal.
  if (op.queryPolicy) {
    const raw = input[propKey(op.queryPolicy.queryParam)];
    const queryText = raw === undefined || raw === null ? "" : String(raw);
    const verdict = checkQuery(queryText, {
      dialect: lexicalFamily(op.queryPolicy.dialect ?? "ansi"),
      allowedStatements: op.queryPolicy.allowedStatements,
      singleStatementOnly: op.queryPolicy.singleStatementOnly,
      forbidComments: op.queryPolicy.forbidComments,
      maxRows: op.queryPolicy.maxRows,
      allowedTables: op.queryPolicy.allowedTables,
    });
    if (!verdict.ok) {
      throw new AnvilError({
        code: "validation_error",
        operation: op.id,
        traceId: randomUUID(),
        message: `Query refused by grammar policy: ${verdict.violations.map((v) => v.message).join("; ")}`,
        retryable: false,
        details: { violations: verdict.violations },
      });
    }
  }

  // Query template rendering: render the parameterized template and place the
  // result at the base operation's targetParam. The derived operation's params
  // are the template variables; they are NOT sent as normal request params.
  //
  // Grammar-aware substitution (`@anvil/grammar`): each placeholder's lexical
  // context is resolved and its value substituted as an escaped literal for
  // exactly that context. A value can never terminate the literal it lives in,
  // and a value that cannot render safely (a non-numeric in a numeric slot, an
  // unanalyzable template) raises rather than reaching the wire. This replaces
  // the old character-splice renderer and its documented quoting caveat.
  if (op.queryTemplate) {
    const values: Record<string, unknown> = {};
    for (const p of op.input.params) {
      const value = input[agentPropKey(p)];
      if (value !== undefined && value !== null) values[p.name] = value;
    }
    const rendered = renderTemplate(
      op.queryTemplate.template,
      values,
      lexicalFamily(op.queryTemplate.dialect ?? "ansi"),
    );
    if (!rendered.ok) {
      throw new AnvilError({
        code: "validation_error",
        operation: op.id,
        traceId: randomUUID(),
        message: `Query template could not be safely rendered: ${rendered.message}`,
        retryable: false,
      });
    }
    const rt = rendered.query;
    // Determine where to place the rendered template: use the location of the first
    // derived param (all derived params have the same in: location by design).
    const paramLocation = op.input.params[0]?.in ?? "body";
    switch (paramLocation) {
      case "query":
        query.set(op.queryTemplate.targetParam, rt);
        break;
      case "header":
        headers[op.queryTemplate.targetParam] = rt;
        break;
      case "body":
        body[op.queryTemplate.targetParam] = rt;
        hasBody = true;
        break;
      case "path":
        path = path.replace(`{${op.queryTemplate.targetParam}}`, encodeURIComponent(rt));
        break;
      case "cookie":
        headers.cookie = `${headers.cookie ? `${headers.cookie}; ` : ""}${op.queryTemplate.targetParam}=${rt}`;
        break;
    }
    // Skip normal param processing; all template params have been consumed.
  } else {
    // Normal param processing (no query template).
    for (const p of op.input.params) {
      const value =
        idempotencyKey && isModeledIdempotencyCarrierInput(binding, p.in, p.name)
          ? idempotencyKey
          : input[agentPropKey(p)];
      if (value === undefined || value === null) continue;
      switch (p.in) {
        case "path":
          path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
          break;
        case "query":
          query.set(p.name, String(value));
          break;
        case "header":
          headers[p.name] = String(value);
          break;
        case "cookie":
          headers.cookie = `${headers.cookie ? `${headers.cookie}; ` : ""}${p.name}=${String(value)}`;
          break;
        case "body":
          // Legacy AIR (bundles compiled before the body-model change) still carry
          // body fields as in:"body" params. Honor them so an old bundle does not
          // silently execute with an empty body; new AIR uses `input.body` below.
          body[p.name] = value;
          hasBody = true;
          break;
      }
    }
  }

  // Reconstruct the request body from the preserved body model. `fields`
  // projection reads each field from the flat input; `whole` reads a single
  // `body` value (its structure preserved), so nesting/arrays/unions survive.
  let bodyValue: unknown = hasBody ? body : undefined;
  if (op.input.body) {
    if (op.input.body.projection === "fields") {
      for (const f of op.input.body.fields) {
        const value =
          idempotencyKey && isModeledIdempotencyCarrierInput(binding, "body", f.name)
            ? idempotencyKey
            : input[agentPropKey(f)];
        if (value === undefined || value === null) continue;
        body[f.name] = value;
        hasBody = true;
      }
      if (hasBody) bodyValue = body;
    } else if (input.body !== undefined && input.body !== null) {
      bodyValue = structuredClone(input.body);
      hasBody = true;
    }
  }

  if (binding && idempotencyKey) {
    switch (binding.mechanism) {
      case "header":
        // HTTP field names are case-insensitive. A source parameter may use
        // `idempotency-key` while the manifest names `Idempotency-Key`; leaving
        // both object keys makes WHATWG Headers combine them into `key, key`.
        // Replace the modeled coordinate case-insensitively before injecting
        // the one authoritative safety value.
        for (const name of Object.keys(headers)) {
          if (name.toLowerCase() === binding.key.toLowerCase()) delete headers[name];
        }
        headers[binding.key] = idempotencyKey;
        break;
      case "query":
        query.set(binding.key, idempotencyKey);
        break;
      case "path":
        path = path.replace(`{${binding.key}}`, encodeURIComponent(idempotencyKey));
        break;
      case "body":
        bodyValue = withBodyCarrier(bodyValue, binding.path, idempotencyKey);
        hasBody = true;
        break;
    }
  }

  // The codec turns bound values into bytes. It is resolved rather than
  // assumed: `wireGateError` above has already refused any operation whose
  // protocol has no codec, so a missing one here is a programming error, not a
  // reason to fall back to JSON.
  const codec = codecFor(op, facadeDeclared);
  if (!codec) throw new Error(`no wire codec registered for operation '${op.id}'`);
  return codec.encode(op, { path, query, headers, body: bodyValue, hasBody, baseUrl });
}

function canonicalUpstream(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    // Request construction and host pinning will reject an invalid URL later.
    // Keeping the exact value here still gives that malformed target a stable,
    // isolated fingerprint rather than collapsing it into another upstream.
    return baseUrl;
  }
}

function textClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Stable replay scope from verified identity claims. Raw bearer bytes, email,
 * and other mutable/display claims are deliberately excluded.
 */
function ledgerPrincipalScope(inbound: InboundIdentity | undefined): unknown | undefined {
  if (!inbound) return { kind: "anonymous" };
  const claims = inbound.claims ?? {};
  const issuer = textClaim(claims.iss);
  const subject = textClaim(claims.sub) ?? textClaim(inbound.sub);
  const objectId = textClaim(claims.oid);
  const authorizedParty = textClaim(claims.azp) ?? textClaim(claims.client_id);
  if (!issuer || (!subject && !objectId && !authorizedParty)) return undefined;
  return {
    issuer,
    subject: subject ?? null,
    objectId: objectId ?? null,
    authorizedParty: authorizedParty ?? null,
    tenant: textClaim(claims.tid) ?? textClaim(claims.tenant) ?? null,
  };
}

function ledgerUnavailableError(
  operation: string,
  traceId: string,
  phase: "reserve" | "replay" | "complete" | "release",
  upstreamTouched: boolean,
  reference?: string,
): AnvilError {
  const safeReference = safeLedgerReference(reference);
  return new AnvilError({
    code: "idempotency_ledger_unavailable",
    message: upstreamTouched
      ? "The upstream write may have completed, but its idempotency ledger transition could not be confirmed. The reservation was retained; inspect the upstream and ledger before retrying."
      : "The idempotency ledger could not reserve or replay this request. The upstream was not called; restore ledger availability and retry.",
    operation,
    traceId,
    retryable: !upstreamTouched,
    safeToRetry: !upstreamTouched,
    details: {
      ledger_phase: phase,
      upstream_touched: upstreamTouched,
      ...(safeReference ? { ledger_reference: safeReference } : {}),
      ...(upstreamTouched ? { operator_action_required: true } : {}),
    },
  });
}

function safeLedgerReference(reference: string | undefined): string | undefined {
  // Accept only the built-in backend's two hashed coordinates. A generic
  // "safe characters" check is insufficient because a raw caller key can
  // itself be printable ASCII and must never become public diagnostics.
  return reference && /^firestore\/anvil_idempotency_[a-f0-9]{16}\/[a-f0-9]{64}$/.test(reference)
    ? reference
    : undefined;
}

function authMaterialOverwritesIdempotencyCarrier(
  material: AuthMaterial,
  carrier: IdempotencyCarrierBinding | undefined,
): boolean {
  if (!carrier) return false;
  if (carrier.mechanism === "header") {
    return Object.keys(material.headers ?? {}).some(
      (name) => name.toLowerCase() === carrier.key.toLowerCase(),
    );
  }
  if (carrier.mechanism === "query") {
    return Object.hasOwn(material.query ?? {}, carrier.key);
  }
  return false;
}

/** Execute a single AIR operation with all safety guarantees applied. */
export async function execute(
  op: Operation,
  args: ExecuteInput,
  ctx: ExecuteContext,
): Promise<ExecuteResult> {
  const traceId = ctx.traceId ?? `trace_${randomUUID()}`;
  const now = ctx.now ?? Date.now;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const start = now();
  const input = args.input ?? {};
  const safetyKeys = operationSafetyInputKeys(op);
  const confirm = args.confirm ?? input[safetyKeys.confirm] === true;
  const policyDecisions: string[] = [];
  // Resolved once, before anything else: the anonymous/every-scope default
  // when a serving surface configures no principal (spec: fleet runtime §2),
  // so every gate below and the record itself see one name for "who is
  // calling" — never the credential that resolved it.
  const principal = resolvePrincipal(ctx.principal);

  const record: ExecutionRecord = {
    traceId,
    operationId: op.id,
    effect: op.effect.kind,
    outcome: "error",
    latencyMs: 0,
    retryCount: 0,
    idempotencyKeyPresent: false,
    authProfile: ctx.authProfile,
    principalId: principal.id,
    requestBytes: 0,
    responseBytes: 0,
    policyDecisions,
    confirmationRequired: op.confirmation.required,
    confirmed: confirm,
    ledger: "none",
  };

  const finish = (result: ExecuteResult): ExecuteResult => {
    result.record.latencyMs = now() - start;
    (ctx.observer ?? noopObserver).onRecord(result.record);
    return result;
  };

  const fail = (err: AnvilError): ExecuteResult => {
    record.outcome = "error";
    record.errorCode = err.code;
    return finish({ outcome: "error", envelope: err.toEnvelope(), record });
  };

  const runHook = async (
    hook: PolicyHook | undefined,
    request?: HttpRequest,
    response?: HttpResponse,
  ): Promise<void> => {
    if (!hook) return;
    const pctx: PolicyContext = {
      operation: op,
      input,
      traceId,
      authProfile: ctx.authProfile,
      request,
      response,
      decide: (d) => policyDecisions.push(d),
    };
    await hook(pctx);
  };

  try {
    // 0. Approval gate — the safety contract's first clause: only approved
    // operations execute, on any surface (CLI, MCP, embedders). This refuses
    // before validation, confirmation, and dry-run so an unapproved operation
    // can never even be planned, regardless of which caller reached us.
    if (op.state !== "approved") {
      return fail(unapprovedOperationError(op, traceId));
    }

    // 0b. Transport gate — the approval gate asks whether this operation may be
    // called; this asks whether *this runtime* can make the call faithfully. A
    // source whose wire protocol is not HTTP+JSON reaches here with a coordinate
    // Anvil invented, and building a request from it would put a well-formed lie
    // on the wire. Refuse unless an operator declared a facade that serves it.
    const wireError = wireGateError(op, traceId, ctx.protocolFacade);
    if (wireError) return fail(wireError);
    if (ctx.protocolFacade !== undefined) {
      const decision = wireFacadeDecision(op, ctx.protocolFacade);
      if (decision) policyDecisions.push(decision);
    }

    if (
      !Number.isSafeInteger(op.retries.maxAttempts) ||
      op.retries.maxAttempts < 1 ||
      op.retries.maxAttempts > MAX_RETRY_ATTEMPTS ||
      !Number.isSafeInteger(op.retries.baseDelayMs) ||
      op.retries.baseDelayMs < 0 ||
      op.retries.baseDelayMs > MAX_RETRY_DELAY_MS ||
      !Number.isSafeInteger(op.retries.maxDelayMs) ||
      op.retries.maxDelayMs < 0 ||
      op.retries.maxDelayMs > MAX_RETRY_DELAY_MS
    ) {
      return fail(
        new AnvilError({
          code: "unsupported_operation",
          message:
            `Operation '${op.id}' has a retry contract outside the runtime safety bounds. ` +
            `Recompile it with at most ${MAX_RETRY_ATTEMPTS} attempts and ` +
            `${MAX_RETRY_DELAY_MS} milliseconds of backoff.`,
          operation: op.id,
          traceId,
          retryable: false,
          details: {
            max_attempts: MAX_RETRY_ATTEMPTS,
            max_delay_ms: MAX_RETRY_DELAY_MS,
          },
        }),
      );
    }

    const carrierResolution = resolveIdempotencyCarrier(op);
    if (!carrierResolution.ok) {
      return fail(
        new AnvilError({
          code: "unsupported_operation",
          message:
            `Operation '${op.id}' has an idempotency contract the runtime cannot honor: ` +
            `${carrierResolution.issue}. Recompile with an exact modeled carrier before approval.`,
          operation: op.id,
          traceId,
          retryable: false,
          details: { idempotency_carrier: carrierResolution.issue },
        }),
      );
    }
    const carrier = carrierResolution.binding;

    // 0c. Principal scope gate (fleet runtime) — resolved from the MCP
    // session BEFORE any upstream call, exactly like the approval and wire
    // gates above it. An anonymous/every-scope principal (the default) never
    // trips this; a named principal missing a scope `op.auth.scopes`
    // requires is refused here, before validation, before auth material is
    // resolved, before a single byte reaches the upstream host.
    const missingRequiredScopes = missingScopes(principal, op.auth.scopes);
    if (missingRequiredScopes.length > 0) {
      return fail(
        new AnvilError({
          code: "policy_denied",
          message:
            `Principal '${principal.id}' is missing required scope(s) for '${op.id}': ` +
            `${missingRequiredScopes.join(", ")}.`,
          operation: op.id,
          traceId,
          retryable: false,
          details: {
            code: FLEET_POLICY_CODE.enum["policy/scope_denied"],
            principalId: principal.id,
            missing: missingRequiredScopes,
          },
        }),
      );
    }

    // 0d. Rate/spend limits (fleet runtime) — same "before any upstream call,
    // never retried" placement as the scope gate. Unconfigured by default
    // (`ctx.limits` absent), so this is a no-op for every serving path that
    // does not opt in.
    const limitCheck = checkLimits(ctx.limits, principal, op, now());
    if (!limitCheck.ok) {
      return fail(
        new AnvilError({
          code: limitCheck.code === "policy/rate_limited" ? "rate_limited" : "policy_denied",
          message: limitCheck.message,
          operation: op.id,
          traceId,
          retryable: false,
          safeToRetry: false,
          details: limitCheck.details,
        }),
      );
    }

    await runHook(ctx.policy?.preValidate);

    // 1. Required inputs present (params + projected body fields / whole body).
    const requiredKeys = op.input.params
      .filter(
        (parameter) =>
          parameter.required &&
          !isModeledIdempotencyCarrierInput(carrier, parameter.in, parameter.name),
      )
      .map((parameter) => agentPropKey(parameter));
    if (op.input.body) {
      if (op.input.body.projection === "fields") {
        for (const field of op.input.body.fields) {
          if (field.required && !isModeledIdempotencyCarrierInput(carrier, "body", field.name)) {
            requiredKeys.push(agentPropKey(field));
          }
        }
      } else if (op.input.body.required) {
        requiredKeys.push("body");
      }
    }
    const missing = requiredKeys.filter(
      (k) => input[k] === undefined || input[k] === null || input[k] === "",
    );
    if (missing.length > 0) {
      return fail(
        new AnvilError({
          code: "validation_error",
          message: `Missing required input: ${missing.join(", ")}.`,
          operation: op.id,
          traceId,
          details: { missing },
        }),
      );
    }

    // 2. Confirmation gate — explicit refusal over accidental execution (§2.4).
    if (op.confirmation.required && confirm !== true) {
      const flags = ["--confirm"];
      const explicitKeyRequired =
        op.idempotency.mode === "required" &&
        op.idempotency.keyDerivation !== "request_fingerprint";
      const explicitKeyPresent = [
        args.idempotencyKey,
        carrier ? input[safetyKeys.idempotencyKey] : undefined,
        carrierInputValue(op, input, carrier),
      ].some((value) => typeof value === "string" && value.length > 0);
      if (explicitKeyRequired && !explicitKeyPresent) flags.push("--idempotency-key");
      return fail(
        new AnvilError({
          code: "confirmation_required",
          message: op.confirmation.reason
            ? op.confirmation.reason
            : `This operation is an unsafe ${op.effect.risk} mutation and requires confirmation.`,
          operation: op.id,
          traceId,
          requiredFlags: flags,
        }),
      );
    }

    // 3. Idempotency resolution.
    const containerIssue = bodyCarrierContainerIssue(op, input, carrier);
    if (containerIssue) {
      return fail(
        new AnvilError({
          code: "validation_error",
          message: containerIssue,
          operation: op.id,
          traceId,
        }),
      );
    }
    const modeledCarrierValue = carrierInputValue(op, input, carrier);
    if (modeledCarrierValue !== undefined && typeof modeledCarrierValue !== "string") {
      return fail(
        new AnvilError({
          code: "validation_error",
          message: "The modeled idempotency carrier must contain a string key.",
          operation: op.id,
          traceId,
        }),
      );
    }
    // The collision-aware safety property is synthetic only when AIR resolved
    // a keyed upstream carrier. A source field with the familiar spelling is
    // ordinary business input and remains on the wire and fingerprint.
    const rawKeyValues: unknown[] = [
      args.idempotencyKey,
      ...(carrier ? [input[safetyKeys.idempotencyKey], modeledCarrierValue] : []),
    ];
    if (
      rawKeyValues.some(
        (value) =>
          value !== undefined &&
          (typeof value !== "string" ||
            (value.length > 0 && !idempotencyKeyIsTransportSafe(value))),
      )
    ) {
      return fail(
        new AnvilError({
          code: "validation_error",
          message:
            "An idempotency key must be 1 to 255 bytes of visible ASCII with no spaces or control characters.",
          operation: op.id,
          traceId,
          details: {
            field: safetyKeys.idempotencyKey,
            encoding: "visible_ascii",
            max_bytes: MAX_IDEMPOTENCY_KEY_BYTES,
          },
        }),
      );
    }
    const suppliedKeys = rawKeyValues.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (!carrier && suppliedKeys.length > 0) {
      return fail(
        new AnvilError({
          code: "validation_error",
          message:
            "This operation does not declare an upstream idempotency-key carrier; remove the caller idempotency key instead of implying local-only protection.",
          operation: op.id,
          traceId,
          details: {
            field: safetyKeys.idempotencyKey,
            declared_mode: op.idempotency.mode,
            accepted_modes: ["required", "key_supported"],
          },
        }),
      );
    }
    if (new Set(suppliedKeys).size > 1) {
      return fail(
        new AnvilError({
          code: "validation_error",
          message:
            "Conflicting idempotency keys were supplied through the safety input and modeled request carrier.",
          operation: op.id,
          traceId,
        }),
      );
    }
    const providedIdempotencyKey = suppliedKeys[0];
    const principalScope = ledgerPrincipalScope(ctx.inbound);
    const serviceId = typeof ctx.serviceId === "string" ? ctx.serviceId.trim() : "";
    if (!serviceId) {
      return fail(
        new AnvilError({
          code: "validation_error",
          message:
            "Execution context serviceId is required to isolate idempotency keys between services.",
          operation: op.id,
          traceId,
        }),
      );
    }
    // Ledger ownership follows the on-wire idempotency namespace, not caller
    // identity. With a service-credential upstream, the same raw key can be
    // global even when two verified end users supplied it. They must meet at
    // one row; principal remains in the request fingerprint so the second user
    // conflicts instead of receiving the first user's cached response. This is
    // deliberately conservative for delegated upstreams that scope keys per
    // end user: a false conflict is safer than a duplicate shared-principal
    // write.
    const ledgerScope = {
      serviceId,
      environment: normalizeEnv(ctx.env),
      upstream: canonicalUpstream(ctx.baseUrl),
      authProfile: ctx.authProfile ?? "default",
      credentialProfile: credentialProfileName(ctx.authProfile ?? "default", op.auth),
    };
    const replayScope = {
      ...ledgerScope,
      principal: principalScope ?? null,
    };
    const fingerprintInput = replayFingerprintInput(op, input, carrier);
    const idempotencyFingerprint = requestFingerprint(op.id, fingerprintInput, replayScope);
    const key = carrier
      ? resolveIdempotencyKey({
          provided: providedIdempotencyKey,
          keyDerivation: op.idempotency.keyDerivation,
          operationId: op.id,
          input,
          fingerprint: idempotencyFingerprint,
        })
      : undefined;
    if (key && !idempotencyKeyMatchesOperation(op, key)) {
      return fail(
        new AnvilError({
          code: "validation_error",
          message: "The idempotency key does not satisfy the modeled upstream carrier constraints.",
          operation: op.id,
          traceId,
          details: { field: safetyKeys.idempotencyKey },
        }),
      );
    }
    const ledgerKey = key
      ? requestFingerprint("anvil.idempotency.ledger-key", key, ledgerScope)
      : undefined;
    if (key && ctx.inbound && !principalScope) {
      return fail(
        new AnvilError({
          code: "auth_required",
          message:
            "Replay protection requires a stable verified caller principal; the inbound identity has no issuer/subject, object id, or authorized party.",
          operation: op.id,
          traceId,
        }),
      );
    }
    if (op.idempotency.mode === "required" && !key) {
      return fail(
        new AnvilError({
          code: "idempotency_required",
          message: "This operation requires an idempotency key and none was supplied or derivable.",
          operation: op.id,
          traceId,
          requiredFlags: ["--idempotency-key"],
        }),
      );
    }
    record.idempotencyKeyPresent = Boolean(key);

    // 4. Build the request (used by dry-run and execution).
    if (
      ctx.timeoutMs !== undefined &&
      (!Number.isSafeInteger(ctx.timeoutMs) ||
        ctx.timeoutMs < MIN_UPSTREAM_TIMEOUT_MS ||
        ctx.timeoutMs > MAX_UPSTREAM_TIMEOUT_MS)
    ) {
      return fail(
        new AnvilError({
          code: "validation_error",
          message:
            `Upstream timeout must be an integer from ${MIN_UPSTREAM_TIMEOUT_MS} ` +
            `to ${MAX_UPSTREAM_TIMEOUT_MS} milliseconds.`,
          operation: op.id,
          traceId,
          details: {
            field: "timeout_ms",
            min: MIN_UPSTREAM_TIMEOUT_MS,
            max: MAX_UPSTREAM_TIMEOUT_MS,
          },
        }),
      );
    }
    // Resolved once and shared by request construction and response decoding:
    // a call must be read back by the same protocol it was written in.
    const codec = codecFor(op, ctx.protocolFacade !== undefined);
    if (!codec) {
      return fail(
        new AnvilError({
          code: "unsupported_operation",
          message:
            `Operation '${op.id}' has no wire codec registered in this runtime. ` +
            `The transport gate should have refused it earlier; this is a build defect.`,
          operation: op.id,
          traceId,
          retryable: false,
        }),
      );
    }
    const baseRequest = buildRequest(
      op,
      input,
      ctx.baseUrl,
      carrier,
      key,
      ctx.protocolFacade !== undefined,
    );
    if (ctx.timeoutMs) baseRequest.timeoutMs = ctx.timeoutMs;

    // 5. Dry-run short-circuits before any auth or side effect.
    if (args.dryRun) {
      record.outcome = "dry_run";
      const retrySafe = retryIsSafe({
        policyMode: op.retries.mode,
        effectKind: op.effect.kind,
        idempotencyMode: op.idempotency.mode,
        hasIdempotencyKey: Boolean(key),
      });
      const dryRunRetriesEnabled = retrySafe && ctx.retries !== false;
      return finish({
        outcome: "dry_run",
        plan: {
          operation: op.id,
          method: baseRequest.method,
          url: baseRequest.url,
          headers: redactHeaders(baseRequest.headers),
          body: baseRequest.body ? JSON.parse(baseRequest.body) : undefined,
          idempotencyKeyPresent: Boolean(key),
          retryPlan: {
            enabled: dryRunRetriesEnabled,
            maxAttempts: dryRunRetriesEnabled ? op.retries.maxAttempts : 1,
          },
          confirmationRequired: op.confirmation.required,
        },
        record,
      });
    }

    // 6. Allowed-host enforcement (fail closed). `env` is normalized so an
    // unset/unknown env is treated as prod (deny non-allowlisted hosts), never dev.
    const env = normalizeEnv(ctx.env);
    if (!hostIsAllowed(baseRequest.url, ctx.allowedHosts ?? [], env)) {
      return fail(
        new AnvilError({
          code: "policy_denied",
          message: `Upstream host is not in the allowed hosts list for env '${env}'.`,
          operation: op.id,
          traceId,
        }),
      );
    }

    // 7. Auth binding.
    let request = baseRequest;
    await runHook(ctx.policy?.preAuth, request);
    if (op.auth.type !== "none") {
      const profile = credentialProfileName(ctx.authProfile ?? "default", op.auth);
      const material = ctx.credentials
        ? await ctx.credentials.resolve(profile, op.auth, { inbound: ctx.inbound })
        : null;
      if (!material) {
        // Name the credential LOCATIONS the resolver would read (env var names,
        // secret ids) so the caller knows the next action. Names only — values
        // are never echoed (spec §13, §18).
        const expected = ctx.credentials?.expectedCredentials?.(profile, op.auth) ?? [];
        return fail(
          new AnvilError({
            code: "auth_required",
            message:
              `Auth profile '${profile}' could not be resolved for scopes [${op.auth.scopes.join(", ")}].` +
              (expected.length > 0 ? ` Set ${expected.join(" and ")} and retry.` : ""),
            operation: op.id,
            traceId,
            details: expected.length > 0 ? { expected_env: expected } : undefined,
          }),
        );
      }
      if (key && authMaterialOverwritesIdempotencyCarrier(material, carrier)) {
        return fail(
          new AnvilError({
            code: "unsupported_operation",
            message:
              "The resolved credential carrier conflicts with this operation's idempotency carrier. " +
              "Configure distinct header or query coordinates before retrying.",
            operation: op.id,
            traceId,
            retryable: false,
            details: {
              idempotency_carrier: carrier?.mechanism,
              credential_carrier_conflict: true,
            },
          }),
        );
      }
      request = applyAuth(request, material);
    }

    record.upstreamEndpoint = `${request.method} ${new URL(request.url).pathname}`;
    record.requestBytes = request.body ? byteLen(request.body) : 0;

    await runHook(ctx.policy?.preExecute, request);

    // 7a. Fail closed on required idempotency without a *durable* ledger outside
    // `dev`. Cloud Run scales horizontally; an in-memory (or absent) ledger
    // gives no cross-instance replay protection, so executing an unsafe mutation
    // here would be a safety lie. dev keeps the in-memory ledger. Placed after
    // dry-run/host-pin/auth so a preview still works and security errors win.
    if (
      op.effect.kind === "mutation" &&
      op.idempotency.mode === "required" &&
      env !== "dev" &&
      !ctx.ledger?.durable
    ) {
      return fail(
        new AnvilError({
          code: "idempotency_ledger_unavailable",
          message:
            `This operation requires idempotency, but no durable ledger is configured in env "${env}". ` +
            "A process-local ledger cannot protect against duplicate execution across instances. " +
            "Configure ANVIL_LEDGER (firestore://PROJECT/DATABASE/SERVICE_NAMESPACE) before invoking unsafe mutations.",
          operation: op.id,
          traceId,
        }),
      );
    }

    // 8. Idempotency ledger for unsafe idempotent mutations.
    let reservationOwned = false;
    let ledgerReference: string | undefined;
    if (op.effect.kind === "mutation" && ledgerKey && ctx.ledger) {
      let reservation: Awaited<ReturnType<IdempotencyLedger["reserve"]>>;
      try {
        reservation = await ctx.ledger.reserve(ledgerKey, idempotencyFingerprint, {
          operationId: op.id,
          traceId,
        });
      } catch {
        return fail(ledgerUnavailableError(op.id, traceId, "reserve", false));
      }
      ledgerReference = safeLedgerReference(reservation.reference);
      if (reservation.outcome === "conflict") {
        record.ledger = "conflict";
        return fail(
          new AnvilError({
            code: "conflict",
            message: "This idempotency key was already used for a different request.",
            operation: op.id,
            traceId,
          }),
        );
      }
      if (reservation.outcome === "replay") {
        const status = reservation.status ?? 200;
        if (!Number.isSafeInteger(status) || status < 200 || status >= 300) {
          return fail(ledgerUnavailableError(op.id, traceId, "replay", false));
        }
        record.outcome = "success";
        record.ledger = "replay";
        return finish({
          outcome: "success",
          status,
          // Ledger values are the exact agent-facing result completed below.
          // Re-projecting a replay would apply wire-path includes a second time.
          data: reservation.result,
          record,
        });
      }
      if (reservation.outcome === "in_progress") {
        record.ledger = "in_progress";
        return fail(
          new AnvilError({
            code: "conflict",
            message: "A request with this idempotency key is already in progress.",
            operation: op.id,
            traceId,
            details: ledgerReference ? { ledger_reference: ledgerReference } : undefined,
          }),
        );
      }
      record.ledger = "reserved";
      reservationOwned = true;
    }

    // 9. Retry-bounded execution.
    const retrySafe = retryIsSafe({
      policyMode: op.retries.mode,
      effectKind: op.effect.kind,
      idempotencyMode: op.idempotency.mode,
      hasIdempotencyKey: Boolean(key),
    });
    const retriesEnabled = retrySafe && ctx.retries !== false;
    const maxAttempts = retriesEnabled ? op.retries.maxAttempts : 1;

    let attempt = 0;
    let finalError: AnvilError | null = null;
    let sawPostResponseFailure = false;
    // Tracks the most recent HttpResponse actually received from the
    // transport (success or non-2xx), so postError/postExecute can surface it
    // to policy hooks when one exists. A thrown TransportError never produces
    // one, so this deliberately stays whatever it last was (often undefined).
    let lastResponse: HttpResponse | undefined;
    while (attempt < maxAttempts) {
      attempt += 1;
      record.retryCount = attempt - 1;
      try {
        const res = await ctx.transport.send(request);
        lastResponse = res;
        record.responseBytes = byteLen(res.body);
        const fault = isFaultAware(codec) ? codec.faultIn(op, res) : undefined;
        if (fault) {
          // A protocol can deliver a failure inside a successful HTTP
          // response — a SOAP Fault is the canonical case. The envelope
          // arrived, so the transport is satisfied, and the operation still
          // did not happen. Handled on exactly the same terms as a non-2xx
          // below rather than as a special case: the retry decision, the
          // ledger reservation, and the terminal envelope all have one
          // meaning, and a second copy of them would be a second chance to
          // get the safety rules subtly different.
          const faultRetryable =
            fault.retryable &&
            retriesEnabled &&
            attempt < maxAttempts &&
            conditionIsRetryable("soap_transport_fault", op.retries);
          if (faultRetryable) {
            await sleep(computeBackoffMs(attempt, op.retries, ctx.rng));
            continue;
          }
          finalError = new AnvilError({
            code: "unknown_upstream_error",
            message: `${op.id} failed upstream: ${fault.message}`,
            operation: op.id,
            traceId,
            retryable: fault.retryable,
            safeToRetry: retrySafe,
            details: { upstream_fault: fault.code },
          });
          break;
        }
        if (res.status >= 200 && res.status < 300) {
          const decoded = codec.decode(op, res);
          // A protocol can deliver a failure inside a successful HTTP response.
          // A SOAP Fault is the canonical case: the envelope arrived intact, so
          // the transport is satisfied, and the operation still did not happen.
          // Refusing it here — before the ledger records a completion — is what
          // stops a fault being replayed forever as a successful mutation.
          const data = applyAgentProjection(decoded, op.output.agentProjection);
          if (reservationOwned && ledgerKey && ctx.ledger) {
            try {
              await ctx.ledger.complete(ledgerKey, data, res.status);
            } catch {
              // The upstream acknowledged the write. Never release this
              // reservation when persistence of the replay result is unknown:
              // doing so could turn a ledger outage into a duplicate mutation.
              // The reservation is now ambiguous/unconfirmed rather than
              // merely reserved, matching the sawPostResponseFailure branch
              // below.
              record.ledger = "in_progress";
              await runHook(ctx.policy?.postResponse, request, res);
              await runHook(ctx.policy?.postExecute, request, res);
              return fail(
                ledgerUnavailableError(op.id, traceId, "complete", true, ledgerReference),
              );
            }
          }
          record.outcome = "success";
          await runHook(ctx.policy?.postResponse, request, res);
          await runHook(ctx.policy?.postExecute, request, res);
          return finish({ outcome: "success", status: res.status, data, record });
        }

        const condition = httpStatusToRetryCondition(res.status);
        // The upstream's stated backpressure (RFC 9110 §10.2.3), read once per
        // response and off the retry decision entirely: it is diagnostics the
        // terminal envelope carries even when nothing here retries, so a caller
        // that is not allowed to auto-retry still learns when to come back.
        const retryAfterMs = retryAfterFromHeaders(res.headers, now());
        const canRetry =
          condition !== null &&
          retriesEnabled &&
          attempt < maxAttempts &&
          conditionIsRetryable(condition, op.retries);
        // `retryAfterMs` is consulted strictly INSIDE this branch. A header can
        // only ever lengthen a wait or end a retry loop that `retryIsSafe`
        // already opened; it can never make a non-idempotent mutation eligible
        // (spec §2.4, §11).
        let stoppedByRetryAfter = false;
        if (canRetry) {
          const decision = resolveRetryDelay(attempt, op.retries, retryAfterMs, ctx.rng);
          if (decision.action === "wait") {
            await sleep(decision.delayMs);
            continue;
          }
          // The server asked for longer than the runtime is willing to hold a
          // call open. Spend no further attempts: retrying at the ceiling would
          // arrive earlier than it asked. Fall through to the terminal envelope
          // with the wait attached as the caller's next action.
          stoppedByRetryAfter = true;
        }
        finalError = httpResponseError({
          operation: op,
          response: res,
          traceId,
          retrySafe,
          retryAfterMs,
          stoppedByRetryAfter,
        });
        break;
      } catch (err) {
        if (!(err instanceof TransportError)) throw err;
        if (err.phase === "after_response") sawPostResponseFailure = true;
        const canRetry =
          retriesEnabled &&
          attempt < maxAttempts &&
          conditionIsRetryable(err.condition, op.retries);
        if (canRetry) {
          await sleep(computeBackoffMs(attempt, op.retries, ctx.rng));
          continue;
        }
        const code = err.condition === "timeout" ? "upstream_timeout" : "upstream_unavailable";
        finalError = new AnvilError({
          code,
          message: retrySafe
            ? `Upstream transport failed for ${op.id}.`
            : `Upstream transport failed for ${op.id} and this operation is not safe to auto-retry.`,
          operation: op.id,
          traceId,
          retryable: true,
          safeToRetry: retrySafe,
        });
        break;
      }
    }

    if (reservationOwned && sawPostResponseFailure) {
      // Once an upstream began a response, the write may have committed even
      // though the body was truncated, reset, or rejected as oversized. A
      // later pre-response failure does not erase that ambiguity. Retain the
      // reservation and require reconciliation; releasing it could permit a
      // duplicate mutation.
      record.ledger = "in_progress";
      await runHook(ctx.policy?.postError, request, lastResponse);
      await runHook(ctx.policy?.postExecute, request, lastResponse);
      return fail(
        new AnvilError({
          code: finalError?.code ?? "upstream_unavailable",
          message:
            "The upstream began a response, but it could not be safely consumed. " +
            "The write may have completed and the idempotency reservation was retained; " +
            "inspect the upstream and ledger before retrying.",
          operation: op.id,
          traceId,
          retryable: true,
          safeToRetry: false,
          upstream: finalError?.upstream,
          details: {
            upstream_outcome: "possibly_committed",
            operator_action_required: true,
            ...(ledgerReference ? { ledger_reference: ledgerReference } : {}),
          },
        }),
      );
    }

    // Only keyed upstream modes can own a reservation. Their exact modeled
    // carrier receives the same key again, so releasing after a terminal
    // upstream failure permits an honest later retry without inventing
    // local-only protection for non-idempotent writes.
    if (reservationOwned && ledgerKey && ctx.ledger) {
      try {
        await ctx.ledger.release(ledgerKey);
        reservationOwned = false;
      } catch {
        return fail(ledgerUnavailableError(op.id, traceId, "release", true, ledgerReference));
      }
    }
    await runHook(ctx.policy?.postError, request, lastResponse);
    await runHook(ctx.policy?.postExecute, request, lastResponse);
    return fail(finalError ?? unknownError(op.id, traceId));
  } catch (err) {
    if (err instanceof AnvilError) return fail(err);
    return fail(unknownError(op.id, traceId, err));
  }
}

function unknownError(operation: string, traceId: string, cause?: unknown): AnvilError {
  return new AnvilError({
    code: "unknown_upstream_error",
    message: cause instanceof Error ? cause.message : "An unexpected error occurred.",
    operation,
    traceId,
  });
}
