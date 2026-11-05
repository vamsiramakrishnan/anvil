import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  type ConnectionSummary,
  coordinates,
  KeyedLock,
  type StoredConnection,
  type VaultBackend,
  VaultUnavailableError,
  vaultRecordId,
} from "./vault.js";

/**
 * The Firestore vault backend (Anvil contract v2, item 1): each connection is
 * one Firestore document, sealed with AES-256-GCM under a fresh 32-byte data
 * key per write; Cloud KMS wraps that data key. The document holds the
 * ciphertext, the wrapped key, and non-secret coordinates — never a token or a
 * key in the clear. The coordinates JSON is the additional authenticated data
 * for both the record and the KMS wrap, so a document copied onto other
 * coordinates fails to decrypt, exactly as a file does in `ConnectionVault`.
 *
 * Firestore and KMS are reached through two small injectable clients
 * (`VaultDocumentStore`, `KmsClient`). `restFirestoreStore` and `restKmsClient`
 * are the production clients (REST over `fetch`, a metadata-server access
 * token); tests use the in-memory fakes in `vault-fakes.ts`.
 *
 * A Firestore or KMS failure is a `VaultUnavailableError`: the call fails and
 * no stale secret is returned. A document that will not decrypt throws an
 * ordinary error, which callers report as an unreadable stored connection.
 */

export const DEFAULT_VAULT_COLLECTION = "anvil_vault";
export const DEFAULT_VAULT_DATABASE = "(default)";
/** How long an unwrapped data key may be kept in process. */
export const DEK_CACHE_MS = 60_000;

const DEK_BYTES = 32;
const RECORD_VERSION = 2;

/** One vault document as plain values. Secret material lives only in `ciphertext`. */
export interface VaultDocument {
  v: number;
  sub: string;
  connector: string;
  account: string;
  kind: string;
  status: string;
  created_at: string;
  updated_at: string;
  wrapped_dek: Buffer;
  kms_key_version: string;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

/** The slice of Firestore the vault uses. Transport failures throw `VaultUnavailableError`. */
export interface VaultDocumentStore {
  get(collection: string, id: string): Promise<VaultDocument | undefined>;
  /** Every document whose `sub` field equals `sub`. */
  listBySub(collection: string, sub: string): Promise<Array<{ id: string; doc: VaultDocument }>>;
  /**
   * Read the document and write what `mutate` returns, in one Firestore
   * transaction (retried when another writer commits first).
   */
  transact(
    collection: string,
    id: string,
    mutate: (current: VaultDocument | undefined) => VaultDocument,
  ): Promise<void>;
  /** Delete in a transaction; whether a document existed. */
  remove(collection: string, id: string): Promise<boolean>;
}

/** The slice of Cloud KMS the vault uses. Failures throw `VaultUnavailableError`. */
export interface KmsClient {
  /** Wrap `plaintext` under the crypto key; returns the key version that did it. */
  encrypt(
    keyName: string,
    plaintext: Buffer,
    aad: Buffer,
  ): Promise<{ ciphertext: Buffer; keyVersion: string }>;
  decrypt(keyName: string, ciphertext: Buffer, aad: Buffer): Promise<Buffer>;
}

export interface FirestoreVaultOptions {
  store: VaultDocumentStore;
  kms: KmsClient;
  /** `projects/P/locations/L/keyRings/R/cryptoKeys/K`. */
  kmsKey: string;
  collection?: string;
  now?: () => number;
}

const KMS_KEY_PATTERN = /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/;

/** True when `name` is a crypto key resource name (not a key version). */
export function isKmsKeyName(name: string): boolean {
  return KMS_KEY_PATTERN.test(name);
}

interface CachedKey {
  dek: Buffer;
  expiresAt: number;
}

export class FirestoreVault implements VaultBackend {
  private readonly store: VaultDocumentStore;
  private readonly kms: KmsClient;
  private readonly kmsKey: string;
  private readonly collection: string;
  private readonly now: () => number;
  private readonly lock = new KeyedLock();
  private readonly dekCache = new Map<string, CachedKey>();

  constructor(options: FirestoreVaultOptions) {
    if (!isKmsKeyName(options.kmsKey)) {
      throw new Error(
        "ANVIL_VAULT_KMS_KEY must look like projects/P/locations/L/keyRings/R/cryptoKeys/K (a crypto key, not a key version)",
      );
    }
    this.store = options.store;
    this.kms = options.kms;
    this.kmsKey = options.kmsKey;
    this.collection = options.collection ?? DEFAULT_VAULT_COLLECTION;
    this.now = options.now ?? Date.now;
  }

  async get(sub: string, connector: string, account: string) {
    const id = vaultRecordId(sub, connector, account);
    const doc = await this.store.get(this.collection, id);
    if (!doc) return undefined;
    const connection = await this.open(doc, sub, connector, account);
    if (
      connection.sub !== sub ||
      connection.connector !== connector ||
      connection.account !== account
    ) {
      throw new Error("vault record coordinates do not match");
    }
    return connection;
  }

