import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleHash, readBundleDir } from "@anvil/generators";
import { afterEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

const examples = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function compileApprovedBundle(): Promise<{ bundle: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "anvil-status-"));
  roots.push(root);
  const bundle = join(root, "bundle");
  const io = bufferIO();
  const code = await runAnvilCli(
    [
      "compile",
      join(examples, "openapi.yaml"),
      "--manifest",
      join(examples, "anvil.yaml"),
      "--service",
      "payments",
      "--out",
      bundle,
      "--root",
      join(root, "workspace"),
    ],
    { io },
  );
  expect(code, io.text()).toBe(0);
  return { bundle, root };
}

async function jsonStatus(bundle: string, sourceRoot?: string) {
  const io = bufferIO();
  const code = await runAnvilCli(
    ["status", bundle, "--json", ...(sourceRoot ? ["--root", sourceRoot] : [])],
    { io },
  );
  return { code, io, report: JSON.parse(io.stdout[0] ?? "{}") };
}

function writePassingExecutableEvidence(bundle: string): void {
  const subject = bundleHash(readBundleDir(bundle));
  writeFileSync(
    join(bundle, "selftest.report.json"),
    JSON.stringify({
      schemaVersion: 1,
      bundleHash: subject,
      summary: { pass: 9, fail: 0, skipped: 1 },
    }),
  );
  writeFileSync(
    join(bundle, "conformance.report.json"),
    JSON.stringify({
      schemaVersion: 1,
      bundleHash: subject,
      summary: { pass: 11, fail: 0, skipped: 0 },
    }),
  );
  writeFileSync(
    join(bundle, "simulation.report.json"),
    JSON.stringify({
      schemaVersion: 1,
      bundleHash: subject,
      summary: {
        coverageCells: 35,
        coveragePassed: 35,
        mutantsKilled: 4,
        ok: true,
      },
    }),
  );
}

