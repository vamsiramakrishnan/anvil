import {
  type Confirmation,
  type Effect,
  type EffectKind,
  type HttpMethod,
  type Idempotency,
  type RetryCondition,
  type RetryPolicy,
  type RiskLevel,
  snakeCase,
} from "@anvil/air";

/**
 * The effect/idempotency classifier — the semantics the source spec almost
 * never states but an agent must know before acting. Every inference here is
 * conservative: unknown side effect beats assumed safety (spec §2.4).
 */

/** Transient conditions retried by default for retry-safe operations (spec §11). */
export const TRANSIENT_CONDITIONS: RetryCondition[] = [
  "timeout",
  "connection_reset",
  "dns_failure",
  "http_408",
  "http_429",
  "http_500",
  "http_502",
  "http_503",
  "http_504",
];

const READ_METHODS: HttpMethod[] = ["get", "head", "options", "trace"];

export function classifyEffectKind(method: HttpMethod): EffectKind {
  return READ_METHODS.includes(method) ? "read" : "mutation";
}

// Matched against the snake_cased signal so camelCase operationIds ("createRefund")
// and plurals ("refunds") both hit.
const FINANCIAL = /(refund|charge|payment|payout|transfer|invoice|capture|debit|credit)/;
const DESTRUCTIVE = /(delete|remove|destroy|purge|revoke|terminate|cancel|drop)/;
const COMMS = /(send|email|notify|message|dispatch|publish|sms)/;

/** Infer blast radius from method + operation naming/path. */
export function classifyRisk(method: HttpMethod, effect: EffectKind, signal: string): RiskLevel {
  if (effect === "read") return "none";
  const s = snakeCase(signal);
  if (method === "delete" || DESTRUCTIVE.test(s)) return "destructive";
  if (FINANCIAL.test(s)) return "financial";
  if (COMMS.test(s)) return "high";
  return "medium";
}

/**
 * Infer idempotency from HTTP method semantics (spec §12):
 *   GET/HEAD, PUT, DELETE — naturally idempotent
 *   PATCH, POST           — not idempotent by default (conservative)
 */
export function classifyIdempotency(method: HttpMethod): Idempotency {
  switch (method) {
    case "get":
    case "head":
    case "options":
    case "trace":
    case "put":
    case "delete":
      return { mode: "natural", mechanism: "none", keyDerivation: "none" };
    default:
      // POST / PATCH: unknown — require a key we can derive so retries stay safe
      // only when the caller opts in, but default the mode to `none`.
      return { mode: "none", mechanism: "none", keyDerivation: "none" };
  }
}

export function classifyEffect(
  method: HttpMethod,
  signal: string,
): { effect: Effect; idempotency: Idempotency } {
  const kind = classifyEffectKind(method);
  const risk = classifyRisk(method, kind, signal);
  const reversible = !(risk === "financial" || risk === "destructive");
  const idempotency = classifyIdempotency(method);
  return { effect: { kind, resource: undefined, risk, reversible }, idempotency };
}

/** Derive a retry policy consistent with the operation's idempotency (spec §11). */
export function classifyRetry(effect: Effect, idempotency: Idempotency): RetryPolicy {
  const proven =
    effect.kind === "read" ||
    idempotency.mode === "natural" ||
    idempotency.mode === "client_id" ||
    idempotency.mode === "required" ||
    idempotency.mode === "key_supported";
  if (!proven) {
    return {
      mode: "none",
      maxAttempts: 1,
      backoff: "none",
      baseDelayMs: 200,
      maxDelayMs: 20_000,
      retryOn: [],
    };
  }
  return {
    mode: "safe",
    maxAttempts: 3,
    backoff: "exponential_jitter",
    baseDelayMs: 200,
    maxDelayMs: 20_000,
    retryOn: [...TRANSIENT_CONDITIONS],
  };
}

/** Require confirmation for irreversible, high-risk, or non-idempotent mutations. */
export function classifyConfirmation(effect: Effect, idempotency: Idempotency): Confirmation {
  if (effect.kind !== "mutation") return { required: false };
  const risky =
    effect.risk === "financial" ||
    effect.risk === "destructive" ||
    effect.risk === "high" ||
    effect.reversible === false ||
    idempotency.mode === "none";
  if (!risky) return { required: false };
  const reason = !effect.reversible
    ? `This operation is an irreversible ${effect.risk} mutation.`
    : `This operation is an unsafe ${effect.risk} mutation.`;
  return { required: true, risk: effect.risk, reason };
}
