import { createHmac } from "node:crypto";
import { type Operation, Operation as OperationSchema, type WebhookContract } from "@anvil/air";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import type { IdempotencyLedger, LedgerReserveResult } from "./idempotency.js";
import { InMemoryLedger } from "./idempotency.js";
import { handleWebhook } from "./webhook-receiver.js";

function webhookOperation(): Operation {
  return OperationSchema.parse({
    id: "payments.webhooks.receive",
    canonicalName: "receive_payment_webhook",
    displayName: "Receive payment webhook",
    sourceRef: { kind: "openapi", path: "/webhooks/payments", method: "post" },
    effect: { kind: "mutation", resource: "payment_webhook", risk: "low", reversible: true },
    input: { params: [] },
    idempotency: { mode: "none" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    archetype: "webhook_receiver",
    cli: { command: "payments webhooks receive" },
    mcp: { toolName: "payments_receive_webhook" },
    skill: { intentExamples: [] },
    state: "approved",
  });
}

/** Wraps a real ledger and records whether any method on it was ever called. */
function trackedLedger(inner: IdempotencyLedger): IdempotencyLedger & { touched: boolean } {
  const wrapper = {
    touched: false,
    durable: inner.durable,
    async reserve(...args: Parameters<IdempotencyLedger["reserve"]>): Promise<LedgerReserveResult> {
      wrapper.touched = true;
      return inner.reserve(...args);
    },
    async complete(...args: Parameters<IdempotencyLedger["complete"]>): Promise<void> {
      wrapper.touched = true;
      return inner.complete(...args);
    },
    async release(...args: Parameters<IdempotencyLedger["release"]>): Promise<void> {
      wrapper.touched = true;
      return inner.release(...args);
    },
    async findBySecondaryKey(jobId: string): Promise<string | undefined> {
      wrapper.touched = true;
      return inner.findBySecondaryKey?.(jobId);
    },
  };
  return wrapper;
}

/** A ledger that has already recorded a submit completion indexed under `jobId`. */
async function ledgerWithIndexedJob(jobId: string, idempotencyKey = "caller-key-1") {
  const ledger = new InMemoryLedger();
  await ledger.reserve(idempotencyKey, "submit-fingerprint");
  await ledger.complete(idempotencyKey, { status: "pending", job: { id: jobId } }, 202, jobId);
  return ledger;
}

const baseParams = {
  operation: webhookOperation(),
  requestUrl: "https://runtime.example.com/webhooks/payments",
  allowedHosts: ["runtime.example.com", "issuer.example.com", "verify.paypal.example.com"],
  env: "prod",
};

describe("handleWebhook — hmac_sha256_header (GitHub/Shopify-shaped)", () => {
  const contract: WebhookContract = {
    webhookOperationId: "payments.webhooks.receive",
    webhookJobIdField: "job.id",
    webhookStateField: "job.state",
    signatureVerification: {
      scheme: "hmac_sha256_header",
      headerName: "X-Hub-Signature-256",
      encoding: "hex",
      valuePrefix: "sha256=",
      secretRef: "webhook_secret",
    },
  };
  const secret = "shh-its-a-secret";
  const rawBody = Buffer.from(JSON.stringify({ job: { id: "job-42", state: "completed" } }));
  const validSig = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const resolveRef = async (ref: string) => (ref === "webhook_secret" ? secret : undefined);

  it("valid signature proceeds and completes the indexed job", async () => {
    const ledger = await ledgerWithIndexedJob("job-42");
    const result = await handleWebhook({
      ...baseParams,
      contract,
      rawBody,
      headers: { "content-type": "application/json", "x-hub-signature-256": validSig },
      ledger,
      resolveRef,
    });
    expect(result).toEqual({ status: 200 });
  });

  it("invalid signature returns 401 before the ledger is touched", async () => {
    const inner = await ledgerWithIndexedJob("job-42");
    const ledger = trackedLedger(inner);
    const result = await handleWebhook({
      ...baseParams,
      contract,
      rawBody,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=" + "0".repeat(64),
      },
      ledger,
      resolveRef,
    });
    expect(result).toEqual({ status: 401, reason: "signature mismatch" });
    expect(ledger.touched).toBe(false);
  });

  it("missing signature header returns 401 before the ledger is touched", async () => {
    const inner = await ledgerWithIndexedJob("job-42");
    const ledger = trackedLedger(inner);
    const result = await handleWebhook({
      ...baseParams,
      contract,
      rawBody,
      headers: { "content-type": "application/json" },
      ledger,
      resolveRef,
    });
    expect(result.status).toBe(401);
    expect(ledger.touched).toBe(false);
  });

  it("unconfigured secret returns 401 before the ledger is touched", async () => {
    const inner = await ledgerWithIndexedJob("job-42");
    const ledger = trackedLedger(inner);
    const result = await handleWebhook({
      ...baseParams,
      contract,
      rawBody,
      headers: { "content-type": "application/json", "x-hub-signature-256": validSig },
      ledger,
      resolveRef: async () => undefined,
    });
    expect(result.status).toBe(401);
    expect(ledger.touched).toBe(false);
  });

  it("duplicate delivery (same job id, byte-identical payload) replays 200 without double-applying", async () => {
    const ledger = await ledgerWithIndexedJob("job-42");
    const params = {
      ...baseParams,
      contract,
      rawBody,
      headers: { "content-type": "application/json", "x-hub-signature-256": validSig },
      ledger,
      resolveRef,
    };
    const first = await handleWebhook(params);
    const second = await handleWebhook(params);
    expect(first).toEqual({ status: 200 });
    expect(second).toEqual({ status: 200 });
  });

  it("a job id the index has never seen returns 400, not 200", async () => {
    const ledger = new InMemoryLedger(); // nothing indexed
    const result = await handleWebhook({
      ...baseParams,
      contract,
      rawBody,
      headers: { "content-type": "application/json", "x-hub-signature-256": validSig },
      ledger,
      resolveRef,
    });
    expect(result.status).toBe(400);
  });

  it("a ledger backend with no findBySecondaryKey support fails closed with 400, not a silent no-op", async () => {
    const bare: IdempotencyLedger = {
      durable: true,
      reserve: async () => ({ outcome: "reserved" }),
      complete: async () => {},
      release: async () => {},
      // findBySecondaryKey intentionally omitted
    };
    const result = await handleWebhook({
      ...baseParams,
      contract,
      rawBody,
      headers: { "content-type": "application/json", "x-hub-signature-256": validSig },
      ledger: bare,
      resolveRef,
    });
    expect(result).toEqual({
      status: 400,
      reason: "this ledger backend does not support job-handle index lookups",
    });
  });
});

