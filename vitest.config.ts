import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve @anvil/* workspace packages to their TS source so the suite runs
// without a prior build step. Keep this list in sync with packages/*.
const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@anvil/air": pkg("air"),
      "@anvil/runtime": pkg("runtime"),
      "@anvil/compiler": pkg("compiler"),
      "@anvil/generators": pkg("generators"),
      "@anvil/harness": pkg("harness"),
      "@anvil/refinement": pkg("refinement"),
      "@anvil/system-pack": pkg("system-pack"),
      "@anvil/simulator": pkg("simulator"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
