import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AuditSink,
  ConnectFlow,
  ConnectionVault,
  type ConnectorAuthProfile,
  connectorAuthProfile,
  fileAuditSink,
  readVaultKey,
  VaultCredentialResolver,
} from "@anvil/runtime";

/**
 * The Branchyard side of the fleet gateway (ADR-0029, docs/branchyard.md):
 * the vault, the connect flow, and the audit log, configured from the
 * gateway's environment. The HTTP routes live in serve-fleet-http.ts; the
 * mechanisms live in @anvil/runtime (vault.ts, connect.ts, audit.ts).
 */

/** The audit sink `ANVIL_AUDIT_FILE` names, or undefined when it is unset. */
export function auditSinkFromEnv(
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): AuditSink | undefined {
  const path = env.ANVIL_AUDIT_FILE?.trim();
  return path ? fileAuditSink(path, log) : undefined;
}

/**
 * The vault: `ANVIL_VAULT_KEY_FILE` names a 0600 file holding a 32-byte key
 * (required — there is no default key, so a gateway that needs the vault
 * refuses to start without one); `ANVIL_VAULT_DIR` holds the encrypted
 * records (default `~/.anvil/gateway/vault`).
 */
export function vaultFromEnv(env: NodeJS.ProcessEnv): ConnectionVault {
  const keyFile = env.ANVIL_VAULT_KEY_FILE?.trim();
  if (!keyFile) {
    throw new Error(
      "branchyard mode keeps upstream authorizations in the credential vault and needs ANVIL_VAULT_KEY_FILE (a 0600 file holding a 32-byte key); refusing to start without one",
    );
  }
  const dir = env.ANVIL_VAULT_DIR?.trim() || join(homedir(), ".anvil", "gateway", "vault");
  return new ConnectionVault(dir, readVaultKey(keyFile));
}

export interface GatewayRuntime {
  vault: ConnectionVault;
  credentials: VaultCredentialResolver;
  connect: ConnectFlow;
  profiles: Map<string, ConnectorAuthProfile>;
}

/**
 * Assemble the vault, resolver, and connect flow for the connectors a fleet
 * serves. `redirectUri` is the gateway's own `/connect/callback`:
 * `ANVIL_GATEWAY_PUBLIC_URL` when set, else derived from the token audience
 * (the gateway's canonical `/mcp` URL).
 */
export function buildGatewayRuntime(
  connectors: ReadonlyArray<{ connector: string; air: Parameters<typeof connectorAuthProfile>[1] }>,
  env: NodeJS.ProcessEnv,
  audience: string,
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): GatewayRuntime {
  const vault = vaultFromEnv(env);
  const profiles = new Map<string, ConnectorAuthProfile>();
  for (const { connector, air } of connectors) {
    profiles.set(connector, connectorAuthProfile(connector, air, env));
  }
  const publicBase = env.ANVIL_GATEWAY_PUBLIC_URL?.trim() || audience;
  const redirectUri = new URL("/connect/callback", publicBase).toString();
  const credentials = new VaultCredentialResolver(
    vault,
    (connector) => profiles.get(connector)?.client,
    deps,
  );
  const connect = new ConnectFlow({ vault, profiles, redirectUri, ...deps });
  return { vault, credentials, connect, profiles };
}
