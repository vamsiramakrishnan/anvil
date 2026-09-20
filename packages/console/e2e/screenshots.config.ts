import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * Regenerates the console screenshots the docs embed (`docs/assets/console/`)
 * from the same workspace the end-to-end proof drives: the built CLI compiles
 * `examples/payments`, `anvil console` serves it, and Chromium captures each
 * key view at one fixed size and theme so the pictures stay comparable across
 * releases. `pnpm --filter @anvil/console screenshots`, after `pnpm build`.
 *
 * This is a separate config so `pnpm test:e2e` never writes into `docs/`.
 */
const chromium = process.env.ANVIL_E2E_CHROMIUM;
// A fixed workspace path, so the paths the console shows are the same in every set.
process.env.ANVIL_E2E_WORKSPACE ??= join(tmpdir(), "anvil-workspace");

export default defineConfig({
  testDir: ".",
  testMatch: /screenshots\.capture\.ts$/,
  globalSetup: "./global-setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: "../test-results/screenshots",
  reporter: "list",
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    ...(chromium ? { launchOptions: { executablePath: chromium } } : {}),
  },
});
