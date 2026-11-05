/**
 * The Anvil contract v2 features this tree implements, by name (Compatibility
 * in Branchyard's docs/anvil-contract-v2.md). `anvil capabilities --json` prints
 * them; Branchyard's `by doctor` reads the list. A host asks before it relies on
 * one; a feature appears here in the change that ships it and not before.
 *
 * One name per line, sorted, so a change that adds a feature merges as a
 * one-line addition. Add a name only with the code and tests that earn it.
 */
export const CAPABILITY_FEATURES: readonly string[] = [
  "bundle.icon", // service.icon in the manifest and AIR, in harness.json, search.json and the index
  "connect.disconnect", // POST /connect/disconnect on the fleet gateway
  "install.prefix", // anvil install --prefix DIR [--from DIR] [--prune]
  "manifest.claim", // by_manifest token claim, recorded in the audit line
  "package.oci", // anvil package oci <package-dir> --out DIR [--push REF]
  "package.search", // search.json and a schema per approved operation
  "skill.lean", // anvil package harness --skill-mode lean (at most 4 KB)
  "token.proxy", // ANVIL_GATEWAY_AUTH=proxy in the SDKs and the CLIs
  "vault.firestore", // ANVIL_VAULT_BACKEND=firestore, envelope-encrypted with Cloud KMS
];

/** The `anvil capabilities --json` document: the names, unique and sorted. */
export function capabilitiesDocument(features: readonly string[] = CAPABILITY_FEATURES): {
  features: string[];
} {
  return { features: [...new Set(features)].sort() };
}
