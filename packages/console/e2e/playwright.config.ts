import { defineConfig } from "@playwright/test";

/**
 * The console's end-to-end proof: a real browser (Chromium) driving the REAL
 * built page served by a REAL `anvil console` process over a workspace that
 * `global-setup.ts` compiles with the built CLI. Every scenario asserts on
 * disk — `air.yaml`, the regenerated projections, the pack's `receipts/` —
 * not only on the DOM, because the console is a projection and the disk is
 * the truth it projects.
 *
 * Runs as its own turbo task (`pnpm test:e2e`), never inside `pnpm test`, so
 * the unit suite and the mutation runner are unaffected. The browser build is
 * whatever `@playwright/test`'s pinned version expects; CI installs it with
 * `playwright install --with-deps chromium`, and a machine with the browsers
 * elsewhere points `PLAYWRIGHT_BROWSERS_PATH` at them (or names a binary in
 * `ANVIL_E2E_CHROMIUM`) — this config never installs anything.
 */
const chromium = process.env.ANVIL_E2E_CHROMIUM;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  globalSetup: "./global-setup.ts",
  // The scenarios share one workspace and change its state in a deliberate
  // order (approve, reject, decide, apply), so they run serially in one worker.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: "../test-results",
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "../playwright-report" }]]
    : "list",
  use: {
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
    ...(chromium ? { launchOptions: { executablePath: chromium } } : {}),
  },
});
