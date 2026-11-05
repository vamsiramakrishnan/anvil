/**
 * The features of the Anvil contract v2 that this tree implements, by name.
 * `anvil capabilities --json` prints them so a caller (Branchyard's
 * `by doctor`) can tell what this Anvil supports. One array, one name per
 * feature: add a name here when, and only when, the feature is built.
 */
export const CAPABILITY_FEATURES: readonly string[] = ["vault.firestore", "connect.disconnect"];

/** The `anvil capabilities --json` document. */
export function capabilitiesDocument(features: readonly string[] = CAPABILITY_FEATURES): {
  features: string[];
} {
  return { features: [...new Set(features)].sort() };
}
