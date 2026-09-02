import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AirDocument, airFromJson, airFromYaml, airToJson, airToYaml } from "@anvil/air";

/**
 * The canonical AIR document on disk: resolve it, read it, write it back in
 * the format its extension names. This lives in `@anvil/refinement` rather
 * than beside the bundle-layout readers in `@anvil/generators` because both
 * the flywheel's apply steps (`applyPackToBundle`, `anvil refine apply`) and
 * the generators' atomic reprojection need it, and generators already depends
 * on refinement — the reverse edge would be a cycle. Refinement's review lane
 * already reads a bundle's `air.json` from disk, so file IO on AIR is not new
 * to this package; what is new is that there is exactly one resolver.
 */

/** Resolve a generated directory (or direct file path) to its AIR file. */
export function resolveAirPath(path?: string): string {
  if (!path) throw new Error("Provide a path to an AIR file or a generated directory.");
  if (existsSync(path) && statSync(path).isDirectory()) {
    for (const name of ["air.yaml", "air.json"]) {
      const candidate = join(path, name);
      if (existsSync(candidate)) return candidate;
    }
    throw new Error(`No air.yaml or air.json in ${path}.`);
  }
  return path;
}

/** Load and validate the AIR document at a file or generated-directory path. */
export function loadAir(path?: string): AirDocument {
  const resolved = resolveAirPath(path);
  const text = readFileSync(resolved, "utf8");
  return resolved.endsWith(".json") ? airFromJson(text) : airFromYaml(text);
}

/**
 * Write AIR back in whatever format the resolved path names. `loadAir` reads by
 * this same extension, so the write path must agree with it instead of always
 * serialising YAML (which would corrupt an air.json target).
 */
export function writeAir(airPath: string, air: AirDocument): void {
  writeFileSync(airPath, airPath.endsWith(".json") ? airToJson(air) : airToYaml(air), "utf8");
}
