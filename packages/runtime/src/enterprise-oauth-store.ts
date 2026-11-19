import type { EnterprisePrincipal } from "./identity.js";
import type { StoredConnection, VersionedVault } from "./vault.js";

/** One encrypted row for the binding. A new revision fences every transition. */
export interface EnterpriseGrantRecord {
  revision: string;
  pending?: {
    stateHash: string;
    browserHash: string;
    verifier: string;
    expiresAt: number;
    principal: EnterprisePrincipal;
  };
  grant?: {
    principal: EnterprisePrincipal;
    accessToken: string;
    awaitingVerification?: true;
    refreshToken?: string;
    expiresAt: number;
  };
  /** Retained only while an already disconnected grant awaits issuer revocation. */
  revocation?: { accessToken: string; refreshToken?: string };
  reconnect?: boolean;
}

export interface EnterpriseOAuthStore {
  read(owner: string): Promise<EnterpriseGrantRecord | undefined>;
  commit(
    owner: string,
    expectedRevision: string | undefined,
    next: EnterpriseGrantRecord | undefined,
  ): Promise<boolean>;
  withLock<T>(owner: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * `owner` is the issuer/tenant/subject-bound principal id. `namespace` is the
 * digest of the reviewed binding. Neither coordinate comes from a tool call.
 */
export class EnterpriseGrantStore implements EnterpriseOAuthStore {
  private readonly connector: string;

  constructor(
    private readonly vault: VersionedVault,
    namespace: string,
  ) {
    if (!namespace) throw new Error("An enterprise OAuth namespace is required.");
    this.connector = `enterprise-oauth:${namespace}`;
  }

  async read(owner: string): Promise<EnterpriseGrantRecord | undefined> {
    const row = await this.vault.get(owner, this.connector, "default");
    if (row && !row.enterpriseOAuth) throw new Error("Invalid enterprise grant record.");
    return row?.enterpriseOAuth;
  }

  async commit(
    owner: string,
    expectedRevision: string | undefined,
    next: EnterpriseGrantRecord | undefined,
  ): Promise<boolean> {
    if (
      next &&
      (!next.revision ||
        next.revision === expectedRevision ||
        (next.grant && next.grant.principal.id !== owner) ||
        (next.pending && next.pending.principal.id !== owner))
    ) {
      throw new Error("Invalid enterprise grant transition.");
    }
    const stamp = new Date().toISOString();
    const connection: StoredConnection | undefined = next && {
      sub: owner,
      connector: this.connector,
      account: "default",
      kind: "oauth",
      status: next.grant && !next.reconnect ? "active" : "needs_reconnect",
      enterpriseOAuth: next,
      createdAt: stamp,
      updatedAt: stamp,
    };
    return this.vault.compareAndSwap(
      owner,
      this.connector,
      "default",
      expectedRevision,
      connection,
    );
  }

  withLock<T>(owner: string, fn: () => Promise<T>): Promise<T> {
    return this.vault.withLock(owner, this.connector, "default", fn);
  }
}
