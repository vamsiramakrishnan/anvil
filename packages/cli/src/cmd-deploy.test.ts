import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

const payments = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
let root: string;
let bundle: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "anvil deploy credentials "));
  bundle = join(root, "bundle");
  const io = bufferIO();
  const code = await runAnvilCli(
    [
      "compile",
      join(payments, "openapi.yaml"),
      "--manifest",
      join(payments, "anvil.yaml"),
      "--service",
      "payments",
      "--out",
      bundle,
      "--root",
      root,
    ],
    { io },
  );
  expect(code, io.text()).toBe(0);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

async function cli(args: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(args, { io });
  return { code, io };
}

describe("anvil deploy credentials", () => {
  it("describes the generated named ledger database instead of a shared default prerequisite", async () => {
    const result = await cli(["deploy", "cloud-run", bundle]);
    expect(result.code, result.io.text()).toBe(0);
    const output = result.io.stdout.join("\n");
    expect(output).toContain("creates its delete-protected named Firestore database");
    expect(output).not.toContain("Firestore (default)");
  });

  it("requires a real project id instead of emitting a literal placeholder", async () => {
    const missing = await cli(["deploy", "credentials", bundle]);
    expect(missing.code).toBe(1);
    expect(missing.io.stderr.join("\n")).toMatch(/required option.*--project/i);

    const invalid = await cli(["deploy", "credentials", bundle, "--project", "$(steal)"]);
    expect(invalid.code).toBe(1);
    expect(invalid.io.stderr.join("\n")).toMatch(/invalid --project/i);
  });

  it("emits deterministic JSON with a bundle-root Terraform directory and deduped secrets", async () => {
    const result = await cli([
      "deploy",
      "credentials",
      join(bundle, "air.yaml"),
      "--project",
      "acme-prod-1",
      "--json",
    ]);
    expect(result.code, result.io.text()).toBe(0);
    expect(result.io.stderr).toEqual([]);
    const plan = JSON.parse(result.io.stdout.join("\n")) as {
      project: string;
      bundleRoot: string;
      terraform: {
        directory: string;
        credentialSecretIds: string[];
        credentialSecretRefs: Record<string, string>;
      };
    };
    expect(plan.project).toBe("acme-prod-1");
    expect(plan.bundleRoot).toBe(bundle);
    expect(plan.terraform.directory).toBe(join(bundle, "deploy", "terraform"));
    expect(new Set(plan.terraform.credentialSecretIds).size).toBe(
      plan.terraform.credentialSecretIds.length,
    );
    expect(Object.values(plan.terraform.credentialSecretRefs)).not.toContain(
      expect.stringContaining("<PROJECT_ID>"),
    );
  });

  it("quotes the bundle path in copy-paste shell output", async () => {
    const result = await cli(["deploy", "credentials", bundle, "--project", "acme-prod-1"]);
    expect(result.code, result.io.text()).toBe(0);
    expect(result.io.stdout.join("\n")).toContain(
      `anvil deploy credentials '${bundle}' --env 'prod' --project 'acme-prod-1' --tfvars`,
    );
    expect(result.io.stdout.join("\n")).not.toContain("terraform apply -var");
    expect(readFileSync(join(bundle, "air.yaml"), "utf8")).toContain("payments");
  });

  it("emits directly consumable external Terraform variables", async () => {
    const result = await cli([
      "deploy",
      "credentials",
      bundle,
      "--project",
      "acme-prod-1",
      "--tfvars",
    ]);
    expect(result.code, result.io.text()).toBe(0);
    const tfvars = JSON.parse(result.io.stdout.join("\n")) as {
      credential_secret_refs: Record<string, string>;
      credential_secret_ids: string[];
      env: Record<string, string>;
      anvil_unresolved_config: Record<string, string>;
    };
    expect(tfvars.credential_secret_refs).toBeDefined();
    expect(tfvars.credential_secret_ids).toBeDefined();
    expect(Object.keys(tfvars.env).some((key) => key.endsWith("_CLIENT_ID"))).toBe(true);
    expect(Object.values(tfvars.env)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^REPLACE_ME_/)]),
    );
    expect(Object.values(tfvars.anvil_unresolved_config).join(" ")).toMatch(
      /ANVIL_CREDENTIAL_HOSTS.*OR.*TOKEN_ENDPOINT/,
    );
    expect(result.io.stderr).toEqual([]);
  });
});
