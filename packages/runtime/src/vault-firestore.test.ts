import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConnectionVault,
  CredentialUnavailableError,
  type StoredConnection,
  VaultCredentialResolver,
  VaultUnavailableError,
  vaultRecordId,
} from "./vault.js";
import { FakeKms, InMemoryFirestore } from "./vault-fakes.js";
import {
  DEK_CACHE_MS,
  FirestoreVault,
  isKmsKeyName,
  restFirestoreStore,
  restKmsClient,
  type VaultDocument,
} from "./vault-firestore.js";

/**
 * The Firestore vault (Anvil contract v2, item 1), tested with in-memory
 * Firestore and KMS fakes only: no network, no emulator, no real Google
 * service. The REST clients are exercised against a scripted `fetch`.
 */

const KEY = "projects/p/locations/global/keyRings/r/cryptoKeys/k";
const OTHER_KEY = "projects/p/locations/global/keyRings/r/cryptoKeys/other";

function connection(overrides: Partial<StoredConnection> = {}): StoredConnection {
  const stamp = "2026-01-01T00:00:00.000Z";
  return {
    sub: "by:v1:aaa",
    connector: "github",
    account: "default",
    kind: "oauth",
    status: "active",
    accessToken: "access-PLAINTEXT-1",
    refreshToken: "refresh-PLAINTEXT-1",
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

function fixture(now: () => number = Date.now) {
  const store = new InMemoryFirestore();
  const kms = new FakeKms();
  const vault = new FirestoreVault({ store, kms, kmsKey: KEY, now });
  return { store, kms, vault };
}

function firstDoc(store: InMemoryFirestore): [string, VaultDocument] {
  const entry = [...store.docs][0];
  if (!entry) throw new Error("no document stored");
  return entry;
}

describe("FirestoreVault", () => {
  it("round-trips a connection through Firestore and KMS, across instances", async () => {
    const { store, kms, vault } = fixture();
    await vault.put(connection());
    // A second gateway instance: same Firestore and KMS, empty key cache.
    const other = new FirestoreVault({ store, kms, kmsKey: KEY });
    expect(await other.get("by:v1:aaa", "github", "default")).toEqual(connection());
    expect(await other.get("by:v1:aaa", "github", "work")).toBeUndefined();
    expect(await other.get("by:v1:bbb", "github", "default")).toBeUndefined();
  });

  it("stores the file vault's document id and only ciphertext, a wrapped key, and coordinates", async () => {
    const { store, vault } = fixture();
    await vault.put(
      connection({ kind: "static", secret: "pat-PLAINTEXT", accessToken: undefined }),
    );
    const [path, doc] = firstDoc(store);
    expect(path).toBe(`anvil_vault/${vaultRecordId("by:v1:aaa", "github", "default")}`);
    expect(doc).toMatchObject({
      v: 2,
      sub: "by:v1:aaa",
      connector: "github",
      account: "default",
      kind: "static",
      status: "active",
      kms_key_version: `${KEY}/cryptoKeyVersions/1`,
    });
    expect(Object.keys(doc).sort()).toEqual(
      [
        "account",
        "ciphertext",
        "connector",
        "created_at",
        "iv",
        "kind",
        "kms_key_version",
        "status",
        "sub",
        "tag",
        "updated_at",
        "v",
        "wrapped_dek",
      ].sort(),
    );
    // No field, in any encoding, carries the secret.
    for (const value of Object.values(doc)) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
      for (const form of [
        bytes.toString("utf8"),
        bytes.toString("base64"),
        bytes.toString("hex"),
      ]) {
        expect(form).not.toContain("PLAINTEXT");
        expect(form).not.toContain(Buffer.from("PLAINTEXT").toString("base64").slice(0, 8));
      }
    }
  });

  it("uses a fresh data key for every write", async () => {
    const { store, vault } = fixture();
    await vault.put(connection());
    const first = [...store.docs.values()][0]?.wrapped_dek.toString("hex");
    await vault.put(connection({ updatedAt: "2026-01-02T00:00:00.000Z" }));
    const second = [...store.docs.values()][0]?.wrapped_dek.toString("hex");
    expect(first).not.toBe(second);
    expect(store.docs.size).toBe(1);
  });

  it("refuses a document copied to other coordinates", async () => {
    const { store, vault } = fixture();
    await vault.put(connection());
    const [path, doc] = firstDoc(store);
    const moved = vaultRecordId("by:v1:bbb", "github", "default");
    store.docs.set(`anvil_vault/${moved}`, { ...doc, sub: "by:v1:bbb" });
    expect(path).not.toContain(moved);
    await expect(vault.get("by:v1:bbb", "github", "default")).rejects.toThrow();
    // The same document under its own sub field but another connector.
    const moved2 = vaultRecordId("by:v1:aaa", "linear", "default");
    store.docs.set(`anvil_vault/${moved2}`, { ...doc, connector: "linear" });
    await expect(vault.get("by:v1:aaa", "linear", "default")).rejects.toThrow();
    // And it does not appear in the other person's listing.
    expect(await vault.list("by:v1:bbb")).toEqual([]);
  });

  it("refuses tampered ciphertext, tag, IV, and wrapped key", async () => {
    for (const field of ["ciphertext", "tag", "iv", "wrapped_dek"] as const) {
      const { store, vault, kms } = fixture();
      await vault.put(connection());
      const [path, doc] = firstDoc(store);
      const tampered = Buffer.from(doc[field]);
      tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
      store.docs.set(path, { ...doc, [field]: tampered });
      // A cold instance, so the cached key cannot mask the tampering.
      const cold = new FirestoreVault({ store, kms, kmsKey: KEY });
      await expect(cold.get("by:v1:aaa", "github", "default")).rejects.toThrow();
    }
  });

  it("refuses a record wrapped under a different KMS key", async () => {
    const { store, kms, vault } = fixture();
    await vault.put(connection());
    const other = new FirestoreVault({ store, kms, kmsKey: OTHER_KEY });
    await expect(other.get("by:v1:aaa", "github", "default")).rejects.toThrow(/different KMS key/);
    // Even a document relabelled with the other key's name: KMS will not unwrap it.
    const [path, doc] = firstDoc(store);
    store.docs.set(path, { ...doc, kms_key_version: `${OTHER_KEY}/cryptoKeyVersions/1` });
    await expect(other.get("by:v1:aaa", "github", "default")).rejects.toThrow(/unwrapped/);
  });

  it("fails with VaultUnavailableError when KMS or Firestore is down, and never serves a key past 60 seconds", async () => {
    let now = 1_000_000;
    const { store, kms, vault } = fixture(() => now);
    await vault.put(connection());
    const cold = new FirestoreVault({ store, kms, kmsKey: KEY, now: () => now });
    await cold.get("by:v1:aaa", "github", "default"); // one KMS decrypt, key cached
    const decrypts = kms.calls.decrypt;
    kms.down = true;
    // Within the window the cached key serves the read without KMS.
    expect((await cold.get("by:v1:aaa", "github", "default"))?.accessToken).toBe(
      "access-PLAINTEXT-1",
    );
    expect(kms.calls.decrypt).toBe(decrypts);
    now += DEK_CACHE_MS + 1;
    await expect(cold.get("by:v1:aaa", "github", "default")).rejects.toBeInstanceOf(
      VaultUnavailableError,
    );
    await expect(cold.put(connection())).rejects.toBeInstanceOf(VaultUnavailableError);
    kms.down = false;
    store.down = true;
    await expect(cold.get("by:v1:aaa", "github", "default")).rejects.toBeInstanceOf(
      VaultUnavailableError,
    );
    await expect(cold.list("by:v1:aaa")).rejects.toBeInstanceOf(VaultUnavailableError);
    await expect(cold.delete("by:v1:aaa", "github", "default")).rejects.toBeInstanceOf(
      VaultUnavailableError,
    );
  });

  it("lists only the owner's connections, without secrets", async () => {
    const { vault } = fixture();
    await vault.put(connection());
    await vault.put(connection({ connector: "linear", kind: "static", secret: "lin-PLAINTEXT" }));
    await vault.put(connection({ sub: "by:v1:bbb", account: "bobs" }));
    const mine = await vault.list("by:v1:aaa");
    expect(mine.map((c) => `${c.connector}/${c.account}`)).toEqual([
      "github/default",
      "linear/default",
    ]);
    expect(JSON.stringify(mine)).not.toContain("PLAINTEXT");
  });

  it("deletes one record, reports whether one existed, and leaves others", async () => {
    const { store, vault } = fixture();
    await vault.put(connection());
    await vault.put(connection({ sub: "by:v1:bbb" }));
    expect(await vault.delete("by:v1:aaa", "github", "default")).toBe(true);
    expect(await vault.delete("by:v1:aaa", "github", "default")).toBe(false);
    expect(await vault.get("by:v1:aaa", "github", "default")).toBeUndefined();
    expect(await vault.get("by:v1:bbb", "github", "default")).toBeDefined();
    expect(store.docs.size).toBe(1);
  });

  it("serializes in-process refreshes of one connection", async () => {
    const { vault } = fixture();
    const order: string[] = [];
    const slow = vault.withLock("by:v1:aaa", "github", "default", async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("a-end");
    });
    const next = vault.withLock("by:v1:aaa", "github", "default", async () => {
      order.push("b");
    });
    await Promise.all([slow, next]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  it("rejects a KMS key that is not a crypto key name", () => {
    expect(isKmsKeyName(KEY)).toBe(true);
    expect(isKmsKeyName(`${KEY}/cryptoKeyVersions/1`)).toBe(false);
    expect(
      () => new FirestoreVault({ store: new InMemoryFirestore(), kms: new FakeKms(), kmsKey: "k" }),
    ).toThrow(/ANVIL_VAULT_KMS_KEY/);
  });

  it("serves the credential resolver, and maps an unavailable vault to a retryable error that does not ask to reconnect", async () => {
    const { store, vault } = fixture();
    await vault.put(
      connection({
        kind: "static",
        secret: "pat-1",
        accessToken: undefined,
        refreshToken: undefined,
      }),
    );
    const resolver = new VaultCredentialResolver(vault, () => undefined);
    const auth = { type: "jwt_bearer", scopes: [] } as never;
    const material = await resolver.resolve("default", auth, {
      principalId: "by:v1:aaa",
      connector: "github",
    });
    expect(material).toEqual({ headers: { Authorization: "Bearer pat-1" } });
    store.down = true;
    const failure = await resolver
      .resolve("default", auth, { principalId: "by:v1:aaa", connector: "github" })
      .catch((error) => error);
    expect(failure).toBeInstanceOf(CredentialUnavailableError);
    expect(failure.details.code).toBe("connector/vault_unavailable");
    expect(failure.toAnvilError("op", "t")).toMatchObject({
      code: "upstream_unavailable",
      retryable: true,
    });
  });
});

describe("the file vault is unchanged", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps its synchronous API and its record id", () => {
    const dir = mkdtempSync(join(tmpdir(), "anvil-vault-fs-"));
    dirs.push(dir);
    const vault = new ConnectionVault(dir, Buffer.alloc(32, 7));
    vault.put(connection());
    expect(vault.get("by:v1:aaa", "github", "default")).toEqual(connection());
    expect(vault.list("by:v1:aaa")).toHaveLength(1);
    expect(vault.delete("by:v1:aaa", "github", "default")).toBe(true);
    expect(vault.delete("by:v1:aaa", "github", "default")).toBe(false);
    expect(vault.get("by:v1:aaa", "github", "default")).toBeUndefined();
  });
});

