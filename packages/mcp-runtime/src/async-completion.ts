import type { WebhookContract } from "@anvil/air";
import { type IdempotencyLedger, idempotencyKeyIsTransportSafe } from "@anvil/runtime";

/**
 * Closes two gaps left open between `@anvil/runtime`'s Phase 2 primitives
 * (`packages/runtime/src/idempotency.ts`'s job-handle index,
 * `packages/runtime/src/webhook-receiver.ts`'s receiver) and a servable
 * hybrid/synthetic status tool — without editing `@anvil/runtime` itself.
 * Both gaps are closed purely by composing the *existing*, exported
 * `IdempotencyLedger` interface; see each export's own doc comment for why
 * that is sufficient and where its limits are.
 *
 * Gap 1 — nothing writes the job-handle index. `IdempotencyLedger.complete()`
 * accepts an optional `secondaryKey` (§14/Decision A's `jobId -> idempotencyKey`
 * index), and `webhook-receiver.ts` already *reads* it via
 * `findBySecondaryKey`. But `packages/runtime/src/executor.ts` — the shared
 * `execute()` every submit-operation call goes through — never passes
 * `secondaryKey` to `complete()`. Nothing in Phase 2 wired the write side.
 * `ledgerWithJobIndexing` is a decorator over the SAME `IdempotencyLedger`
 * seam `ExecuteContext.ledger` already is (a normal, supported injection
 * point, not a change to the ledger's own implementation): wrapped for one
 * operation's call, its `complete()` extracts the operation's own
 * `AsyncContract.jobIdField` from the just-completed result and forwards it
 * as `secondaryKey`, so the index gets written without touching
 * `executor.ts`. This is scoped to calls made through `buildMcpServer`
 * (`server.ts`) — the MCP serving path Phase 3 owns. A caller that invokes
 * `execute()` directly, bypassing MCP entirely (e.g. a future direct
 * `@anvil/runtime` consumer), still will not get indexed; the durable fix
 * belongs in `executor.ts` itself, in a later, `@anvil/runtime`-scoped change.
 *
 * Gap 2 — a webhook's completion is unreadable by anything but the receiver
 * that wrote it. `handleWebhook()` durably records each delivery under a key
 * derived from a hash of the raw payload bytes
 * (`${idempotencyKey}#webhook:${digest}`) — deliberately, so a retried
 * delivery replays instead of double-applying. But nothing makes that digest
 * discoverable to a reader that only has the job id (a status tool has never
 * seen the raw webhook bytes, so it cannot recompute the key), and
 * `IdempotencyLedger` has no "read arbitrary key" or "list by prefix"
 * primitive — `reserve`/`complete`/`release` are the only mutating primitives,
 * and `findBySecondaryKey` only ever returns the *submit* operation's
 * idempotency key, not webhook content. `recordWebhookCompletionIfIndexed`
 * and `peekWebhookStatus` add ONE deterministic, additional cache key
 * (`${idempotencyKey}#webhook_status`) that a writer and a reader can agree
 * on without either needing to know the other's content hash. Both accept
 * the ledger's genuine constraints rather than fighting them — see each
 * function's own doc comment.
 */

const WEBHOOK_STATUS_CACHE_FINGERPRINT = "anvil_webhook_status_cache_v1";

/** The deterministic cache key both the writer and the reader agree on, or
 *  `undefined` if the derived key would not be transport-safe (fails closed,
 *  matching `webhook-receiver.ts`'s own posture for its own derived key). */
export function webhookStatusCacheKey(idempotencyKey: string): string | undefined {
  const key = `${idempotencyKey}#webhook_status`;
  return idempotencyKeyIsTransportSafe(key) ? key : undefined;
}

function valueAtDottedPath(value: unknown, dottedPath: string): unknown {
  const segments = dottedPath.split(".").filter(Boolean);
  let current: unknown = value;
  for (const segment of segments) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Read a string (or finite-number-as-string) at a dotted path. Mirrors
 *  `webhook-receiver.ts`'s own (unexported) helper of the same name — kept as
 *  a small, deliberate duplication rather than a new `@anvil/runtime` export,
 *  since this module may not depend on runtime internals it does not need. */
function stringAtPath(value: unknown, dottedPath: string): string | undefined {
  const found = valueAtDottedPath(value, dottedPath);
  if (typeof found === "string" && found.length > 0) return found;
  if (typeof found === "number" && Number.isFinite(found)) return String(found);
  return undefined;
}

function parseBodyLoosely(rawBody: Buffer, headers: Record<string, string>): unknown {
  const contentType =
    Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "";
  const text = rawBody.toString("utf8");
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(text);
    const out: Record<string, string> = {};
    for (const [key, value] of params.entries()) out[key] = value;
    return out;
  }
  if (text.trim().length === 0) return {};
  return JSON.parse(text);
}

/**
 * Decorate a ledger so a submit operation's own `execute()` call indexes its
 * job handle — closing Gap 1 above for exactly one call. `jobIdField` is the
 * operation's own resolved `AsyncContract.jobIdField` (a dotted path into
 * *this* operation's response). Every other method passes straight through
 * unchanged; optional methods (`checkReadiness`, `findBySecondaryKey`) are
 * preserved only when the wrapped ledger itself has them, so a caller that
 * checks for their presence (as `webhook-receiver.ts` and `peekWebhookStatus`
 * both deliberately do) sees the same answer through the wrapper as through
 * the ledger directly.
 */