  async put(connection: StoredConnection): Promise<void> {
    const { sub, connector, account } = connection;
    const aad = Buffer.from(coordinates(sub, connector, account));
    const dek = randomBytes(DEK_BYTES);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(connection), "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const wrapped = await this.kms.encrypt(this.kmsKey, dek, aad);
    const doc: VaultDocument = {
      v: RECORD_VERSION,
      sub,
      connector,
      account,
      kind: connection.kind,
      status: connection.status,
      created_at: connection.createdAt,
      updated_at: connection.updatedAt,
      wrapped_dek: wrapped.ciphertext,
      kms_key_version: wrapped.keyVersion,
      iv,
      ciphertext,
      tag,
    };
    await this.store.transact(this.collection, vaultRecordId(sub, connector, account), () => doc);
    // The key we just made is already unwrapped; no KMS call for the next read.
    this.remember(wrapped.ciphertext, aad, dek);
  }

  delete(sub: string, connector: string, account: string): Promise<boolean> {
    return this.store.remove(this.collection, vaultRecordId(sub, connector, account));
  }

  async list(sub: string): Promise<ConnectionSummary[]> {
    const out: ConnectionSummary[] = [];
    for (const { id, doc } of await this.store.listBySub(this.collection, sub)) {
      let connection: StoredConnection;
      try {
        connection = await this.open(doc, doc.sub, doc.connector, doc.account);
      } catch (error) {
        // A document that will not decrypt is skipped, as the file vault does;
        // an unavailable service is not a reason to show a partial list.
        if (error instanceof VaultUnavailableError) throw error;
        continue;
      }
      if (
        connection.sub !== sub ||
        vaultRecordId(connection.sub, connection.connector, connection.account) !== id
      ) {
        continue;
      }
      out.push({
        connector: connection.connector,
        account: connection.account,
        kind: connection.kind,
        status: connection.status,
        ...(connection.expiresAt !== undefined ? { expiresAt: connection.expiresAt } : {}),
        ...(connection.scope !== undefined ? { scope: connection.scope } : {}),
        updatedAt: connection.updatedAt,
      });
    }
    return out.sort((a, b) =>
      `${a.connector}/${a.account}`.localeCompare(`${b.connector}/${b.account}`),
    );
  }

  withLock<T>(sub: string, connector: string, account: string, fn: () => Promise<T>) {
    return this.lock.run(coordinates(sub, connector, account), fn);
  }

