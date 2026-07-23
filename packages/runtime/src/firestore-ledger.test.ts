import { describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig } from "./config.js";
import {
  DEFAULT_LEDGER_RESULT_TTL_SECONDS,
  FirestoreLedger,
  InMemoryLedger,
  probeLedgerReadiness,
  resolveLedger,
} from "./idempotency.js";

const UPDATE_1 = "2026-07-23T10:00:00.000000Z";
const UPDATE_2 = "2026-07-23T10:00:01.000000Z";
const NOW = "2026-07-23T10:00:00.000Z";
const FUTURE_EXPIRY = "2099-01-01T00:00:00.000Z";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function conflictResponse(status = 409): Response {
  return new Response(null, { status });
}

function document(
  fields: Record<string, { stringValue?: string; timestampValue?: string }>,
  updateTime = UPDATE_1,
) {
  return { fields, updateTime };
}

describe("FirestoreLedger", () => {
  it("is the built-in durable backend for generated Cloud Run ledger URIs", () => {
    const ledger = resolveLedger("firestore://my-project/payments-ledger/payments");
    expect(ledger).toBeInstanceOf(FirestoreLedger);
    expect(ledger.durable).toBe(true);
  });

  it.each([
    "firestore://project",
    "firestore://bad_project/(default)",
    "firestore://project/database",
    "firestore://project/database/namespace/child",
    "firestore://project/UPPERCASE/namespace",
    "https://project/(default)/namespace",
    "firestore://project/(default)/namespace?unsafe=true",
  ])("rejects malformed backend URI %s", (uri) => {
    expect(() => new FirestoreLedger(uri)).toThrow(/ANVIL_LEDGER|Firestore/);
  });

  it("atomically creates and completes a reservation with an update-time precondition", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (init?.method === "POST") return jsonResponse(document({}, UPDATE_1));
      if (init?.method === "PATCH") return jsonResponse(document({}, UPDATE_2));
      throw new Error("unexpected request");
    }) as typeof fetch;
    const ledger = new FirestoreLedger("firestore://my-project/payments-ledger/payments", {
      fetchImpl,
      metadataToken: async () => "access-token",
      now: () => Date.parse(NOW),
    });

    await expect(ledger.reserve("same key", "fingerprint-a")).resolves.toEqual({
      outcome: "reserved",
    });
    await expect(ledger.complete("same key", { id: "result-1" })).resolves.toBeUndefined();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toMatch(
      /firestore\.googleapis\.com\/v1\/projects\/my-project\/databases\/payments-ledger\/documents\/anvil_idempotency_[a-f0-9]{16}\?documentId=[a-f0-9]{64}$/,
    );
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer access-token");
    expect(calls[1]?.url).toContain(`currentDocument.updateTime=${encodeURIComponent(UPDATE_1)}`);
    const completion = JSON.parse(String(calls[1]?.init?.body));
    expect(completion.fields.result_json.stringValue).toBe('{"id":"result-1"}');
    expect(completion.fields.expires_at.timestampValue).toBe("2026-07-30T10:00:00.000Z");
    expect(calls[1]?.url).toContain("updateMask.fieldPaths=expires_at");
    expect(JSON.stringify(calls)).not.toContain("same key");
  });

  it("replays a completed result only for the same request fingerprint", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(conflictResponse())
      .mockResolvedValueOnce(
        jsonResponse(
          document({
            status: { stringValue: "completed" },
            fingerprint: { stringValue: "fingerprint-a" },
            result_json: { stringValue: '{"id":"result-1"}' },
            expires_at: { timestampValue: FUTURE_EXPIRY },
          }),
        ),
      ) as typeof fetch;
    const ledger = new FirestoreLedger("firestore://my-project/payments-ledger/payments", {
      fetchImpl,
      metadataToken: async () => "access-token",
    });

    await expect(ledger.reserve("key", "fingerprint-a")).resolves.toEqual({
      outcome: "replay",
      result: { id: "result-1" },
    });
  });

  it("fails closed when an idempotency key belongs to a different request", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(conflictResponse())
      .mockResolvedValueOnce(
        jsonResponse(
          document({
            status: { stringValue: "completed" },
            fingerprint: { stringValue: "fingerprint-a" },
            result_json: { stringValue: '{"id":"result-1"}' },
            expires_at: { timestampValue: FUTURE_EXPIRY },
          }),
        ),
      ) as typeof fetch;
    const ledger = new FirestoreLedger("firestore://my-project/payments-ledger/payments", {
      fetchImpl,
      metadataToken: async () => "access-token",
    });

    await expect(ledger.reserve("key", "fingerprint-b")).resolves.toEqual({
      outcome: "conflict",
    });
  });

  it("never reclaims an in-progress entry automatically, even if a legacy lease expired", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (init?.method === "POST") return conflictResponse();
      if (init?.method === "GET") {
        return jsonResponse(
          document({
            status: { stringValue: "in_progress" },
            fingerprint: { stringValue: "fingerprint-a" },
            lease_expires_at: { timestampValue: "2026-07-23T09:59:00.000Z" },
          }),
        );
      }
      throw new Error("unexpected request");
    }) as typeof fetch;
    const ledger = new FirestoreLedger("firestore://my-project/payments-ledger/payments", {
      fetchImpl,
      metadataToken: async () => "access-token",
      now: () => Date.parse("2026-07-23T10:00:00.000Z"),
    });

    await expect(ledger.reserve("key", "fingerprint-a")).resolves.toEqual({
      outcome: "in_progress",
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => !call.startsWith("PATCH "))).toBe(true);
  });

  it("expires only completed results with a compare-and-delete before re-reserving", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      if (calls.length === 1) return conflictResponse();
      if (calls.length === 2) {
        return jsonResponse(
          document(
            {
              status: { stringValue: "completed" },
              fingerprint: { stringValue: "old-fingerprint" },
              result_json: { stringValue: '{"old":true}' },
              expires_at: { timestampValue: "2026-07-23T09:59:59.000Z" },
            },
            UPDATE_1,
          ),
        );
      }
      if (calls.length === 3) return jsonResponse({});
      if (calls.length === 4) return jsonResponse(document({}, UPDATE_2));
      throw new Error("unexpected request");
    }) as typeof fetch;
    const ledger = new FirestoreLedger("firestore://my-project/payments-ledger/payments", {
      fetchImpl,
      metadataToken: async () => "access-token",
      now: () => Date.parse(NOW),
    });

    await expect(ledger.reserve("reusable-key", "new-fingerprint")).resolves.toEqual({
      outcome: "reserved",
    });
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET", "DELETE", "POST"]);
    expect(calls[2]?.url).toContain(`currentDocument.updateTime=${encodeURIComponent(UPDATE_1)}`);
  });

  it("fails closed instead of replaying an unbounded legacy completed result", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(conflictResponse())
      .mockResolvedValueOnce(
        jsonResponse(
          document({
            status: { stringValue: "completed" },
            fingerprint: { stringValue: "fingerprint-a" },
            result_json: { stringValue: '{"legacy":true}' },
          }),
        ),
      ) as typeof fetch;
    const ledger = new FirestoreLedger("firestore://my-project/payments-ledger/payments", {
      fetchImpl,
      metadataToken: async () => "access-token",
    });

    await expect(ledger.reserve("key", "fingerprint-a")).rejects.toThrow(/valid expiry/i);
  });

  it("releases only the update-time version reserved by this process", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (init?.method === "POST") return jsonResponse(document({}, UPDATE_1));
      if (init?.method === "DELETE") return jsonResponse({});
      throw new Error("unexpected request");
    }) as typeof fetch;
    const ledger = new FirestoreLedger("firestore://my-project/payments-ledger/payments", {
      fetchImpl,
      metadataToken: async () => "access-token",
    });

    await ledger.reserve("key", "fingerprint-a");
    await ledger.release("key");

    expect(calls[1]).toContain(`currentDocument.updateTime=${encodeURIComponent(UPDATE_1)}`);
  });

  it("recognizes Firestore's real HTTP 400 FAILED_PRECONDITION ownership error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(document({}, UPDATE_1)))
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: 9, status: "FAILED_PRECONDITION" } }, 400),
      ) as typeof fetch;
    const ledger = new FirestoreLedger("firestore://my-project/payments-ledger/payments", {
      fetchImpl,
      metadataToken: async () => "access-token",
    });

    await ledger.reserve("key", "fingerprint-a");
    await expect(ledger.complete("key", { ok: true })).rejects.toThrow(/ownership changed/i);
  });

  it("treats a stale-owner release precondition as benign but not INVALID_ARGUMENT", async () => {
    const preconditionFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(document({}, UPDATE_1)))
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: 9, status: "FAILED_PRECONDITION" } }, 400),
      ) as typeof fetch;
    const preconditionLedger = new FirestoreLedger(
      "firestore://my-project/payments-ledger/payments",
      {
        fetchImpl: preconditionFetch,
        metadataToken: async () => "access-token",
      },
    );
    await preconditionLedger.reserve("key", "fingerprint-a");
    await expect(preconditionLedger.release("key")).resolves.toBeUndefined();

    const invalidFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(document({}, UPDATE_1)))
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: 3, status: "INVALID_ARGUMENT" } }, 400),
      ) as typeof fetch;
    const invalidLedger = new FirestoreLedger("firestore://my-project/payments-ledger/payments", {
      fetchImpl: invalidFetch,
      metadataToken: async () => "access-token",
    });
    await invalidLedger.reserve("key", "fingerprint-a");
    await expect(invalidLedger.release("key")).rejects.toThrow(/could not release/i);
  });

  it("uses namespace-specific collections and consumes conflict response bodies", async () => {
    const conflict = jsonResponse({ error: { status: "ALREADY_EXISTS" } }, 409);
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      if (init?.method === "POST") return conflict;
      return jsonResponse(
        document({
          status: { stringValue: "completed" },
          fingerprint: { stringValue: "fingerprint-a" },
          result_json: { stringValue: "null" },
          expires_at: { timestampValue: FUTURE_EXPIRY },
        }),
      );
    }) as typeof fetch;
    const first = new FirestoreLedger("firestore://my-project/payments-ledger/payments", {
      fetchImpl,
      metadataToken: async () => "access-token",
    });
    await first.reserve("key", "fingerprint-a");
    expect(conflict.bodyUsed).toBe(true);

    const secondFetch = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return jsonResponse(document({}, UPDATE_1));
    }) as typeof fetch;
    const second = new FirestoreLedger("firestore://my-project/payments-ledger/other-service", {
      fetchImpl: secondFetch,
      metadataToken: async () => "access-token",
    });
    await second.reserve("key", "fingerprint-a");

    const collections = urls
      .filter((url) => url.includes("documentId="))
      .map((url) => /documents\/([^?]+)/.exec(url)?.[1]);
    expect(new Set(collections).size).toBe(2);
  });

  it("mints at the fixed metadata endpoint and caches the access token", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      if (String(input).includes("metadata.google.internal")) {
        expect(new Headers(init?.headers).get("metadata-flavor")).toBe("Google");
        return jsonResponse({ access_token: "metadata-token", expires_in: 3600 });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer metadata-token");
      if (init?.method === "POST") return jsonResponse(document({}, UPDATE_1));
      return jsonResponse(document({}, UPDATE_2));
    }) as typeof fetch;
    const ledger = new FirestoreLedger("firestore://my-project/payments-ledger/payments", {
      fetchImpl,
      now: () => Date.parse("2026-07-23T10:00:00.000Z"),
    });

    await ledger.reserve("key", "fingerprint-a");
    await ledger.complete("key", { ok: true });

    expect(urls.filter((url) => url.includes("metadata.google.internal"))).toHaveLength(1);
  });

  it("probes readiness with one field-masked GET and never reads result payloads", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({});
    }) as typeof fetch;
    const ledger = new FirestoreLedger("firestore://my-project/payments-ledger/payments", {
      fetchImpl,
      metadataToken: async () => "access-token",
      now: () => Date.parse(NOW),
    });

    await expect(ledger.checkReadiness()).resolves.toEqual({ ready: true, code: "ok" });
    await expect(ledger.checkReadiness()).resolves.toEqual({ ready: true, code: "ok" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.url).toContain("pageSize=1");
    expect(calls[0]?.url).toContain("mask.fieldPaths=status");
    expect(calls[0]?.url).not.toContain("result_json");
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it.each([
    [403, "permission_denied"],
    [404, "database_not_found"],
    [503, "unavailable"],
  ] as const)("reports a safe readiness code for Firestore HTTP %s", async (status, code) => {
    const ledger = new FirestoreLedger("firestore://my-project/payments-ledger/payments", {
      fetchImpl: vi.fn(async () => jsonResponse({ error: { message: "sensitive" } }, status)),
      metadataToken: async () => "access-token",
      readinessCacheMs: 0,
    });

    await expect(ledger.checkReadiness()).resolves.toEqual({ ready: false, code });
  });

  it("fails readiness closed for required process-local or unprobeable durable ledgers", async () => {
    await expect(probeLedgerReadiness(new InMemoryLedger(), true)).resolves.toEqual({
      ready: false,
      code: "durable_ledger_required",
    });
    await expect(
      probeLedgerReadiness(
        {
          durable: true,
          reserve: async () => ({ outcome: "reserved" }),
          complete: async () => {},
          release: async () => {},
        },
        true,
      ),
    ).resolves.toEqual({ ready: false, code: "probe_unsupported" });
  });

  it("loads a bounded seven-day result TTL and rejects unsafe configuration", () => {
    expect(loadRuntimeConfig({} as NodeJS.ProcessEnv).ledgerResultTtlSeconds).toBe(
      DEFAULT_LEDGER_RESULT_TTL_SECONDS,
    );
    expect(
      loadRuntimeConfig({
        ANVIL_LEDGER_RESULT_TTL_SECONDS: "3600",
      } as NodeJS.ProcessEnv).ledgerResultTtlSeconds,
    ).toBe(3600);
    expect(() =>
      loadRuntimeConfig({
        ANVIL_LEDGER_RESULT_TTL_SECONDS: "0",
      } as NodeJS.ProcessEnv),
    ).toThrow(/ANVIL_LEDGER_RESULT_TTL_SECONDS/);
  });
});
