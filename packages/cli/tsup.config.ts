import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { defineConfig } from "tsup";

/** The commit this bundle is built at, for `anvil --version --json`; null outside git. */
function commit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export default defineConfig({
  entry: ["src/index.ts", "src/bin-anvil.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2023",
  // Written beside the bundle rather than inlined into it, so the content
  // digest `--version --json` reports moves only when the code does.
  onSuccess: async () => {
    writeFileSync("dist/build-info.json", `${JSON.stringify({ commit: commit() })}\n`);
  },
});
