import { randomUUID } from "node:crypto";
import {
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
import {
  applyAuth,
  type AuthMaterial,
  type CredentialResolver,
  credentialProfileName,
} from "./auth.js";
import {
  hostIsAllowed,
  MAX_UPSTREAM_TIMEOUT_MS,
  MIN_UPSTREAM_TIMEOUT_MS,
  normalizeEnv,
} from "./config.js";
import {
  AnvilError,
  type ErrorEnvelope,
  httpStatusToErrorCode,
  isRetryableCode,
} from "./errors.js";
import {
  type IdempotencyLedger,
  idempotencyKeyIsTransportSafe,
  MAX_IDEMPOTENCY_KEY_BYTES,
  requestFingerprint,
  resolveIdempotencyKey,
} from "./idempotency.js";
import type { InboundIdentity } from "./inbound-identity.js";
import { type ExecutionRecord, noopObserver, type Observer } from "./observability.js";
import type { PolicyContext, PolicyHook, PolicyHooks } from "./policy.js";
import {
  computeBackoffMs,
  conditionIsRetryable,
  httpStatusToRetryCondition,
  retryIsSafe,
} from "./retry.js";
import { type HttpRequest, type Transport, TransportError } from "./transport.js";

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
        propKey(parameter.name) === key,
    ) ||
    (op.input.body?.projection === "fields" &&
      op.input.body.fields.some(
        (field) =>
          !isModeledIdempotencyCarrierInput(binding, "body", field.name) &&
          propKey(field.name) === key,
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
): HttpRequest {
  let path = op.sourceRef.path ?? "/";
  const query = new URLSearchParams();
  const headers: Record<string, string> = { accept: "application/json" };
  const body: Record<string, unknown> = {};
  let hasBody = false;

  for (const p of op.input.params) {
    const value =
      idempotencyKey && isModeledIdempotencyCarrierInput(binding, p.in, p.name)
        ? idempotencyKey
        : input[propKey(p.name)];
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
            : input[propKey(f.name)];
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

  const method = (op.sourceRef.method ?? "get").toUpperCase();
  const base = baseUrl.replace(/\/$/, "");
  const qs = query.toString();
  const url = `${base}${path}${qs ? `?${qs}` : ""}`;
  const req: HttpRequest = { method, url, headers };
  if (hasBody) {
    req.headers["content-type"] = op.input.body?.contentType ?? "application/json";
    req.body = JSON.stringify(bodyValue);
  }
  return req;
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

  const record: ExecutionRecord = {
    traceId,
    operationId: op.id,
    effect: op.effect.kind,
    outcome: "error",
    latencyMs: 0,
    retryCount: 0,
    idempotencyKeyPresent: false,
    authProfile: ctx.authProfile,
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

  const runHook = async (hook: PolicyHook | undefined, request?: HttpRequest): Promise<void> => {
    if (!hook) return;
    const pctx: PolicyContext = {
      operation: op,
      input,
      traceId,
      authProfile: ctx.authProfile,
      request,
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

    await runHook(ctx.policy?.preValidate);

    // 1. Required inputs present (params + projected body fields / whole body).
    const requiredKeys = op.input.params
      .filter(
        (parameter) =>
          parameter.required &&
          !isModeledIdempotencyCarrierInput(carrier, parameter.in, parameter.name),
      )
      .map((parameter) => propKey(parameter.name));
    if (op.input.body) {
      if (op.input.body.projection === "fields") {
        for (const field of op.input.body.fields) {
          if (field.required && !isModeledIdempotencyCarrierInput(carrier, "body", field.name)) {
            requiredKeys.push(propKey(field.name));
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
    const baseRequest = buildRequest(op, input, ctx.baseUrl, carrier, key);
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
            enabled: retrySafe && ctx.retries !== false,
            maxAttempts: retrySafe ? op.retries.maxAttempts : 1,
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
        return finish({ outcome: "success", status, data: reservation.result, record });
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
    while (attempt < maxAttempts) {
      attempt += 1;
      record.retryCount = attempt - 1;
      try {
        const res = await ctx.transport.send(request);
        record.responseBytes = byteLen(res.body);
        if (res.status >= 200 && res.status < 300) {
          const data = res.body ? safeJson(res.body) : null;
          if (reservationOwned && ledgerKey && ctx.ledger) {
            try {
              await ctx.ledger.complete(ledgerKey, data, res.status);
            } catch {
              // The upstream acknowledged the write. Never release this
              // reservation when persistence of the replay result is unknown:
              // doing so could turn a ledger outage into a duplicate mutation.
              return fail(
                ledgerUnavailableError(op.id, traceId, "complete", true, ledgerReference),
              );
            }
          }
          record.outcome = "success";
          await runHook(ctx.policy?.postResponse, request);
          await runHook(ctx.policy?.postExecute, request);
          return finish({ outcome: "success", status: res.status, data, record });
        }

        const condition = httpStatusToRetryCondition(res.status);
        const canRetry =
          condition !== null &&
          retriesEnabled &&
          attempt < maxAttempts &&
          conditionIsRetryable(condition, op.retries);
        if (canRetry) {
          await sleep(computeBackoffMs(attempt, op.retries, ctx.rng));
          continue;
        }
        const code = httpStatusToErrorCode(res.status);
        finalError = new AnvilError({
          code,
          message: `Upstream returned ${res.status} for ${op.id}.`,
          operation: op.id,
          traceId,
          upstream: { status: res.status, requestId: res.headers["x-request-id"] },
          retryable: isRetryableCode(code),
          safeToRetry: retrySafe && isRetryableCode(code),
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
            ? `Upstream transport failed for ${op.id}: ${err.message}`
            : `Upstream transport failed for ${op.id} and this operation is not safe to auto-retry: ${err.message}`,
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
      await runHook(ctx.policy?.postError, request);
      await runHook(ctx.policy?.postExecute, request);
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
    await runHook(ctx.policy?.postError, request);
    await runHook(ctx.policy?.postExecute, request);
    return fail(finalError ?? unknownError(op.id, traceId));
  } catch (err) {
    if (err instanceof AnvilError) return fail(err);
    return fail(unknownError(op.id, traceId, err));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
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
