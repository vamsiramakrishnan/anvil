/**
 * The inbound webhook receiver (design doc `docs/design/async-events-and-callbacks.md`
 * §14). Serves two shapes that are architecturally identical: a third-party
 * webhook (Stripe, GitHub, Twilio, PayPal, Shopify — §11) and a queue-push
 * delivery (GCP Pub/Sub push — §12), which is the same "verify, then complete
 * a ledger row" flow with `oidc_jwt` in place of an HMAC scheme.
 *
 * Five steps, in this exact order, because the order IS the safety property:
 *
 *   1. Verify the sender per `contract.signatureVerification`. Reject `401`
 *      before the ledger is touched or the body is parsed further — for ANY
 *      scheme failure, with no exceptions. An unverified payload can be
 *      forged by anyone who finds the receiver URL, so nothing downstream of
 *      verification may run on unverified bytes.
 *   2. Parse `rawBody` and extract `webhookJobIdField` (and, if present,
 *      `webhookStateField`).
 *   3. Resolve the upstream job id to the ledger row that reserved it.
 *      `IdempotencyLedger` is addressed by the *caller's* idempotency key —
 *      a different value space than the *upstream's* job id in the general
 *      case (a Stripe payment intent id is not, and must never be treated
 *      as, an Anvil idempotency key). Calling `complete(jobId, ...)` directly
 *      would either miss the row entirely or, worse, collide with an
 *      unrelated one. `findBySecondaryKey` is the index a submit operation's
 *      own `complete()` call wrote (`packages/runtime/src/idempotency.ts`)
 *      the moment the upstream handed back that job id.
 *   4. Write the resolved completion. See `handleWebhook`'s body for exactly
 *      how — the short version is that this delivery gets its own reserve/
 *      complete pair, namespaced under the resolved idempotency key, so a
 *      byte-identical retried delivery replays instead of double-applying,
 *      while genuinely distinct deliveries for the same job (e.g. a
 *      `pending` webhook followed later by a `completed` one) each still
 *      land as their own recorded write.
 *   5. Always return `200` once durably written, or on a duplicate delivery.
 *      Never let a downstream failure make the provider believe a delivery
 *      that never landed did.
 *
 * Fail-closed posture matches the rest of this codebase: no verifiable
 * scheme match -> reject. A ledger backend that cannot resolve job ids back
 * to reservations (`findBySecondaryKey` absent) -> reject explicitly, never
 * silently no-op. An ambiguous ledger write outcome -> throw, never guess a
 * status code. Every test exercising this module runs as a pure function of
 * (payload, headers, contract, a fake ledger) — no deployed server, no real
 * network, matching the design doc's own "unit-testable without a deployed
 * server" claim.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Operation, WebhookContract, WebhookSignatureVerification } from "@anvil/air";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { hostIsAllowed } from "./config.js";
import { type IdempotencyLedger, idempotencyKeyIsTransportSafe } from "./idempotency.js";

/** Everything `handleWebhook` needs beyond the AIR contract and the ledger. */
export interface HandleWebhookParams {
  /** The compiled webhook-receiver operation (`archetype: "webhook_receiver"`). */
  operation: Operation;
  contract: WebhookContract;
  /**
   * The exact bytes as received, before any parsing. Required — HMAC and
   * signature verification must run over the literal wire bytes, never a
   * `JSON.parse`/re-`JSON.stringify` round trip, which is not guaranteed to
   * reproduce the original byte sequence a sender signed.
   */
  rawBody: Buffer;
  /** Inbound headers. Looked up case-insensitively; casing from the wire is fine. */
  headers: Record<string, string>;
  /** The exact URL the sender POSTed to. Twilio's signature covers the URL, not just the body. */
  requestUrl: string;
  /** The SAME ledger instance the executor uses for this service. */
  ledger: IdempotencyLedger;
  /**
   * Resolves any `*Ref` field on `WebhookSignatureVerification`
   * (`secretRef`, `credentialRef`, `verifyEndpointRef`, `expectedAudienceRef`)
   * to its configured material. One seam for all of them, deliberately: AIR
   * models every one of these as an indirect reference rather than a literal
   * (the same "never hardcode secret storage" doctrine `CredentialResolver`
   * already follows in `auth.ts`), and none of them are secrets in every
   * case — `verifyEndpointRef` resolves to a URL, `expectedAudienceRef` to an
   * audience string — so this is named generically rather than
   * `resolveSecret`. Returns `undefined` for an unconfigured ref; every
   * caller of this seam treats that as a verification failure, never a skip.
   */
  resolveRef: (ref: string) => Promise<string | undefined>;
  /** Egress allowlist for `remote_verify`'s outbound call and `oidc_jwt`'s JWKS discovery (`RuntimeConfig.allowedHosts`). */
  allowedHosts: string[];
  /** Runtime environment string, for the same dev-only allowance `hostIsAllowed` already grants elsewhere. */
  env: string;
  /** Test/production seam for every outbound call this module makes. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam for time-bound checks (Stripe's replay-tolerance window). */
  now?: () => number;
}

