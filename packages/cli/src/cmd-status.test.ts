import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

describe("anvil status", () => {
  it("shows a fresh released journey with canonical source coordinates", async () => {
    const { bundle, root } = await compileApprovedBundle();
    const sourceRoot = join(root, "workspace");
    const certify = bufferIO();
    expect(await runAnvilCli(["certify", bundle], { io: certify }), certify.text()).toBe(0);
    const publish = bufferIO();
    expect(
      await runAnvilCli(["publish", bundle, "--target", "cloud-run", "--env", "dev"], {
        io: publish,
      }),
      publish.text(),
    ).toBe(0);

    const io = bufferIO();
    expect(await runAnvilCli(["status", bundle], { io })).toBe(0);
    expect(io.text()).toContain("Core projections — ALIGNED");
    expect(io.text()).toContain("certification: fresh");
    expect(io.text()).toContain("publication:   fresh");
    expect(io.text()).toContain("Next safe action — complete");

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
      approved: 4,
      review_required: 0,
      blocked: 0,
    });
    expect(
      report.core.projections.every(
        (projection: { state: string }) => projection.state === "fresh",
      ),
    ).toBe(true);
    expect(report.certification.state).toBe("fresh");
    expect(report.publication.state).toBe("fresh");
  });

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
    expect(report.nextAction.code).toBe("certify");
  });
});
