import { FakeKms, FirestoreVault, InMemoryFirestore, type StoredConnection } from "@anvil/runtime";
import { describe, expect, it } from "vitest";
import { disconnectConnection } from "./fleet-disconnect.js";

const KEY = "projects/p/locations/global/keyRings/r/cryptoKeys/k";
const SUB = "by:v1:aaa";
const stamp = "2026-01-01T00:00:00.000Z";
const record: StoredConnection = {
  sub: SUB,
  connector: "github",
  account: "default",
  kind: "static",
  status: "active",
  secret: "pat-1",
  createdAt: stamp,
  updatedAt: stamp,
};

describe("disconnectConnection", () => {
  it("waits for a holder of the account lock on another instance, then deletes", async () => {
    const store = new InMemoryFirestore();
    const kms = new FakeKms();
    const a = new FirestoreVault({ store, kms, kmsKey: KEY });
    const b = new FirestoreVault({ store, kms, kmsKey: KEY, leasePollMs: 1 });
    await a.put(record);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inside: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      inside = resolve;
    });
    // A refresh on instance A: read, then (later) write back.
    const refresh = a.withLock(SUB, "github", "default", async () => {
      const current = await a.get(SUB, "github", "default");
      inside();
      await gate;
      if (current) await a.put({ ...current, updatedAt: "2026-02-02T00:00:00.000Z" });
    });
    await entered;
    let done = false;
    const disconnect = disconnectConnection({
      vault: b,
      audit: undefined,
      sub: SUB,
      claims: { sub: SUB },
      connector: "github",
      account: undefined,
    }).then((result) => {
      done = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBe(false);
    release();
    await refresh;
    expect(await disconnect).toEqual({
      connector: "github",
      account: "default",
      disconnected: true,
    });
    expect(await a.get(SUB, "github", "default")).toBeUndefined();
  });
});
