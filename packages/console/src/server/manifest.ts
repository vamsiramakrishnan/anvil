import { formatManifestIssue } from "@anvil/compiler";
import {
  loadBundleAir,
  readBundleDir,
  readBundleManifest,
  validateBundleManifest,
  writeBundleManifest,
} from "@anvil/generators";
import type { ConsoleResponse } from "../contract.js";
import { ConsoleError } from "./errors.js";
import { shellArg } from "./history.js";
import type { Request } from "./mutations.js";
import { findBundle } from "./workspace.js";

/**
 * The bundle's manifest — the semantic overlay it was compiled with, kept at
 * `<bundle>/.anvil/manifest.yaml` by `anvil compile` and the console's own
 * create route. Three routes, one file, no recompile:
 *
 *   GET  manifest            `readBundleManifest`
 *   POST manifest/validate   `validateBundleManifest` (= `parseManifestDetailed`)
 *   POST manifest            `writeBundleManifest` (atomic; refuses invalid text)
 *
 * The file is addressed by the bundle id alone, so a request carries no path
 * that could leave the workspace root. Editing the manifest changes nothing
 * about the bundle until `anvil compile` runs again; every response says so
 * by carrying that command.
 */

function recompileCommand(root: string, bundleDir: string, manifestPath: string): string {
  const air = loadBundleAir(bundleDir, readBundleDir(bundleDir));
  const snapshot = air.service.source.snapshotId;
  const input = snapshot
    ? `--source ${shellArg(snapshot)}`
    : shellArg(air.service.source.uri ?? "<spec>");
  return `anvil compile ${input} --manifest ${shellArg(manifestPath)} --out ${shellArg(bundleDir)} --root ${shellArg(root)}`;
}

export function manifestView(root: string, id: string): ConsoleResponse<"manifest"> {
  const bundle = findBundle(root, id);
  const manifest = readBundleManifest(bundle.dir);
  return { ...manifest, recompileCommand: recompileCommand(root, bundle.dir, manifest.path) };
}

export function validateManifest(
  root: string,
  id: string,
  body: Request<"validateManifest">,
): ConsoleResponse<"validateManifest"> {
  findBundle(root, id);
  return validateBundleManifest(body.text);
}

export function writeManifest(
  root: string,
  id: string,
  body: Request<"writeManifest">,
): ConsoleResponse<"writeManifest"> {
  const bundle = findBundle(root, id);
  const validation = validateBundleManifest(body.text);
  if (!validation.ok) {
    throw new ConsoleError(
      "console/manifest_invalid",
      422,
      "The manifest was not written: the compiler's parser refuses it.",
      { issues: validation.issues.map((issue) => formatManifestIssue(issue, "manifest.yaml")) },
    );
  }
  const path = writeBundleManifest(bundle.dir, body.text);
  return { path, written: true, recompileCommand: recompileCommand(root, bundle.dir, path) };
}
