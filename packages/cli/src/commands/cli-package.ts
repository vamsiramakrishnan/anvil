import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The `@anvil/cli` package directory, so the harness can link it into the
 * bundle and spawn `node cli/<svc>.mjs`. The harness cannot depend on
 * `@anvil/cli` (it would cycle), so the CLI resolves its own root here by
 * walking up from this module to the nearest package.json named `@anvil/cli`.
 */
export function resolveCliPackageDir(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      try {
        const name = JSON.parse(readFileSync(manifest, "utf8")).name;
        if (name === "@anvil/cli") return current;
      } catch {
        // keep walking
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Could not locate the @anvil/cli package root from the CLI command.");
    }
    current = parent;
  }
}
