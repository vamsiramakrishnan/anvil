import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve @anvil/* workspace packages to their TS source so the suite runs
// without a prior build step. Keep this list in sync with packages/*.
const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@anvil/compiler/legacy": fileURLToPath(
        new URL("./packages/compiler/src/legacy/index.ts", import.meta.url),
      ),
      "@anvil/air": pkg("air"),
      "@anvil/runtime": pkg("runtime"),
      "@anvil/compiler": pkg("compiler"),
      "@anvil/generators": pkg("generators"),
      "@anvil/harness": pkg("harness"),
      "@anvil/refinement": pkg("refinement"),
      "@anvil/system-pack": pkg("system-pack"),
      "@anvil/simulator": pkg("simulator"),
      "@anvil/certification": pkg("certification"),
      "@anvil/targets": pkg("targets"),
      "@anvil/console": pkg("console"),
    },
  },
  test: {
    // tools/corpus is included so the naming-conformance ratchet's logic is a
    // vitest-testable module — the mutation gate (tools/mutation) kills its
    // mutants by running vitest test sets, which only works for files the
    // runner can collect.
    // `*.test.tsx` is the console UI's React tests (jsdom, opted in per file).
    include: ["packages/**/*.test.ts", "packages/**/*.test.tsx", "tools/corpus/**/*.test.ts"],
    environment: "node",
    globals: false,
    /**
     * Vitest's 5s default is sized for unit tests. Much of this suite is not:
     * the CLI tests import gateway estates, compile them, certify bundles, boot
     * MCP servers over a real transport, and drive the simulator — each doing
     * real filesystem work in a temp dir.
     *
     * Those tests are fast on an idle machine (the estate-import lifecycle case
     * that forced this runs in ~800ms locally) and nowhere near the limit on
     * their own. Under CI, where turbo runs packages in parallel on a contended
     * runner, the same case exceeded 5s and failed the build. Two different
     * files hit it, so the cause is the default rather than any one test.
     *
     * 30s is chosen to absorb that contention without hiding a real hang: a test
     * that genuinely deadlocks still fails, just less promptly. If a test needs
     * more than this, it is doing too much and should be split rather than
     * granted its own longer timeout.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