describe("handleWebhook — provider_sdk: stripe", () => {
  const contract: WebhookContract = {
    webhookOperationId: "payments.webhooks.receive",
    webhookJobIdField: "data.object.id",
    signatureVerification: {
      scheme: "provider_sdk",
      provider: "stripe",
      secretRef: "stripe_secret",
    },
  };
  const secret = "whsec_test";
  const rawBody = Buffer.from(JSON.stringify({ data: { object: { id: "pi_123" } } }));
  const resolveRef = async (ref: string) => (ref === "stripe_secret" ? secret : undefined);
  const nowMs = Date.parse("2026-01-01T00:00:00.000Z");

  function stripeHeader(timestampSeconds: number, body = rawBody): string {
    const v1 = createHmac("sha256", secret)
      .update(`${timestampSeconds}.${body.toString("utf8")}`)
      .digest("hex");
    return `t=${timestampSeconds},v1=${v1}`;
  }

  it("valid composite signature within the replay window proceeds", async () => {
    const ledger = await ledgerWithIndexedJob("pi_123");
    const result = await handleWebhook({
      ...baseParams,
      contract,
      rawBody,
      headers: { "stripe-signature": stripeHeader(Math.floor(nowMs / 1000)) },
      ledger,
      resolveRef,
      now: () => nowMs,
    });
    expect(result).toEqual({ status: 200 });
  });

  it("a stale timestamp outside the replay-tolerance window returns 401 before the ledger is touched", async () => {
    const inner = await ledgerWithIndexedJob("pi_123");
    const ledger = trackedLedger(inner);
    const staleSeconds = Math.floor(nowMs / 1000) - 3600; // 1 hour old
    const result = await handleWebhook({
      ...baseParams,
      contract,
      rawBody,
      headers: { "stripe-signature": stripeHeader(staleSeconds) },
      ledger,
      resolveRef,
      now: () => nowMs,
    });
    expect(result.status).toBe(401);
    expect(ledger.touched).toBe(false);
  });

  it("a tampered body invalidates the signature and returns 401 before the ledger is touched", async () => {
    const inner = await ledgerWithIndexedJob("pi_123");
    const ledger = trackedLedger(inner);
    const header = stripeHeader(Math.floor(nowMs / 1000));
    const tamperedBody = Buffer.from(JSON.stringify({ data: { object: { id: "pi_999" } } }));
    const result = await handleWebhook({
      ...baseParams,
      contract,
      rawBody: tamperedBody,
      headers: { "stripe-signature": header },
      ledger,
      resolveRef,
      now: () => nowMs,
    });
    expect(result.status).toBe(401);
    expect(ledger.touched).toBe(false);
  });
});

