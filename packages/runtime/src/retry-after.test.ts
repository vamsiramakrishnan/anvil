import { MAX_RETRY_DELAY_MS, type Operation, Operation as OperationSchema } from "@anvil/air";
import { describe, expect, it, vi } from "vitest";
import {
  execute,
  type HttpResponse,
  MockTransport,
  parseRetryAfter,
  resolveRetryDelay,
  retryAfterFromHeaders,
} from "./index.js";

/**
 * `Retry-After` coverage: the parser (both RFC 9110 wire forms), the decision
 * that weighs an upstream's stated backpressure against our own backoff, and
 * the executor seam where a real 429/503 header changes what an agent does.
 *
 * The load-bearing test in this file is the last one: honoring a header must
 * never widen the retry surface. `retryIsSafe` remains the sole gate.
 */

/** Minimal operation factory for tests — identical to runtime.test.ts's `op()`. */
function op(overrides: Record<string, unknown> = {}): Operation {
  return OperationSchema.parse({
    id: "payments.refund.create",
    canonicalName: "create_refund",
    displayName: "Create refund",
    sourceRef: { kind: "openapi", path: "/payments/{payment_id}/refunds", method: "post" },
    effect: { kind: "mutation", resource: "refund", risk: "financial", reversible: false },
    input: {
      params: [{ name: "payment_id", in: "path", required: true, schema: { type: "string" } }],
      body: {
        contentType: "application/json",
        required: true,
        schema: {
          type: "object",
          required: ["amount"],
          properties: { amount: { type: "integer" } },
        },
        projection: "fields",
        fields: [{ name: "amount", required: true, schema: { type: "integer" } }],
      },
    },
    idempotency: {
      mode: "required",
      mechanism: "header",
      key: "Idempotency-Key",
      keyDerivation: "request_fingerprint",
    },
    retries: {
      mode: "safe",
      maxAttempts: 3,
      backoff: "exponential_jitter",
      retryOn: ["http_503", "http_429", "timeout"],
    },
    confirmation: { required: true, risk: "financial" },
    auth: { type: "none", scopes: [] },
    cli: { command: "payments refunds create" },
    mcp: { toolName: "payments_create_refund" },
    skill: { intentExamples: [] },
    state: "approved",
    ...overrides,
  });
}

const ok = (body: unknown): HttpResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(body),
});

const throttled = (retryAfter?: string, status = 429): HttpResponse => ({
  status,
  headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
  body: "",
});

/** A fixed instant so every HTTP-date assertion is an exact number, not a range. */
const NOW = Date.UTC(2015, 9, 21, 7, 0, 0);

/**
 * Records what the executor actually slept for. `rng: () => 0.5` makes the
 * jittered fallback exactly 100 ms at attempt 1 (floor(0.5 × 200)), so a test
 * can tell "honored the header" apart from "fell back to backoff" by value.
 */
function ctxWith(transport: MockTransport, sleeps: number[]) {
  return {
    serviceId: "payments",
    baseUrl: "https://payments.internal.example.com",
    allowedHosts: ["payments.internal.example.com"],
    env: "dev",
    rng: () => 0.5,
    now: () => NOW,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    transport,
  };
}

const BACKOFF_AT_ATTEMPT_1 = 100;

describe("parseRetryAfter — delta-seconds", () => {
  it.each([
    ["120", 120_000],
    ["0", 0],
    ["1", 1_000],
    ["  30  ", 30_000],
  ])("reads %j as %i ms", (value, expected) => {
    expect(parseRetryAfter(value, NOW)).toBe(expected);
  });

  it.each([
    ["-5"],
    ["1.5"],
    ["12a"],
    ["+7"],
    [""],
    ["   "],
    ["soon"],
    ["NaN"],
    ["1e3"],
  ])("refuses %j as unparseable so the caller keeps its own backoff", (value) => {
    expect(parseRetryAfter(value, NOW)).toBeNull();
  });

  it("saturates an absurd delta rather than discarding the instruction", () => {
    // Null would mean "no signal" and hand the agent back to plain backoff —
    // i.e. hammer a service that just asked for a decade of silence. It must
    // stay a very large number so the give-up branch sees it.
    const parsed = parseRetryAfter("99999999999999999999", NOW);
    expect(parsed).toBe(Number.MAX_SAFE_INTEGER);
    expect(parsed as number).toBeGreaterThan(MAX_RETRY_DELAY_MS);
  });
});

