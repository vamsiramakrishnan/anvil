import type { RetryCondition, RetryPolicy } from "@anvil/air";

/** Map an HTTP status to a normalized retry condition, if it is transient. */
export function httpStatusToRetryCondition(status: number): RetryCondition | null {
  switch (status) {
    case 408:
      return "http_408";
    case 429:
      return "http_429";
    case 500:
      return "http_500";
    case 502:
      return "http_502";
    case 503:
      return "http_503";
    case 504:
      return "http_504";
    default:
      return null;
  }
}

/**
 * Bounded exponential backoff with full jitter (spec §11). `attempt` is 1-based:
 * the delay applies *before* the (attempt+1)th try. `rng` is injectable so the
 * schedule is deterministic under test.
 */
export function computeBackoffMs(
  attempt: number,
  policy: Pick<RetryPolicy, "backoff" | "baseDelayMs" | "maxDelayMs">,
  rng: () => number = Math.random,
): number {
  const { backoff, baseDelayMs, maxDelayMs } = policy;
  if (backoff === "none") return 0;
  if (backoff === "fixed") return Math.min(baseDelayMs, maxDelayMs);
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  if (backoff === "exponential") return exp;
  // exponential_jitter: full jitter in [0, exp]
  return Math.floor(rng() * exp);
}

/** Is this transient condition eligible for retry under the policy? */
export function conditionIsRetryable(
  condition: RetryCondition,
  policy: Pick<RetryPolicy, "mode" | "retryOn">,
): boolean {
  return policy.mode === "safe" && policy.retryOn.includes(condition);
}

/**
 * Whether automatic retry is *safe* for this operation given its idempotency.
 * This is the guard behind the whole trust wedge: a mutation that is not
 * provably idempotent is never retried, no matter the policy (spec §2.4, §11).
 */
export function retryIsSafe(params: {
  policyMode: RetryPolicy["mode"];
  effectKind: "read" | "mutation";
  idempotencyMode: "natural" | "key_supported" | "client_id" | "required" | "none";
  hasIdempotencyKey: boolean;
}): boolean {
  if (params.policyMode !== "safe") return false;
  if (params.effectKind === "read") return true;
  switch (params.idempotencyMode) {
    case "natural":
    case "client_id":
      return true;
    case "required":
    case "key_supported":
      return params.hasIdempotencyKey;
    case "none":
      return false;
  }
}
