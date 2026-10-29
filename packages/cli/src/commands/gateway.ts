import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AuditSink,
  ConnectFlow,
  ConnectionVault,
  type ConnectorAuthProfile,
  connectEnvPrefix,
  connectorAuthProfile,
  fileAuditSink,
  GoogleWorkloadCredentials,
  isSendableOAuthEndpoint,
  type McpConnectionConfig,
  McpUpstream,
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
function vaultFromEnv(env: NodeJS.ProcessEnv): ConnectionVault {
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
  mcp: McpUpstream;
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
  const mcpConfigurations = new Map<string, McpConnectionConfig>();
  for (const { connector, air } of connectors) {
    const profile = connectorAuthProfile(connector, air, env);
    const prefix = connectEnvPrefix(connector);
    const read = (key: string) => env[`${prefix}${key}`]?.trim();
    const url = read("MCP_URL");
    if (url) {
      if (
        !isSendableOAuthEndpoint(url) ||
        new URL(url).username ||
        new URL(url).password ||
        new URL(url).hash
      ) {
        throw new Error(
          `${prefix}MCP_URL must be HTTPS or loopback HTTP without credentials or fragments.`,
        );
      }
      const kind = read("MCP_AUTH");
      if (kind === "oauth") {
        const issuer = read("ISSUER");
        const clientId = read("CLIENT_ID");
        if (!issuer || !clientId || !isSendableOAuthEndpoint(issuer)) {
          throw new Error(`${prefix}ISSUER and CLIENT_ID are required for protected MCP OAuth.`);
        }
        const allowedOrigins =
          read("OAUTH_ALLOWED_ORIGINS")
            ?.split(/[\s,]+/)
            .filter(Boolean) ?? [];
        if (
          allowedOrigins.some((origin) => {
            try {
              return !isSendableOAuthEndpoint(origin) || new URL(origin).origin !== origin;
            } catch {
              return true;
            }
          })
        )
          throw new Error(
            `${prefix}OAUTH_ALLOWED_ORIGINS must contain exact HTTPS or loopback HTTP origins.`,
          );
        const oauth = {
          allowedOrigins,
          resource: url,
          issuer,
          clientId,
          clientSecret: read("CLIENT_SECRET"),
          scopes:
            read("SCOPES")
              ?.split(/[\s,]+/)
              .filter(Boolean) ?? profile.scopes,
        };
        mcpConfigurations.set(connector, { url, kind, oauth });
        profiles.set(connector, {
          connector,
          kind: "oauth",
          authType: "oauth2_authorization_code",
          scopes: oauth.scopes,
          mcp: oauth,
        });
      } else if (kind === "workload" || kind === "static" || kind === "none") {
        mcpConfigurations.set(connector, { url, kind });
        profiles.set(connector, profile);
      } else {
        throw new Error(
          `${prefix}MCP_AUTH must explicitly select oauth, workload, static or none.`,
        );
      }
    } else profiles.set(connector, profile);
  }
  const publicBase = env.ANVIL_GATEWAY_PUBLIC_URL?.trim() || audience;
  const redirectUri = new URL("/connect/callback", publicBase).toString();
  const credentials = new VaultCredentialResolver(
    vault,
    (connector) => profiles.get(connector)?.client,
    { ...deps, workload: new GoogleWorkloadCredentials() },
  );
  const connect = new ConnectFlow({ vault, profiles, redirectUri, ...deps });
  const mcp = new McpUpstream(
    mcpConfigurations,
    vault,
    credentials,
    redirectUri,
    deps.fetchImpl,
    deps.now,
  );
  return { vault, credentials, connect, profiles, mcp };
}
