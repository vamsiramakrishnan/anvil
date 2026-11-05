import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AuditSink,
  ConnectFlow,
  ConnectionVault,
  type ConnectorAuthProfile,
  connectEnvPrefix,
  connectorAuthProfile,
  DEFAULT_VAULT_COLLECTION,
  DEFAULT_VAULT_DATABASE,
  FirestoreVault,
  fileAuditSink,
  GoogleWorkloadCredentials,
  isSendableOAuthEndpoint,
  type KmsClient,
  type McpConnectionConfig,
  McpUpstream,
  readVaultKey,
  restFirestoreStore,
  restKmsClient,
  type VaultBackend,
  VaultCredentialResolver,
  type VaultDocumentStore,
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

/** Test seams for the Firestore vault: in-memory clients in place of Firestore and KMS. */
export interface VaultClients {
  store?: VaultDocumentStore;
  kms?: KmsClient;
}

/**
 * The vault, chosen by `ANVIL_VAULT_BACKEND`:
 *
 * - `file` (the default): `ANVIL_VAULT_KEY_FILE` names a 0600 file holding a
 *   32-byte key (required — there is no default key, so a gateway that needs
 *   the vault refuses to start without one); `ANVIL_VAULT_DIR` holds the
 *   encrypted records (default `~/.anvil/gateway/vault`).
 * - `firestore`: one Firestore document per connection, envelope-encrypted
 *   with the Cloud KMS key `ANVIL_VAULT_KMS_KEY` (required);
 *   `ANVIL_VAULT_FIRESTORE_COLLECTION` (default `anvil_vault`),
 *   `ANVIL_VAULT_FIRESTORE_DATABASE` (default `(default)`) and
 *   `ANVIL_VAULT_FIRESTORE_PROJECT` (default: the KMS key's project) are
 *   optional. `ANVIL_VAULT_KEY_FILE` and `ANVIL_VAULT_DIR` are refused: the
 *   two backends are never mixed.
 */
export function vaultFromEnv(
  env: NodeJS.ProcessEnv,
  clients: VaultClients & { fetchImpl?: typeof fetch } = {},
): VaultBackend {
  const backend = env.ANVIL_VAULT_BACKEND?.trim() || "file";
  if (backend === "firestore") {
    for (const name of ["ANVIL_VAULT_KEY_FILE", "ANVIL_VAULT_DIR"]) {
      if (env[name]?.trim()) {
        throw new Error(
          `${name} is set but ANVIL_VAULT_BACKEND=firestore: the file and Firestore vaults are never mixed; unset ${name}`,
        );
      }
    }
    const kmsKey = env.ANVIL_VAULT_KMS_KEY?.trim();
    if (!kmsKey) {
      throw new Error(
        "ANVIL_VAULT_BACKEND=firestore needs ANVIL_VAULT_KMS_KEY (projects/P/locations/L/keyRings/R/cryptoKeys/K); refusing to start without one",
      );
    }
    const project =
      env.ANVIL_VAULT_FIRESTORE_PROJECT?.trim() || /^projects\/([^/]+)\//.exec(kmsKey)?.[1];
    if (!project) throw new Error("ANVIL_VAULT_KMS_KEY must start with projects/<project>/");
    const database = env.ANVIL_VAULT_FIRESTORE_DATABASE?.trim() || DEFAULT_VAULT_DATABASE;
    const rest = clients.fetchImpl ? { fetchImpl: clients.fetchImpl } : {};
    return new FirestoreVault({
      store: clients.store ?? restFirestoreStore({ project, database, ...rest }),
      kms: clients.kms ?? restKmsClient(rest),
      kmsKey,
      collection: env.ANVIL_VAULT_FIRESTORE_COLLECTION?.trim() || DEFAULT_VAULT_COLLECTION,
    });
  }
  if (backend !== "file") {
    throw new Error(`ANVIL_VAULT_BACKEND must be 'file' or 'firestore', not '${backend}'`);
  }
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
  vault: VaultBackend;
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
  deps: { fetchImpl?: typeof fetch; now?: () => number; vaultClients?: VaultClients } = {},
): GatewayRuntime {
  const { vaultClients, ...flowDeps } = deps;
  const vault = vaultFromEnv(env, vaultClients ?? {});
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
    { ...flowDeps, workload: new GoogleWorkloadCredentials() },
  );
  const connect = new ConnectFlow({ vault, profiles, redirectUri, ...flowDeps });
  const mcp = new McpUpstream(
    mcpConfigurations,
    vault,
    credentials,
    redirectUri,
    flowDeps.fetchImpl,
    flowDeps.now,
  );
  return { vault, credentials, connect, profiles, mcp };
}
