import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AnvilCliDeps, runAnvilCli } from "./anvil-cli.js";
import type { TargetDeps } from "./commands/target.js";
import { bufferIO } from "./io.js";

const payments = fileURLToPath(new URL("../../../examples/payments/", import.meta.url));
let root: string;
let baseBundle: string;
let sequence = 0;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "anvil-target-cli-"));
  baseBundle = join(root, "base");
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
      baseBundle,
      "--root",
      root,
    ],
    { io },
  );
  expect(code, io.text()).toBe(0);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function freshBundle(): string {
  const bundle = join(root, `bundle-${sequence++}`);
  cpSync(baseBundle, bundle, { recursive: true });
  return bundle;
}

async function cli(argv: string[], deps: TargetDeps = {}) {
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io, ...deps } as AnvilCliDeps & TargetDeps);
  return { code, io };
}

function oauthArgs(
  bundleOrAir: string,
  surface: "custom-mcp" | "agent-gateway" | "both" = "custom-mcp",
): string[] {
  const args = [
    "target",
    "gemini-enterprise",
    bundleOrAir,
    "--surface",
    surface,
    "--server-auth",
    "oauth",
    "--endpoint",
    "https://mcp.example.test/mcp",
    "--project",
    "acme-proj",
    "--location",
    "global",
    "--engine",
    "eng-1",
    "--idp",
    "entra",
    "--tenant",
    "tenant-123",
    "--oauth-scope",
    "api://anvil-mcp/mcp.invoke",
    "--inbound-issuer",
    "https://login.microsoftonline.com/tenant-123/v2.0",
    "--inbound-audience",
    "api://anvil-mcp",
    "--wif",
    "locations/global/workforcePools/ge-users",
  ];
  if (surface !== "custom-mcp") {
    args.push(
      "--agent-identity-principal-set",
      "principalSet://agents.global.org-123.system.id.goog/deployed-agents",
      "--gateway-authorization-policy",
      "projects/acme-proj/locations/us-central1/authzPolicies/mcp-egress",
    );
  }
  return args;
}