describe("anvil status", () => {
  it(
    "shows a planned journey without claiming a cloud deployment completed",
    async () => {
      const { bundle, root } = await compileApprovedBundle();
      const sourceRoot = join(root, "workspace");
      const certify = bufferIO();
      expect(await runAnvilCli(["certify", bundle], { io: certify }), certify.text()).toBe(0);
      writePassingExecutableEvidence(bundle);
      const publish = bufferIO();
      expect(
        await runAnvilCli(["publish", bundle, "--env", "dev"], {
          io: publish,
        }),
        publish.text(),
      ).toBe(0);

      const io = bufferIO();
      expect(await runAnvilCli(["status", bundle], { io })).toBe(0);
      expect(io.text()).toContain("Core projections — ALIGNED");
      expect(io.text()).toContain("static assurance: fresh");
      expect(io.text()).toContain("selftest:         fresh");
      expect(io.text()).toContain("conformance:      fresh");
      expect(io.text()).toContain("simulation:       fresh");
      expect(io.text()).toContain("deployment plan:  planned");
      expect(io.text()).toContain("Writes & idempotency");
      expect(io.text()).toContain("store contract: fresh · firestore");
      expect(io.text()).toContain("live readiness: unverified · /readyz");
      expect(io.text()).toContain("anvil deploy ledger");
      expect(io.text()).toContain("Next safe action — operator-action-required");
      expect(io.text()).toContain("Anvil made no cloud call");

      const { report } = await jsonStatus(bundle, sourceRoot);
      expect(report.paths.bundle).toBe(bundle);
      expect(report.paths.canonicalAir).toBe(join(bundle, "air.yaml"));
      expect(report.source.snapshotId).toMatch(/^src-/);
      expect(report.source.sourceHash).toBeTruthy();
      expect(report.source.origin).toEqual({
        kind: "filesystem",
        uri: join(examples, "openapi.yaml"),
      });
      expect(report.source.entrypoint).toBe("openapi.yaml");
      expect(report.source.root).toBe(sourceRoot);
      expect(report.source.integrity.state).toBe("fresh");
      expect(report.source.expectedLockedSource.snapshotRecord).toBe(
        join(sourceRoot, ".anvil", "sources", report.source.snapshotId, "source.json"),
      );
      expect(report.source.expectedLockedSource.entrypointBytes).toBe(
        join(sourceRoot, ".anvil", "sources", report.source.snapshotId, "raw", "openapi.yaml"),
      );
      expect(report.operations).toMatchObject({
        total: 4,
        generated: 0,
        approved: 4,
        review_required: 0,
        deprecated: 0,
        blocked: 0,
      });
      expect(report.idempotency).toMatchObject({
        writes: expect.arrayContaining([
          {
            id: "payments.refunds.create",
            command: "payments refunds create",
            mode: "required",
            keyDerivation: "client_supplied",
            explicitKeyRequired: true,
            explicitKeyRecommended: true,
            managedStoreRequired: true,
          },
        ]),
        store: {
          contractState: "fresh",
          required: true,
          backend: "firestore",
          databaseId: null,
          databaseTerraformVariable: "ledger_database_id",
          provisioningModeTerraformVariable: "ledger_database_mode",
          provisioningModeDefault: "shared",
          collectionGroup: expect.stringMatching(/^anvil_idempotency_[a-f0-9]{16}$/),
          runtimeUriTemplate: "firestore://{project_id}/{database_id}/payments",
          locationTerraformVariable: "ledger_location",
          locationImmutable: true,
          contractPath: join(bundle, "deploy", "idempotency-store.json"),
          detail: expect.stringContaining("every compiler-owned bundle byte"),
        },
        liveReadiness: {
          state: "unverified",
          path: "/readyz",
          mutates: false,
        },
      });
      expect(
        report.core.projections.every(
          (projection: { state: string }) => projection.state === "fresh",
        ),
      ).toBe(true);
      expect(report.certification.state).toBe("fresh");
      expect(report.executableEvidence.selftest).toMatchObject({
        state: "fresh",
        fresh: true,
        passed: true,
        bundleHash: report.core.bundleHash,
      });
      expect(report.executableEvidence.conformance.state).toBe("fresh");
      expect(report.executableEvidence.simulation.state).toBe("fresh");
      expect(report.publication.state).toBe("planned");
      expect(report.publication.cloudCallsMade).toBe(false);
      expect(report.publication.operatorActionRequired).toBe(true);
      expect(report.nextAction.code).toBe("operator-action-required");
    },
    20_000,
  );

  it("anchors --root, validates locked source bytes, and propagates it to recovery", async () => {
    const { bundle, root } = await compileApprovedBundle();
    const sourceRoot = join(root, "workspace");
    const initial = await jsonStatus(bundle, sourceRoot);
    expect(initial.code, initial.io.text()).toBe(0);
    const rawEntrypoint = initial.report.source.expectedLockedSource.entrypointBytes as string;
    writeFileSync(rawEntrypoint, `${readFileSync(rawEntrypoint, "utf8")}\n# tampered\n`);

    const { code, report } = await jsonStatus(bundle, sourceRoot);
    expect(code).toBe(1);
    expect(report.source.root).toBe(sourceRoot);
    expect(report.source.integrity.state).toBe("corrupt");
    expect(
      report.source.integrity.diagnostics.map((diagnostic: { code: string }) => diagnostic.code),
    ).toContain("source/file_changed");
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "status.source.corrupt", severity: "error" }),
    );
    expect(report.nextAction.code).toBe("repair-core");
    expect(report.nextAction.command).toContain(`--root ${sourceRoot}`);
  });

  it("returns a stable core diagnostic after a projection is tampered", async () => {
    const { bundle } = await compileApprovedBundle();
    const cliPath = join(bundle, "cli", "air.json");
    const cliAir = JSON.parse(readFileSync(cliPath, "utf8"));
    cliAir.operations[0].state = "blocked";
    writeFileSync(cliPath, `${JSON.stringify(cliAir, null, 2)}\n`, "utf8");

    const { code, report } = await jsonStatus(bundle);
    expect(code).toBe(1);
    expect(report.core.state).toBe("misaligned");
    expect(report.core.projections).toContainEqual(
      expect.objectContaining({ id: "cli", state: "misaligned" }),
    );
    expect(report.diagnostics.map((diagnostic: { code: string }) => diagnostic.code)).toEqual(
      expect.arrayContaining(["contract.surfaces-agree", "status.core.cli.misaligned"]),
    );
    expect(report.nextAction.code).toBe("repair-core");
    expect(readFileSync(cliPath, "utf8")).toBe(`${JSON.stringify(cliAir, null, 2)}\n`);
  });

  it("routes healthy gateway projections with opaque policy to the policy owner, not source repair", async () => {
    const root = mkdtempSync(join(tmpdir(), "anvil-status-gateway-"));
    roots.push(root);
    const gateway = join(root, "kong.yaml");
    const bundle = join(root, "bundle");
    writeFileSync(
      gateway,
      `_format_version: "3.0"
services:
  - name: refunds
    routes:
      - name: refunds
        paths: ["/refunds"]
        methods: ["POST"]
    plugins:
      - name: custom-request-transformer
        config: { add: { headers: ["x-tenant:example"] } }
`,
    );
    const imported = bufferIO();
    expect(
      await runAnvilCli(
        [
          "estate",
          "import",
          gateway,
          "--vendor",
          "kong",
          "--api",
          "refunds",
          "--out",
          bundle,
          "--root",
          root,
        ],
        { io: imported },
      ),
      imported.text(),
    ).toBe(0);

    const { code, report } = await jsonStatus(bundle);
    expect(code).toBe(0);
    expect(report.core.state).toBe("aligned");
    expect(report.gatewayImport).toMatchObject({
      state: "bound",
      verifyCommand: expect.stringContaining(`--root ${root}`),
    });
    expect(
      report.core.projections.every(
        (projection: { state: string }) => projection.state === "fresh",
      ),
    ).toBe(true);
    expect(report.core.contractChecks).toContainEqual(
      expect.objectContaining({
        code: "contract.gateway-blockers-resolved",
        state: "failed",
      }),
    );
    expect(report.nextAction).toMatchObject({
      code: "resolve-gateway-policy",
      command: `anvil inspect ${bundle}`,
      reason: expect.stringContaining("gateway policy evidence is unresolved"),
    });
    expect(report.nextAction.reason).not.toContain("verify the locked source");
  });

  it("fails core status when the generated idempotency-store contract is stale", async () => {
    const { bundle } = await compileApprovedBundle();
    const path = join(bundle, "deploy", "idempotency-store.json");
    const contract = JSON.parse(readFileSync(path, "utf8"));
    contract.firestore.runtimeUri.resolvedTemplate =
      "firestore://{project_id}/{database_id}/forged";
    writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`, "utf8");

    const { code, report } = await jsonStatus(bundle);
    expect(code).toBe(1);
    expect(report.core.state).toBe("misaligned");
    expect(report.idempotency.store.contractState).toBe("stale");
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "status.idempotency.contract_stale",
        severity: "error",
        path,
      }),
    );
    expect(report.nextAction.code).toBe("repair-core");
  });

  it("marks the store projection stale when the generated Terraform ledger URI is tampered", async () => {
    const { bundle } = await compileApprovedBundle();
    const path = join(bundle, "deploy", "terraform", "main.tf");
    const original = readFileSync(path, "utf8");
    const expectedUri =
      "firestore://${var.project_id}/${local.ledger_database_id}/payments";
    expect(original).toContain(expectedUri);
    writeFileSync(path, original.replace(expectedUri, `${expectedUri}-forged`), "utf8");

    const { code, report } = await jsonStatus(bundle);
    expect(code).toBe(1);
    expect(report.core.state).toBe("misaligned");
    expect(report.idempotency.store.contractState).toBe("stale");
    expect(report.idempotency.store.detail).toContain(
      "deploy/terraform/main.tf: bytes differ from deterministic projection",
    );
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "status.idempotency.contract_stale",
        severity: "error",
        path: join(bundle, "deploy", "idempotency-store.json"),
      }),
    );
    expect(report.core.contractChecks).toContainEqual(
      expect.objectContaining({
        code: "contract.generated-bytes-agree",
        state: "failed",
      }),
    );
    expect(report.nextAction.code).toBe("repair-core");
  });

  it("fails closed when the AIR loaded by the deployed runtime is tampered", async () => {
    const { bundle } = await compileApprovedBundle();
    const runtimeAirPath = join(bundle, "runtime", "air.json");
    const runtimeAir = JSON.parse(readFileSync(runtimeAirPath, "utf8"));
    runtimeAir.operations[0].mcp.toolName = "runtime_only_tool";
    writeFileSync(runtimeAirPath, `${JSON.stringify(runtimeAir, null, 2)}\n`, "utf8");

    const { code, report } = await jsonStatus(bundle);
    expect(code).toBe(1);
    expect(report.core.projections).toContainEqual(
      expect.objectContaining({ id: "runtime-air", state: "misaligned" }),
    );
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "status.core.runtime_air.misaligned",
        severity: "error",
      }),
    );
  });

  it("reports compiler-owned executable drift even after the bytes are present and parseable", async () => {
    const { bundle } = await compileApprovedBundle();
    const runtimePath = join(bundle, "runtime", "server.js");
    writeFileSync(
      runtimePath,
      `${readFileSync(runtimePath, "utf8")}\n// bypass inbound auth\n`,
      "utf8",
    );

    const { code, report } = await jsonStatus(bundle);
    expect(code).toBe(1);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "contract.generated-bytes-agree",
        severity: "error",
      }),
    );
    expect(
      report.core.contractChecks.find(
        (check: { code: string }) => check.code === "contract.generated-bytes-agree",
      )?.detail,
    ).toContain("runtime/server.js");
  });

  it("prioritizes exact retargeting before re-certification when target bytes drift", async () => {
    const { bundle } = await compileApprovedBundle();
    const target = bufferIO();
    expect(
      await runAnvilCli(
        [
          "target",
          "gemini-enterprise",
          bundle,
          "--surface",
          "custom-mcp",
          "--server-auth",
          "no-auth",
          "--allow-unauthenticated-mcp",
          "--endpoint",
          "https://mcp.example.test/mcp",
          "--project",
          "example-project",
          "--location",
          "global",
          "--engine",
          "example-engine",
        ],
        { io: target },
      ),
      target.text(),
    ).toBe(0);
    const certify = bufferIO();
    expect(await runAnvilCli(["certify", bundle], { io: certify }), certify.text()).toBe(0);
    const human = bufferIO();
    expect(await runAnvilCli(["status", bundle], { io: human }), human.text()).toBe(0);
    expect(human.text()).toContain("custom-mcp · GE global · no-auth");

    const setupPath = join(bundle, "targets", "gemini-enterprise", "setup.json");
    const setup = JSON.parse(readFileSync(setupPath, "utf8"));
    setup.surfaceSignatureDigest = "stale-surface-signature";
    writeFileSync(setupPath, `${JSON.stringify(setup, null, 2)}\n`, "utf8");

    const { code, report } = await jsonStatus(bundle);
    expect(code).toBe(0);
    expect(report.certification.state).toBe("stale");
    expect(report.targets).toEqual([
      expect.objectContaining({
        targetId: "gemini-enterprise",
        state: "stale",
        recordedSurfaceSignature: "stale-surface-signature",
      }),
    ]);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "status.target.kit_stale", severity: "warning" }),
    );
    expect(report.nextAction.code).toBe("retarget");
    expect(report.nextAction.command).toContain("anvil target gemini-enterprise");
  });

  it("--json emits exactly one pure StatusReport document", async () => {
    const { bundle } = await compileApprovedBundle();
    const { code, io, report } = await jsonStatus(bundle);

    expect(code).toBe(0);
    expect(io.stderr).toEqual([]);
    expect(io.stdout).toHaveLength(1);
    expect(io.stdout[0]?.trim().startsWith("{")).toBe(true);
    expect(io.stdout[0]?.trim().endsWith("}")).toBe(true);
    expect(report.schemaVersion).toBe(1);
    expect(report.serviceId).toBe("payments");
    expect(report.executableEvidence.selftest).toMatchObject({
      state: "missing",
      fresh: false,
      passed: null,
    });
    expect(report.nextAction.code).toBe("certify");
  });

  it("reports pass and freshness independently and routes to the first incomplete lane", async () => {
    const { bundle } = await compileApprovedBundle();
    const certify = bufferIO();
    expect(await runAnvilCli(["certify", bundle], { io: certify }), certify.text()).toBe(0);
    const subject = bundleHash(readBundleDir(bundle));
    writeFileSync(
      join(bundle, "selftest.report.json"),
      JSON.stringify({
        schemaVersion: 1,
        bundleHash: subject,
        summary: { pass: 9, fail: 0, skipped: 1 },
      }),
    );
    writeFileSync(
      join(bundle, "conformance.report.json"),
      JSON.stringify({
        schemaVersion: 1,
        bundleHash: "0".repeat(64),
        summary: { pass: 11, fail: 0, skipped: 0 },
      }),
    );
    writeFileSync(
      join(bundle, "simulation.report.json"),
      JSON.stringify({
        schemaVersion: 1,
        bundleHash: subject,
        summary: {
          coverageCells: 35,
          coveragePassed: 34,
          mutantsKilled: 3,
          ok: false,
        },
      }),
    );

    const { code, report } = await jsonStatus(bundle);
    expect(code).toBe(0);
    expect(report.executableEvidence.selftest).toMatchObject({
      state: "fresh",
      fresh: true,
      passed: true,
    });
    expect(report.executableEvidence.conformance).toMatchObject({
      state: "stale",
      fresh: false,
      passed: true,
    });
    expect(report.executableEvidence.simulation).toMatchObject({
      state: "failed",
      fresh: true,
      passed: false,
    });
    expect(report.nextAction).toMatchObject({
      code: "conformance",
      command: `anvil conformance ${bundle}`,
    });
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "status.evidence.conformance.stale" }),
        expect.objectContaining({ code: "status.evidence.simulation.failed" }),
      ]),
    );
  });
});
