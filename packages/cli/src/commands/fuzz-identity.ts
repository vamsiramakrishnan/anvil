import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readBundleDir } from "@anvil/generators";

/** The generated bundle loads these installed binaries when the driver executes it. */
export function fuzzToolchainHash(
  cliRoot: string,
  packageDir: (name: string, from?: string) => string,
): string {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch }),
  );
  for (const name of ["cli", "air", "runtime", "mcp-runtime", "harness", "fuzz"]) {
    const root = name === "cli" ? cliRoot : packageDir(`@anvil/${name}`, cliRoot);
    hash.update(readFileSync(join(root, "package.json")));
    const files = readBundleDir(join(root, "dist"));
    for (const path of Object.keys(files)
      .filter((path) => /\.(m?js|cjs)$/.test(path))
      .sort()) {
      hash.update(`${name}/${path}\0${files[path]}\0`);
    }
  }
  // Runtime protocol/schema versions and the campaign generator affect behavior.
  for (const [name, from] of [
    ["@modelcontextprotocol/sdk", cliRoot],
    ["zod", cliRoot],
    ["fast-check", packageDir("@anvil/fuzz", cliRoot)],
    ["@anvil/grammar", packageDir("@anvil/runtime", cliRoot)],
  ] as const) {
    const manifest = JSON.parse(readFileSync(join(packageDir(name, from), "package.json"), "utf8"));
    hash.update(JSON.stringify({ name: manifest.name, version: manifest.version }));
  }
  return hash.digest("hex");
}
