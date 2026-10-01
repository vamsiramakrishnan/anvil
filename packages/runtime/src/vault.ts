import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type AuthRequirement, effectiveAuthCarrier } from "@anvil/air";
import {
  type AuthMaterial,
  apiKeyMaterial,
  type CredentialCallContext,
  type CredentialResolver,
} from "./auth.js";
import { AnvilError } from "./errors.js";
import { DEFAULT_ACCOUNT } from "./grants.js";

/**
 * The gateway's credential vault (docs/branchyard.md, ADR-0029): upstream
 * authorizations kept per `(sub, connector, account)`, encrypted at rest with
 * AES-256-GCM under a key read from the file `ANVIL_VAULT_KEY_FILE` names.
 *
 * One file per connection, named by a hash of its coordinates, holding
 * `{ v, iv, tag, ct }`. The coordinates are bound into the ciphertext as
 * additional authenticated data, so a file copied onto another person's
 * coordinates fails to decrypt instead of lending them a token. Nothing here
 * logs a secret, and an upstream token never leaves the gateway process.
 */
export interface StoredConnection {
  sub: string;
  connector: string;
  account: string;
  /** `oauth`: an authorization-code grant. `static`: an API key or personal token. */
  kind: "oauth" | "static";
  /** `needs_reconnect` once the provider refused a refresh (`invalid_grant`). */
  status: "active" | "needs_reconnect";
  secret?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Epoch milliseconds when `accessToken` expires, when the provider said. */
  expiresAt?: number;
  scope?: string;
  createdAt: string;
  updatedAt: string;
}

/** What `list` shows: a connection without any secret. */
export interface ConnectionSummary {
  connector: string;
  account: string;
  kind: StoredConnection["kind"];
  status: StoredConnection["status"];
  expiresAt?: number;
  scope?: string;
  updatedAt: string;
}

/**
 * A credential the vault cannot supply for this call: the account is not
 * connected, needs reconnecting, or its token could not be refreshed. The
 * executor turns it into a structured `auth_required` naming the connector —
 * never a connect link; that goes to the person through `/connect/start`.
 */
export class CredentialUnavailableError extends Error {
  constructor(
    message: string,
    readonly details: {
      code:
        | "connector/not_connected"
        | "connector/needs_reconnect"
        | "connector/refresh_failed"
        | "connector/unsupported_auth"
        | "connector/vault_unreadable"
        | "connector/unresolved";
      connector?: string;
      account?: string;
    },
  ) {
    super(message);
    this.name = "CredentialUnavailableError";
  }

  /** The refusal a call gets: `auth_required`, naming the connector and account. */
  toAnvilError(operation: string, traceId: string): AnvilError {
    return new AnvilError({
      code: "auth_required",
      message: this.message,
      operation,
      traceId,
      retryable: false,
      details: this.details,
    });
  }
}

const KEY_BYTES = 32;

/**
 * Read a 32-byte vault key: raw bytes, 64 hex characters, or base64. The file
 * must not be readable by group or others — a key anyone on the host can read
 * protects nothing, so that is a refusal, not a warning.
 */
export function readVaultKey(path: string): Buffer {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new Error(`vault key file ${path} does not exist`);
  }
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new Error(`vault key file ${path} must not be readable by group or others (chmod 600)`);
  }
  const raw = readFileSync(path);
  if (raw.length === KEY_BYTES) return raw;
  const text = raw.toString("utf8").trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
  const decoded = Buffer.from(text, "base64");
  if (decoded.length === KEY_BYTES) return decoded;
  throw new Error(`vault key file ${path} must hold 32 bytes (raw, 64 hex characters, or base64)`);
}

function coordinates(sub: string, connector: string, account: string): string {
  return JSON.stringify([sub, connector, account]);
}