/**
 * The receiver's only three decidable outcomes (design doc §14). A ledger or
 * other backend failure that cannot be safely mapped to one of these is
 * deliberately NOT forced into this union — `handleWebhook` throws instead
 * (see its body), so the caller can return a real `5xx` and let the
 * provider's normal retry behavior recover, rather than this function
 * inventing a misleading status. "Ambiguous state -> refuse, don't guess."
 */
export type WebhookOutcome =
  | { status: 200 }
  | { status: 401; reason: string }
  | { status: 400; reason: string };

type SignatureResult = { ok: true } | { ok: false; reason: string };

interface SignatureContext {
  rawBody: Buffer;
  headers: Record<string, string>;
  requestUrl: string;
  resolveRef: (ref: string) => Promise<string | undefined>;
  allowedHosts: string[];
  env: string;
  fetchImpl: typeof fetch;
  now: () => number;
}

/** Stripe's own documented replay-tolerance window for `Stripe-Signature`'s `t=` field. */
const STRIPE_REPLAY_TOLERANCE_SECONDS = 300;
const OUTBOUND_TIMEOUT_MS = 10_000;
/** Generous but bounded — verification/discovery responses are small JSON documents, never application data. */
const MAX_OUTBOUND_RESPONSE_BYTES = 64 * 1024;