describe("the REST clients", () => {
  function scripted(responses: Array<{ status: number; body: unknown }>) {
    const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      calls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify(response.body), { status: response.status });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it("wraps and unwraps with the KMS REST API using the supplied access token", async () => {
    const { calls, fetchImpl } = scripted([
      { status: 200, body: { name: `${KEY}/cryptoKeyVersions/3`, ciphertext: "d3JhcHBlZA==" } },
      { status: 200, body: { plaintext: Buffer.alloc(32, 1).toString("base64") } },
      { status: 400, body: { error: { status: "INVALID_ARGUMENT" } } },
      { status: 503, body: {} },
    ]);
    const kms = restKmsClient({ fetchImpl, accessToken: async () => "tok" });
    const aad = Buffer.from("aad");
    expect(await kms.encrypt(KEY, Buffer.alloc(32, 1), aad)).toEqual({
      ciphertext: Buffer.from("wrapped"),
      keyVersion: `${KEY}/cryptoKeyVersions/3`,
    });
    expect(calls[0]).toMatchObject({
      url: `https://cloudkms.googleapis.com/v1/${KEY}:encrypt`,
      auth: "Bearer tok",
      body: { additionalAuthenticatedData: aad.toString("base64") },
    });
    expect(await kms.decrypt(KEY, Buffer.from("wrapped"), aad)).toEqual(Buffer.alloc(32, 1));
    // A refusal is an unreadable record; a 5xx is an unavailable service.
    await expect(kms.decrypt(KEY, Buffer.from("x"), aad)).rejects.not.toBeInstanceOf(
      VaultUnavailableError,
    );
    await expect(kms.decrypt(KEY, Buffer.from("x"), aad)).rejects.toBeInstanceOf(
      VaultUnavailableError,
    );
  });

  it("reads, queries, and writes Firestore documents in transactions", async () => {
    const doc = {
      v: 2,
      sub: "s",
      connector: "c",
      account: "a",
      kind: "static",
      status: "active",
      created_at: "t",
      updated_at: "t",
      wrapped_dek: Buffer.from("w"),
      kms_key_version: `${KEY}/cryptoKeyVersions/1`,
      iv: Buffer.from("i"),
      ciphertext: Buffer.from("c"),
      tag: Buffer.from("t"),
    };
    const written: unknown[] = [];
    const { calls, fetchImpl } = scripted([
      { status: 200, body: { transaction: "tx1" } }, // begin
      { status: 404, body: {} }, // read: absent
      { status: 409, body: {} }, // commit aborted
      { status: 200, body: { transaction: "tx2" } },
      { status: 404, body: {} },
      { status: 200, body: {} }, // commit
    ]);
    const store = restFirestoreStore({ project: "p", fetchImpl, accessToken: async () => "tok" });
    await store.transact("anvil_vault", "id1", (current) => {
      written.push(current);
      return doc;
    });
    expect(written).toEqual([undefined, undefined]);
    const commit = calls.at(-1);
    expect(commit?.url).toBe(
      "https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents:commit",
    );
    expect(JSON.stringify(commit?.body)).toContain(
      "projects/p/databases/(default)/documents/anvil_vault/id1",
    );
    expect(JSON.stringify(commit?.body)).toContain('"transaction":"tx2"');
    // The commit body carries bytes as base64 fields, never a bare secret.
    expect(JSON.stringify(commit?.body)).toContain('"bytesValue"');
  });
});
