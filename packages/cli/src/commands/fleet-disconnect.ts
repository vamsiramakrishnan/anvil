import { randomUUID } from "node:crypto";
import {
  type AuditSink,
  auditDisconnect,
  DEFAULT_ACCOUNT,
  type VaultBackend,
} from "@anvil/runtime";

/**
 * `POST /connect/disconnect`: delete the stored connection under the account
 * lock (a Firestore lease across instances), so a refresh that already read
 * the record cannot put it back after `disconnected: true` was answered. A
 * vault failure throws; the caller maps it to `vault_unavailable`.
 */
export async function disconnectConnection(input: {
  vault: VaultBackend;
  audit: AuditSink | undefined;
  /** The credential owner (the verified token's, never a request field). */
  sub: string;
  claims: { sub?: string; by_tenant?: unknown };
  connector: string;
  account: string | undefined;
}): Promise<{ connector: string; account: string; disconnected: boolean }> {
  const { vault, audit, sub, claims, connector } = input;
  const started = Date.now();
  const target = input.account ?? DEFAULT_ACCOUNT;
  const removed = await vault.withLock(sub, connector, target, async () =>
    vault.delete(sub, connector, target),
  );
  // No upstream revocation follows: AIR declares no revocation endpoint here.
  if (audit) {
    auditDisconnect(audit, {
      sub: claims.sub ?? sub,
      tenant: typeof claims.by_tenant === "string" ? claims.by_tenant : null,
      connector,
      account: target,
      disconnected: removed,
      latencyMs: Date.now() - started,
      traceId: randomUUID(),
    });
  }
  return { connector, account: target, disconnected: removed };
}
