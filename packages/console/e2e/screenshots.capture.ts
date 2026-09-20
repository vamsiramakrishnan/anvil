import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { type E2EState, readState } from "./global-setup.js";

/**
 * The console's key views, captured for the documentation. Runs under
 * `screenshots.config.ts` (never under `pnpm test:e2e`), over the workspace
 * `global-setup.ts` compiles. The only state it changes is one extra bundle,
 * generated from the built-in example through the Import API page, so the
 * workspace picture shows more than a single row.
 *
 * Every capture waits for the view's own heading and for web fonts, and
 * keeps the viewport the config fixes, so a regenerated set differs only
 * where the console itself changed.
 */

const OUT = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "..",
  "..",
  "docs",
  "assets",
  "console",
);

test.describe.configure({ mode: "serial" });

let state: E2EState;

test.beforeAll(() => {
  state = readState();
  mkdirSync(OUT, { recursive: true });
});

const bundleUrl = (view: string, query = "") =>
  `${state.url}/#/b/${encodeURIComponent(state.bundleId)}/${view}${query}`;

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle");
}

async function capture(page: Page, name: string): Promise<void> {
  await settle(page);
  await page.screenshot({
    path: join(OUT, `${name}.png`),
    fullPage: false,
    animations: "disabled",
  });
}

test("import an API from a pasted contract", async ({ page }) => {
  await page.goto(`${state.url}/#/new`);
  await page.getByRole("button", { name: "Paste a contract" }).click();
  await page.getByRole("button", { name: "Use an example" }).click();
  await expect(page.getByPlaceholder("Paste your specification here…")).not.toBeEmpty();
  await capture(page, "import-api");

  await page.getByRole("button", { name: "Generate bundle →" }).click();
  await expect(page.getByRole("heading", { name: "generated/store-orders" })).toBeVisible();
  await capture(page, "import-result");
});

test("the workspace lists every bundle with its review state", async ({ page }) => {
  await page.goto(`${state.url}/#/`);
  await expect(page.locator(`tr[data-bundle-id="${state.bundleId}"]`)).toBeVisible();
  await expect(page.locator('tr[data-bundle-id="generated/store-orders"]')).toBeVisible();
  await capture(page, "workspace");
});

test("a bundle's overview", async ({ page }) => {
  await page.goto(bundleUrl("overview"));
  await expect(page.getByRole("heading", { name: "Prepare your API", level: 2 })).toBeVisible();
  await capture(page, "overview");
});

test("API operations with the refund selected", async ({ page }) => {
  await page.goto(bundleUrl("catalog", `?op=${encodeURIComponent(state.nonIdempotentMutation)}`));
  await expect(page.getByRole("heading", { name: "API operations", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Operation details" })).toBeVisible();
  await capture(page, "api-operations");
});

test("the review queue with a pending decision open", async ({ page }) => {
  await page.goto(bundleUrl("queue"));
  await expect(page.getByRole("heading", { name: "Review", level: 1, exact: true })).toBeVisible();
  const id = state.nonIdempotentMutation;
  await page
    .getByRole("option")
    .filter({ has: page.getByLabel(`select ${id}`, { exact: true }) })
    .click();
  await expect(page.locator("aside.detail")).toContainText(id);
  await capture(page, "review");
});

test("the request builder drafting a dry run", async ({ page }) => {
  await page.goto(
    bundleUrl("workbench", `?operation=${encodeURIComponent(state.nonIdempotentMutation)}`),
  );
  await expect(page.getByRole("heading", { name: "Request builder", level: 1 })).toBeVisible();
  await expect(page.getByLabel("JSON arguments")).toBeVisible();
  await capture(page, "request-builder");
});

test("interfaces, reading the generated MCP server", async ({ page }) => {
  await page.goto(bundleUrl("artifacts", "?interface=mcp"));
  await expect(page.getByRole("heading", { name: "Interfaces", level: 1 })).toBeVisible();
  const files = page.getByRole("navigation", { name: "Artifact files" });
  await files.getByText("mcp/server.js", { exact: true }).click();
  await expect(page.getByRole("region", { name: "Contents of mcp/server.js" })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await capture(page, "interfaces");
});

test("checks and evidence", async ({ page }) => {
  await page.goto(bundleUrl("evidence"));
  await expect(page.getByRole("heading", { name: "Checks & evidence", level: 1 })).toBeVisible();
  await capture(page, "checks-evidence");
});
