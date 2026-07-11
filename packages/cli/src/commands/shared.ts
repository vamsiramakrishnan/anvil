import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type AirDocument, airFromJson, airFromYaml } from "@anvil/air";

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