describe("parseRetryAfter — HTTP-date", () => {
  it("reads an IMF-fixdate as the delay from the supplied clock", () => {
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT", NOW)).toBe(28 * 60 * 1_000);
  });

  it("treats an instant that has already passed as no signal at all", () => {
    expect(parseRetryAfter("Wed, 21 Oct 2015 06:00:00 GMT", NOW)).toBeNull();
  });

  it("reads an instant equal to now as zero, not as the past", () => {
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:00:00 GMT", NOW)).toBe(0);
  });

  it("carries a far-future date through intact so the ceiling can act on it", () => {
    const parsed = parseRetryAfter("Fri, 21 Oct 2095 07:28:00 GMT", NOW);
    expect(parsed).toBe(Date.UTC(2095, 9, 21, 7, 28, 0) - NOW);
    expect(parsed as number).toBeGreaterThan(MAX_RETRY_DELAY_MS);
  });

  it("accepts the obsolete rfc850 form", () => {
    expect(parseRetryAfter("Wednesday, 21-Oct-15 07:28:00 GMT", NOW)).toBe(28 * 60 * 1_000);
  });

  it("resolves an rfc850 two-digit year more than 50 years ahead into the past", () => {
    // 2075 is 60 years out from the supplied clock, so it means 1975 — long
    // past, therefore no signal (RFC 9110 §5.6.7).
    expect(parseRetryAfter("Monday, 21-Oct-75 07:28:00 GMT", NOW)).toBeNull();
  });

  it("accepts the obsolete asctime form and reads it as UTC", () => {
    expect(parseRetryAfter("Wed Oct 21 07:28:00 2015", NOW)).toBe(28 * 60 * 1_000);
    expect(parseRetryAfter("Wed Oct  6 07:28:00 2095", NOW)).toBe(
      Date.UTC(2095, 9, 6, 7, 28, 0) - NOW,
    );
  });

  it.each([
    ["Wed, 32 Oct 2015 07:28:00 GMT", "a day outside the month"],
    ["Wed, 31 Feb 2015 07:28:00 GMT", "a day that rolls into the next month"],
    ["Wed, 21 Foo 2015 07:28:00 GMT", "an unknown month"],
    ["Wed, 21 Oct 2015 25:28:00 GMT", "an hour outside the day"],
    ["Wed, 21 Oct 2015 07:28:00 PST", "a zone other than GMT"],
    ["2015-10-21T07:28:00Z", "an ISO instant that is not an HTTP-date"],
    ["Wed, 21 Oct 2015", "a truncated date"],
    ["Tomorrow", "prose"],
  ])("refuses %j — %s", (value) => {
    expect(parseRetryAfter(value, NOW)).toBeNull();
  });

  it("never reads the ambient clock", () => {
    // A retry schedule that depends on ambient time cannot be asserted on, and
    // an untestable safety path is one that quietly stops working.
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("parseRetryAfter must not call Date.now()");
    });
    try {
      expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT", NOW)).toBe(28 * 60 * 1_000);
      expect(parseRetryAfter("Wednesday, 21-Oct-15 07:28:00 GMT", NOW)).toBe(28 * 60 * 1_000);
      expect(parseRetryAfter("120", NOW)).toBe(120_000);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("retryAfterFromHeaders", () => {
  it("matches the field name case-insensitively", () => {
    expect(retryAfterFromHeaders({ "Retry-After": "7" }, NOW)).toBe(7_000);
    expect(retryAfterFromHeaders({ "RETRY-AFTER": "7" }, NOW)).toBe(7_000);
  });

  it("is null when the upstream said nothing", () => {
    expect(retryAfterFromHeaders({ "x-request-id": "req_1" }, NOW)).toBeNull();
  });
});

describe("resolveRetryDelay", () => {
  const policy = { backoff: "exponential_jitter", baseDelayMs: 200, maxDelayMs: 20_000 } as const;

  it("uses the computed backoff when the upstream said nothing", () => {
    expect(resolveRetryDelay(1, policy, null, () => 0.5)).toEqual({
      action: "wait",
      delayMs: BACKOFF_AT_ATTEMPT_1,
      source: "backoff",
    });
  });

  it("lets a longer upstream wait override the backoff", () => {
    expect(resolveRetryDelay(1, policy, 5_000, () => 0.5)).toEqual({
      action: "wait",
      delayMs: 5_000,
      source: "retry_after",
    });
  });

  it.each([
    ["zero", 0],
    ["shorter than our own schedule", 50],
  ])("keeps the backoff when the upstream asks for %s", (_label, retryAfterMs) => {
    // Retry-After is a floor on staying away, not permission to come back
    // sooner: a "Retry-After: 0" must not collapse full jitter into a loop.
    expect(resolveRetryDelay(1, policy, retryAfterMs, () => 0.5)).toEqual({
      action: "wait",
      delayMs: BACKOFF_AT_ATTEMPT_1,
      source: "backoff",
    });
  });

  it("waits exactly at the ceiling rather than stopping", () => {
    expect(resolveRetryDelay(1, policy, MAX_RETRY_DELAY_MS, () => 0.5)).toEqual({
      action: "wait",
      delayMs: MAX_RETRY_DELAY_MS,
      source: "retry_after",
    });
  });

  it("stops retrying when the upstream asks for longer than the ceiling", () => {
    // Clamping to the ceiling would knock 100s early on a service that asked
    // for 120s — the exact behavior that turns a rate limit into a ban.
    const rng = vi.fn(() => 0.5);
    expect(resolveRetryDelay(1, policy, 120_000, rng)).toEqual({
      action: "stop",
      retryAfterMs: 120_000,
    });
    // And it must not burn an rng draw, or a caller's deterministic schedule
    // would shift depending on whether an upstream sent a header.
    expect(rng).not.toHaveBeenCalled();
  });
});

describe("executor honors Retry-After", () => {
  it("sleeps for the stated wait on a 429 instead of its blind backoff", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const transport = new MockTransport(() => {
      n += 1;
      return n === 1 ? throttled("5") : ok({ id: "re_1" });
    });
    const res = await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      ctxWith(transport, sleeps),
    );
    expect(res.outcome).toBe("success");
    expect(sleeps).toEqual([5_000]);
    expect(res.record.retryCount).toBe(1);
  });

  it("honors an HTTP-date on a 503", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const transport = new MockTransport(() => {
      n += 1;
      return n === 1
        ? {
            status: 503,
            headers: { "Retry-After": "Wed, 21 Oct 2015 07:00:03 GMT" },
            body: "",
          }
        : ok({ id: "re_1" });
    });
    const res = await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      ctxWith(transport, sleeps),
    );
    expect(res.outcome).toBe("success");
    expect(sleeps).toEqual([3_000]);
  });

  it("falls back to jittered backoff when the header is malformed", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const transport = new MockTransport(() => {
      n += 1;
      return n === 1 ? throttled("whenever") : ok({ id: "re_1" });
    });
    const res = await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      ctxWith(transport, sleeps),
    );
    expect(res.outcome).toBe("success");
    expect(sleeps).toEqual([BACKOFF_AT_ATTEMPT_1]);
  });

  it("stops retrying and surfaces the wait when it exceeds the runtime ceiling", async () => {
    const sleeps: number[] = [];
    const transport = new MockTransport(() => throttled("600"));
    const res = await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      ctxWith(transport, sleeps),
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(transport.requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(res.envelope.error.code).toBe("rate_limited");
    // Retryable, just not by us and not now: the caller gets the number the
    // server gave it and decides for itself.
    expect(res.envelope.error.retryable).toBe(true);
    expect(res.envelope.error.details).toMatchObject({
      retry_after_ms: 600_000,
      retry_stopped: "retry_after_exceeds_ceiling",
      max_delay_ms: MAX_RETRY_DELAY_MS,
    });
  });

  it("reports the stated wait after exhausting its attempt budget", async () => {
    const sleeps: number[] = [];
    const transport = new MockTransport(() => throttled("2"));
    const res = await execute(
      op(),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      ctxWith(transport, sleeps),
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(transport.requests).toHaveLength(3);
    expect(sleeps).toEqual([2_000, 2_000]);
    expect(res.envelope.error.details).toMatchObject({ retry_after_ms: 2_000 });
  });

  it("attaches no retry detail when the upstream stated nothing", async () => {
    const sleeps: number[] = [];
    const transport = new MockTransport(() => throttled(undefined, 500));
    const res = await execute(
      op({ retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] } }),
      { input: { payment_id: "pay_1", amount: 2500 }, confirm: true, idempotencyKey: "k1" },
      ctxWith(transport, sleeps),
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(res.envelope.error.details).toBeUndefined();
  });

  it("NEVER retries a non-idempotent mutation, whatever the upstream asks for", async () => {
    // The invariant this whole feature must not dent: the operation's retry
    // policy says `safe` with three attempts and lists http_429, and the
    // upstream is politely asking to be retried in one second. `retryIsSafe`
    // still refuses, because a mutation with no idempotency contract can
    // duplicate a financial write. A response header is not evidence about the
    // *effect* of an operation and can never become one (spec §2.4, §11).
    const sleeps: number[] = [];
    const nonIdempotent = op({
      confirmation: { required: false },
      idempotency: { mode: "none", mechanism: "none", keyDerivation: "none" },
      retries: {
        mode: "safe",
        maxAttempts: 3,
        backoff: "exponential_jitter",
        retryOn: ["http_429", "http_503", "timeout"],
      },
    });
    const transport = new MockTransport(() => throttled("1"));
    const res = await execute(
      nonIdempotent,
      { input: { payment_id: "pay_1", amount: 2500 } },
      ctxWith(transport, sleeps),
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") return;
    expect(transport.requests).toHaveLength(1); // exactly one attempt
    expect(sleeps).toEqual([]); // and it never even waited
    expect(res.envelope.error.code).toBe("rate_limited");
    expect(res.envelope.error.safe_to_retry).toBe(false);
    // The stated wait is still reported — it is useful to a human deciding
    // whether to re-issue the write by hand; it just never drives a retry.
    expect(res.envelope.error.details).toMatchObject({ retry_after_ms: 1_000 });
  });
});