export class ConnectionVault {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    readonly dir: string,
    private readonly key: Buffer,
  ) {
    if (key.length !== KEY_BYTES) throw new Error("vault key must be 32 bytes");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private fileFor(sub: string, connector: string, account: string): string {
    const name = createHash("sha256")
      .update(coordinates(sub, connector, account))
      .digest("hex");
    return join(this.dir, `${name}.json`);
  }

  private seal(connection: StoredConnection): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(
      Buffer.from(coordinates(connection.sub, connection.connector, connection.account)),
    );
    const ct = Buffer.concat([cipher.update(JSON.stringify(connection), "utf8"), cipher.final()]);
    return JSON.stringify({
      v: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ct: ct.toString("base64"),
    });
  }

  private decrypt(text: string, sub: string, connector: string, account: string) {
    const sealed = JSON.parse(text) as { v?: number; iv?: string; tag?: string; ct?: string };
    if (sealed.v !== 1 || !sealed.iv || !sealed.tag || !sealed.ct) {
      throw new Error("unrecognized vault record");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(sealed.iv, "base64"));
    decipher.setAAD(Buffer.from(coordinates(sub, connector, account)));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(sealed.ct, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString("utf8")) as StoredConnection;
  }

  /** The connection at these coordinates; throws when a record exists but will not decrypt. */
  get(sub: string, connector: string, account: string): StoredConnection | undefined {
    const file = this.fileFor(sub, connector, account);
    if (!existsSync(file)) return undefined;
    const connection = this.decrypt(readFileSync(file, "utf8"), sub, connector, account);
    if (
      connection.sub !== sub ||
      connection.connector !== connector ||
      connection.account !== account
    ) {
      throw new Error("vault record coordinates do not match");
    }
    return connection;
  }

  /** Store (replace) one connection, atomically, 0600. */
  put(connection: StoredConnection): void {
    const file = this.fileFor(connection.sub, connection.connector, connection.account);
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, this.seal(connection), { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
    renameSync(tmp, file);
  }

  delete(sub: string, connector: string, account: string): boolean {
    const file = this.fileFor(sub, connector, account);
    if (!existsSync(file)) return false;
    unlinkSync(file);
    return true;
  }

  /** Every connection `sub` holds, without secrets. Records that will not decrypt are skipped. */
  list(sub: string): ConnectionSummary[] {
    const out: ConnectionSummary[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      let connection: StoredConnection;
      try {
        const text = readFileSync(join(this.dir, name), "utf8");
        const sealed = JSON.parse(text) as { v?: number };
        if (sealed.v !== 1) continue;
        connection = this.openAny(text);
      } catch {
        continue;
      }
      if (connection.sub !== sub) continue;
      if (
        this.fileFor(connection.sub, connection.connector, connection.account) !==
        join(this.dir, name)
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

  /**
   * Decrypt a record whose coordinates are not known up front (listing). The
   * AAD is recovered from the plaintext and then verified by decrypting again
   * with it, so a record moved onto other coordinates is still rejected.
   */
  private openAny(text: string): StoredConnection {
    const sealed = JSON.parse(text) as { iv: string; tag: string; ct: string };
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(sealed.iv, "base64"));
    // GCM without the AAD cannot authenticate; decrypt the stream to read the
    // claimed coordinates, then authenticate properly with them.
    const claimed = JSON.parse(
      decipher.update(Buffer.from(sealed.ct, "base64")).toString("utf8"),
    ) as StoredConnection;
    return this.decrypt(text, claimed.sub, claimed.connector, claimed.account);
  }

  /**
   * Run `fn` holding this connection's lock: concurrent refreshes of one
   * connection queue behind each other instead of racing the provider with
   * the same refresh token (which rotating providers treat as reuse).
   */
  async withLock<T>(sub: string, connector: string, account: string, fn: () => Promise<T>) {
    const id = coordinates(sub, connector, account);
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.locks.set(id, tail);
    try {
      await previous;
      return await fn();
    } finally {
      release();
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }
}

/** Token-endpoint client configuration for one OAuth connector (gateway-side, never in AIR). */
export interface OAuthClientConfig {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  clientAuth: "client_secret_basic" | "client_secret_post" | "none";
}

/** Build the token-endpoint request headers and form for one grant. */
export function tokenRequest(
  client: OAuthClientConfig,
  form: Record<string, string>,
): { headers: Record<string, string>; body: string } {
  const body = new URLSearchParams(form);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (client.clientAuth === "client_secret_basic" && client.clientSecret) {
    const id = encodeURIComponent(client.clientId);
    const secret = encodeURIComponent(client.clientSecret);
    headers.authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
  } else {
    body.set("client_id", client.clientId);
    if (client.clientSecret && client.clientAuth === "client_secret_post") {
      body.set("client_secret", client.clientSecret);
    }
  }
  return { headers, body: body.toString() };
}

/** Auth material for one operation from one stored secret, under the carrier AIR declared. */
export function vaultMaterial(auth: AuthRequirement, value: string): AuthMaterial {
  switch (auth.type) {
    case "none":
      return {};
    case "api_key":
      return apiKeyMaterial(value, auth, "ANVIL_VAULT", {});
    case "basic":
      return { headers: { Authorization: `Basic ${Buffer.from(value).toString("base64")}` } };
    case "custom_header": {
      const carrier = effectiveAuthCarrier(auth);
      if (!carrier) return { headers: { Authorization: `Bearer ${value}` } };
      return carrier.in === "query"
        ? { query: { [carrier.name]: value } }
        : { headers: { [carrier.name]: carrier.scheme ? `${carrier.scheme} ${value}` : value } };
    }
    default: {
      const carrier = auth.carrier;
      if (carrier?.in === "query") return { query: { [carrier.name]: value } };
      if (carrier?.in === "header") {
        return {
          headers: { [carrier.name]: carrier.scheme ? `${carrier.scheme} ${value}` : value },
        };
      }
      return { headers: { Authorization: `Bearer ${value}` } };
    }
  }
}

const REFRESH_SKEW_MS = 60_000;

/**
 * The credential resolver a call made by a Branchyard principal uses: the
 * person's own connection for this connector and account, from the vault —
 * never an environment variable. An `oauth` connection close to expiry is
 * refreshed under the connection's lock; a refresh the provider refuses with
 * `invalid_grant` marks the connection `needs_reconnect`.
 */
export class VaultCredentialResolver implements CredentialResolver {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly vault: ConnectionVault,
    private readonly oauthClientFor: (connector: string) => OAuthClientConfig | undefined,
    opts: { fetchImpl?: typeof fetch; now?: () => number } = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  expectedCredentials(): string[] {
    return [];
  }

  async resolve(
    _profile: string,
    auth: AuthRequirement,
    callCtx: CredentialCallContext = {},
  ): Promise<AuthMaterial | null> {
    if (auth.type === "none") return {};
    const sub = callCtx.principalId;
    const connector = callCtx.connector;
    const account = callCtx.account ?? DEFAULT_ACCOUNT;
    if (!sub || !connector) {
      throw new CredentialUnavailableError(
        "This call has no person and connector to resolve a connected account for.",
        { code: "connector/unresolved" },
      );
    }
    if (auth.type === "mtls" || auth.type === "workload_identity") {
      throw new CredentialUnavailableError(
        `Connector '${connector}' uses ${auth.type} authentication, which is not held per person in the gateway vault.`,
        { code: "connector/unsupported_auth", connector, account },
      );
    }
    let connection: StoredConnection | undefined;
    try {
      connection = this.vault.get(sub, connector, account);
    } catch {
      throw new CredentialUnavailableError(
        `The stored connection for connector '${connector}' (account '${account}') could not be read; the person must reconnect it.`,
        { code: "connector/vault_unreadable", connector, account },
      );
    }
    if (!connection) {
      throw new CredentialUnavailableError(
        `Connector '${connector}' has no connected account '${account}' for this person. ` +
          "Ask the person to connect it; the connect link is issued to them, not to this session.",
        { code: "connector/not_connected", connector, account },
      );
    }
    if (connection.status === "needs_reconnect") throw needsReconnect(connector, account);
    if (connection.kind === "static") {
      if (!connection.secret) throw needsReconnect(connector, account);
      return vaultMaterial(auth, connection.secret);
    }
    const fresh =
      connection.expiresAt !== undefined && connection.expiresAt - this.now() < REFRESH_SKEW_MS
        ? await this.refresh(sub, connector, account)
        : connection;
    if (!fresh.accessToken) throw needsReconnect(connector, account);
    return vaultMaterial(auth, fresh.accessToken);
  }

  private refresh(sub: string, connector: string, account: string): Promise<StoredConnection> {
    return this.vault.withLock(sub, connector, account, async () => {
      // Re-read under the lock: a concurrent call may already have refreshed.
      const current = this.vault.get(sub, connector, account);
      if (!current) {
        throw new CredentialUnavailableError(
          `Connector '${connector}' has no connected account '${account}' for this person.`,
          { code: "connector/not_connected", connector, account },
        );
      }
      if (current.status === "needs_reconnect") throw needsReconnect(connector, account);
      if (current.expiresAt === undefined || current.expiresAt - this.now() >= REFRESH_SKEW_MS) {
        return current;
      }
      const client = this.oauthClientFor(connector);
      if (!current.refreshToken || !client) {
        this.vault.put({ ...current, status: "needs_reconnect", updatedAt: this.stamp() });
        throw needsReconnect(connector, account);
      }
      const request = tokenRequest(client, {
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
      });
      let res: Response;
      try {
        res = await this.fetchImpl(client.tokenEndpoint, {
          method: "POST",
          headers: request.headers,
          body: request.body,
        });
      } catch {
        throw refreshFailed(connector, account);
      }
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        if (body.error === "invalid_grant") {
          this.vault.put({ ...current, status: "needs_reconnect", updatedAt: this.stamp() });
          throw needsReconnect(connector, account);
        }
        throw refreshFailed(connector, account);
      }
      if (typeof body.access_token !== "string" || body.access_token.length === 0) {
        throw refreshFailed(connector, account);
      }
      const next: StoredConnection = {
        ...current,
        accessToken: body.access_token,
        // A provider that rotates refresh tokens hands back a new one; keep
        // the old one only when it did not.
        refreshToken:
          typeof body.refresh_token === "string" ? body.refresh_token : current.refreshToken,
        expiresAt:
          typeof body.expires_in === "number" ? this.now() + body.expires_in * 1000 : undefined,
        ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
        status: "active",
        updatedAt: this.stamp(),
      };
      this.vault.put(next);
      return next;
    });
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }
}

function needsReconnect(connector: string, account: string): CredentialUnavailableError {
  return new CredentialUnavailableError(
    `Connector '${connector}' (account '${account}') needs to be reconnected by the person; its provider refused the stored authorization.`,
    { code: "connector/needs_reconnect", connector, account },
  );
}

function refreshFailed(connector: string, account: string): CredentialUnavailableError {
  return new CredentialUnavailableError(
    `Connector '${connector}' (account '${account}') could not refresh its authorization right now.`,
    { code: "connector/refresh_failed", connector, account },
  );
}
