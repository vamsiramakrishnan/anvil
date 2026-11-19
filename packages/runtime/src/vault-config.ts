import { homedir } from "node:os";
import { join } from "node:path";
import { ConnectionVault, readVaultKey } from "./vault.js";
import {
  DEFAULT_VAULT_COLLECTION,
  DEFAULT_VAULT_DATABASE,
  FirestoreVault,
  type KmsClient,
  restFirestoreStore,
  restKmsClient,
  type VaultDocumentStore,
} from "./vault-firestore.js";

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
): ConnectionVault | FirestoreVault {
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
      "The file vault needs ANVIL_VAULT_KEY_FILE (a 0600 file holding a 32-byte key); refusing to start without one",
    );
  }
  const dir = env.ANVIL_VAULT_DIR?.trim() || join(homedir(), ".anvil", "gateway", "vault");
  return new ConnectionVault(dir, readVaultKey(keyFile));
}