export async function handleWebhook(params: HandleWebhookParams): Promise<WebhookOutcome> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const now = params.now ?? Date.now;
  const sigCtx: SignatureContext = {
    rawBody: params.rawBody,
    headers: params.headers,
    requestUrl: params.requestUrl,
    resolveRef: params.resolveRef,
    allowedHosts: params.allowedHosts,
    env: params.env,
    fetchImpl,
    now,
  };

  // Step 1. No scheme skips this, and nothing below runs until it passes.
  const verification = await verifySignature(params.contract.signatureVerification, sigCtx);
  if (!verification.ok) {
    return { status: 401, reason: verification.reason };
  }

  // Step 2. Parsed loosely (no ajv/JSON-Schema dependency in this runtime
  // today, matching how the rest of this package treats wire payloads once
  // signature-verified — `execute()` doesn't validate upstream response
  // bodies against `output.schema` either): extract exactly the two dotted
  // coordinates the contract names, nothing more.
  let parsed: unknown;
  try {
    parsed = parseWebhookBody(params.rawBody, params.headers);
  } catch {
    return { status: 400, reason: "payload could not be parsed" };
  }
  const jobId = stringAtPath(parsed, params.contract.webhookJobIdField);
  if (jobId === undefined) {
    return {
      status: 400,
      reason: `'${params.contract.webhookJobIdField}' is missing from the webhook payload`,
    };
  }
  const state = params.contract.webhookStateField
    ? stringAtPath(parsed, params.contract.webhookStateField)
    : undefined;

  // Step 3. Fail closed and EXPLICIT if this ledger backend cannot resolve
  // job ids at all — never silently no-op a webhook that could carry a real
  // completion.
  if (!params.ledger.findBySecondaryKey) {
    return {
      status: 400,
      reason: "this ledger backend does not support job-handle index lookups",
    };
  }
  const idempotencyKey = await params.ledger.findBySecondaryKey(jobId);
  if (idempotencyKey === undefined) {
    // Deliberate, documented choice (pinned by webhook-receiver.test.ts): a
    // job id the index has never seen gets `400`, not `200` and not a
    // best-effort "orphaned completion" record. There is no reservation to
    // complete, so there is nothing safe to acknowledge as durably written;
    // and providers generally only retry a `>=500`/`429`, so `400` correctly
    // tells them this exact delivery will never resolve rather than inviting
    // an infinite retry loop. In practice the race this guards is narrow:
    // the submit operation's own `complete()` call — which writes the index
    // — runs synchronously, before its HTTP response even reaches the
    // caller, let alone before the provider could have fired a callback.
    return { status: 400, reason: `no reservation is indexed for job id '${jobId}'` };
  }

  // Step 4. This delivery's own reserve/complete pair, namespaced under the
  // RESOLVED idempotency key (never the raw job id, per step 3's own
  // reasoning). It is deliberately its own row rather than a second write
  // onto the submit operation's already-completed row: `complete()`
  // (`idempotency.ts`) refuses to re-complete an entry that isn't
  // `in_progress`, by design — that precondition is exactly what stops an
  // ordinary duplicate mutation retry from corrupting an unrelated replay
  // cache, and relaxing it globally to accommodate webhooks would weaken
  // that guarantee for every other caller. Keying by a hash of the exact
  // payload bytes gives the right granularity for free: a byte-identical
  // retried delivery (the provider re-sending because it lost the `200`)
  // reserves the SAME key and replays; a genuinely new delivery for the same
  // job (e.g. `pending` followed later by `completed`) hashes differently
  // and is recorded as its own write, not rejected as a conflict.
  const deliveryDigest = createHash("sha256").update(params.rawBody).digest("hex").slice(0, 40);
  const webhookLedgerKey = `${idempotencyKey}#webhook:${deliveryDigest}`;
  if (!idempotencyKeyIsTransportSafe(webhookLedgerKey)) {
    // The idempotency key this derives from is already guaranteed transport-
    // safe by whatever produced it; a fixed-width hex suffix keeps this
    // derived key inside the same bound in every realistic case. Fail closed
    // rather than hand an unsafe key to the ledger on the exotic path where
    // it doesn't.
    return { status: 400, reason: "derived webhook ledger key is not transport-safe" };
  }

  let reservation: Awaited<ReturnType<IdempotencyLedger["reserve"]>>;
  try {
    reservation = await params.ledger.reserve(webhookLedgerKey, deliveryDigest, {
      operationId: params.operation.id,
    });
  } catch (err) {
    // A ledger write failure must never be told to the provider as `200`
    // (the delivery may not be durably recorded) and must not be guessed
    // into `400`/`401` either (this is not a client error). Throw and let the
    // caller surface a real `5xx`, which the provider will legitimately
    // retry.
    throw new Error(`Webhook ledger reservation failed for '${params.operation.id}'.`, {
      cause: err,
    });
  }
  if (reservation.outcome === "replay" || reservation.outcome === "in_progress") {
    // Same job id, byte-identical payload, already recorded (or being
    // recorded right now by a concurrent delivery of the same retry).
    // Acknowledge without reapplying — step 5.
    return { status: 200 };
  }
  if (reservation.outcome === "conflict") {
    // The key is derived deterministically from the payload's own hash; a
    // fingerprint mismatch under it should be structurally impossible.
    // Refuse rather than guess if it somehow happens.
    throw new Error(
      `Webhook ledger reservation reported an impossible fingerprint conflict for '${params.operation.id}'.`,
    );
  }

  const result: Record<string, unknown> = { jobId, ...(state === undefined ? {} : { state }) };
  try {
    await params.ledger.complete(webhookLedgerKey, result, 200);
  } catch (err) {
    throw new Error(`Webhook ledger completion failed for '${params.operation.id}'.`, {
      cause: err,
    });
  }
  return { status: 200 };
}