describe("handleWebhook — provider_sdk: twilio (signed material is URL + sorted form params, not the body)", () => {
  const contract: WebhookContract = {
    webhookOperationId: "payments.webhooks.receive",
    webhookJobIdField: "CallSid",
    signatureVerification: {
      scheme: "provider_sdk",
      provider: "twilio",
      secretRef: "twilio_auth_token",
    },
  };
  const authToken = "twilio-auth-token";
  const resolveRef = async (ref: string) => (ref === "twilio_auth_token" ? authToken : undefined);
  const requestUrl = "https://runtime.example.com/webhooks/payments";
  const form = { CallSid: "CA123", From: "+15550001111", To: "+15550002222" };
  const rawBody = Buffer.from(new URLSearchParams(form).toString());

  function twilioSignature(url: string, params: Record<string, string>): string {
    let material = url;
    for (const key of Object.keys(params).sort()) {
      material += key + params[key];
    }
    return createHmac("sha1", authToken).update(material).digest("base64");
  }

  it("valid URL+params signature proceeds", async () => {
    const ledger = await ledgerWithIndexedJob("CA123");
    const result = await handleWebhook({
      ...baseParams,
      requestUrl,
      contract,
      rawBody,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilioSignature(requestUrl, form),
      },
      ledger,
      resolveRef,
    });
    expect(result).toEqual({ status: 200 });
  });

  it("a signature computed over the raw body instead of URL+params is rejected (proves the schemes are genuinely different)", async () => {
    const inner = await ledgerWithIndexedJob("CA123");
    const ledger = trackedLedger(inner);
    const bodyHmac = createHmac("sha1", authToken).update(rawBody).digest("base64");
    const result = await handleWebhook({
      ...baseParams,
      requestUrl,
      contract,
      rawBody,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": bodyHmac,
      },
      ledger,
      resolveRef,
    });
    expect(result.status).toBe(401);
    expect(ledger.touched).toBe(false);
  });
});