describe("anvil target Gemini Enterprise journey", () => {
  it("requires explicit registration surface and MCP server auth choices", async () => {
    const bundle = freshBundle();
    const missingSurface = await cli(["target", "gemini-enterprise", bundle]);
    expect(missingSurface.code).toBe(1);
    expect(missingSurface.io.stderr.join("\n")).toContain(
      "required option '--surface <surface>' not specified",
    );

    const missingAuth = await cli([
      "target",
      "gemini-enterprise",
      bundle,
      "--surface",
      "custom-mcp",
    ]);
    expect(missingAuth.code).toBe(1);
    expect(missingAuth.io.stderr.join("\n")).toContain(
      "required option '--server-auth <mode>' not specified",
    );
  });

  it("generates the console-first Custom MCP surface with persisted identity config", async () => {
    const bundle = freshBundle();
    const result = await cli([...oauthArgs(bundle), "--location", "asia-southeast1"]);
    expect(result.code, result.io.text()).toBe(0);
    expect(result.io.stdout.join("\n")).toContain("console-first");
    expect(result.io.stdout.join("\n")).not.toContain("registration.curl.sh");

    const target = join(bundle, "targets/gemini-enterprise");
    expect(existsSync(join(target, "registration.request.template.json"))).toBe(true);
    expect(existsSync(join(target, "agent-registry"))).toBe(false);
    const setup = JSON.parse(readFileSync(join(target, "setup.json"), "utf8")) as {
      config: {
        surface: string;
        appLocation: string;
        workforcePool: string;
        connectorOAuth: { tenant: string; scopes: string[] };
      };
      inboundAuth: { resource: string; audience: string };
    };
    expect(setup.config.surface).toBe("custom-mcp");
    expect(setup.config.appLocation).toBe("asia-southeast1");
    expect(setup.config.workforcePool).toContain("workforcePools/ge-users");
    expect(setup.config.connectorOAuth.tenant).toBe("tenant-123");
    expect(setup.config.connectorOAuth.scopes).toEqual(["api://anvil-mcp/mcp.invoke"]);
    expect(setup.inboundAuth.resource).toBe("https://mcp.example.test/mcp");
    expect(setup.inboundAuth.audience).toBe("api://anvil-mcp");
    expect(readFileSync(join(target, "inbound-auth.env"), "utf8")).toContain(
      "ANVIL_INBOUND_RESOURCE=https://mcp.example.test/mcp",
    );
    expect(readFileSync(join(target, "oauth.template.json"), "utf8")).not.toContain("User.Read");
    expect(existsSync(join(target, "terraform/cloud-run.tfvars"))).toBe(true);
    expect(readFileSync(join(target, "terraform/README.md"), "utf8")).toContain("-var-file");
    expect(existsSync(join(target, "terraform/connector.tf"))).toBe(false);
  });

  it("validates before creating a target subtree", async () => {
    const bundle = freshBundle();
    const args = oauthArgs(bundle);
    const endpoint = args.indexOf("--endpoint");
    args.splice(endpoint, 2);
    const result = await cli(args);
    expect(result.code).toBe(1);
    expect(result.io.text()).toContain("target/missing_endpoint");
    expect(existsSync(join(bundle, "targets/gemini-enterprise"))).toBe(false);
  });

  it("guards Agent Gateway rerouting and uses a numeric project in the engine resource", async () => {
    const bundle = freshBundle();
    const rejected = await cli([
      ...oauthArgs(bundle, "agent-gateway"),
      "--project-number",
      "123456789",
      "--registry-location",
      "global",
    ]);
    expect(rejected.code).toBe(1);
    expect(rejected.io.text()).toContain("target/engine_egress_confirmation_required");
    expect(existsSync(join(bundle, "targets/gemini-enterprise"))).toBe(false);

    const accepted = await cli([
      ...oauthArgs(bundle, "agent-gateway"),
      "--project-number",
      "123456789",
      "--registry-location",
      "global",
      "--confirm-engine-egress-reroute",
    ]);
    expect(accepted.code, accepted.io.text()).toBe(0);
    const target = join(bundle, "targets/gemini-enterprise");
    expect(existsSync(join(target, "registration.request.template.json"))).toBe(false);
    const setup = JSON.parse(readFileSync(join(target, "setup.json"), "utf8")) as {
      engineResource: string;
      mutableState: {
        rootEnvironmentVariable: string;
        relativePath: string;
        externalToBundle: boolean;
      };
    };
    expect(setup.engineResource).toBe(
      "projects/123456789/locations/global/collections/default_collection/engines/eng-1",
    );
    expect(setup.mutableState.rootEnvironmentVariable).toBe("ANVIL_STATE_DIR");
    expect(setup.mutableState.externalToBundle).toBe(true);
    const register = readFileSync(join(target, "agent-registry/register.sh"), "utf8");
    expect(register).toContain("ANVIL_CONFIRM_ENGINE_EGRESS_REROUTE");
    expect(register).toContain("projects/123456789/locations/global");
    const stateKey = register.match(/^STATE_KEY='([^']+)'$/m)?.[1];
    expect(setup.mutableState.relativePath).toBe(`gemini-enterprise/${stateKey}`);
    expect(register).toContain('STATE_DIR="$STATE_ROOT/gemini-enterprise/$STATE_KEY"');
    expect(register).not.toContain("$BUNDLE_ROOT/.anvil");
    expect(existsSync(join(target, "agent-registry/rollback.sh"))).toBe(true);
  });

  it("preserves external rollback evidence across retargets and migrates legacy state", async () => {
    const bundle = freshBundle();
    const stateRoot = join(root, `gateway-state-${sequence++}`);
    mkdirSync(stateRoot, { recursive: true });
    const args = [
      ...oauthArgs(bundle, "agent-gateway"),
      "--project-number",
      "123456789",
      "--registry-location",
      "global",
      "--confirm-engine-egress-reroute",
    ];
    const env = { ANVIL_STATE_DIR: stateRoot } as NodeJS.ProcessEnv;
    const initial = await cli(args, { env });
    expect(initial.code, initial.io.text()).toBe(0);

    const target = join(bundle, "targets/gemini-enterprise");
    const setup = JSON.parse(readFileSync(join(target, "setup.json"), "utf8")) as {
      mutableState: { relativePath: string };
    };
    const externalState = join(stateRoot, setup.mutableState.relativePath);
    mkdirSync(externalState, { recursive: true });
    const snapshot = join(externalState, "engine-before.json");
    writeFileSync(snapshot, '{"agentGatewaySetting":{}}\n');

    const legacyState = join(target, "agent-registry/.state");
    mkdirSync(legacyState, { recursive: true });
    writeFileSync(join(legacyState, "legacy-evidence.json"), '{"legacy":true}\n');

    const retarget = await cli(args, { env });
    expect(retarget.code, retarget.io.text()).toBe(0);
    expect(readFileSync(snapshot, "utf8")).toBe('{"agentGatewaySetting":{}}\n');
    expect(readFileSync(join(externalState, "legacy-evidence.json"), "utf8")).toBe(
      '{"legacy":true}\n',
    );
    expect(existsSync(join(target, "agent-registry/.state"))).toBe(false);
  });

  it("keeps certification fresh when gateway runtime state changes outside the bundle", async () => {
    const bundle = freshBundle();
    const stateRoot = join(root, `certified-gateway-state-${sequence++}`);
    mkdirSync(stateRoot, { recursive: true });
    const target = await cli([
      ...oauthArgs(bundle, "agent-gateway"),
      "--project-number",
      "123456789",
      "--registry-location",
      "global",
      "--confirm-engine-egress-reroute",
    ]);
    expect(target.code, target.io.text()).toBe(0);

    const certified = await cli(["certify", bundle]);
    expect(certified.code, certified.io.text()).toBe(0);
    const setup = JSON.parse(
      readFileSync(join(bundle, "targets/gemini-enterprise/setup.json"), "utf8"),
    ) as { mutableState: { relativePath: string } };
    const externalState = join(stateRoot, setup.mutableState.relativePath);
    mkdirSync(externalState, { recursive: true });
    writeFileSync(join(externalState, "engine-before.json"), '{"agentGatewaySetting":{}}\n');

    const status = await cli(["status", bundle, "--json"]);
    expect(status.code, status.io.text()).toBe(0);
    const report = JSON.parse(status.io.stdout.join("\n")) as {
      certification: { state: string };
    };
    expect(report.certification.state).toBe("fresh");
  });

  it("keeps Terraform initialization, lockfiles, and plans outside the certified bundle", async () => {
    const bundle = freshBundle();
    const targeted = await cli(oauthArgs(bundle));
    expect(targeted.code, targeted.io.text()).toBe(0);
    const certified = await cli(["certify", bundle]);
    expect(certified.code, certified.io.text()).toBe(0);

    const terraformWork = join(root, `terraform-work-${sequence++}`);
    cpSync(join(bundle, "deploy/terraform"), terraformWork, { recursive: true });
    mkdirSync(join(terraformWork, ".terraform/providers"), { recursive: true });
    writeFileSync(join(terraformWork, ".terraform.lock.hcl"), "# external lock\n");
    writeFileSync(join(terraformWork, "tfplan"), "external plan\n");

    expect(existsSync(join(bundle, "deploy/terraform/.terraform"))).toBe(false);
    expect(existsSync(join(bundle, "deploy/terraform/.terraform.lock.hcl"))).toBe(false);
    expect(existsSync(join(bundle, "deploy/terraform/tfplan"))).toBe(false);
    expect(existsSync(join(bundle, "targets/gemini-enterprise/.terraform"))).toBe(false);
    expect(existsSync(join(bundle, "targets/gemini-enterprise/tfplan"))).toBe(false);

    const status = await cli(["status", bundle, "--json"]);
    expect(status.code, status.io.text()).toBe(0);
    const report = JSON.parse(status.io.stdout.join("\n")) as {
      certification: { state: string };
      targets: Array<{ state: string }>;
    };
    expect(report.certification.state).toBe("fresh");
    expect(report.targets).toEqual([expect.objectContaining({ state: "fresh" })]);
  });

  it("fails certification and recommends retargeting when generated target bytes drift", async () => {
    const bundle = freshBundle();
    const targeted = await cli(oauthArgs(bundle));
    expect(targeted.code, targeted.io.text()).toBe(0);
    const targetFile = join(bundle, "targets/gemini-enterprise/action-selection.json");
    writeFileSync(targetFile, `${readFileSync(targetFile, "utf8")}\n`, "utf8");

    const certified = await cli(["certify", bundle]);
    expect(certified.code).toBe(1);
    expect(certified.io.text()).toContain("contract.target-kit-exact.gemini-enterprise");

    const status = await cli(["status", bundle, "--json"]);
    expect(status.code, status.io.text()).toBe(0);
    const report = JSON.parse(status.io.stdout.join("\n")) as {
      certification: { state: string };
      targets: Array<{ state: string; integrity: { findings: Array<{ code: string }> } }>;
      nextAction: { code: string };
    };
    expect(report.certification.state).toBe("failed");
    expect(report.targets[0]?.state).toBe("stale");
    expect(report.targets[0]?.integrity.findings).toContainEqual(
      expect.objectContaining({ code: "target/file_mismatch" }),
    );
    expect(report.nextAction.code).toBe("retarget");
  });

  it("discovers a target directory with no setup and fails it closed", async () => {
    const bundle = freshBundle();
    const targeted = await cli(oauthArgs(bundle));
    expect(targeted.code, targeted.io.text()).toBe(0);
    rmSync(join(bundle, "targets/gemini-enterprise/setup.json"));

    const status = await cli(["status", bundle, "--json"]);
    expect(status.code, status.io.text()).toBe(0);
    const report = JSON.parse(status.io.stdout.join("\n")) as {
      targets: Array<{ state: string; integrity: { findings: Array<{ code: string }> } }>;
      nextAction: { code: string; command: string };
    };
    expect(report.targets).toHaveLength(1);
    expect(report.targets[0]?.state).toBe("corrupt");
    expect(report.targets[0]?.integrity.findings).toEqual([
      expect.objectContaining({ code: "target/missing_setup" }),
    ]);
    expect(report.nextAction.code).toBe("retarget");
    expect(report.nextAction.command).toContain("--help");
  });

  it("round-trips every persisted target field in the status retarget command", async () => {
    const bundle = freshBundle();
    const args = oauthArgs(bundle, "agent-gateway");
    args[args.indexOf("--idp") + 1] = "other";
    args.splice(args.indexOf("--tenant"), 2);
    args.push(
      "--oauth-authorization-url",
      "https://identity.example/authorize",
      "--oauth-token-url",
      "https://identity.example/token",
      "--project-number",
      "123456789",
      "--registry-location",
      "global",
      "--confirm-engine-egress-reroute",
    );
    const targeted = await cli(args);
    expect(targeted.code, targeted.io.text()).toBe(0);
    const targetFile = join(bundle, "targets/gemini-enterprise/server-description.md");
    writeFileSync(targetFile, `${readFileSync(targetFile, "utf8")}tampered\n`, "utf8");

    const status = await cli(["status", bundle, "--json"]);
    expect(status.code, status.io.text()).toBe(0);
    const report = JSON.parse(status.io.stdout.join("\n")) as {
      nextAction: { code: string; command: string };
    };
    expect(report.nextAction.code).toBe("retarget");
    for (const expected of [
      "--surface agent-gateway",
      "--server-auth oauth",
      "--endpoint https://mcp.example.test/mcp",
      "--project acme-proj",
      "--project-number 123456789",
      "--location global",
      "--engine eng-1",
      "--gateway-location us-central1",
      "--registry-location global",
      "--agent-identity-principal-set principalSet://agents.global.org-123.system.id.goog/deployed-agents",
      "--gateway-authorization-policy projects/acme-proj/locations/us-central1/authzPolicies/mcp-egress",
      "--wif locations/global/workforcePools/ge-users",
      "--idp other",
      "--oauth-authorization-url https://identity.example/authorize",
      "--oauth-token-url https://identity.example/token",
      "--inbound-issuer https://login.microsoftonline.com/tenant-123/v2.0",
      "--inbound-audience api://anvil-mcp",
      "--oauth-scope api://anvil-mcp/mcp.invoke",
      "--confirm-engine-egress-reroute",
    ]) {
      expect(report.nextAction.command).toContain(expected);
    }
  });

  it("treats a direct air.yaml path exactly like its bundle directory", async () => {
    const bundle = freshBundle();
    const result = await cli(oauthArgs(join(bundle, "air.yaml")));
    expect(result.code, result.io.text()).toBe(0);
    expect(existsSync(join(bundle, "targets/gemini-enterprise/setup.json"))).toBe(true);
    expect(existsSync(join(bundle, "air.yaml/targets"))).toBe(false);
  });

  it("emits success JSON only after the staged target is installed", async () => {
    const bundle = freshBundle();
    const result = await cli([...oauthArgs(bundle), "--json"]);
    expect(result.code, result.io.text()).toBe(0);
    const payload = JSON.parse(result.io.stdout.join("\n")) as {
      report: { ok: boolean };
      written: { targetDir: string; files: string[] };
    };
    expect(payload.report.ok).toBe(true);
    expect(payload.written.targetDir).toBe(join(bundle, "targets/gemini-enterprise"));
    expect(payload.written.files.length).toBeGreaterThan(0);
    expect(existsSync(join(payload.written.targetDir, "setup.json"))).toBe(true);
  });

  it("keeps the prior target and stdout clean when the atomic install fails", async () => {
    const bundle = freshBundle();
    const initial = await cli(oauthArgs(bundle));
    expect(initial.code, initial.io.text()).toBe(0);
    const target = join(bundle, "targets/gemini-enterprise");
    const marker = join(target, "prior-target-marker");
    writeFileSync(marker, "preserve me");

    const failed = await cli([...oauthArgs(bundle), "--json"], {
      installStagedTarget: (_stageDir, destination) => {
        mkdirSync(destination, { recursive: true });
        writeFileSync(join(destination, "partial-install"), "discard me");
        throw new Error("injected target install failure");
      },
    });
    expect(failed.code).toBe(1);
    expect(failed.io.stdout).toEqual([]);
    expect(failed.io.stderr.join("\n")).toContain("injected target install failure");
    expect(readFileSync(marker, "utf8")).toBe("preserve me");
    expect(existsSync(join(target, "partial-install"))).toBe(false);
    expect(existsSync(join(bundle, "targets/gemini-enterprise/setup.json"))).toBe(true);
  });

  it("reports backup cleanup failure as a warning after a successful swap", async () => {
    const bundle = freshBundle();
    const initial = await cli(oauthArgs(bundle));
    expect(initial.code, initial.io.text()).toBe(0);
    const target = join(bundle, "targets/gemini-enterprise");
    writeFileSync(join(target, "prior-target-marker"), "retained backup");
    let retainedBackup = "";

    const retargeted = await cli([...oauthArgs(bundle), "--json"], {
      cleanupTargetBackup: (backupDir) => {
        retainedBackup = backupDir;
        throw new Error("injected target backup cleanup failure");
      },
    });

    expect(retargeted.code, retargeted.io.text()).toBe(0);
    expect(retargeted.io.stderr).toEqual([]);
    const payload = JSON.parse(retargeted.io.stdout.join("\n")) as {
      written: {
        targetDir: string;
        warnings: string[];
        retainedBackupDir?: string;
      };
    };
    expect(payload.written.targetDir).toBe(target);
    expect(payload.written.warnings).toEqual([
      expect.stringContaining("injected target backup cleanup failure"),
    ]);
    expect(payload.written.warnings[0]).toContain("installed successfully");
    expect(payload.written.retainedBackupDir).toBe(retainedBackup);
    expect(existsSync(join(target, "setup.json"))).toBe(true);
    expect(existsSync(join(target, "prior-target-marker"))).toBe(false);
    expect(readFileSync(join(retainedBackup, "prior-target-marker"), "utf8")).toBe(
      "retained backup",
    );
  });

  it("removes a partial first install when the atomic installer throws", async () => {
    const bundle = freshBundle();
    const target = join(bundle, "targets/gemini-enterprise");
    const failed = await cli([...oauthArgs(bundle), "--json"], {
      installStagedTarget: (_stageDir, destination) => {
        mkdirSync(destination, { recursive: true });
        writeFileSync(join(destination, "partial-install"), "discard me");
        throw new Error("injected partial first install");
      },
    });
    expect(failed.code).toBe(1);
    expect(failed.io.stdout).toEqual([]);
    expect(failed.io.stderr.join("\n")).toContain("injected partial first install");
    expect(existsSync(target)).toBe(false);
  });

  it("rejects a detached --out target because certification could not bind it", async () => {
    const bundle = freshBundle();
    const detached = join(root, `detached-target-${sequence++}`);
    const result = await cli([...oauthArgs(bundle), "--out", detached, "--json"]);
    expect(result.code).toBe(1);
    expect(result.io.stdout).toEqual([]);
    expect(result.io.stderr.join("\n")).toContain(
      "Target kits must attach to their bundle for certification",
    );
    expect(existsSync(detached)).toBe(false);
    expect(existsSync(join(bundle, "targets/gemini-enterprise"))).toBe(false);
  });
});
