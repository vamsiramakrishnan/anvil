import { describe, expect, it } from "vitest";
import { MAX_RETRY_ATTEMPTS, MAX_RETRY_DELAY_MS, RetryPolicy } from "./schema.js";

describe("AIR retry safety bounds", () => {
  it("accepts the boundary contract", () => {
    expect(
      RetryPolicy.parse({
        mode: "safe",
        maxAttempts: MAX_RETRY_ATTEMPTS,
        backoff: "fixed",
        baseDelayMs: MAX_RETRY_DELAY_MS,
        maxDelayMs: MAX_RETRY_DELAY_MS,
        retryOn: ["timeout"],
      }),
    ).toMatchObject({
      maxAttempts: 5,
      baseDelayMs: 20_000,
      maxDelayMs: 20_000,
    });
  });

  it.each([
    { maxAttempts: MAX_RETRY_ATTEMPTS + 1 },
    { baseDelayMs: MAX_RETRY_DELAY_MS + 1 },
    { maxDelayMs: MAX_RETRY_DELAY_MS + 1 },
  ])("rejects retry policy outside the runtime envelope: %o", (override) => {
    expect(() =>
      RetryPolicy.parse({
        mode: "safe",
        maxAttempts: 1,
        backoff: "fixed",
        baseDelayMs: 0,
        maxDelayMs: 0,
        retryOn: ["timeout"],
        ...override,
      }),
    ).toThrow();
  });
});