export function ledgerWithJobIndexing(
  ledger: IdempotencyLedger,
  jobIdField: string,
): IdempotencyLedger {
  const wrapped: IdempotencyLedger = {
    durable: ledger.durable,
    reserve: (key, fingerprint, context) => ledger.reserve(key, fingerprint, context),
    complete: (key, result, status, secondaryKey) =>
      ledger.complete(key, result, status, secondaryKey ?? stringAtPath(result, jobIdField)),
    release: (key) => ledger.release(key),
  };
  if (ledger.checkReadiness) {
    wrapped.checkReadiness = () =>
      (ledger.checkReadiness as NonNullable<typeof ledger.checkReadiness>)();
  }
  if (ledger.findBySecondaryKey) {
    wrapped.findBySecondaryKey = (jobId) =>
      (ledger.findBySecondaryKey as NonNullable<typeof ledger.findBySecondaryKey>)(jobId);
  }
  return wrapped;
}

export interface RecordWebhookCompletionParams {
  contract: WebhookContract;
  rawBody: Buffer;
  headers: Record<string, string>;
  ledger: IdempotencyLedger;
}

/**
 * Best-effort cache write, run AFTER `handleWebhook()` has already durably
 * recorded the delivery under its own content-addressed key and returned
 * `{status: 200}`. This is never the canonical record of a delivery —
 * `handleWebhook()` already is that — so any failure here is swallowed
 * rather than changing the receiver's response to the provider; at worst a
 * hybrid/synthetic status tool falls back to a real upstream poll (or reports
 * "pending" a little longer), never a wrong answer.
 *
 * KNOWN LIMITATION, inherited rather than introduced: only the FIRST delivery
 * for a given idempotency key is cached here. `IdempotencyLedger.complete()`
 * deliberately refuses to re-complete an already-completed entry (the same
 * invariant that makes `handleWebhook()` itself namespace each delivery under
 * its own key rather than overwriting) — so a SECOND delivery for the same
 * job (e.g. `pending` then later `completed`) is still durably recorded by
 * `handleWebhook()`, but this cache keeps showing the first. This is exactly
 * the "multiple deliveries with different terminal states" question the
 * design doc's §19 leaves open ("decide before Phase 2's tests are written,
 * not after") — Phase 2 shipped without resolving it, so this cache cannot
 * resolve it either. A hybrid status tool always has a safe fallback (the
 * real upstream poll); a synthetic (webhook-only) tool does not, and will
 * keep reporting the first delivery's state until that gap is closed
 * upstream of this file.
 */
export async function recordWebhookCompletionIfIndexed(
  params: RecordWebhookCompletionParams,
): Promise<void> {
  if (!params.ledger.findBySecondaryKey) return;
  let parsed: unknown;
  try {
    parsed = parseBodyLoosely(params.rawBody, params.headers);
  } catch {
    return;
  }
  const jobId = stringAtPath(parsed, params.contract.webhookJobIdField);
  if (jobId === undefined) return;
  const state = params.contract.webhookStateField
    ? stringAtPath(parsed, params.contract.webhookStateField)
    : undefined;

  let idempotencyKey: string | undefined;
  try {
    idempotencyKey = await params.ledger.findBySecondaryKey(jobId);
  } catch {
    return;
  }
  if (idempotencyKey === undefined) return;
  const cacheKey = webhookStatusCacheKey(idempotencyKey);
  if (!cacheKey) return;

  try {
    const reservation = await params.ledger.reserve(cacheKey, WEBHOOK_STATUS_CACHE_FINGERPRINT);
    if (reservation.outcome !== "reserved") return; // already cached, or a concurrent write is landing
    await params.ledger.complete(
      cacheKey,
      { jobId, ...(state === undefined ? {} : { state }) },
      200,
    );
  } catch {
    // Best effort only — handleWebhook() already durably recorded the delivery.
  }
}

export interface WebhookStatusPeekResult {
  found: boolean;
  result?: unknown;
}

/**
 * Read-only peek at the cache `recordWebhookCompletionIfIndexed` writes,
 * safe to call from any stateless serving instance. `IdempotencyLedger` has
 * no bare "read" primitive, so this probes with `reserve()` — the only
 * primitive that reports what is already there — and, when that reserve
 * itself just CREATED the entry (`outcome: "reserved"`, meaning nobody had
 * written yet), immediately `release()`s it. That release is safe precisely
 * because this call just performed the matching `reserve()` in the same
 * process: it undoes only what it created, and never leaves a phantom
 * `in_progress` row behind that could block the real webhook delivery from
 * ever claiming the key. Under a genuine race (a real delivery's `reserve()`
 * lands first), this peek observes `"in_progress"` instead of `"reserved"`
 * and does not attempt to release a reservation it does not own — reported
 * as "not found yet", which is always a safe answer (a caller with an
 * upstream fallback retries it; a synthetic caller reports "pending").
 */
export async function peekWebhookStatus(
  ledger: IdempotencyLedger,
  idempotencyKey: string,
): Promise<WebhookStatusPeekResult> {
  const cacheKey = webhookStatusCacheKey(idempotencyKey);
  if (!cacheKey) return { found: false };
  let reservation: Awaited<ReturnType<IdempotencyLedger["reserve"]>>;
  try {
    reservation = await ledger.reserve(cacheKey, WEBHOOK_STATUS_CACHE_FINGERPRINT);
  } catch {
    return { found: false };
  }
  if (reservation.outcome === "replay") {
    return { found: true, result: reservation.result };
  }
  if (reservation.outcome === "reserved") {
    try {
      await ledger.release(cacheKey);
    } catch {
      // Best effort — worst case a stale in_progress row lingers until the
      // real webhook delivery arrives and its own reserve() call observes it.
    }
    return { found: false };
  }
  // "in_progress" (a concurrent write is landing right now) or "conflict"
  // (unreachable given the fixed fingerprint above, but handled the same,
  // conservative way if it ever occurred) — not something this peek owns.
  return { found: false };
}
