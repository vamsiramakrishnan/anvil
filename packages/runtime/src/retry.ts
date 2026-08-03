import { MAX_RETRY_DELAY_MS, type RetryCondition, type RetryPolicy } from "@anvil/air";

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
 *
 * This is the *speculative* schedule: what we guess when the upstream told us
 * nothing. When the upstream did state its own backpressure, go through
 * `resolveRetryDelay` instead, which lets that instruction win.
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

const HTTP_DATE_MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

// The three timestamp forms a recipient must accept (RFC 9110 §5.6.7): the
// preferred IMF-fixdate, and the two obsolete forms that real upstreams still
// emit. All are parsed by hand rather than handed to `Date.parse`: the platform
// parser is lenient in ways that matter here — it happily reads bare years and
// ISO strings that are not HTTP-dates at all, and it resolves the zone-less
// asctime form in *local* time, which would make an agent's backoff depend on
// the deployment's TZ. Anvil has no external dependencies on this path and
// determinism is not negotiable, so the grammar is spelled out.
const IMF_FIXDATE = /^[A-Za-z]{3}, (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const RFC850_DATE = /^[A-Za-z]{6,9}, (\d{2})-([A-Za-z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const ASCTIME_DATE = /^[A-Za-z]{3} ([A-Za-z]{3}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

function utcFromParts(
  year: number,
  monthToken: string,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | null {
  const month = HTTP_DATE_MONTHS.indexOf(monthToken.toLowerCase());
  if (month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.UTC(year, month, day, hour, minute, second);
  // `Date.UTC` silently rolls a nonsense day forward ("31 Feb" becomes 3 March).
  // A malformed timestamp must read as *unparseable* so the caller falls back to
  // its own backoff, never as a real instant the upstream never named.
  return new Date(ms).getUTCDate() === day ? ms : null;
}

function parseHttpDate(value: string, nowMs: number): number | null {
  const imf = IMF_FIXDATE.exec(value);
  if (imf) {
    return utcFromParts(
      Number(imf[3]),
      imf[2] as string,
      Number(imf[1]),
      Number(imf[4]),
      Number(imf[5]),
      Number(imf[6]),
    );
  }

  const rfc850 = RFC850_DATE.exec(value);
  if (rfc850) {
    // Two-digit years are resolved against the caller-supplied clock, never a
    // hardcoded century: a timestamp that would land more than 50 years ahead is
    // the most recent past year ending in those digits (RFC 9110 §5.6.7).
    const nowYear = new Date(nowMs).getUTCFullYear();
    const candidate = Math.floor(nowYear / 100) * 100 + Number(rfc850[3]);
    const year = candidate - nowYear > 50 ? candidate - 100 : candidate;
    return utcFromParts(
      year,
      rfc850[2] as string,
      Number(rfc850[1]),
      Number(rfc850[4]),
      Number(rfc850[5]),
      Number(rfc850[6]),
    );
  }

  const asctime = ASCTIME_DATE.exec(value);
  if (asctime) {
    return utcFromParts(
      Number(asctime[6]),
      asctime[1] as string,
      Number(asctime[2]),
      Number(asctime[3]),
      Number(asctime[4]),
      Number(asctime[5]),
    );
  }
  return null;
}

/**
 * The upstream's own answer to "when should I come back?" (RFC 9110 §10.2.3),
 * in milliseconds from `nowMs`. Both wire forms are accepted: delta-seconds
 * ("120") and an HTTP-date ("Wed, 21 Oct 2015 07:28:00 GMT").
 *
 * `nowMs` is a parameter and this function never reads the clock itself. A
 * retry schedule that depends on ambient time cannot be asserted on, and an
 * untestable safety path is one that quietly stops working (spec §11).
 *
 * Returns null when the value is not a valid `Retry-After` at all, or when the
 * date it names has already passed — in both cases we have learned nothing and
 * fall back to our own backoff. Null is deliberately *not* used for "wait a
 * very long time": see the saturation below, because the difference between
 * "no signal" and "an enormous signal" is the difference between retrying and
 * refusing to.
 */
export function parseRetryAfter(value: string, nowMs: number): number | null {
  const raw = value.trim();
  if (raw.length === 0 || !Number.isFinite(nowMs)) return null;

  if (/^\d+$/.test(raw)) {
    // delta-seconds is 1*DIGIT — unsigned by grammar, so "-5" and "1.5" never
    // reach here and read as malformed rather than as a delay to honor.
    const ms = Number(raw) * 1000;
    // An upstream that names an absurd delta (or one that overflows exact
    // integer arithmetic) is still telling us to stay away for far longer than
    // we are willing to sleep. Saturating keeps that on the give-up path;
    // returning null would discard the instruction and let the agent hammer a
    // service that just asked it to stop.
    return Number.isSafeInteger(ms) ? ms : Number.MAX_SAFE_INTEGER;
  }

  const at = parseHttpDate(raw, nowMs);
  if (at === null) return null;
  const delta = at - nowMs;
  return delta < 0 ? null : delta;
}

/**
 * What the executor should do before the next attempt, once the upstream's
 * `Retry-After` (if any) is weighed against our own backoff.
 *
 * `stop` is a retry decision, never a safety decision: it can only ever end a
 * retry loop that `retryIsSafe` already opened.
 */
export type RetryDelayDecision =
  | { action: "wait"; delayMs: number; source: "backoff" | "retry_after" }
  | { action: "stop"; retryAfterMs: number };

/**
 * Resolve the pre-attempt delay, honoring upstream backpressure over our guess.
 *
 * Two judgment calls are encoded here, both in the direction of the upstream:
 *
 * 1. When the server asks for LONGER than `MAX_RETRY_DELAY_MS` we stop retrying
 *    instead of clamping the sleep to the ceiling. Clamping looks like the
 *    conservative choice and is the opposite: it means waiting 20s when the
 *    service said 120s and knocking again 100s early — precisely the behavior
 *    that turns a rate limit into a ban, and precisely what the ceiling exists
 *    to prevent us from doing on our own initiative. The ceiling bounds how long
 *    a single in-flight call may sit inside the runtime; it is not a license to
 *    ignore the part of the instruction that does not fit. So the attempt budget
 *    ends here and the caller receives a structured `rate_limited` /
 *    `upstream_unavailable` envelope carrying `retry_after_ms`. An agent that
 *    wants to come back in two minutes can — with the number the server gave it,
 *    as a deliberate act — which is the whole posture: refuse with the next
 *    action attached rather than retry blindly (spec §10, §11).
 *
 * 2. When the server asks for LESS than our computed backoff we keep the
 *    backoff. `Retry-After` is a floor on how long to stay away, not a
 *    permission slip to come back sooner; a "Retry-After: 0" from a misbehaving
 *    (or overloaded, or hostile) upstream must not be able to collapse full
 *    jitter into a tight loop or de-synchronize a fleet into a thundering herd.
 *    The invariant that survives every branch: we never retry sooner than
 *    either the server asked or our own schedule allows.
 */
export function resolveRetryDelay(
  attempt: number,
  policy: Pick<RetryPolicy, "backoff" | "baseDelayMs" | "maxDelayMs">,
  retryAfterMs: number | null,
  rng: () => number = Math.random,
): RetryDelayDecision {
  // Checked before the backoff is computed so the give-up path does not consume
  // a draw from the injected rng and shift a caller's deterministic schedule.
  if (retryAfterMs !== null && retryAfterMs > MAX_RETRY_DELAY_MS) {
    return { action: "stop", retryAfterMs };
  }
  const backoffMs = computeBackoffMs(attempt, policy, rng);
  if (retryAfterMs === null || retryAfterMs <= backoffMs) {
    return { action: "wait", delayMs: backoffMs, source: "backoff" };
  }
  return { action: "wait", delayMs: retryAfterMs, source: "retry_after" };
}

/**
 * Read `Retry-After` off a response. Field names are case-insensitive
 * (RFC 9110 §5.1): `FetchTransport` lowercases what it collects, but a mock or
 * an embedder's transport may hand us the wire casing, so match on the folded
 * name rather than trusting the key.
 */
export function retryAfterFromHeaders(
  headers: Record<string, string | undefined>,
  nowMs: number,
): number | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "retry-after" && value !== undefined) {
      return parseRetryAfter(value, nowMs);
    }
  }
  return null;
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
