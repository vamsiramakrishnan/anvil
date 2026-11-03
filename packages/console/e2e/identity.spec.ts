import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadBundleAir, readBundleDir } from "@anvil/generators";
import { expect, test } from "@playwright/test";
import { readState } from "./global-setup.js";

/** Real browser + local server + CLI parity. No identity-provider network calls or credentials. */
test("identity configuration validates, applies exactly the CLI kit, and refuses a stale preview", async ({
  page,
}, testInfo) => {
  const state = readState();
  const bundleId = "identity-browser";
  const bundleDir = join(state.root, bundleId);
  const cliDir = join(state.root, "identity-cli-parity");
  const profilePath = join(state.root, "identity-browser-profile.json");
  const cli = (...args: string[]) =>
    execFileSync(process.execPath, [state.cli, ...args], { cwd: state.root, encoding: "utf8" });
  cli("compile", join(state.root, "openapi.yaml"), "--out", bundleDir, "--root", state.root);
  cpSync(bundleDir, cliDir, { recursive: true });
  try {
    const filesBefore = readBundleDir(bundleDir);
    const air = loadBundleAir(bundleDir, filesBefore);
    const operation = air.operations.find((candidate) => candidate.effect.kind === "read");
    if (!operation) throw new Error("The compiled fixture needs a read operation");
    const profile = {
      version: 1,
      id: "ultimatix-siteminder",
      authentication: {
        provider: "oauth2_introspection",
        issuer: "https://siteminder.example.com",
        audience: "https://ultimatix-mcp.example.com",
        requiredScopes: ["ultimatix.mcp"],
        introspection: {
          endpoint: "https://siteminder.example.com/introspect",
          clientIdEnv: "SITEMINDER_CLIENT_ID",
          clientSecretEnv: "SITEMINDER_CLIENT_SECRET",
          audienceSource: "dedicated_client",
        },
      },
      mapping: { tenant: { source: "fixed", value: "tcs" }, upstreamScopes: operation.auth.scopes },
      authorization: {
        rules: [
          {
            id: "employee-read",
            service: air.service.id,
            operations: [operation.id],
            effect: "allow",
          },
        ],
      },
    };
    writeFileSync(profilePath, JSON.stringify(profile));
    await page.goto(`${state.url}/#/b/${bundleId}/overview`);
    await page.getByRole("link", { name: "Identity", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Identity", level: 1 })).toBeVisible();
    await expect(page.getByText(/No identity profile is attached/)).toBeVisible();
    await expect(
      page.getByText(/Employees may sign into Gemini Enterprise with Entra ID/),
    ).toBeVisible();
    const apply = page.getByRole("button", { name: "Apply identity kit", exact: true });
    await expect(apply).toBeDisabled();
    await page.getByLabel("Import profile JSON").setInputFiles(profilePath);
    await expect(page.getByRole("textbox", { name: "Identity profile JSON" })).toHaveValue(
      /ultimatix-siteminder/,
    );
    await page.getByRole("button", { name: "Validate profile", exact: true }).click();
    await expect(page.getByText("valid preview", { exact: true })).toBeVisible();
    expect(readBundleDir(bundleDir)).toEqual(filesBefore);
    expect(existsSync(join(bundleDir, "targets/identity"))).toBe(false);
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(page.getByText(/Identity kit applied/)).toBeVisible();
    await expect(page.getByText("fresh", { exact: true })).toBeVisible();
    await expect(page.getByText("unverified", { exact: true })).toBeVisible();
    await expect(
      page.getByText("SITEMINDER_CLIENT_ID, SITEMINDER_CLIENT_SECRET", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("identity-configured.png"), fullPage: true });
    const after = readBundleDir(bundleDir);
    expect(after["air.json"]).toBe(filesBefore["air.json"]);
    expect(after["air.yaml"]).toBe(filesBefore["air.yaml"]);
    const binding = JSON.parse(String(after["targets/identity/binding.json"]));
    expect(binding).toMatchObject({ profile: profile.id, verifiedLive: false });
    cli("target", "identity", cliDir, "--profile", profilePath);
    const cliFiles = readBundleDir(cliDir);
    const targetFiles = Object.keys(after)
      .filter((path) => path.startsWith("targets/identity/"))
      .sort();
    expect(targetFiles.length).toBeGreaterThan(0);
    for (const path of targetFiles) expect(after[path], path).toBe(cliFiles[path]);

    // A previously valid preview cannot overwrite a bundle changed by another process.
    const editor = page.getByRole("textbox", { name: "Identity profile JSON" });
    await editor.fill(JSON.stringify({ ...profile, id: "replacement" }));
    await page.getByRole("button", { name: "Validate profile", exact: true }).click();
    await expect(page.getByText("valid preview", { exact: true })).toBeVisible();
    const installed = readFileSync(join(bundleDir, "targets/identity/profile.json"), "utf8");
    appendFileSync(join(bundleDir, "mcp/server.js"), "\n// external bundle edit\n");
    const refused = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/bundles/${bundleId}/identity`),
    );
    await apply.click();
    expect((await refused).status()).toBe(409);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(apply).toBeDisabled();
    expect(readFileSync(join(bundleDir, "targets/identity/profile.json"), "utf8")).toBe(installed);
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
    rmSync(cliDir, { recursive: true, force: true });
    rmSync(profilePath, { force: true });
  }
});