describe("handleWebhook — remote_verify (PayPal-shaped)", () => {
  const contract: WebhookContract = {
    webhookOperationId: "payments.webhooks.receive",
    webhookJobIdField: "resource.id",
    signatureVerification: {
      scheme: "remote_verify",
      provider: "paypal",
      verifyEndpointRef: "paypal_verify_endpoint",
      credentialRef: "paypal_credential",
    },
  };
  const rawBody = Buffer.from(JSON.stringify({ resource: { id: "WH-1" } }));
  const headers = {
    "content-type": "application/json",
    "paypal-transmission-id": "tx-1",
    "paypal-transmission-time": "2026-01-01T00:00:00Z",
    "paypal-cert-url": "https://api.paypal.com/cert",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-transmission-sig": "sig-value",
  };
  const endpoint = "https://verify.paypal.example.com/v1/notifications/verify-webhook-signature";
  const resolveRef = async (ref: string) => {
    if (ref === "paypal_verify_endpoint") return endpoint;
    if (ref === "paypal_credential") {
      return JSON.stringify({ accessToken: "access-token", webhookId: "WH-CONFIG-1" });
    }
    return undefined;
  };

  it("SUCCESS from the verify endpoint proceeds", async () => {
    const ledger = await ledgerWithIndexedJob("WH-1");
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(endpoint);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
      const body = JSON.parse(String(init?.body));
      expect(body.webhook_id).toBe("WH-CONFIG-1");
      expect(body.transmission_id).toBe("tx-1");
      return new Response(JSON.stringify({ verification_status: "SUCCESS" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await handleWebhook({
      ...baseParams,
      contract,
      rawBody,
      headers,
      ledger,
      resolveRef,
      fetchImpl,
    });
    expect(result).toEqual({ status: 200 });
  });

  it("FAILURE from the verify endpoint returns 401 before the ledger is touched", async () => {
    const inner = await ledgerWithIndexedJob("WH-1");
    const ledger = trackedLedger(inner);
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ verification_status: "FAILURE" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const result = await handleWebhook({
      ...baseParams,
      contract,
      rawBody,
      headers,
      ledger,
      resolveRef,
      fetchImpl,
    });
    expect(result.status).toBe(401);
    expect(ledger.touched).toBe(false);
  });

  it("a verify endpoint host outside the egress allowlist fails closed with 401 before any outbound call or ledger touch", async () => {
    const inner = await ledgerWithIndexedJob("WH-1");
    const ledger = trackedLedger(inner);
    const fetchImpl = vi.fn(async () => {
      throw new Error("should never be called — the host is not on the allowlist");
    }) as unknown as typeof fetch;

    const result = await handleWebhook({
      ...baseParams,
      allowedHosts: ["runtime.example.com"], // deliberately excludes verify.paypal.example.com
      contract,
      rawBody,
      headers,
      ledger,
      resolveRef,
      fetchImpl,
    });
    expect(result.status).toBe(401);
    expect(result).toMatchObject({ reason: expect.stringContaining("allowlist") });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ledger.touched).toBe(false);
  });
});

describe("handleWebhook — oidc_jwt (GCP Pub/Sub push-shaped)", () => {
  const issuer = "https://issuer.example.com";
  const contract: WebhookContract = {
    webhookOperationId: "payments.webhooks.receive",
    webhookJobIdField: "message.messageId",
    signatureVerification: {
      scheme: "oidc_jwt",
      headerName: "Authorization",
      expectedIssuer: issuer,
      expectedAudienceRef: "pubsub_audience",
    },
  };
  const rawBody = Buffer.from(JSON.stringify({ message: { messageId: "msg-1" } }));
  const resolveRef = async (ref: string) =>
    ref === "pubsub_audience" ? "https://runtime.example.com/push" : undefined;

  async function issueToken(): Promise<{ token: string; jwks: { keys: unknown[] } }> {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    (jwk as { kid?: string }).kid = "test-key-1";
    (jwk as { alg?: string }).alg = "RS256";
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuer(issuer)
      .setAudience("https://runtime.example.com/push")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    return { token, jwks: { keys: [jwk] } };
  }

  function discoveryFetch(jwks: { keys: unknown[] }): typeof fetch {
    return vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return new Response(JSON.stringify({ jwks_uri: `${issuer}/jwks` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `${issuer}/jwks`) {
        return new Response(JSON.stringify(jwks), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;
  }

  it("a validly signed token from the issuer's own keys proceeds", async () => {
    const { token, jwks } = await issueToken();
    const ledger = await ledgerWithIndexedJob("msg-1");
    const result = await handleWebhook({
      ...baseParams,
      contract,
      rawBody,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ledger,
      resolveRef,
      fetchImpl: discoveryFetch(jwks),
    });
    expect(result).toEqual({ status: 200 });
  });

  it("a token signed by an unrelated key is rejected with 401 before the ledger is touched", async () => {
    const { jwks } = await issueToken();
    const { privateKey: rogueKey } = await generateKeyPair("RS256");
    const forgedToken = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuer(issuer)
      .setAudience("https://runtime.example.com/push")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(rogueKey);

    const inner = await ledgerWithIndexedJob("msg-1");
    const ledger = trackedLedger(inner);
    const result = await handleWebhook({
      ...baseParams,
      contract,
      rawBody,
      headers: { "content-type": "application/json", authorization: `Bearer ${forgedToken}` },
      ledger,
      resolveRef,
      fetchImpl: discoveryFetch(jwks),
    });
    expect(result.status).toBe(401);
    expect(ledger.touched).toBe(false);
  });

  it("missing Authorization header returns 401 before the ledger is touched", async () => {
    const { jwks } = await issueToken();
    const inner = await ledgerWithIndexedJob("msg-1");
    const ledger = trackedLedger(inner);
    const result = await handleWebhook({
      ...baseParams,
      contract,
      rawBody,
      headers: { "content-type": "application/json" },
      ledger,
      resolveRef,
      fetchImpl: discoveryFetch(jwks),
    });
    expect(result.status).toBe(401);
    expect(ledger.touched).toBe(false);
  });

  // Phase 5 (async-events-implementation-plan.md, "Queue systems"): the two
  // cases below complete this block's coverage to match the
  // `hmac_sha256_header` (GitHub/Shopify-shaped) describe block above
  // exactly — a Pub/Sub push delivery resolves a ledger row the same way any
  // other webhook provider does. No receiver code changes; this is a
  // provider-flavored test case reusing the existing fixture helpers
  // (`ledgerWithIndexedJob`, `trackedLedger`) verbatim.
  it("duplicate delivery (same message id, byte-identical payload) replays 200 without double-applying", async () => {
    const { token, jwks } = await issueToken();
    const ledger = await ledgerWithIndexedJob("msg-1");
    const params = {
      ...baseParams,
      contract,
      rawBody,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ledger,
      resolveRef,
      fetchImpl: discoveryFetch(jwks),
    };
    const first = await handleWebhook(params);
    const second = await handleWebhook(params);
    expect(first).toEqual({ status: 200 });
    expect(second).toEqual({ status: 200 });
  });

  it("a Pub/Sub message id the index has never seen returns 400, not 200", async () => {
    const { token, jwks } = await issueToken();
    const ledger = new InMemoryLedger(); // nothing indexed
    const result = await handleWebhook({
      ...baseParams,
      contract,
      rawBody,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ledger,
      resolveRef,
      fetchImpl: discoveryFetch(jwks),
    });
    expect(result.status).toBe(400);
  });
});
