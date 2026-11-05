/**
 * The Anvil contract v2 features this tree implements, by name (Compatibility
 * in Branchyard's docs/anvil-contract-v2.md). `anvil capabilities --json` prints
 * them; Branchyard's `by doctor` reads the list.
 *
 * One name per line, sorted, so a change that adds a feature merges as a
 * one-line addition. Add a name only with the code and tests that earn it.
 */
export const CAPABILITIES: readonly string[] = [
  "manifest.claim", // by_manifest token claim, recorded in the audit line
  "token.proxy", // ANVIL_GATEWAY_AUTH=proxy in the SDKs and the CLIs
];
