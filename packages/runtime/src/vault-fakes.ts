import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { VaultUnavailableError } from "./vault.js";
import type { KmsClient, VaultDocument, VaultDocumentStore } from "./vault-firestore.js";

/**
 * In-memory stand-ins for Firestore and Cloud KMS, for hermetic tests of the
 * Firestore vault (no network, no emulator). `InMemoryFirestore` keeps every
 * document it is given so a test can scan them for plaintext; `FakeKms` wraps
 * keys with AES-256-GCM under per-key-name secrets held in memory.
 */
export class InMemoryFirestore implements VaultDocumentStore {
  readonly docs = new Map<string, VaultDocument>();
  /** When set, every call throws `VaultUnavailableError`. */
  down = false;

  private path(collection: string, id: string): string {
    return `${collection}/${id}`;
  }

  private check(): void {
    if (this.down) throw new VaultUnavailableError("fake Firestore is down");
  }

  async get(collection: string, id: string) {
    this.check();
    const doc = this.docs.get(this.path(collection, id));
    return doc ? clone(doc) : undefined;
  }

  async listBySub(collection: string, sub: string) {
    this.check();
    const out: Array<{ id: string; doc: VaultDocument }> = [];
    for (const [path, doc] of this.docs) {
      if (path.startsWith(`${collection}/`) && doc.sub === sub) {
        out.push({ id: path.slice(collection.length + 1), doc: clone(doc) });
      }
    }
    return out;
  }

  async transact(
    collection: string,
    id: string,
    mutate: (current: VaultDocument | undefined) => VaultDocument,
  ) {
    this.check();
    const current = this.docs.get(this.path(collection, id));
    this.docs.set(this.path(collection, id), clone(mutate(current ? clone(current) : undefined)));
  }

  async remove(collection: string, id: string) {
    this.check();
    return this.docs.delete(this.path(collection, id));
  }
}

function clone(doc: VaultDocument): VaultDocument {
  return {
    ...doc,
    wrapped_dek: Buffer.from(doc.wrapped_dek),
    iv: Buffer.from(doc.iv),
    ciphertext: Buffer.from(doc.ciphertext),
    tag: Buffer.from(doc.tag),
  };
}

export class FakeKms implements KmsClient {
  private readonly secrets = new Map<string, Buffer>();
  /** When set, every call throws `VaultUnavailableError`. */
  down = false;
  readonly calls = { encrypt: 0, decrypt: 0 };

  private secret(keyName: string): Buffer {
    let secret = this.secrets.get(keyName);
    if (!secret) {
      secret = randomBytes(32);
      this.secrets.set(keyName, secret);
    }
    return secret;
  }

  async encrypt(keyName: string, plaintext: Buffer, aad: Buffer) {
    if (this.down) throw new VaultUnavailableError("fake KMS is down");
    this.calls.encrypt += 1;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.secret(keyName), iv);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]),
      keyVersion: `${keyName}/cryptoKeyVersions/1`,
    };
  }

  async decrypt(keyName: string, ciphertext: Buffer, aad: Buffer) {
    if (this.down) throw new VaultUnavailableError("fake KMS is down");
    this.calls.decrypt += 1;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.secret(keyName),
      ciphertext.subarray(0, 12),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(ciphertext.subarray(12, 28));
    return Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]);
  }
}
