import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ManifestIssue, ManifestParseError, parseManifestDetailed } from "@anvil/compiler";

/**
 * The manifest a bundle was compiled with, kept beside it. A compile that
 * takes a manifest records a copy at `<bundle>/.anvil/manifest.yaml` so the
 * semantic overlay behind a bundle is discoverable from the bundle alone —
 * the console's manifest editor reads and writes this copy, and the recompile
 * command it hands back points `--manifest` at it. A compile without a
 * manifest removes a stale copy, so the file never describes an overlay the
 * bundle does not carry.
 *
 * It lives under `.anvil/`, outside the bundle's bytes (`readBundleDir`
 * skips that directory): the manifest is a compile INPUT, and editing it
 * changes nothing about the bundle until `anvil compile` runs again. That is
 * the whole point — the editor never recompiles, and a saved manifest that
 * fails `parseManifestDetailed` is refused before the file changes.
 */
export const BUNDLE_MANIFEST_FILE = ".anvil/manifest.yaml";

export function bundleManifestPath(bundleDir: string): string {
  return join(bundleDir, ...BUNDLE_MANIFEST_FILE.split("/"));
}

/** Keep the compile's manifest beside the bundle, or drop a stale copy when there was none. */
export function recordBundleManifest(bundleDir: string, manifestText: string | undefined): void {
  const path = bundleManifestPath(bundleDir);
  if (manifestText === undefined) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, manifestText, "utf8");
}

export interface BundleManifest {
  path: string;
  exists: boolean;
  text: string;
}

export function readBundleManifest(bundleDir: string): BundleManifest {
  const path = bundleManifestPath(bundleDir);
  const exists = existsSync(path);
  return { path, exists, text: exists ? readFileSync(path, "utf8") : "" };
}

export type ManifestValidation = { ok: true; issues: [] } | { ok: false; issues: ManifestIssue[] };

/** Positioned issues from the compiler's own parser; `ok` means `anvil compile` would accept it. */
export function validateBundleManifest(text: string): ManifestValidation {
  const parsed = parseManifestDetailed(text);
  return parsed.ok ? { ok: true, issues: [] } : { ok: false, issues: parsed.issues };
}

/**
 * Replace the bundle's manifest copy, atomically (write beside, rename over),
 * and only when the compiler's parser accepts the text. Returns the path.
 */
export function writeBundleManifest(bundleDir: string, text: string): string {
  const validation = validateBundleManifest(text);
  if (!validation.ok) throw new ManifestParseError(validation.issues);
  const path = bundleManifestPath(bundleDir);
  mkdirSync(dirname(path), { recursive: true });
  const staged = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(staged, text, { encoding: "utf8", flag: "wx" });
  try {
    renameSync(staged, path);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
  return path;
}