/** Dispatch on `WebhookSignatureVerification.scheme` — the only place this module trusts a payload. */
async function verifySignature(
  verification: WebhookSignatureVerification,
  ctx: SignatureContext,
): Promise<SignatureResult> {
  switch (verification.scheme) {
    case "hmac_sha256_header":
      return verifyHmacSha256Header(verification, ctx);
    case "provider_sdk":
      return verifyProviderSdk(verification, ctx);
    case "remote_verify":
      return verifyRemoteVerify(verification, ctx);
    case "oidc_jwt":
      return verifyOidcJwt(verification, ctx);
    default: {
      // Exhaustiveness guard: a fifth scheme added to the AIR union without a
      // branch here must fail closed, not fall through silently.
      const unreachable: never = verification;
      return {
        ok: false,
        reason: `unrecognized signature scheme '${(unreachable as { scheme: string }).scheme}'`,
      };
    }
  }
}

/**
 * Raw-body HMAC, digest carried in one header (GitHub, Shopify, and the
 * generic `hmac_sha256_header` case). Uses `crypto.timingSafeEqual` rather
 * than `===` — a MAC comparison must not leak timing information about how
 * many leading bytes matched.
 */
async function verifyHmacSha256Header(
  verification: Extract<WebhookSignatureVerification, { scheme: "hmac_sha256_header" }>,
  ctx: SignatureContext,
): Promise<SignatureResult> {
  const secret = await ctx.resolveRef(verification.secretRef);
  if (!secret) return { ok: false, reason: "signing secret is not configured" };
  const provided = headerLookup(ctx.headers, verification.headerName);
  if (!provided) return { ok: false, reason: `missing '${verification.headerName}' header` };
  const value = stripPrefix(provided, verification.valuePrefix);
  if (value === undefined)
    return { ok: false, reason: "signature header has an unexpected prefix" };
  const expected = createHmac("sha256", secret).update(ctx.rawBody).digest(verification.encoding);
  return constantTimeEqual(value, expected)
    ? { ok: true }
    : { ok: false, reason: "signature mismatch" };
}

/**
 * Per-provider logic a generic HMAC scheme cannot express. GitHub and Shopify
 * are both plain raw-body HMAC-SHA256 and are expressed by delegating to
 * `verifyHmacSha256Header` with the provider's own header/encoding — they are
 * NOT unified into one code path with Stripe or Twilio, which are genuinely
 * different computations (composite timestamped header; signed material
 * other than the body), per the design doc's explicit instruction not to try.
 */
async function verifyProviderSdk(
  verification: Extract<WebhookSignatureVerification, { scheme: "provider_sdk" }>,
  ctx: SignatureContext,
): Promise<SignatureResult> {
  switch (verification.provider) {
    case "github":
      return verifyHmacSha256Header(
        {
          scheme: "hmac_sha256_header",
          headerName: "X-Hub-Signature-256",
          encoding: "hex",
          valuePrefix: "sha256=",
          secretRef: verification.secretRef,
        },
        ctx,
      );
    case "shopify":
      return verifyHmacSha256Header(
        {
          scheme: "hmac_sha256_header",
          headerName: "X-Shopify-Hmac-Sha256",
          encoding: "base64",
          secretRef: verification.secretRef,
        },
        ctx,
      );
    case "stripe":
      return verifyStripeSignature(verification, ctx);
    case "twilio":
      return verifyTwilioSignature(verification, ctx);
  }
}

