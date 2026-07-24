import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("describes the shared estate default and explicit dedicated ledger mode", async () => {
    const result = await cli(["deploy", "cloud-run", bundle]);
    expect(result.code, result.io.text()).toBe(0);
    const output = result.io.stdout.join("\n");
    expect(output).toContain("shared mode uses an existing");
    expect(output).toContain("dedicated mode creates one protected database");
    expect(output).toContain("No cloud call is made by this command");
    expect(output).toContain("Deployment remains operator action");
    expect(output).toContain("gcloud builds submit --project <PROJECT_ID>");
    expect(output).toContain("refuses a reviewed ledger project");
    expect(output).not.toContain("Firestore (default)");
  });

  it("makes the offline ledger inspection journey discoverable from deploy help", async () => {
    const result = await cli(["deploy", "--help"]);
    expect(result.code, result.io.text()).toBe(0);
    const output = result.io.stdout.join("\n");
    expect(output).toContain("ledger");
    expect(output).toContain("durable idempotency");
    expect(output).toContain("does not call Cloud Run, Firestore");
  });

  it("lists every approved write and distinguishes static wiring from live readiness", async () => {
    const result = await cli(["deploy", "ledger", bundle]);
    expect(result.code, result.io.text()).toBe(0);
    const output = result.io.stdout.join("\n");
    expect(output).toContain("Idempotency write plan — payments");
    expect(output).toContain("payments.refunds.create");
    expect(output).toContain("payments.capture.create");
    expect(output).toContain("Google Cloud Firestore Native (no Firebase client SDK)");
    expect(output).toContain("Static wiring — FRESH");
    expect(output).toContain("Live readiness — UNVERIFIED");
    expect(output).toContain('curl --fail --silent --show-error "$ANVIL_SERVICE_URL/readyz"');
    expect(output).toContain("This is not exactly-once execution");
    expect(output).toContain("AlloyDB or Spanner require an explicitly registered backend");
    expect(output).toContain("replay result ceiling: 819200 serialized bytes");
    expect(output).toContain("cross-caller raw-key reuse conflicts before upstream");
    expect(output).toContain("provisioning mode: shared");
    expect(output).toContain("certified bundle hash:");
    expect(output).toContain("deployed runtime artifact hash:");
    expect(output).toContain("store contract digest:");
    expect(output).toContain("reviewed input digest: unresolved");
    expect(output).toContain("Cloud Build must submit with --project");
    expect(output).toContain("matching digest binds the plan, but is not an apply receipt");
    expect(output).toContain("0 per-capability");
    expect(output).toContain("never import the shared database");
    expect(output).toContain("Google Cloud console access does not enforce");
    expect(output).toContain("No cloud call was made");
    expect(result.io.stderr).toEqual([]);
  });

  it("resolves the generated store contract into machine-readable coordinates and tfvars", async () => {
    const json = await cli([
      "deploy",
      "ledger",
      bundle,
      "--project",
      "acme-prod-1",
      "--database",
      "trust-ledger-prod",
      "--ttl-seconds",
      "3600",
      "--json",
    ]);
    expect(json.code, json.io.text()).toBe(0);
    const report = JSON.parse(json.io.stdout.join("\n")) as {
      bundleHash: string;
      contract: { state: string; backend: string; digest: string };
      writes: Array<{
        id: string;
        idempotency: { explicitKeyRequired: boolean; explicitKeyRecommended: boolean };
      }>;
      store: {
        databaseId: string | null;
        provisioningMode: string;
        location: string | null;
        collectionGroup: string;
        runtimeUri: string;
        deploymentArtifactHash: string;
        resultTtlSeconds: number;
        maxReplayResultBytes: number;
        provisioning: {
          requiredSharedApis: string[];
          databaseQuotaSlotsPerCapability: { shared: number; dedicated: number };
          collectionMaterialization: string;
        };
        indexing: { defaultSingleFieldIndexes: boolean; queryPattern: string };
      };
      deploymentInput: {
        state: string;
        digest: string;
        values: {
          bundleHash: string;
          databaseId: string;
          databaseMode: string;
          expectedProjectId: string;
          location: string | null;
          namespace: string;
          resultTtlSeconds: number;
          runtimeArtifactHash: string;
          storeContractDigest: string;
        };
      };
      liveReadiness: { state: string; path: string; mutates: boolean };
      guarantees: {
        exactlyOnce: boolean;
        completedReplayRetentionSeconds: number;
        oversizedSuccessfulResponse: string;
        scope: string;
      };
      cloudCallsMade: boolean;
    };
    expect(report.contract).toMatchObject({ state: "fresh", backend: "firestore" });
    expect(report.bundleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.contract.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(report.writes).toContainEqual(
      expect.objectContaining({
        id: "payments.refunds.create",
        idempotency: expect.objectContaining({
          explicitKeyRequired: true,
          explicitKeyRecommended: true,
        }),
      }),
    );
    expect(report.store).toMatchObject({
      databaseId: "trust-ledger-prod",
      provisioningMode: "shared",
      location: null,
      runtimeUri: "firestore://acme-prod-1/trust-ledger-prod/payments",
      resultTtlSeconds: 3600,
      maxReplayResultBytes: 819_200,
    });
    expect(report.store.collectionGroup).toMatch(/^anvil_idempotency_[a-f0-9]{16}$/);
    expect(report.store.deploymentArtifactHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.store.provisioning).toMatchObject({
      requiredSharedApis: ["firestore.googleapis.com"],
      databaseQuotaSlotsPerCapability: { shared: 0, dedicated: 1 },
      collectionMaterialization: "first_atomic_reservation",
    });
    expect(report.store.indexing).toMatchObject({
      defaultSingleFieldIndexes: false,
      queryPattern: "document_id_only",
    });
    expect(report.deploymentInput).toMatchObject({
      state: "bound",
      values: {
        bundleHash: report.bundleHash,
        databaseId: "trust-ledger-prod",
        databaseMode: "shared",
        expectedProjectId: "acme-prod-1",
        location: null,
        resultTtlSeconds: 3600,
        runtimeArtifactHash: report.store.deploymentArtifactHash,
        storeContractDigest: report.contract.digest,
      },
    });
    expect(report.deploymentInput.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(report.liveReadiness).toEqual({
      state: "unverified",
      path: "/readyz",
      method: "field_masked_list",
      mutates: false,
      deploymentStartupGate: true,
      livenessRestartOnProviderFailure: false,
      expected: { httpStatus: 200, body: { ready: true, service: "payments" } },
      detail:
        "Only the deployed /readyz data-plane probe can prove the database exists and the runtime identity can reach it.",
    });
    expect(report.guarantees).toMatchObject({
      exactlyOnce: false,
      completedReplayRetentionSeconds: 3600,
      oversizedSuccessfulResponse: expect.stringContaining("819200"),
      scope: expect.stringContaining("when inbound identity is verified"),
    });
    expect(report.cloudCallsMade).toBe(false);

    const missingProject = await cli(["deploy", "ledger", bundle, "--tfvars"]);
    expect(missingProject.code).toBe(1);
    expect(missingProject.io.stderr.join("\n")).toContain(
      "--tfvars requires --project and --database",
    );

    const tfvars = await cli([
      "deploy",
      "ledger",
      bundle,
      "--project",
      "acme-prod-1",
      "--database",
      "trust-ledger-prod",
      "--ttl-seconds",
      "3600",
      "--tfvars",
    ]);
    expect(tfvars.code, tfvars.io.text()).toBe(0);
    const sharedInputs = JSON.parse(tfvars.io.stdout.join("\n")) as Record<string, unknown>;
    expect(sharedInputs).toMatchObject({
      anvil_expected_project_id: "acme-prod-1",
      ledger_database_mode: "shared",
      ledger_database_id: "trust-ledger-prod",
      ledger_location: null,
      ledger_result_ttl_seconds: 3600,
    });
    expect(sharedInputs.anvil_bundle_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(sharedInputs.anvil_ledger_input_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(sharedInputs.anvil_bundle_hash).toBe(report.bundleHash);
    expect(sharedInputs.anvil_ledger_input_digest).toBe(report.deploymentInput.digest);
    expect(sharedInputs).not.toHaveProperty("project_id");

    const dedicated = await cli([
      "deploy",
      "ledger",
      bundle,
      "--project",
      "acme-prod-1",
      "--database",
      "payments-ledger",
      "--database-mode",
      "dedicated",
      "--location",
      "nam5",
      "--tfvars",
    ]);
    expect(dedicated.code, dedicated.io.text()).toBe(0);
    expect(JSON.parse(dedicated.io.stdout.join("\n"))).toMatchObject({
      anvil_expected_project_id: "acme-prod-1",
      ledger_database_mode: "dedicated",
      ledger_database_id: "payments-ledger",
      ledger_location: "nam5",
    });

    const incompleteDedicated = await cli([
      "deploy",
      "ledger",
      bundle,
      "--database",
      "payments-ledger",
      "--database-mode",
      "dedicated",
    ]);
    expect(incompleteDedicated.code).toBe(1);
    expect(incompleteDedicated.io.stderr.join("\n")).toContain(
      "Dedicated mode requires --location",
    );
  });

  it("refuses a stale generated store contract instead of re-deriving coordinates", async () => {
    const path = join(bundle, "deploy", "idempotency-store.json");
    const original = readFileSync(path, "utf8");
    const contract = JSON.parse(original);
    contract.firestore.runtimeUri.resolvedTemplate =
      "firestore://{project_id}/{database_id}/forged";
    writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
    try {
      const result = await cli(["deploy", "ledger", bundle, "--project", "acme-prod-1"]);
      expect(result.code).toBe(1);
      expect(result.io.stderr.join("\n")).toContain("contract is stale");
      expect(result.io.stdout).toEqual([]);
    } finally {
      writeFileSync(path, original, "utf8");
    }
  });

  it("refuses a tampered Terraform ledger URI instead of claiming static wiring is fresh", async () => {
    const path = join(bundle, "deploy", "terraform", "main.tf");
    const original = readFileSync(path, "utf8");
    const expectedUri =
      "firestore://${var.project_id}/${local.ledger_database_id}/payments";
    expect(original).toContain(expectedUri);
    writeFileSync(path, original.replace(expectedUri, `${expectedUri}-forged`), "utf8");
    try {
      const result = await cli(["deploy", "ledger", bundle, "--project", "acme-prod-1"]);
      expect(result.code).toBe(1);
      expect(result.io.stderr.join("\n")).toContain("contract is stale");
      expect(result.io.stderr.join("\n")).toContain(
        "deploy/terraform/main.tf: bytes differ from deterministic projection",
      );
      expect(result.io.stdout).toEqual([]);
    } finally {
      writeFileSync(path, original, "utf8");
    }
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

  it("scopes recommended secret ids to the persisted deployment namespace", async () => {
    const generationPath = join(bundle, "generation.json");
    const original = readFileSync(generationPath, "utf8");
    try {
      const generation = JSON.parse(original);
      generation.resourceOptions.deploymentNamespace = "payments-prod-coordinate";
      writeFileSync(generationPath, `${JSON.stringify(generation, null, 2)}\n`);

      const result = await cli([
        "deploy",
        "credentials",
        bundle,
        "--project",
        "acme-prod-1",
        "--json",
      ]);
      expect(result.code, result.io.text()).toBe(0);
      const plan = JSON.parse(result.io.stdout.join("\n")) as {
        credentialNamespace: string;
        terraform: { credentialSecretIds: string[] };
      };
      expect(plan.credentialNamespace).toBe("payments-prod-coordinate");
      expect(plan.terraform.credentialSecretIds).not.toHaveLength(0);
      expect(plan.terraform.credentialSecretIds).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^projects\/acme-prod-1\/secrets\/payments-prod-coordinate-/,
          ),
        ]),
      );
    } finally {
      writeFileSync(generationPath, original, "utf8");
    }
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
