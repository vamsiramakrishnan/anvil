import {
  type AuthPrincipal,
  type AuthType,
  type Confirmation,
  type Effect,
  type EffectKind,
  type HttpMethod,
  type Idempotency,
  type OperationAction,
  type RetryBasis,
  type RetryCondition,
  type RetryPolicy,
  type RiskLevel,
  type SecretSource,
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

const SEARCH = /(search|query|find|lookup|filter)/;
const EXPORT = /(export|download|report|dump)/;
const POLL = /(status|poll|wait|progress|health)/;
const APPROVE = /(approve|authorize|accept|confirm|grant)/;
const RESERVE = /(reserve|hold|lock|allocate)/;
const SIMULATE = /(simulate|preview|dry_run|estimate|quote)/;
const VALIDATE = /(validate|verify|check)/;
const EXECUTE = /(execute|run|trigger|invoke|start|launch)/;

/**
 * The descriptive action verb (spec §10 richer vocabulary). It refines
 * discovery/naming/metadata but NEVER the safety core — `kind` still decides
 * retry/confirmation. Read methods map to read-family verbs; write methods map
 * to mutation-family verbs, with naming/path keywords sharpening the choice.
 */
export function classifyAction(
  method: HttpMethod,
  kind: EffectKind,
  endsWithParam: boolean,
  signal: string,
): OperationAction {
  const s = snakeCase(signal);
  if (kind === "read") {
    if (EXPORT.test(s)) return "export";
    if (SEARCH.test(s)) return "search";
    if (POLL.test(s)) return "poll";
    return endsWithParam ? "get" : "list";
  }
  // Mutation family — keyword intent first, then HTTP method.
  if (SIMULATE.test(s)) return "simulate";
  if (VALIDATE.test(s)) return "validate";
  if (APPROVE.test(s)) return "approve";
  if (DESTRUCTIVE.test(s) && /(cancel|revoke|terminate)/.test(s)) return "cancel";
  if (COMMS.test(s)) return "send";
  if (RESERVE.test(s)) return "reserve";
  if (EXECUTE.test(s)) return "execute";
  switch (method) {
    case "post":
      return "create";
    case "put":
      return "replace";
    case "patch":
      return "update";
    case "delete":
      return "delete";
    default:
      return "other";
  }
}

/**
 * Infer *whose authority* a call runs under and where the credential is sourced
 * (spec §11). The decisive question for agent tools; refined by enrichment.
 */
export function classifyAuth(type: AuthType): {
  principal: AuthPrincipal;
  secretSource: SecretSource;
} {
  switch (type) {
    case "none":
      return { principal: "anonymous", secretSource: "none" };
    case "workload_identity":
      return { principal: "service", secretSource: "workload_identity" };
    case "oauth2_on_behalf_of":
      return { principal: "delegated", secretSource: "env" };
    case "oauth2_authorization_code":
      return { principal: "end_user", secretSource: "env" };
    default:
      return { principal: "service", secretSource: "env" };
  }
}

export function classifyEffect(
  method: HttpMethod,
  signal: string,
  endsWithParam = false,
): { effect: Effect; idempotency: Idempotency } {
  const kind = classifyEffectKind(method);
  const risk = classifyRisk(method, kind, signal);
  const reversible = !(risk === "financial" || risk === "destructive");
  const idempotency = classifyIdempotency(method);
  const action = classifyAction(method, kind, endsWithParam, signal);
  return { effect: { kind, action, resource: undefined, risk, reversible }, idempotency };
}

/** The descriptive basis behind a retry-safe posture, given how safety was proven. */
function retryBasisFor(effect: Effect, idempotency: Idempotency): RetryBasis {
  if (effect.kind === "read") return "read_safe";
  if (idempotency.mode === "natural") return "natural_idempotent";
  if (idempotency.mode === "required" || idempotency.mode === "key_supported") {
    return "idempotency_key";
  }
  if (idempotency.mode === "client_id") return "natural_idempotent";
  return "unproven";
}

/** Derive a retry policy consistent with the operation's idempotency (spec §11). */
export function classifyRetry(effect: Effect, idempotency: Idempotency): RetryPolicy {
  const basis = retryBasisFor(effect, idempotency);
  const proven = basis !== "unproven";
  if (!proven) {
    return {
      mode: "none",
      basis: "unproven",
      maxAttempts: 1,
      backoff: "none",
      baseDelayMs: 200,
      maxDelayMs: 20_000,
      retryOn: [],
    };
  }
  return {
    mode: "safe",
    basis,
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
