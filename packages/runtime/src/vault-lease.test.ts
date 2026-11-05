import { describe, expect, it } from "vitest";
import {
  type StoredConnection,
  VaultCredentialResolver,
  VaultUnavailableError,
  vaultRecordId,
} from "./vault.js";
import { FakeKms, InMemoryFirestore } from "./vault-fakes.js";
import { FirestoreVault, LEASE_TTL_MS } from "./vault-firestore.js";

/**
 * Cross-instance serialization of the Firestore vault (review finding: the
 * in-process lock alone let two gateway instances spend one rotating refresh
 * token twice). Tested with the in-memory Firestore and KMS fakes only: no
 * network, no emulator. Two `FirestoreVault`s over one fake are two instances.
 */

const KEY = "projects/p/locations/global/keyRings/r/cryptoKeys/k";
const SUB = "by:v1:aaa";
const AUTH = { type: "jwt_bearer", scopes: [] } as never;
const CLIENT = {
  tokenEndpoint: "https://idp.example/token",
  clientId: "cid",
  clientAuth: "none" as const,
};

function expiring(now: number): StoredConnection {
  const stamp = "2026-01-01T00:00:00.000Z";
  return {
    sub: SUB,
    connector: "github",
    account: "default",
    kind: "oauth",
    status: "active",
    accessToken: "access-old",
    refreshToken: "refresh-1",
    expiresAt: now + 1000,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

function instances(options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
  const store = new InMemoryFirestore();
  const kms = new FakeKms();
  const make = () => new FirestoreVault({ store, kms, kmsKey: KEY, ...options });
  return { store, kms, a: make(), b: make(), make };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 2));

describe("Firestore vault lease", () => {
  it("spends a rotating refresh token once across two instances", async () => {
    const { a, b } = instances();
    await a.put(expiring(Date.now()));
    const seen: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      seen.push(form.get("refresh_token") ?? "");
      await tick();
      // A rotating provider: the old token is dead once used.
      if (form.get("refresh_token") !== "refresh-1") {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json({
        access_token: "access-new",
        refresh_token: "refresh-2",
        expires_in: 3600,
      });
    }) as typeof fetch;
    const resolve = (vault: FirestoreVault) =>
      new VaultCredentialResolver(vault, () => CLIENT, { fetchImpl }).resolve("default", AUTH, {
        principalId: SUB,
        connector: "github",
      });
    const [x, y] = await Promise.all([resolve(a), resolve(b)]);
    expect(seen).toEqual(["refresh-1"]);
    expect(x).toEqual({ headers: { Authorization: "Bearer access-new" } });
    expect(y).toEqual(x);
    const stored = await a.get(SUB, "github", "default");
    expect(stored).toMatchObject({
      status: "active",
      accessToken: "access-new",
      refreshToken: "refresh-2",
    });
  });

  it("holds the lease only inside the lock and releases it, even when fn throws", async () => {
    const { store, a } = instances();
    await expect(
      a.withLock(SUB, "github", "default", async () => {
        expect(store.leases.size).toBe(1);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(store.leases.size).toBe(0);
    expect([...store.docs.keys()].some((k) => k.startsWith("anvil_vault_leases/"))).toBe(false);
  });

  it("makes a second instance wait for a live lease", async () => {
    let clock = 1_000_000;
    const { store, a, b } = instances({
      now: () => clock,
      sleep: async () => {
        clock += 10;
        await tick();
      },
    });
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = a.withLock(SUB, "github", "default", async () => {
      order.push("a-start");
      await gate;
      order.push("a-end");
    });
    await tick();
    const second = b.withLock(SUB, "github", "default", async () => {
      order.push("b");
    });
    await tick();
    await tick();
    expect(order).toEqual(["a-start"]);
    expect(store.leases.size).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
    expect(store.leases.size).toBe(0);
  });

  it("takes over a lease whose holder crashed once it has expired", async () => {
    let clock = 1_000_000;
    const { store, a } = instances({ now: () => clock });
    // A crashed holder: a lease nobody will release.
    await store.acquireLease(
      "anvil_vault_leases",
      vaultRecordId(SUB, "github", "default"),
      "crashed",
      LEASE_TTL_MS,
      clock,
    );
    let ran = false;
    clock += LEASE_TTL_MS + 1;
    await a.withLock(SUB, "github", "default", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(store.leases.size).toBe(0);
  });

  it("gives vault_unavailable when the wait deadline passes", async () => {
    let clock = 1_000_000;
    const { store, a } = instances({
      now: () => clock,
      sleep: async () => {
        clock += 5_000;
      },
    });
    await store.acquireLease(
      "anvil_vault_leases",
      vaultRecordId(SUB, "github", "default"),
      "other",
      LEASE_TTL_MS,
      clock,
    );
    let ran = false;
    const failure = await a
      .withLock(SUB, "github", "default", async () => {
        ran = true;
      })
      .catch((error) => error);
    expect(failure).toBeInstanceOf(VaultUnavailableError);
    expect(ran).toBe(false);
    // The other holder's lease is untouched.
    expect([...store.leases.values()].map((l) => l.holder)).toEqual(["other"]);
  });

  it("does not release a lease another holder has since taken", async () => {
    const store = new InMemoryFirestore();
    await store.acquireLease("c", "id", "first", 100, 0);
    await store.acquireLease("c", "id", "second", 100, 200);
    await store.releaseLease("c", "id", "first");
    expect(store.leases.get("c/id")?.holder).toBe("second");
  });

  it("orders a disconnect after a refresh that holds the lock, so the record stays gone", async () => {
    for (const crossInstance of [false, true]) {
      const { a, b } = instances();
      await a.put(expiring(Date.now()));
      let reachedProvider: () => void = () => {};
      const atProvider = new Promise<void>((resolve) => {
        reachedProvider = resolve;
      });
      let letProviderAnswer: () => void = () => {};
      const providerGate = new Promise<void>((resolve) => {
        letProviderAnswer = resolve;
      });
      const fetchImpl = (async () => {
        reachedProvider();
        await providerGate;
        return Response.json({ access_token: "access-new", expires_in: 3600 });
      }) as typeof fetch;
      const refreshing = new VaultCredentialResolver(a, () => CLIENT, { fetchImpl }).resolve(
        "default",
        AUTH,
        { principalId: SUB, connector: "github" },
      );
      await atProvider;
      const other = crossInstance ? b : a;
      const disconnecting = other.withLock(SUB, "github", "default", () =>
        other.delete(SUB, "github", "default"),
      );
      await tick();
      letProviderAnswer();
      await refreshing;
      expect(await disconnecting).toBe(true);
      expect(await a.get(SUB, "github", "default")).toBeUndefined();
    }
  });
});
