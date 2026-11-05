/**
 * The contract-v2 features this build of Anvil implements, by name
 * (`anvil capabilities --json`). A host asks before it relies on one; a feature
 * appears here in the change that ships it and not before.
 *
 * - `package.search`: `anvil package harness` writes `search.json` and a schema
 *   per approved operation.
 * - `skill.lean`: `anvil package harness --skill-mode lean`.
 * - `install.prefix`: `anvil install --prefix DIR [--from DIR] [--prune]`.
 * - `package.oci`: `anvil package oci <package-dir> --out <dir> [--push <ref>]`.
 * - `bundle.icon`: `service.icon` in the manifest and AIR, copied into
 *   `harness.json`, `search.json` and the connector index.
 */
export const FEATURES: readonly string[] = [
  "package.search",
  "skill.lean",
  "install.prefix",
  "package.oci",
  "bundle.icon",
];