/**
 * Stripe's composite `Stripe-Signature: t=<timestamp>,v1=<hex hmac>` header,
 * computed over `"{timestamp}.{raw_body}"` — not the raw body alone, and not
 * expressible by `hmac_sha256_header`. Includes Stripe's own documented
 * replay-tolerance check: a signature with a valid MAC but a stale timestamp
 * is still rejected, because a captured valid signature would otherwise be
 * replayable forever.
 */
async function verifyStripeSignature(
  verification: { secretRef: string },
  ctx: SignatureContext,
): Promise<SignatureResult> {
  const secret = await ctx.resolveRef(verification.secretRef);
  if (!secret) return { ok: false, reason: "signing secret is not configured" };
  const header = headerLookup(ctx.headers, "Stripe-Signature");
  if (!header) return { ok: false, reason: "missing 'Stripe-Signature' header" };

  const parts = new Map<string, string[]>();
  for (const segment of header.split(",")) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const k = segment.slice(0, eq).trim();
    const v = segment.slice(eq + 1).trim();
    const list = parts.get(k) ?? [];
    list.push(v);
    parts.set(k, list);
  }
  const timestamp = parts.get("t")?.[0];
  const signatures = parts.get("v1") ?? [];
  if (!timestamp || signatures.length === 0) {
    return { ok: false, reason: "malformed Stripe-Signature header" };
  }
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: "malformed Stripe-Signature timestamp" };
  }
  const nowSeconds = Math.floor(ctx.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > STRIPE_REPLAY_TOLERANCE_SECONDS) {
    return {
      ok: false,
      reason: "Stripe-Signature timestamp is outside the replay-tolerance window",
    };
  }
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${ctx.rawBody.toString("utf8")}`)
    .digest("hex");
  const matched = signatures.some((candidate) => constantTimeEqual(candidate, expected));
  return matched ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

/**
 * Twilio's `X-Twilio-Signature`: `base64(HMAC-SHA1(auth_token, full_url +
 * sorted_POST_params))` — signed material is the URL plus the form body's
 * own key/value pairs concatenated in sorted-key order, NOT the raw body
 * itself and NOT SHA-256. A genuinely different computation from every other
 * scheme here, per the design doc's explicit instruction not to unify it.
 */
async function verifyTwilioSignature(
  verification: { secretRef: string },
  ctx: SignatureContext,
): Promise<SignatureResult> {
  const authToken = await ctx.resolveRef(verification.secretRef);
  if (!authToken) return { ok: false, reason: "auth token is not configured" };
  const provided = headerLookup(ctx.headers, "X-Twilio-Signature");
  if (!provided) return { ok: false, reason: "missing 'X-Twilio-Signature' header" };

  const params = new URLSearchParams(ctx.rawBody.toString("utf8"));
  const sortedKeys = Array.from(new Set(params.keys())).sort();
  let material = ctx.requestUrl;
  for (const key of sortedKeys) {
    for (const value of params.getAll(key)) {
      material += key + value;
    }
  }
  const expected = createHmac("sha1", authToken).update(material).digest("base64");
  return constantTimeEqual(provided, expected)
    ? { ok: true }
    : { ok: false, reason: "signature mismatch" };
}

/**
 * PayPal-shaped: verification is an outbound call to the provider's own
 * verify endpoint rather than a local computation. Gated through
 * `hostIsAllowed`/`RuntimeConfig.allowedHosts` BEFORE the call is made — an
 * unlisted host fails closed exactly like any other egress this runtime
 * makes, from the start, not as an afterthought (design doc §15).
 *
 * `credentialRef` resolves to a JSON object `{"accessToken":"...",
 * "webhookId":"..."}` rather than a single opaque string: PayPal's real
 * verify call needs both a bearer credential AND the configured webhook id,
 * and `WebhookSignatureVerification`'s AIR shape (frozen ahead of this
 * phase) carries only one ref field for both. Packing them as one resolved
 * JSON value keeps this module inside the existing `resolveRef` seam instead
 * of inventing a second one.
 */
async function verifyRemoteVerify(
  verification: Extract<WebhookSignatureVerification, { scheme: "remote_verify" }>,
  ctx: SignatureContext,
): Promise<SignatureResult> {
  const endpoint = await ctx.resolveRef(verification.verifyEndpointRef);
  if (!endpoint) return { ok: false, reason: "verify endpoint is not configured" };
  if (!hostIsAllowed(endpoint, ctx.allowedHosts, ctx.env)) {
    return { ok: false, reason: "verify endpoint host is not on the egress allowlist" };
  }
  const credentialRaw = await ctx.resolveRef(verification.credentialRef);
  if (!credentialRaw) return { ok: false, reason: "verification credential is not configured" };
  let credential: { accessToken?: string; webhookId?: string };
  try {
    credential = JSON.parse(credentialRaw) as { accessToken?: string; webhookId?: string };
  } catch {
    return { ok: false, reason: "verification credential is malformed" };
  }
  if (!credential.accessToken || !credential.webhookId) {
    return { ok: false, reason: "verification credential is missing required fields" };
  }

  let event: unknown;
  try {
    event = JSON.parse(ctx.rawBody.toString("utf8"));
  } catch {
    return { ok: false, reason: "payload is not valid JSON" };
  }
  const transmissionId = headerLookup(ctx.headers, "paypal-transmission-id");
  const transmissionTime = headerLookup(ctx.headers, "paypal-transmission-time");
  const certUrl = headerLookup(ctx.headers, "paypal-cert-url");
  const authAlgo = headerLookup(ctx.headers, "paypal-auth-algo");
  const transmissionSig = headerLookup(ctx.headers, "paypal-transmission-sig");
  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    return { ok: false, reason: "missing PayPal transmission headers" };
  }

  let outcome: { response: Response; json: unknown };
  try {
    outcome = await boundedFetchJson(
      endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential.accessToken}`,
        },
        body: JSON.stringify({
          transmission_id: transmissionId,
          transmission_time: transmissionTime,
          cert_url: certUrl,
          auth_algo: authAlgo,
          transmission_sig: transmissionSig,
          webhook_id: credential.webhookId,
          webhook_event: event,
        }),
      },
      ctx.fetchImpl,
    );
  } catch {
    return { ok: false, reason: "verification endpoint call failed" };
  }
  if (!outcome.response.ok) {
    return { ok: false, reason: `verification endpoint returned ${outcome.response.status}` };
  }
  const status = (outcome.json as { verification_status?: string } | null)?.verification_status;
  return status === "SUCCESS"
    ? { ok: true }
    : { ok: false, reason: "verification endpoint rejected the signature" };
}

