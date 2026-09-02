import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { type AirDocument, airFromJson, airFromYaml } from "@anvil/air";

/**
 * Locating a bundle and its canonical AIR from the files already read. These
 * sit beside `readBundleDir`/`bundleHash` because the bundle layout — air.yaml
 * first, air.json as the projection — is this package's to know; every bundle
 * command in the CLI and every other reader of a generated directory resolves
 * a bundle through here so "which AIR is canonical" is answered exactly once.
 */

/** Accept a bundle directory or a path to its air.yaml/air.json. */
export function resolveBundleDir(path: string): string {
  if (!existsSync(path)) throw new Error(`No such bundle: ${path}`);
  return statSync(path).isDirectory() ? path : dirname(path);
}

/** Load the canonical AIR from the already-read bundle files. */
export function loadBundleAir(dir: string, files: Record<string, string>): AirDocument {
  const yaml = files["air.yaml"];
  if (yaml !== undefined) return airFromYaml(yaml);
  const json = files["air.json"];
  if (json !== undefined) return airFromJson(json);
  throw new Error(`No air.yaml or air.json in ${dir}. Run \`anvil compile\` first.`);
}