  private async open(
    doc: VaultDocument,
    sub: string,
    connector: string,
    account: string,
  ): Promise<StoredConnection> {
    if (doc.v !== RECORD_VERSION) throw new Error("unrecognized vault record");
    // A record sealed under another KMS key is refused, not decrypted: the
    // configured key is the only one this gateway trusts.
    if (!doc.kms_key_version.startsWith(`${this.kmsKey}/cryptoKeyVersions/`)) {
      throw new Error("vault record was wrapped by a different KMS key");
    }
    const aad = Buffer.from(coordinates(sub, connector, account));
    const dek = await this.unwrap(doc.wrapped_dek, aad);
    const decipher = createDecipheriv("aes-256-gcm", dek, doc.iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(doc.tag);
    const plain = Buffer.concat([decipher.update(doc.ciphertext), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as StoredConnection;
  }

  private async unwrap(wrapped: Buffer, aad: Buffer): Promise<Buffer> {
    const key = cacheKey(wrapped, aad);
    const cached = this.dekCache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.dek;
    this.dekCache.delete(key);
    let dek: Buffer;
    try {
      dek = await this.kms.decrypt(this.kmsKey, wrapped, aad);
    } catch (error) {
      if (error instanceof VaultUnavailableError) throw error;
      // KMS refused (wrong key, wrong AAD, tampered wrap): this record is unreadable.
      throw new Error("vault record data key could not be unwrapped");
    }
    if (dek.length !== DEK_BYTES) throw new Error("vault record data key has the wrong length");
    this.remember(wrapped, aad, dek);
    return dek;
  }

  private remember(wrapped: Buffer, aad: Buffer, dek: Buffer): void {
    const now = this.now();
    for (const [key, entry] of this.dekCache) {
      if (entry.expiresAt <= now) this.dekCache.delete(key);
    }
    this.dekCache.set(cacheKey(wrapped, aad), { dek, expiresAt: now + DEK_CACHE_MS });
  }
}

function cacheKey(wrapped: Buffer, aad: Buffer): string {
  return createHash("sha256").update(wrapped).update("\0").update(aad).digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Production clients: REST over fetch                                        */
/* -------------------------------------------------------------------------- */

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const FIRESTORE_API = "https://firestore.googleapis.com/v1";
const KMS_API = "https://cloudkms.googleapis.com/v1";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_TRANSACTION_ATTEMPTS = 5;

export interface RestClientOptions {
  fetchImpl?: typeof fetch;
  /** An OAuth access token for the runtime service account. Default: the metadata server. */
  accessToken?: () => Promise<string>;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Access tokens for Google APIs from the Cloud Run / GCE metadata server,
 * cached until shortly before expiry. Other Application Default Credentials
 * sources (a key file, `gcloud` user credentials) are not read here.
 */
export function metadataAccessToken(options: RestClientOptions = {}): () => Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let cached: { token: string; expiresAt: number } | undefined;
  return async () => {
    if (cached && now() < cached.expiresAt) return cached.token;
    let res: Response;
    try {
      res = await fetchImpl(METADATA_TOKEN_URL, {
        headers: { "metadata-flavor": "Google" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new VaultUnavailableError("the metadata server could not be reached");
    }
    if (!res.ok) throw new VaultUnavailableError(`the metadata server answered ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new VaultUnavailableError("the metadata server returned no access token");
    }
    const ttl = typeof body.expires_in === "number" ? body.expires_in : 300;
    cached = { token: body.access_token, expiresAt: now() + Math.max(ttl - 60, 0) * 1000 };
    return cached.token;
  };
}

class RestJson {
  private readonly fetchImpl: typeof fetch;
  private readonly token: () => Promise<string>;
  private readonly timeoutMs: number;

  constructor(options: RestClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.token = options.accessToken ?? metadataAccessToken(options);
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** One JSON request. Network errors and 5xx/429 are `VaultUnavailableError`; other statuses are returned. */
  async call(
    method: "GET" | "POST",
    url: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const token = await this.token();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new VaultUnavailableError("the vault's backing service could not be reached");
    }
    const json = await res.json().catch(() => ({}));
    if (res.status >= 500 || res.status === 429) {
      throw new VaultUnavailableError(`the vault's backing service answered ${res.status}`);
    }
    return { status: res.status, json };
  }
}

/** Cloud KMS over REST: `cryptoKeys.encrypt` / `cryptoKeys.decrypt`. */
export function restKmsClient(options: RestClientOptions = {}): KmsClient {
  const http = new RestJson(options);
  const unavailable = (what: string, status: number) =>
    new VaultUnavailableError(`KMS ${what} answered ${status}`);
  return {
    async encrypt(keyName, plaintext, aad) {
      const { status, json } = await http.call("POST", `${KMS_API}/${keyName}:encrypt`, {
        plaintext: plaintext.toString("base64"),
        additionalAuthenticatedData: aad.toString("base64"),
      });
      const body = json as { ciphertext?: unknown; name?: unknown };
      if (status !== 200 || typeof body.ciphertext !== "string" || typeof body.name !== "string") {
        throw unavailable("encrypt", status);
      }
      return { ciphertext: Buffer.from(body.ciphertext, "base64"), keyVersion: body.name };
    },
    async decrypt(keyName, ciphertext, aad) {
      const { status, json } = await http.call("POST", `${KMS_API}/${keyName}:decrypt`, {
        ciphertext: ciphertext.toString("base64"),
        additionalAuthenticatedData: aad.toString("base64"),
      });
      if (status === 400 || status === 404) throw new Error("KMS refused the data key");
      const body = json as { plaintext?: unknown };
      if (status !== 200 || typeof body.plaintext !== "string")
        throw unavailable("decrypt", status);
      return Buffer.from(body.plaintext, "base64");
    },
  };
}

interface FirestoreValue {
  stringValue?: string;
  integerValue?: string;
  bytesValue?: string;
}
type FirestoreFields = Record<string, FirestoreValue>;

function encodeDocument(doc: VaultDocument): FirestoreFields {
  const str = (value: string): FirestoreValue => ({ stringValue: value });
  const bytes = (value: Buffer): FirestoreValue => ({ bytesValue: value.toString("base64") });
  return {
    v: { integerValue: String(doc.v) },
    sub: str(doc.sub),
    connector: str(doc.connector),
    account: str(doc.account),
    kind: str(doc.kind),
    status: str(doc.status),
    created_at: str(doc.created_at),
    updated_at: str(doc.updated_at),
    wrapped_dek: bytes(doc.wrapped_dek),
    kms_key_version: str(doc.kms_key_version),
    iv: bytes(doc.iv),
    ciphertext: bytes(doc.ciphertext),
    tag: bytes(doc.tag),
  };
}

function decodeDocument(fields: FirestoreFields | undefined): VaultDocument {
  const f = fields ?? {};
  const str = (name: string): string => {
    const value = f[name]?.stringValue;
    if (typeof value !== "string") throw new Error("unrecognized vault record");
    return value;
  };
  const bytes = (name: string): Buffer => {
    const value = f[name]?.bytesValue;
    if (typeof value !== "string") throw new Error("unrecognized vault record");
    return Buffer.from(value, "base64");
  };
  return {
    v: Number(f.v?.integerValue ?? 0),
    sub: str("sub"),
    connector: str("connector"),
    account: str("account"),
    kind: str("kind"),
    status: str("status"),
    created_at: str("created_at"),
    updated_at: str("updated_at"),
    wrapped_dek: bytes("wrapped_dek"),
    kms_key_version: str("kms_key_version"),
    iv: bytes("iv"),
    ciphertext: bytes("ciphertext"),
    tag: bytes("tag"),
  };
}

export interface RestFirestoreOptions extends RestClientOptions {
  project: string;
  database?: string;
}

/** Firestore over REST: get, a `sub` query, and read-then-write transactions. */
export function restFirestoreStore(options: RestFirestoreOptions): VaultDocumentStore {
  const http = new RestJson(options);
  const database = options.database ?? DEFAULT_VAULT_DATABASE;
  const databaseName = `projects/${options.project}/databases/${database}`;
  const documents = `${FIRESTORE_API}/${encodeURI(databaseName)}/documents`;
  const docName = (collection: string, id: string) =>
    `${databaseName}/documents/${collection}/${id}`;
  const docUrl = (collection: string, id: string) => `${documents}/${collection}/${id}`;
  const failure = (what: string, status: number) =>
    new VaultUnavailableError(`Firestore ${what} answered ${status}`);

  async function begin(): Promise<string> {
    const { status, json } = await http.call("POST", `${documents}:beginTransaction`, {
      options: { readWrite: {} },
    });
    const transaction = (json as { transaction?: unknown }).transaction;
    if (status !== 200 || typeof transaction !== "string")
      throw failure("beginTransaction", status);
    return transaction;
  }

  async function inTransaction<T>(
    collection: string,
    id: string,
    decide: (
      current: VaultDocument | undefined,
      exists: boolean,
    ) => { write?: FirestoreFields; delete?: true; result: T },
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      const transaction = await begin();
      const read = await http.call(
        "GET",
        `${docUrl(collection, id)}?transaction=${encodeURIComponent(transaction)}`,
      );
      if (read.status !== 200 && read.status !== 404) throw failure("get", read.status);
      let current: VaultDocument | undefined;
      try {
        current =
          read.status === 200
            ? decodeDocument((read.json as { fields?: FirestoreFields }).fields)
            : undefined;
      } catch {
        // A malformed document is replaced or deleted like any other.
        current = undefined;
      }
      const outcome = decide(current, read.status === 200);
      const write = outcome.write
        ? { update: { name: docName(collection, id), fields: outcome.write } }
        : outcome.delete
          ? { delete: docName(collection, id) }
          : undefined;
      if (!write) return outcome.result;
      const commit = await http.call("POST", `${documents}:commit`, {
        writes: [write],
        transaction,
      });
      if (commit.status === 200) return outcome.result;
      // 409 ABORTED / 400 FAILED_PRECONDITION: another writer got there first.
      if (commit.status !== 409 && commit.status !== 400) throw failure("commit", commit.status);
    }
    throw new VaultUnavailableError("Firestore transaction kept aborting; try again");
  }

  return {
    async get(collection, id) {
      const { status, json } = await http.call("GET", docUrl(collection, id));
      if (status === 404) return undefined;
      if (status !== 200) throw failure("get", status);
      return decodeDocument((json as { fields?: FirestoreFields }).fields);
    },
    async listBySub(collection, sub) {
      const { status, json } = await http.call("POST", `${documents}:runQuery`, {
        structuredQuery: {
          from: [{ collectionId: collection }],
          where: {
            fieldFilter: {
              field: { fieldPath: "sub" },
              op: "EQUAL",
              value: { stringValue: sub },
            },
          },
        },
      });
      if (status !== 200 || !Array.isArray(json)) throw failure("runQuery", status);
      const out: Array<{ id: string; doc: VaultDocument }> = [];
      for (const row of json as Array<{ document?: { name?: string; fields?: FirestoreFields } }>) {
        if (!row.document?.name) continue;
        try {
          out.push({
            id: row.document.name.slice(row.document.name.lastIndexOf("/") + 1),
            doc: decodeDocument(row.document.fields),
          });
        } catch {
          // Not a vault document; skipped, as an undecryptable one is.
        }
      }
      return out;
    },
    transact(collection, id, mutate) {
      return inTransaction(collection, id, (current) => ({
        write: encodeDocument(mutate(current)),
        result: undefined,
      }));
    },
    remove(collection, id) {
      return inTransaction(collection, id, (_current, exists) => ({
        ...(exists ? { delete: true as const } : {}),
        result: exists,
      }));
    },
  };
}