/**
 * Signed JWT bearer verified against the issuer's own public keys (GCP
 * Pub/Sub push — §12). AIR's `oidc_jwt` shape carries `expectedIssuer` but no
 * JWKS URI directly, so this performs standard OIDC discovery
 * (`{issuer}/.well-known/openid-configuration` -> `jwks_uri`) before handing
 * the result to `jose`'s `createRemoteJWKSet` + `jwtVerify`. Both the
 * discovery fetch and the JWKS fetch are gated through `hostIsAllowed` —
 * the design doc calls this out explicitly only for `remote_verify`, but the
 * same "every outbound call is egress, every egress is gated" posture is
 * applied here too, for consistency rather than leaving one push-verification
 * path ungated by accident.
 *
 * Deliberately builds a fresh `createRemoteJWKSet` per call rather than
 * caching one across invocations: this module's tests inject a distinct
 * `fetchImpl` per test, and jose's remote key set caches BOTH the resolved
 * keys and (implicitly) whichever fetch implementation built it — a
 * process-lifetime cache would leak one test's fake network into another's,
 * or into production. A real deployment re-paying the discovery+JWKS fetch
 * per delivery is a reasonable place to add a keyed cache later; it is not
 * a correctness requirement of this phase.
 */
async function verifyOidcJwt(
  verification: Extract<WebhookSignatureVerification, { scheme: "oidc_jwt" }>,
  ctx: SignatureContext,
): Promise<SignatureResult> {
  const audience = await ctx.resolveRef(verification.expectedAudienceRef);
  if (!audience) return { ok: false, reason: "expected audience is not configured" };
  const header = headerLookup(ctx.headers, verification.headerName);
  if (!header) return { ok: false, reason: `missing '${verification.headerName}' header` };
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;

  const issuer = verification.expectedIssuer.replace(/\/+$/, "");
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  if (!hostIsAllowed(discoveryUrl, ctx.allowedHosts, ctx.env)) {
    return { ok: false, reason: "issuer discovery host is not on the egress allowlist" };
  }
  let discovery: { jwks_uri?: string };
  try {
    const { json } = await boundedFetchJson(discoveryUrl, { method: "GET" }, ctx.fetchImpl);
    discovery = json as { jwks_uri?: string };
  } catch {
    return { ok: false, reason: "issuer discovery failed" };
  }
  if (!discovery.jwks_uri || !hostIsAllowed(discovery.jwks_uri, ctx.allowedHosts, ctx.env)) {
    return { ok: false, reason: "issuer JWKS host is not on the egress allowlist" };
  }

  let jwksUrl: URL;
  try {
    jwksUrl = new URL(discovery.jwks_uri);
  } catch {
    return { ok: false, reason: "issuer JWKS uri is invalid" };
  }
  const jwks = createRemoteJWKSet(jwksUrl, {
    // jose's own docs note real typing friction here between its minimal
    // fetch shape and the DOM `fetch` signature this runtime's seam uses;
    // the cast is confined to this one call site.
    [customFetch]: ctx.fetchImpl as unknown as Parameters<typeof createRemoteJWKSet>[1] extends {
      [customFetch]?: infer F;
    }
      ? F
      : never,
  });
  try {
    await jwtVerify(token, jwks, { issuer: verification.expectedIssuer, audience });
    return { ok: true };
  } catch {
    return { ok: false, reason: "JWT verification failed" };
  }
}

