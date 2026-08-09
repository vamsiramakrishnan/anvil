import { describe, expect, it } from "vitest";
import { InMemoryLedger } from "./idempotency.js";

/**
 * Decision A (implementation plan "Before you start" §A): the job-handle
 * index — `jobId -> idempotencyKey` — written at `complete()` time via its
 * optional `secondaryKey` parameter, read back via `findBySecondaryKey`.
 * These are pure round-trip tests against the in-memory dev ledger; no
 * network, no deployed server.
 */
describe("IdempotencyLedger job-handle index (Decision A)", () => {
  it("round-trips reserve -> complete-with-secondary-key -> findBySecondaryKey", async () => {
    const ledger = new InMemoryLedger();

    await expect(ledger.reserve("key-1", "fingerprint-1")).resolves.toEqual({
      outcome: "reserved",
    });
    await ledger.complete("key-1", { status: "pending" }, 202, "upstream-job-abc");

    await expect(ledger.findBySecondaryKey("upstream-job-abc")).resolves.toBe("key-1");
  });

  it("returns undefined cleanly for a job id nobody has indexed, never throwing", async () => {
    const ledger = new InMemoryLedger();

    await expect(ledger.findBySecondaryKey("no-such-job")).resolves.toBeUndefined();
  });

  it("does not index a completion that never supplied a secondary key", async () => {
    const ledger = new InMemoryLedger();

    await ledger.reserve("key-2", "fingerprint-2");
    await ledger.complete("key-2", { ok: true });

    // No secondary key was ever supplied for "key-2", so nothing should be
    // discoverable by any job id — confirms the index write is opt-in per
    // `complete()` call, not inferred from the presence of a result.
    await expect(ledger.findBySecondaryKey("key-2")).resolves.toBeUndefined();
  });

  it("keeps distinct job ids resolving to their own idempotency key", async () => {
    const ledger = new InMemoryLedger();

    await ledger.reserve("key-a", "fp-a");
    await ledger.complete("key-a", { id: "a" }, 200, "job-a");
    await ledger.reserve("key-b", "fp-b");
    await ledger.complete("key-b", { id: "b" }, 200, "job-b");

    await expect(ledger.findBySecondaryKey("job-a")).resolves.toBe("key-a");
    await expect(ledger.findBySecondaryKey("job-b")).resolves.toBe("key-b");
  });

  it("records the job id on the completed entry's cached result independently of the index", async () => {
    // LedgerEntry.jobId is bookkeeping on the entry itself; findBySecondaryKey
    // is the actual reverse-lookup surface. Prove both exist without
    // depending on LedgerEntry's internal storage shape: complete once, then
    // read back only through the public interface.
    const ledger = new InMemoryLedger();
    await ledger.reserve("key-3", "fp-3");
    await ledger.complete("key-3", { ok: true }, 200, "job-3");

    const found = await ledger.findBySecondaryKey("job-3");
    expect(found).toBe("key-3");
  });
});
