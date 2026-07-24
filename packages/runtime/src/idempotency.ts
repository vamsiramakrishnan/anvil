import { createHash, randomUUID } from "node:crypto";

export const MAX_IDEMPOTENCY_KEY_BYTES = 255;

/**
 * Portable caller-key contract shared by every carrier. Visible ASCII avoids
 * header/control ambiguity and the byte bound matches common provider limits.
 */
export function idempotencyKeyIsTransportSafe(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_IDEMPOTENCY_KEY_BYTES &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

/** Deterministic canonical JSON: object keys sorted, so equal inputs hash equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * A stable fingerprint of a request: sha256 over the operation id and the
 * canonicalized input. Used to derive idempotency keys and to detect replays.
 */
export function requestFingerprint(operationId: string, input: unknown, scope?: unknown): string {
  const hash = createHash("sha256").update(operationId).update("\0");
  if (scope !== undefined) hash.update(canonicalJson(scope)).update("\0");
  return hash.update(canonicalJson(input)).digest("hex");
}

/**
 * Resolve the idempotency key for a request. Precedence: caller-supplied key,
 * then fingerprint derivation, else none. Returns `undefined` when no key can
 * be produced (the executor then decides whether that is an error).
 */
export function resolveIdempotencyKey(params: {
  provided?: string;
  keyDerivation: "request_fingerprint" | "client_supplied" | "none";
  operationId: string;
  input: unknown;
  /** Precomputed request + service/principal scope for derived keys. */
  fingerprint?: string;
}): string | undefined {
  if (params.provided && params.provided.length > 0) {
    if (!idempotencyKeyIsTransportSafe(params.provided)) {
      throw new Error(
        "An idempotency key must be 1 to 255 bytes of visible ASCII with no spaces or control characters.",
      );
    }
    return params.provided;
  }
  if (params.keyDerivation === "request_fingerprint") {
    return `anvil-${(params.fingerprint ?? requestFingerprint(params.operationId, params.input)).slice(0, 32)}`;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Idempotency ledger (Cloud Run is stateless — unsafe ops need external state) */
/* -------------------------------------------------------------------------- */

export type LedgerStatus = "in_progress" | "completed";

export interface LedgerEntry {
  status: LedgerStatus;
  fingerprint: string;
  /** Cached result once completed, replayed for duplicate keys. */
  result?: unknown;
  /** Original successful upstream status. Legacy entries replay as 200. */
  responseStatus?: number;
}

export type LedgerReadinessCode =
  | "ok"
  | "not_required"
  | "durable_ledger_required"
  | "probe_unsupported"
  | "permission_denied"
  | "database_not_found"
  | "unavailable"
  | "invalid_response";

export interface LedgerReadiness {
  ready: boolean;
  /**
   * Stable, non-sensitive diagnostic. Readiness callers must not return raw
   * backend errors, resource URIs, credentials, or document contents.
   */
  code: LedgerReadinessCode;
}

export interface LedgerReservationMetadata {
  /**
   * Optional deterministic, non-secret backend row locator. It must never
   * contain a raw caller key, backend URI, project/database id, or credential.
   */
  reference?: string;
}

export interface LedgerReservationContext {
  /** Non-secret correlation metadata persisted with the reservation when safe. */
  operationId?: string;
  traceId?: string;
}

export type LedgerReserveResult = (
  | { outcome: "reserved" }
  | { outcome: "replay"; result: unknown; status?: number }
  | { outcome: "in_progress" }
  | { outcome: "conflict" }
) &
  LedgerReservationMetadata;

/**
 * The idempotency ledger contract (spec: "Idempotency on Cloud Run"). Prod
 * implementations back this with Firestore/Postgres/libSQL; the in-memory
 * implementation below is for dev, tests, and single-instance use.
 *
 *   reserve(key, fingerprint):
 *     - unseen               -> reserves, returns { outcome: "reserved" }
 *     - seen + completed     -> returns { outcome: "replay", result }
 *     - seen + in_progress   -> returns { outcome: "in_progress" }
 */
export interface IdempotencyLedger {
  /**
   * Whether this ledger survives across process instances (Firestore/Postgres/
   * libSQL) or is process-local (in-memory). The executor fails closed on a
   * required-idempotency mutation outside `dev` when no *durable* ledger is
   * configured — an in-memory ledger gives no cross-instance protection on a
   * horizontally-scaled runtime (Cloud Run), so silently trusting it would be a
   * safety lie. See `resolveLedger`.
   */
  readonly durable: boolean;
  /**
   * Optional live, non-mutating backend probe. Durable ledgers used by a
   * serving runtime must implement this or readiness fails closed.
   */
  checkReadiness?(): Promise<LedgerReadiness>;
  reserve(
    key: string,
    fingerprint: string,
    context?: LedgerReservationContext,
  ): Promise<LedgerReserveResult>;
  /**
   * Persist a successful result before acknowledging it to the caller.
   * `status` is optional for backwards-compatible custom ledgers; new runtimes
   * always supply the original 2xx status so replay preserves wire semantics.
   */
  complete(key: string, result: unknown, status?: number): Promise<void>;
  release(key: string): Promise<void>;
}

export class InMemoryLedger implements IdempotencyLedger {
  /** Process-local: never durable. */
  readonly durable = false;
  private readonly store = new Map<string, LedgerEntry>();

  async reserve(key: string, fingerprint: string) {
    const existing = this.store.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return { outcome: "conflict" as const };
      }
      if (existing.status === "completed") {
        return {
          outcome: "replay" as const,
          result: existing.result,
          ...(existing.responseStatus === undefined ? {} : { status: existing.responseStatus }),
        };
      }
      return { outcome: "in_progress" as const };
    }
    this.store.set(key, { status: "in_progress", fingerprint });
    return { outcome: "reserved" as const };
  }

  async complete(key: string, result: unknown, status = 200) {
    const existing = this.store.get(key);
    if (existing?.status !== "in_progress") {
      throw new Error("Cannot complete an in-memory reservation that is not in progress.");
    }
    assertSuccessfulResponseStatus(status);
    this.store.set(key, {
      status: "completed",
      fingerprint: existing.fingerprint,
      result,
      responseStatus: status,
    });
  }

  async release(key: string) {
    if (this.store.get(key)?.status === "in_progress") this.store.delete(key);
  }
}

/**
 * Resolve the serving readiness posture without exposing backend details.
 * Process-local state remains valid for dev/non-ledger surfaces. A durable
 * dependency must prove live access through its own non-mutating probe.
 */
export async function probeLedgerReadiness(
  ledger: IdempotencyLedger,
  durableRequired: boolean,
): Promise<LedgerReadiness> {
  if (!ledger.durable) {
    return durableRequired
      ? { ready: false, code: "durable_ledger_required" }
      : { ready: true, code: "not_required" };
  }
  if (!ledger.checkReadiness) {
    return { ready: false, code: "probe_unsupported" };
  }
  try {
    return await ledger.checkReadiness();
  } catch {
    // Raw network/provider errors can contain resource names or response data.
    // Collapse them into a stable code before they reach a public /readyz.
    return { ready: false, code: "unavailable" };
  }
}

/* -------------------------------------------------------------------------- */
/* Firestore durable ledger (the generated Cloud Run deployment backend)       */
/* -------------------------------------------------------------------------- */

export interface FirestoreLedgerOptions {
  /** Test seam. Production uses the platform fetch implementation. */
  fetchImpl?: typeof fetch;
  /** Test seam. Production mints a token from the fixed metadata endpoint. */
  metadataToken?: () => Promise<string>;
  /** Test seam for access-token caching. */
  now?: () => number;
  /** Deadline for each metadata or Firestore request. */
  timeoutMs?: number;
  /** Retention window for completed replay results. */
  resultTtlMs?: number;
  /** Cache window for the non-mutating readiness lookup (0 disables caching). */
  readinessCacheMs?: number;
  /** Test seam for bounded transient Firestore retries. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam for reservation ownership tokens. */
  reservationId?: () => string;
}

interface FirestoreDocument {
  name?: string;
  fields?: Record<
    string,
    {
      integerValue?: string;
      stringValue?: string;
      timestampValue?: string;
    }
  >;
  updateTime?: string;
}

interface OwnedReservation {
  fingerprint: string;
  reservationId: string;
  updateTime: string;
}

const FIRESTORE_API = "https://firestore.googleapis.com/v1";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const FIRESTORE_COLLECTION_PREFIX = "anvil_idempotency";
/** Generated-runtime deadline for each metadata or Firestore HTTP exchange. */
export const DEFAULT_FIRESTORE_TIMEOUT_MS = 10_000;
export const DEFAULT_LEDGER_RESULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_LEDGER_RESULT_TTL_MS = DEFAULT_LEDGER_RESULT_TTL_SECONDS * 1000;
const MAX_LEDGER_RESULT_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_LEDGER_READINESS_CACHE_MS = 30_000;
const FAILED_LEDGER_READINESS_CACHE_MS = 5_000;
// Firestore stores `result_json` as a string. Its REST representation JSON-
// escapes that already-serialized result a second time, so a valid 800 KiB row
// can approach 1.6 MiB on the wire when it is quote/backslash-heavy. Two MiB is
// a bounded envelope for at most 2x string escaping plus document metadata.
const MAX_FIRESTORE_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Maximum serialized replay result stored in one Firestore ledger document. */
export const MAX_LEDGER_RESULT_BYTES = 800 * 1024;
export const MAX_FIRESTORE_ATTEMPTS = 3;
export const FIRESTORE_RETRY_BASE_MS = 50;
const MAX_RESERVATION_CREATE_READ_CYCLES = 3;
/** Worst bounded duration of one retried Firestore request, including backoff. */
export const MAX_FIRESTORE_REQUEST_SEGMENT_MS =
  MAX_FIRESTORE_ATTEMPTS * DEFAULT_FIRESTORE_TIMEOUT_MS +
  FIRESTORE_RETRY_BASE_MS * (2 ** (MAX_FIRESTORE_ATTEMPTS - 1) - 1);
/**
 * A reservation can lose a fixed-id create response, observe a concurrent
 * release, and repeat three create/read cycles. This is deliberately
 * conservative and excludes the one cached metadata-token acquisition.
 */
export const MAX_FIRESTORE_RESERVE_SEGMENT_MS =
  MAX_RESERVATION_CREATE_READ_CYCLES * 2 * MAX_FIRESTORE_REQUEST_SEGMENT_MS;
/** Completion may need one conditional patch plus one exact-state readback. */
export const MAX_FIRESTORE_COMPLETE_SEGMENT_MS = 2 * MAX_FIRESTORE_REQUEST_SEGMENT_MS;

/**
 * Durable, dependency-light Firestore ledger used by generated Cloud Run
 * runtimes. Reservations use Firestore create preconditions; completion and
 * release use update-time preconditions so one instance can never overwrite or
 * delete another instance's reservation. An in-progress reservation is never
 * reclaimed automatically: without a bounded upstream execution time, a lease
 * expiry could execute a still-running mutation twice. Recovery is therefore a
 * deliberate operator action after checking the upstream.
 */
export class FirestoreLedger implements IdempotencyLedger {
  readonly durable = true;
  private readonly fetchImpl: typeof fetch;
  private readonly mintToken: () => Promise<string>;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly resultTtlMs: number;
  private readonly readinessCacheMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly reservationId: () => string;
  private readonly documentsBase: string;
  private readonly collection: string;
  private readonly owned = new Map<string, OwnedReservation>();
  private metadata?: { token: string; expEpochMs: number };
  private readinessCache?: { value: LedgerReadiness; expiresAt: number };
  private readinessInFlight?: Promise<LedgerReadiness>;

  constructor(uri: string, options: FirestoreLedgerOptions = {}) {
    const { project, database, namespace } = parseFirestoreUri(uri);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.mintToken = options.metadataToken ?? (() => this.defaultMetadataToken());
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FIRESTORE_TIMEOUT_MS;
    this.resultTtlMs = options.resultTtlMs ?? DEFAULT_LEDGER_RESULT_TTL_MS;
    this.readinessCacheMs = options.readinessCacheMs ?? DEFAULT_LEDGER_READINESS_CACHE_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.reservationId = options.reservationId ?? randomUUID;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new Error("Firestore ledger timeoutMs must be an integer from 100 to 60000.");
    }
    if (
      !Number.isSafeInteger(this.resultTtlMs) ||
      this.resultTtlMs < 1_000 ||
      this.resultTtlMs > MAX_LEDGER_RESULT_TTL_MS
    ) {
      throw new Error("Firestore ledger resultTtlMs must be an integer from 1000 to 31536000000.");
    }
    if (
      !Number.isSafeInteger(this.readinessCacheMs) ||
      this.readinessCacheMs < 0 ||
      this.readinessCacheMs > 5 * 60_000
    ) {
      throw new Error("Firestore ledger readinessCacheMs must be an integer from 0 to 300000.");
    }
    const databaseBase =
      `${FIRESTORE_API}/projects/${encodeURIComponent(project)}` +
      `/databases/${encodeURIComponent(database)}`;
    this.documentsBase = `${databaseBase}/documents`;
    this.collection = firestoreLedgerCollection(namespace);
  }

  /**
   * Exercise the exact database and collection with a field-masked, one-row
   * list. This is a live data-plane permission check but never creates,
   * updates, or deletes a document, and never reads cached result payloads.
   */
  async checkReadiness(): Promise<LedgerReadiness> {
    const cached = this.readinessCache;
    if (cached && this.now() < cached.expiresAt) return cached.value;
    if (this.readinessInFlight) return this.readinessInFlight;

    const probe = this.performReadinessCheck();
    this.readinessInFlight = probe;
    try {
      const value = await probe;
      const cacheMs = value.ready
        ? this.readinessCacheMs
        : Math.min(this.readinessCacheMs, FAILED_LEDGER_READINESS_CACHE_MS);
      this.readinessCache = { value, expiresAt: this.now() + cacheMs };
      return value;
    } finally {
      if (this.readinessInFlight === probe) this.readinessInFlight = undefined;
    }
  }

  async reserve(
    key: string,
    fingerprint: string,
    context?: LedgerReservationContext,
  ): Promise<LedgerReserveResult> {
    const documentId = ledgerDocumentId(key);
    const reference = this.reference(documentId);
    const reservationId = this.reservationId();
    if (!/^[\x21-\x7e]{1,128}$/.test(reservationId)) {
      throw new Error("Firestore reservation id is invalid.");
    }
    const createUrl =
      `${this.documentsBase}/${this.collection}` + `?documentId=${encodeURIComponent(documentId)}`;

    for (let attempt = 0; attempt < MAX_RESERVATION_CREATE_READ_CYCLES; attempt += 1) {
      const created = await this.requestWithTransientRetry(createUrl, {
        method: "POST",
        body: JSON.stringify({
          fields: {
            status: { stringValue: "in_progress" },
            fingerprint: { stringValue: fingerprint },
            reservation_id: { stringValue: reservationId },
            started_at: { timestampValue: new Date(this.now()).toISOString() },
            ...firestoreReservationMetadata(context),
          },
        }),
      });
      if (created.response.ok) {
        const document = requireFirestoreDocument(created.json);
        this.owned.set(key, {
          fingerprint,
          reservationId,
          updateTime: requireUpdateTime(document),
        });
        return { outcome: "reserved", reference };
      }
      if (created.response.status !== 409) {
        throw firestoreFailure("reserve", created.response.status);
      }

      const current = await this.requestWithTransientRetry(this.documentUrl(documentId), {
        method: "GET",
      });
      // The document can disappear between create and read when a failed owner
      // releases it. Retry the atomic create rather than treating that race as
      // an error.
      if (current.response.status === 404) continue;
      if (!current.response.ok) {
        throw firestoreFailure("read reservation", current.response.status);
      }
      const document = requireFirestoreDocument(current.json);
      const fields = document.fields ?? {};
      if (fields.status?.stringValue === "completed") {
        const expiresAt = requireCompletedExpiry(fields);
        if (expiresAt <= this.now()) {
          await this.deleteExpiredCompleted(documentId, requireUpdateTime(document));
          continue;
        }
        if (fields.fingerprint?.stringValue !== fingerprint) {
          return { outcome: "conflict" };
        }
        const serialized = fields.result_json?.stringValue;
        if (serialized === undefined) {
          throw new Error("Firestore ledger completed entry has no result.");
        }
        return {
          outcome: "replay",
          result: JSON.parse(serialized),
          status: completedResponseStatus(fields),
        };
      }
      if (fields.status?.stringValue !== "in_progress") {
        throw new Error("Firestore ledger entry has an invalid status.");
      }
      if (fields.fingerprint?.stringValue !== fingerprint) {
        return { outcome: "conflict" };
      }
      // A fixed-document create is idempotent, but its response can be lost
      // after Firestore committed it. Only the invocation whose unguessable
      // ownership token is stored may recover that reservation and execute.
      if (fields.reservation_id?.stringValue === reservationId) {
        this.owned.set(key, {
          fingerprint,
          reservationId,
          updateTime: requireUpdateTime(document),
        });
        return { outcome: "reserved", reference };
      }
      return { outcome: "in_progress", reference };
    }
    return { outcome: "in_progress", reference };
  }

  async complete(key: string, result: unknown, status = 200): Promise<void> {
    const reservation = this.owned.get(key);
    if (!reservation) {
      throw new Error("Cannot complete a Firestore reservation not owned by this process.");
    }
    assertSuccessfulResponseStatus(status);
    const serialized = JSON.stringify(result) ?? "null";
    if (Buffer.byteLength(serialized, "utf8") > MAX_LEDGER_RESULT_BYTES) {
      throw new Error("Idempotency result exceeds the Firestore ledger byte limit.");
    }
    const expiresAt = new Date(this.now() + this.resultTtlMs).toISOString();
    let completed: { response: Response; json: unknown };
    try {
      completed = await this.requestWithTransientRetry(
        this.patchUrl(
          ledgerDocumentId(key),
          [
            "status",
            "fingerprint",
            "result_json",
            "response_status",
            "expires_at",
            "reservation_id",
          ],
          reservation.updateTime,
        ),
        {
          method: "PATCH",
          body: JSON.stringify({
            fields: {
              status: { stringValue: "completed" },
              fingerprint: { stringValue: reservation.fingerprint },
              result_json: { stringValue: serialized },
              response_status: { integerValue: String(status) },
              expires_at: { timestampValue: expiresAt },
            },
          }),
        },
      );
    } catch {
      // Every attempted conditional PATCH can have committed immediately before
      // the connection failed. Reconcile the exact intended state before
      // reporting failure; never release the reservation on an unknown result.
      if (await this.completedExactly(key, reservation, serialized, status, expiresAt)) {
        this.deleteOwnedIfCurrent(key, reservation);
        return;
      }
      throw new Error("Firestore completion could not be confirmed after bounded retries.");
    }
    if (!completed.response.ok) {
      // A conditional PATCH can commit while its response is lost. A retry
      // then correctly fails its old update-time precondition. Reconcile after
      // every terminal response, because a proxy can also surface a generic
      // transient status after Firestore accepted the write.
      const reconciled = await this.completedExactly(
        key,
        reservation,
        serialized,
        status,
        expiresAt,
      );
      if (reconciled) {
        this.deleteOwnedIfCurrent(key, reservation);
        return;
      }
      if (isPreconditionFailure(completed)) {
        throw new Error("Firestore reservation ownership changed before completion.");
      }
      throw firestoreFailure("complete reservation", completed.response.status);
    }
    this.deleteOwnedIfCurrent(key, reservation);
  }

  async release(key: string): Promise<void> {
    const reservation = this.owned.get(key);
    if (!reservation) return;
    const url =
      `${this.documentUrl(ledgerDocumentId(key))}` +
      `?currentDocument.updateTime=${encodeURIComponent(reservation.updateTime)}`;
    const released = await this.requestWithTransientRetry(url, { method: "DELETE" });
    this.deleteOwnedIfCurrent(key, reservation);
    if (
      !released.response.ok &&
      released.response.status !== 404 &&
      !isPreconditionFailure(released)
    ) {
      throw firestoreFailure("release reservation", released.response.status);
    }
  }

  private documentUrl(documentId: string): string {
    return `${this.documentsBase}/${this.collection}/${encodeURIComponent(documentId)}`;
  }

  private reference(documentId: string): string {
    return `firestore/${this.collection}/${documentId}`;
  }

  private patchUrl(documentId: string, fields: string[], updateTime: string): string {
    const query = new URLSearchParams();
    for (const field of fields) query.append("updateMask.fieldPaths", field);
    query.set("currentDocument.updateTime", updateTime);
    return `${this.documentUrl(documentId)}?${query.toString()}`;
  }

  private async performReadinessCheck(): Promise<LedgerReadiness> {
    const query = new URLSearchParams();
    query.set("pageSize", "1");
    // Only the lifecycle marker is needed. Never fetch result_json, which can
    // contain application response data.
    query.append("mask.fieldPaths", "status");
    let result: { response: Response; json: unknown };
    try {
      result = await this.requestWithTransientRetry(
        `${this.documentsBase}/${this.collection}?${query}`,
        {
          method: "GET",
        },
      );
    } catch {
      return { ready: false, code: "unavailable" };
    }
    if (result.response.ok) {
      if (!isFirestoreListResponse(result.json)) {
        return { ready: false, code: "invalid_response" };
      }
      return { ready: true, code: "ok" };
    }
    if (result.response.status === 401 || result.response.status === 403) {
      return { ready: false, code: "permission_denied" };
    }
    if (result.response.status === 404) {
      return { ready: false, code: "database_not_found" };
    }
    return { ready: false, code: "unavailable" };
  }

  private async deleteExpiredCompleted(documentId: string, updateTime: string): Promise<void> {
    const url =
      `${this.documentUrl(documentId)}` +
      `?currentDocument.updateTime=${encodeURIComponent(updateTime)}`;
    const deleted = await this.requestWithTransientRetry(url, { method: "DELETE" });
    if (
      !deleted.response.ok &&
      deleted.response.status !== 404 &&
      !isPreconditionFailure(deleted)
    ) {
      throw firestoreFailure("expire completed result", deleted.response.status);
    }
  }

  private async request(
    url: string,
    init: RequestInit,
  ): Promise<{ response: Response; json: unknown }> {
    const token = await this.mintToken();
    const response = await this.fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...Object.fromEntries(new Headers(init.headers).entries()),
      },
    });
    const text = await boundedResponseText(response, MAX_FIRESTORE_RESPONSE_BYTES);
    let json: unknown;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error("Firestore returned an invalid JSON response.");
      }
    }
    return { response, json };
  }

  /**
   * Firestore calls here are safe to retry: reads are side-effect free, creates
   * use a fixed document id, and mutations carry an update-time precondition.
   * A lost successful PATCH is reconciled by `complete`; a lost DELETE becomes
   * 404/precondition-failed and is already treated as success by its caller.
   */
  private async requestWithTransientRetry(
    url: string,
    init: RequestInit,
  ): Promise<{ response: Response; json: unknown }> {
    let lastResponse: { response: Response; json: unknown } | undefined;
    for (let attempt = 1; attempt <= MAX_FIRESTORE_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.request(url, init);
        lastResponse = result;
        if (
          !isTransientFirestoreStatus(result.response.status) ||
          attempt === MAX_FIRESTORE_ATTEMPTS
        ) {
          return result;
        }
      } catch {
        if (attempt === MAX_FIRESTORE_ATTEMPTS) {
          throw new Error("Firestore ledger request failed after bounded retries.");
        }
      }
      await this.sleep(FIRESTORE_RETRY_BASE_MS * 2 ** (attempt - 1));
    }
    if (lastResponse) return lastResponse;
    throw new Error("Firestore ledger request failed after bounded retries.");
  }

  private async completedExactly(
    key: string,
    reservation: OwnedReservation,
    serialized: string,
    status: number,
    expiresAt: string,
  ): Promise<boolean> {
    let current: { response: Response; json: unknown };
    try {
      current = await this.requestWithTransientRetry(this.documentUrl(ledgerDocumentId(key)), {
        method: "GET",
      });
    } catch {
      return false;
    }
    if (!current.response.ok) return false;
    const fields = requireFirestoreDocument(current.json).fields ?? {};
    return (
      fields.status?.stringValue === "completed" &&
      fields.fingerprint?.stringValue === reservation.fingerprint &&
      fields.result_json?.stringValue === serialized &&
      completedResponseStatus(fields) === status &&
      fields.expires_at?.timestampValue === expiresAt
    );
  }

  private deleteOwnedIfCurrent(key: string, reservation: OwnedReservation): void {
    if (this.owned.get(key)?.updateTime === reservation.updateTime) {
      this.owned.delete(key);
    }
  }

  private async defaultMetadataToken(): Promise<string> {
    if (this.metadata && this.now() < this.metadata.expEpochMs) return this.metadata.token;
    const response = await this.fetchImpl(METADATA_TOKEN_URL, {
      headers: { "metadata-flavor": "Google" },
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Firestore credential acquisition failed (${response.status}).`);
    }
    const text = await boundedResponseText(response, 16 * 1024);
    let body: { access_token?: string; expires_in?: number };
    try {
      body = JSON.parse(text) as { access_token?: string; expires_in?: number };
    } catch {
      throw new Error("Firestore credential acquisition returned invalid JSON.");
    }
    if (!body.access_token) {
      throw new Error("Firestore credential acquisition returned no access token.");
    }
    const ttlMs = Math.max(0, (body.expires_in ?? 3600) * 1000 - 60_000);
    this.metadata = { token: body.access_token, expEpochMs: this.now() + ttlMs };
    return body.access_token;
  }
}

function parseFirestoreUri(uri: string): {
  project: string;
  database: string;
  namespace: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("ANVIL_LEDGER Firestore URI is invalid.");
  }
  if (
    parsed.protocol !== "firestore:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("ANVIL_LEDGER must be firestore://PROJECT/DATABASE/SERVICE_NAMESPACE.");
  }
  const project = parsed.hostname;
  let segments: string[];
  try {
    segments = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    throw new Error("ANVIL_LEDGER Firestore database is invalid.");
  }
  const [database, namespace] = segments;
  if (!/^[a-z0-9](?:[a-z0-9:.-]{0,61}[a-z0-9])?$/.test(project)) {
    throw new Error("ANVIL_LEDGER Firestore project is invalid.");
  }
  if (
    segments.length !== 2 ||
    !database ||
    !/^(?:\(default\)|[a-z](?:[a-z0-9-]{2,61}[a-z0-9])?)$/.test(database)
  ) {
    throw new Error("ANVIL_LEDGER Firestore database is invalid.");
  }
  if (!namespace || !/^[a-zA-Z0-9_.~-]{1,128}$/.test(namespace)) {
    throw new Error("ANVIL_LEDGER Firestore namespace is invalid.");
  }
  return { project, database, namespace };
}

function ledgerDocumentId(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function firestoreReservationMetadata(
  context: LedgerReservationContext | undefined,
): Record<string, { stringValue: string }> {
  const operationId = safeCorrelationValue(context?.operationId);
  const traceId = safeCorrelationValue(context?.traceId);
  return {
    ...(operationId ? { operation_id: { stringValue: operationId } } : {}),
    ...(traceId ? { trace_id: { stringValue: traceId } } : {}),
  };
}

function safeCorrelationValue(value: string | undefined): string | undefined {
  return value && /^[\x21-\x7e]{1,200}$/.test(value) ? value : undefined;
}

/** Collection group name shared by the runtime and generated Terraform TTL policy. */
export function firestoreLedgerCollection(namespace: string): string {
  if (!/^[a-zA-Z0-9_.~-]{1,128}$/.test(namespace)) {
    throw new Error("Firestore ledger namespace is invalid.");
  }
  return (
    `${FIRESTORE_COLLECTION_PREFIX}_` +
    createHash("sha256").update(namespace).digest("hex").slice(0, 16)
  );
}

function requireFirestoreDocument(value: unknown): FirestoreDocument {
  if (!value || typeof value !== "object") {
    throw new Error("Firestore returned an invalid document.");
  }
  return value as FirestoreDocument;
}

function requireCompletedExpiry(fields: NonNullable<FirestoreDocument["fields"]>): number {
  const timestamp = fields.expires_at?.timestampValue;
  const epochMs = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(epochMs)) {
    // Legacy/unbounded completed rows must not be replayed indefinitely. An
    // operator can inspect and remove them after checking the upstream.
    throw new Error("Firestore ledger completed entry has no valid expiry.");
  }
  return epochMs;
}

function completedResponseStatus(fields: NonNullable<FirestoreDocument["fields"]>): number {
  const raw = fields.response_status?.integerValue;
  // Rows written by runtimes before response-status persistence are safe to
  // replay with the historical behavior (200). New malformed rows fail closed.
  if (raw === undefined) return 200;
  const status = Number(raw);
  assertSuccessfulResponseStatus(status);
  return status;
}

function assertSuccessfulResponseStatus(status: number): void {
  if (!Number.isSafeInteger(status) || status < 200 || status >= 300) {
    throw new Error("Idempotency ledger response status must be an integer from 200 to 299.");
  }
}

function isFirestoreListResponse(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const documents = (value as { documents?: unknown }).documents;
  return documents === undefined || Array.isArray(documents);
}

function requireUpdateTime(document: FirestoreDocument): string {
  if (!document.updateTime || !Number.isFinite(Date.parse(document.updateTime))) {
    throw new Error("Firestore document has no valid update time.");
  }
  return document.updateTime;
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new Error("Firestore response exceeds the byte limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Firestore response exceeds the byte limit.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function firestoreFailure(action: string, status: number): Error {
  return new Error(`Firestore ledger could not ${action} (${status}).`);
}

function isPreconditionFailure(result: { response: Response; json: unknown }): boolean {
  if (result.response.status === 409 || result.response.status === 412) return true;
  if (result.response.status !== 400 || !result.json || typeof result.json !== "object") {
    return false;
  }
  const error = (result.json as { error?: { status?: unknown; code?: unknown } }).error;
  return error?.status === "FAILED_PRECONDITION" || error?.code === 9;
}

function isTransientFirestoreStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

/* -------------------------------------------------------------------------- */
/* Ledger selection (Firestore built in; other durable backends are plugins)   */
/* -------------------------------------------------------------------------- */

/** Builds a durable ledger from a backend URI (e.g. `firestore://project/database/service`). */
export type LedgerFactory = (uri: string) => IdempotencyLedger;

const ledgerBackends = new Map<string, LedgerFactory>();

/**
 * Register a durable ledger backend under a scheme. The generated Cloud Run
 * path has a built-in Firestore backend; operators can register another
 * implementation (or deliberately override Firestore) before resolution.
 */
export function registerLedgerBackend(scheme: string, factory: LedgerFactory): void {
  ledgerBackends.set(scheme, factory);
}

/**
 * Resolve the idempotency ledger for a runtime instance. Precedence:
 *   1. `ANVIL_LEDGER=<scheme>://…` → the registered durable backend (fails if
 *      the scheme is unregistered, so a misconfigured prod deploy never boots
 *      into a false-safety state).
 *   2. no ledger configured → in-memory (durable=false). Safe for `dev` and
 *      single-instance use; the executor fails closed on required-idempotency
 *      mutations outside `dev` (see the durable-ledger gate in `execute`).
 */
export function resolveLedger(
  uri?: string,
  firestoreOptions: FirestoreLedgerOptions = {},
): IdempotencyLedger {
  if (uri && uri.length > 0) {
    const scheme = uri.split("://", 1)[0] ?? uri;
    const factory = ledgerBackends.get(scheme);
    if (factory) return factory(uri);
    if (scheme === "firestore") return new FirestoreLedger(uri, firestoreOptions);
    throw new Error(
      `No idempotency ledger backend registered for scheme "${scheme}" (ANVIL_LEDGER=${uri}). ` +
        `Register one with registerLedgerBackend("${scheme}", …) before boot.`,
    );
  }
  return new InMemoryLedger();
}
