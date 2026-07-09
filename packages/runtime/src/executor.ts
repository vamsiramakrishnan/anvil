import { randomUUID } from "node:crypto";
import { type Operation, propKey } from "@anvil/air";
import { applyAuth, type CredentialResolver } from "./auth.js";
import { hostIsAllowed, normalizeEnv } from "./config.js";
import {
  AnvilError,
  type ErrorEnvelope,
  httpStatusToErrorCode,
  isRetryableCode,
} from "./errors.js";
import {
  type IdempotencyLedger,
  requestFingerprint,
  resolveIdempotencyKey,
} from "./idempotency.js";
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
  baseUrl: string;
  credentials?: CredentialResolver;
  authProfile?: string;
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

/** Build the upstream HTTP request from AIR + snake_cased input. */
function buildRequest(op: Operation, input: Record<string, unknown>, baseUrl: string): HttpRequest {
  let path = op.sourceRef.path ?? "/";
  const query = new URLSearchParams();
  const headers: Record<string, string> = { accept: "application/json" };
  const body: Record<string, unknown> = {};
  let hasBody = false;

  for (const p of op.input.params) {
    const value = input[propKey(p.name)];
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
        const value = input[propKey(f.name)];
        if (value === undefined || value === null) continue;
        body[f.name] = value;
        hasBody = true;
      }
      if (hasBody) bodyValue = body;
    } else if (input.body !== undefined && input.body !== null) {
      bodyValue = input.body;
      hasBody = true;
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
  const confirm = args.confirm ?? input.confirm === true;
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
    await runHook(ctx.policy?.preValidate);

    // 1. Required inputs present (params + projected body fields / whole body).
    const requiredKeys = op.input.params.filter((p) => p.required).map((p) => propKey(p.name));
    if (op.input.body) {
      if (op.input.body.projection === "fields") {
        for (const f of op.input.body.fields) if (f.required) requiredKeys.push(propKey(f.name));
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
      if (op.idempotency.mode === "required") flags.push("--idempotency-key");
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
    const key = resolveIdempotencyKey({
      provided:
        args.idempotencyKey ??
        (typeof input.idempotency_key === "string" ? input.idempotency_key : undefined),
      keyDerivation: op.idempotency.keyDerivation,
      operationId: op.id,
      input,
    });
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
    const baseRequest = buildRequest(op, input, ctx.baseUrl);
    if (op.idempotency.mechanism === "header" && key && op.idempotency.key) {
      baseRequest.headers[op.idempotency.key] = key;
    }
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
      const material = ctx.credentials
        ? await ctx.credentials.resolve(ctx.authProfile ?? "default", op.auth)
        : null;
      if (!material) {
        return fail(
          new AnvilError({
            code: "auth_required",
            message: `Auth profile '${ctx.authProfile ?? "default"}' could not be resolved for scopes [${op.auth.scopes.join(", ")}].`,
            operation: op.id,
            traceId,
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
            "Configure ANVIL_LEDGER (e.g. firestore://…) before invoking unsafe mutations.",
          operation: op.id,
          traceId,
        }),
      );
    }

    // 8. Idempotency ledger for unsafe idempotent mutations.
    if (op.effect.kind === "mutation" && key && ctx.ledger) {
      const fp = requestFingerprint(op.id, input);
      const reservation = await ctx.ledger.reserve(key, fp);
      if (reservation.outcome === "replay") {
        record.outcome = "success";
        record.ledger = "replay";
        return finish({ outcome: "success", status: 200, data: reservation.result, record });
      }
      if (reservation.outcome === "in_progress") {
        record.ledger = "in_progress";
        return fail(
          new AnvilError({
            code: "conflict",
            message: "A request with this idempotency key is already in progress.",
            operation: op.id,
            traceId,
          }),
        );
      }
      record.ledger = "reserved";
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
    while (attempt < maxAttempts) {
      attempt += 1;
      record.retryCount = attempt - 1;
      try {
        const res = await ctx.transport.send(request);
        record.responseBytes = byteLen(res.body);
        if (res.status >= 200 && res.status < 300) {
          const data = res.body ? safeJson(res.body) : null;
          if (key && ctx.ledger && op.effect.kind === "mutation")
            await ctx.ledger.complete(key, data);
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

    // Execution failed — release the ledger reservation so a later retry can proceed.
    if (key && ctx.ledger && op.effect.kind === "mutation") await ctx.ledger.release(key);
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