/** Case-insensitive header lookup — wire header casing is not a contract. */
function headerLookup(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function stripPrefix(value: string, prefix: string | undefined): string | undefined {
  if (!prefix) return value;
  return value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

/** Constant-time comparison for a MAC/signature value. Never `===` for this. */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Loosely parse a webhook body by content type: JSON for every scheme except
 * Twilio's classic form-encoded POST, which this receiver also decodes into
 * a plain object so `webhookJobIdField`/`webhookStateField` extraction works
 * identically regardless of wire encoding.
 */
function parseWebhookBody(rawBody: Buffer, headers: Record<string, string>): unknown {
  const contentType = headerLookup(headers, "content-type") ?? "";
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

function valueAtDottedPath(value: unknown, dottedPath: string): unknown {
  const segments = dottedPath.split(".").filter(Boolean);
  let current: unknown = value;
  for (const segment of segments) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringAtPath(value: unknown, dottedPath: string): string | undefined {
  const found = valueAtDottedPath(value, dottedPath);
  if (typeof found === "string" && found.length > 0) return found;
  if (typeof found === "number" && Number.isFinite(found)) return String(found);
  return undefined;
}

/** Bounded-size JSON fetch shared by `remote_verify` and `oidc_jwt`'s discovery/JWKS calls. */
async function boundedFetchJson(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<{ response: Response; json: unknown }> {
  const response = await fetchImpl(url, {
    ...init,
    redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
  });
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_OUTBOUND_RESPONSE_BYTES) {
    throw new Error("outbound response exceeds the byte limit");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_OUTBOUND_RESPONSE_BYTES) {
    throw new Error("outbound response exceeds the byte limit");
  }
  let json: unknown = null;
  if (text.length > 0) {
    json = JSON.parse(text);
  }
  return { response, json };
}
