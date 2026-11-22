import { describe, expect, it } from "vitest";
import { type EnterpriseGrantRecord, EnterpriseGrantStore } from "./enterprise-oauth-store.js";
import type { EnterprisePrincipal } from "./identity.js";
import { FakeKms, InMemoryFirestore } from "./vault-fakes.js";
import { FirestoreVault, restFirestoreStore } from "./vault-firestore.js";

const kmsKey = "projects/p/locations/global/keyRings/r/cryptoKeys/k";
const alice: EnterprisePrincipal = {
  id: "alice-id",
  scopes: ["read"],
  identity: {
    subject: "alice",
    tenant: "north",
    issuer: "https://id.example",
    scopes: [],
    groups: [],
    expiresAt: 12345,
  },
};
const pending: EnterpriseGrantRecord = {
  revision: "pending-1",
  pending: {
    stateHash: "state-digest",
    browserHash: "browser-digest",
    verifier: "secret-verifier",
    expiresAt: 5000,
    principal: alice,
  },
};
const active: EnterpriseGrantRecord = {
  revision: "active-2",
  grant: {
    principal: alice,
    accessToken: "secret-access",
    refreshToken: "secret-refresh",
    expiresAt: 9000,
  },
};

function replicas() {
  const store = new InMemoryFirestore();
  const kms = new FakeKms();
  let now = 1000;
  const create = (binding = "binding-one") =>
    new EnterpriseGrantStore(
      new FirestoreVault({ store, kms, kmsKey, now: () => now, leaseTtlMs: 500 }),
      binding,
    );
  return {
    store,
    create,
    advance: () => {
      now += 1000;
    },
  };
}

describe("enterprise OAuth storage", () => {
  it("binds encrypted enrollment and grants to the customer binding and user", async () => {
    const { store, create } = replicas();
    const writer = create();
    const reader = create();
    expect(await writer.commit(alice.id, undefined, pending)).toBe(true);
    expect(await reader.read(alice.id)).toEqual(pending);
    expect(await reader.read("other-user")).toBeUndefined();
    expect(await create("binding-two").read(alice.id)).toBeUndefined();
    await expect(writer.commit("other-user", undefined, pending)).rejects.toThrow();
    const serialized = () =>
      [...store.docs.values()]
        .flatMap(Object.values)
        .map((v) => (Buffer.isBuffer(v) ? v.toString("utf8") : String(v)))
        .join(" ");
    expect(serialized()).not.toContain("secret-verifier");
    expect(await reader.commit(alice.id, pending.revision, active)).toBe(true);
    expect(serialized()).not.toContain("secret-");
    expect(await writer.read(alice.id)).toEqual(active);
  });

  it("permits exactly one concurrent callback to consume an enrollment", async () => {
    const { create } = replicas();
    const first = create();
    const second = create();
    await first.commit(alice.id, undefined, pending);
    const outcomes = await Promise.all([
      first.commit(alice.id, pending.revision, active),
      second.commit(alice.id, pending.revision, { ...active, revision: "other-callback" }),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
  });

  it("fences a stalled refresher even after lease expiry, disconnect and re-enrollment", async () => {
    const { create, advance } = replicas();
    const old = create();
    const live = create();
    await old.commit(alice.id, undefined, active);
    await old.withLock(alice.id, async () => {
      const previous = await old.read(alice.id);
      advance();
      await live.withLock(alice.id, async () => {
        expect(await live.commit(alice.id, active.revision, undefined)).toBe(true);
        expect(await live.commit(alice.id, undefined, pending)).toBe(true);
      });
      expect(
        await old.commit(alice.id, previous?.revision, { ...active, revision: "late-refresh" }),
      ).toBe(false);
      expect(await old.commit(alice.id, previous?.revision, undefined)).toBe(false);
    });
    expect(await live.read(alice.id)).toEqual(pending);
  });

  it("uses Firestore updateTime on conditional deletion and recognizes a racing write", async () => {
    const bodies: unknown[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      if (init?.method === "GET")
        return Response.json({
          updateTime: "2026-01-01T00:00:00Z",
          fields: { revision: { stringValue: "r1" } },
        });
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ error: { status: "FAILED_PRECONDITION" } }, { status: 400 });
    };
    const rest = restFirestoreStore({ project: "p", fetchImpl, accessToken: async () => "test" });
    expect(await rest.compareAndSwap?.("v", "owner", "r1", undefined)).toBe(false);
    expect(bodies).toEqual([
      {
        writes: [
          {
            delete: "projects/p/databases/(default)/documents/v/owner",
            currentDocument: { updateTime: "2026-01-01T00:00:00Z" },
          },
        ],
      },
    ]);
  });
});
