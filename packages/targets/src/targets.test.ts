import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AirDocument } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { beforeEach, describe, expect, it } from "vitest";
import { TOOLSPEC_MAX_BYTES } from "./agent-registry.js";
import {
  createGeminiEnterpriseTargetConfig,
  engineStateKey,
  type GeminiEnterpriseTargetConfigInput,
} from "./config.js";
import { buildConnectorPlan, renderConnectorPlanText } from "./connector-plan.js";
import {
  isGcpProjectId,
  isGcpProjectNumber,
  isWorkforcePoolResource,
  parseAgentIdentityPrincipalSet,
  parseCanonicalEngineResource,
  parseGatewayAuthorizationPolicyResource,
} from "./coordinates.js";
import { GEMINI_ENTERPRISE_PROFILE } from "./gemini-enterprise.js";
import { generateTargetKit } from "./generate.js";
import { buildRegistrationRequest, renderRegistrationCurl } from "./registration.js";
import { validateTarget } from "./validate.js";
import { verifyTargetKit } from "./verify.js";

const SPEC = `openapi: "3.0.3"
info: { title: Refunds, version: "1.0.0" }
paths:
  /refunds:
    get:
      operationId: listRefunds
      tags: [refunds]
      description: List refunds.
      responses: { "200": { description: ok } }
    post:
      operationId: createRefund
      tags: [refunds]
      description: Issue a refund.
      responses: { "201": { description: created } }
`;
const AGENT_PRINCIPAL_SET =
  "principalSet://agents.global.org-123456789012.system.id.goog/attribute.container/projects/123456789";

let air: AirDocument;

beforeEach(async () => {
  const compiled = await compile({ spec: SPEC, serviceId: "refunds" });
  air = approveOperations(
    compiled,
    compiled.operations.map((operation) => operation.id),
  );
});

function config(overrides: GeminiEnterpriseTargetConfigInput = {}) {
  const connectorOAuth = {
    provider: "entra" as const,
    tenant: "tenant-123",
    scopes: ["api://anvil-mcp/mcp.invoke"],
    inboundIssuer: "https://login.microsoftonline.com/tenant-123/v2.0",
    inboundAudience: "api://anvil-mcp",
    ...overrides.connectorOAuth,
  };
  return createGeminiEnterpriseTargetConfig({
    surface: "both",
    serverAuth: "oauth",
    endpoint: "https://x.example/mcp",
    project: "acme-proj",
    projectNumber: "123456789",
    appLocation: "global",
    engine: "eng-1",
    gatewayLocation: "us-central1",
    registryLocation: "global",
    agentIdentityPrincipalSet: AGENT_PRINCIPAL_SET,
    gatewayAuthorizationPolicy: "projects/acme-proj/locations/us-central1/authzPolicies/mcp-egress",
    workforcePool: "locations/global/workforcePools/ge-users",
    confirmEngineEgressReroute: true,
    ...overrides,
    connectorOAuth,
  });
}

function textFile(kit: ReturnType<typeof generateTargetKit>, suffix: string): string {
  const file = kit.files.find((candidate) => candidate.path.endsWith(suffix));
  expect(file, `missing ${suffix}`).toBeDefined();
  return new TextDecoder().decode(file?.bytes);
}

function bundleFiles(kit: ReturnType<typeof generateTargetKit>): Record<string, string> {
  return Object.fromEntries(
    kit.files.map((file) => [file.path, new TextDecoder().decode(file.bytes)]),
  );
}

describe("target kit generation", () => {
  it("emits the explicitly requested dual-surface kit deterministically", () => {
    const target = config();
    const a = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, target);
    const b = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, target);
    const names = a.files.map((file) => file.path.split("/").pop());
    expect(names).toEqual([
      "action-selection.json",
      "admin-runbook.md",
      "agent-gateway.md",
      "agent-gateway.yaml",
      "agent-registry.tf",
      "readiness.template.json",
      "register.sh",
      "rollback.sh",
      "toolspec.json",
      "compatibility-report.json",
      "inbound-auth.env",
      "oauth.template.json",
      "organization-policy-checklist.md",
      "README.md",
      "registration.curl.sh",
      "registration.request.template.json",
      "server-description.md",
      "setup.json",
      "target-profile.json",
      "cloud-run.tfvars",
      "README.md",
    ]);
    for (let index = 0; index < a.files.length; index += 1) {
      expect(Buffer.from(a.files[index]!.bytes).equals(Buffer.from(b.files[index]!.bytes))).toBe(
        true,
      );
    }
  });

  it("persists non-secret identity, WIF, and the exact canonical engine resource", () => {
    const kit = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, config());
    const setup = JSON.parse(textFile(kit, "setup.json")) as {
      config: {
        project: string;
        projectNumber: string;
        workforcePool: string;
        connectorOAuth: { tenant: string; inboundAudience: string };
      };
      engineResource: string;
      inboundAuth: { resource: string; audience: string };
      mutableState: {
        rootEnvironmentVariable: string;
        relativePath: string;
        externalToBundle: boolean;
      };
    };
    expect(setup.config.project).toBe("acme-proj");
    expect(setup.config.projectNumber).toBe("123456789");
    expect(setup.config.workforcePool).toContain("workforcePools/ge-users");
    expect(setup.config.connectorOAuth.tenant).toBe("tenant-123");
    expect(setup.config.connectorOAuth.inboundAudience).toBe("api://anvil-mcp");
    expect(setup.engineResource).toBe(
      "projects/123456789/locations/global/collections/default_collection/engines/eng-1",
    );
    expect(setup.mutableState.rootEnvironmentVariable).toBe("ANVIL_STATE_DIR");
    expect(setup.mutableState.relativePath).toMatch(/^gemini-enterprise\/eng-1-[0-9a-f]{32}$/);
    expect(setup.mutableState.externalToBundle).toBe(true);
    expect(setup.inboundAuth.resource).toBe("https://x.example/mcp");
    expect(setup.inboundAuth.audience).toBe("api://anvil-mcp");
    expect(textFile(kit, "inbound-auth.env")).toContain(
      "ANVIL_INBOUND_RESOURCE=https://x.example/mcp",
    );
    expect(textFile(kit, "inbound-auth.env")).toContain("ANVIL_INBOUND_AUDIENCE=api://anvil-mcp");
    expect(textFile(kit, "cloud-run.tfvars")).toContain(
      'ANVIL_INBOUND_RESOURCE = "https://x.example/mcp"',
    );
    expect(textFile(kit, "cloud-run.tfvars")).toContain("api://anvil-mcp/mcp.invoke");
    expect(textFile(kit, "cloud-run.tfvars")).toContain("allow_unauthenticated = true");
    expect(textFile(kit, "cloud-run.tfvars")).toContain(
      `invoker_members       = ["${AGENT_PRINCIPAL_SET}"]`,
    );
    const terraformReadme = textFile(kit, "terraform/README.md");
    expect(terraformReadme).toContain('terraform -chdir="$ANVIL_TF_WORK_DIR"');
    expect(terraformReadme).toContain('-var-file="$ANVIL_BUNDLE_DIR/targets/gemini-enterprise');
    expect(terraformReadme).not.toContain("terraform -chdir=deploy/terraform");
    expect(terraformReadme).toContain(".terraform.lock.hcl");
    expect(terraformReadme).toContain("set -euo pipefail");
    expect(terraformReadme).toContain('backend-config="bucket=$ANVIL_TF_STATE_BUCKET"');
    expect(terraformReadme).toContain('backend-config="prefix=$ANVIL_TF_STATE_PREFIX"');
    expect(terraformReadme).toContain("TF_VAR_project_id='acme-proj'");
    expect(terraformReadme).toContain("TF_VAR_region=REPLACE_WITH_CLOUD_RUN_REGION");
    expect(terraformReadme).toContain("TF_VAR_ledger_database_mode=shared");
    expect(terraformReadme).toContain(
      "TF_VAR_ledger_database_id=REPLACE_WITH_TRUST_DOMAIN_FIRESTORE_DATABASE",
    );
    expect(terraformReadme).toContain("--database-mode");
    expect(terraformReadme).toContain("Firestore IAM conditions stop at the database boundary");
    expect(terraformReadme).toContain("air.service.environment");
    expect(terraformReadme).toContain("/readyz` proves only ledger data-plane access");
    expect(terraformReadme).toContain("never sends a live mutation");
    expect(terraformReadme).toContain('anvil deploy ledger "$ANVIL_BUNDLE_DIR"');
    expect(terraformReadme).toContain("TF_VAR_image_tag");
    expect(terraformReadme).toContain("must be absolute");
    expect(terraformReadme).toContain("must be outside the bundle");
    expect(terraformReadme).toContain("must be empty");
    expect(terraformReadme).toContain("Never copy");
  });

  it("verifies the complete target subtree by deterministic regeneration", () => {
    const kit = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, config());
    const files = bundleFiles(kit);
    const fresh = verifyTargetKit(air, GEMINI_ENTERPRISE_PROFILE, files);
    expect(fresh.ok).toBe(true);
    expect(fresh.expectedDigest).toBe(fresh.actualDigest);
    expect(fresh.expectedFiles).toEqual(fresh.actualFiles);

    const tampered = { ...files, [kit.files[0]!.path]: "tampered\n" };
    expect(
      verifyTargetKit(air, GEMINI_ENTERPRISE_PROFILE, tampered).findings.map(
        (finding) => finding.code,
      ),
    ).toContain("target/file_mismatch");

    const missing = { ...files };
    delete missing[kit.files[0]!.path];
    expect(
      verifyTargetKit(air, GEMINI_ENTERPRISE_PROFILE, missing).findings.map(
        (finding) => finding.code,
      ),
    ).toContain("target/missing_file");

    const extra = {
      ...files,
      "targets/gemini-enterprise/operator-note.txt": "not generated\n",
    };
    expect(
      verifyTargetKit(air, GEMINI_ENTERPRISE_PROFILE, extra).findings.map(
        (finding) => finding.code,
      ),
    ).toContain("target/unexpected_file");

    const missingSetup = { ...files };
    delete missingSetup["targets/gemini-enterprise/setup.json"];
    expect(
      verifyTargetKit(air, GEMINI_ENTERPRISE_PROFILE, missingSetup).findings.map(
        (finding) => finding.code,
      ),
    ).toEqual(["target/missing_setup"]);
  });

  it("emits only the selected registration surface", () => {
    const custom = generateTargetKit(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({
        surface: "custom-mcp",
        appLocation: "asia-southeast1",
        gatewayLocation: undefined,
        registryLocation: undefined,
        projectNumber: undefined,
        confirmEngineEgressReroute: false,
      }),
    );
    expect(
      custom.files.some((file) => file.path.endsWith("registration.request.template.json")),
    ).toBe(true);
    expect(custom.files.some((file) => file.path.includes("/agent-registry/"))).toBe(false);

    const gateway = generateTargetKit(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({ surface: "agent-gateway" }),
    );
    expect(
      gateway.files.some((file) => file.path.endsWith("registration.request.template.json")),
    ).toBe(false);
    expect(gateway.files.some((file) => file.path.endsWith("agent-registry/register.sh"))).toBe(
      true,
    );
    const customTfvars = textFile(custom, "cloud-run.tfvars");
    expect(customTfvars).toContain("allow_unauthenticated = true");
    expect(customTfvars).toContain("invoker_members       = []");
    const gatewayTfvars = textFile(gateway, "cloud-run.tfvars");
    expect(gatewayTfvars).toContain("allow_unauthenticated = false");
    expect(gatewayTfvars).toContain(`invoker_members       = ["${AGENT_PRINCIPAL_SET}"]`);
  });

  it("labels and sequences each selected surface without leaking the other journey", () => {
    const custom = generateTargetKit(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({
        surface: "custom-mcp",
        appLocation: "asia-southeast1",
        gatewayLocation: undefined,
        registryLocation: undefined,
        projectNumber: undefined,
        confirmEngineEgressReroute: false,
      }),
    );
    const gateway = generateTargetKit(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({ surface: "agent-gateway" }),
    );

    const customReadme = textFile(custom, "gemini-enterprise/README.md");
    expect(customReadme).toContain("Selected integration: **Custom MCP Server data store**");
    expect(customReadme).toContain("## Custom MCP Server data store");
    expect(customReadme).not.toContain("## Agent Registry + Agent Gateway");
    expect(textFile(custom, "server-description.md")).toContain(
      "Gemini Enterprise — Custom MCP Server data store",
    );

    const gatewayReadme = textFile(gateway, "gemini-enterprise/README.md");
    expect(gatewayReadme).toContain("Selected integration: **Agent Registry + Agent Gateway**");
    expect(gatewayReadme).toContain("## Agent Registry + Agent Gateway");
    expect(gatewayReadme).not.toContain("## Custom MCP Server data store");
    const gatewayRunbook = textFile(gateway, "admin-runbook.md");
    const numbers = [...gatewayRunbook.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
    expect(numbers[0]).toBe(1);
    expect(gatewayRunbook).not.toContain("registration.curl.sh");
    const gatewayAssumptions = textFile(gateway, "organization-policy-checklist.md");
    expect(gatewayAssumptions).not.toContain("setUpDataConnector");
    expect(gatewayAssumptions).not.toContain("external gateway in front");
    expect(gatewayAssumptions).toContain("Gateway IAM does not replace");
  });

  it("keeps Agent Gateway-only no-auth reachable only by the service-scoped principalSet", () => {
    const kit = generateTargetKit(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({
        surface: "agent-gateway",
        serverAuth: "no-auth",
        allowUnauthenticatedMcp: true,
        connectorOAuth: {
          provider: undefined,
          tenant: undefined,
          scopes: [],
          inboundIssuer: undefined,
          inboundAudience: undefined,
        },
      }),
    );
    const tfvars = textFile(kit, "cloud-run.tfvars");
    expect(tfvars).toContain('ingress               = "INGRESS_TRAFFIC_ALL"');
    expect(tfvars).toContain("allow_unauthenticated = false");
    expect(tfvars).toContain(`invoker_members       = ["${AGENT_PRINCIPAL_SET}"]`);
    expect(textFile(kit, "agent-registry/agent-registry.tf")).not.toContain(
      'role    = "roles/run.invoker"',
    );
  });

  it("builds the confirmed custom_mcp shape without inventing Graph scopes", () => {
    const request = buildRegistrationRequest(air, {
      endpoint: "https://x.example/mcp",
      project: "acme-proj",
      location: "global",
      oauthAccessTokenRef: "private-app-token",
      clientId: "client-123",
      clientSecretRef: "projects/acme-proj/secrets/mcp-oauth/versions/latest",
      authUri: "https://idp.example/authorize",
      tokenUri: "https://idp.example/token",
      scopes: ["api://anvil-mcp/mcp.invoke"],
    });
    const connector = request.body.dataConnector;
    expect(connector.dataSource).toBe("custom_mcp");
    expect(connector.params.oauth_access_token).toBe("private-app-token");
    expect(connector.actionConfig.actionParams.instance_uri).toBe("https://x.example/mcp");
    expect(connector.actionConfig.actionParams.scopes).toBe("api://anvil-mcp/mcp.invoke");
    expect(JSON.stringify(request)).not.toContain("User.Read");

    const script = renderRegistrationCurl(request);
    expect(script).toContain('SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")"');
    expect(script).toContain("ANVIL_EXPERIMENTAL_SETUP_DATA_CONNECTOR");
    expect(script).toContain("Verified existing Anvil collection");
    expect(script).toContain('TEMP_BODY="$(mktemp)"');
    expect(script).toContain('chmod 600 "$TEMP_BODY"');
    expect(script).toContain('chmod 600 "$CHECK_BODY" "$SETUP_RESPONSE"');
    expect(script).toContain('SETUP_STATUS="$(curl -sS -o "$SETUP_RESPONSE"');
    expect(script).toContain("emit_success_summary");
    expect(script).toContain("Collection id collision");
    expect(script).not.toContain('cat "$CHECK_BODY"');
    expect(script).toContain("ANVIL_PRIVATE_APP_ACCESS_TOKEN_FILE");
    expect(script).toContain("trap cleanup EXIT");
    expect(script).toContain('-d @"$TEMP_BODY"');
    expect(script).not.toContain('-d @"$REQUEST_TEMPLATE"');
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
  });

  it("supports an explicitly acknowledged NO_AUTH server without OAuth params", () => {
    const target = config({
      surface: "custom-mcp",
      serverAuth: "no-auth",
      allowUnauthenticatedMcp: true,
      connectorOAuth: {
        provider: undefined,
        tenant: undefined,
        scopes: [],
        inboundIssuer: undefined,
        inboundAudience: undefined,
      },
    });
    const result = validateTarget(air, GEMINI_ENTERPRISE_PROFILE, target);
    expect(result.ok).toBe(true);
    expect(result.findings.map((finding) => finding.code)).toContain("target/unauthenticated_mcp");
    const kit = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, target);
    const request = JSON.parse(textFile(kit, "registration.request.template.json")) as {
      dataConnector: { actionConfig: { actionParams: Record<string, unknown> } };
    };
    expect(request.dataConnector.actionConfig.actionParams.auth_type).toBe("NO_AUTH");
    expect(request.dataConnector.actionConfig.actionParams.auth_uri).toBeUndefined();
    expect(textFile(kit, "inbound-auth.env")).toContain("ANVIL_INBOUND_AUTH_MODE=none");
  });

  it("emits fail-closed Agent Gateway readiness, external state, and rollback scripts", () => {
    const kit = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, config());
    const gateway = textFile(kit, "agent-registry/agent-gateway.yaml");
    const register = textFile(kit, "agent-registry/register.sh");
    const rollback = textFile(kit, "agent-registry/rollback.sh");
    const terraform = textFile(kit, "agent-registry/agent-registry.tf");
    const readiness = JSON.parse(textFile(kit, "agent-registry/readiness.template.json")) as {
      authorizationPolicyResource: string;
      agentIdentityPrincipalSet: string;
      checks: Record<string, boolean>;
      verifiedAt: string;
    };
    expect(gateway).toContain("AGENT_TO_ANYWHERE");
    expect(gateway).toContain("/locations/global");
    expect(register).toContain("ANVIL_CONFIRM_ENGINE_EGRESS_REROUTE");
    expect(register).toContain("ANVIL_RECONCILE_REGISTRY_GATEWAY");
    expect(register).toContain("ANVIL_CONFIRM_REGISTRY_GATEWAY_RECONCILE");
    expect(register).toContain('SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")"');
    expect(register).toContain("services update");
    expect(register).toContain('STATE_ROOT="${ANVIL_STATE_DIR:-}"');
    expect(register).toContain('STATE_DIR="$STATE_ROOT/gemini-enterprise/$STATE_KEY"');
    expect(register).not.toContain('STATE_DIR="$BUNDLE_ROOT/');
    expect(register).toContain("$STATE_DIR/engine-before.json");
    expect(register).toContain("discoveryengine.googleapis.com/v1/$ENGINE");
    expect(register.indexOf("ANVIL_STATE_DIR is required")).toBeLessThan(
      register.indexOf("services describe"),
    );
    expect(register.indexOf('if [[ ! -s "$READINESS_FILE" ]]')).toBeLessThan(
      register.indexOf('TOKEN="$(gcloud auth print-access-token)"'),
    );
    expect(register.indexOf('TOKEN="$(gcloud auth print-access-token)"')).toBeLessThan(
      register.indexOf("services describe"),
    );
    expect(register.indexOf("services describe")).toBeLessThan(register.indexOf("services update"));
    expect(register).toContain('PREFLIGHT_ETAG="$(jq -r');
    expect(register).toContain("Engine changed after preflight");
    expect(register).toContain('-H "If-Match: $ENGINE_ETAG"');
    expect(register).toContain("{etag:$etag,agentGatewaySetting:");
    expect(register).toContain("Refusing to fabricate rollback evidence");
    expect(register).toContain("ANVIL_ACKNOWLEDGE_NO_ROLLBACK");
    expect(register).toContain('SNAPSHOT_TEMP="$(mktemp "$STATE_DIR/.engine-before.XXXXXX")"');
    expect(register).toContain("previousDefaultEgressAgentGateway");
    expect(register).toContain(".name == $engine");
    expect(register).toContain('-o "$MUTATION_RESPONSE"');
    expect(register).toContain("Discovery Engine readback did not confirm");
    expect(register).not.toContain("engine-current.json");
    expect(register).not.toContain("engine-bind-response.json");
    expect(rollback).toContain("ANVIL_CONFIRM_ENGINE_EGRESS_ROLLBACK");
    expect(rollback).toContain('STATE_ROOT="${ANVIL_STATE_DIR:-}"');
    expect(rollback).toContain('STATE_FILE="$STATE_DIR/engine-before.json"');
    expect(rollback).toContain(".name == $engine");
    expect(rollback).toContain("Engine no longer routes through this kit's gateway");
    expect(rollback).toContain('-H "If-Match: $ENGINE_ETAG"');
    expect(rollback).toContain("{etag:$etag,agentGatewaySetting:");
    expect(rollback).toContain('-o "$MUTATION_RESPONSE"');
    expect(rollback).toContain("readback did not confirm");
    expect(terraform).not.toContain("google_agent_registry_service");
    expect(terraform).toContain("roles/agentregistry.viewer");
    expect(terraform).toContain("principalSet://agents.global.org-123456789012.system.id.goog");
    expect(terraform).not.toContain('resource "google_project_iam_member" "agent_run_invoker"');
    expect(readiness.authorizationPolicyResource).toContain("authzPolicies/mcp-egress");
    expect(readiness.agentIdentityPrincipalSet).toContain("principalSet://");
    expect(Object.values(readiness.checks)).toEqual([false, false, false, false, false, false]);
    expect(readiness.verifiedAt).toBe("");
    expect(spawnSync("bash", ["-n"], { input: register }).status).toBe(0);
    expect(spawnSync("bash", ["-n"], { input: rollback }).status).toBe(0);
  });

  it("does not make a provider call when readiness evidence is incomplete", () => {
    const target = config({ surface: "agent-gateway" });
    const kit = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, target);
    const root = mkdtempSync(join(tmpdir(), "anvil-target-readiness-"));
    const scriptDir = join(root, "bundle", "targets", "gemini-enterprise", "agent-registry");
    const stateDir = join(root, "state", "gemini-enterprise", engineStateKey(target));
    const fakeBin = join(root, "bin");
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    const scriptPath = join(scriptDir, "register.sh");
    writeFileSync(scriptPath, textFile(kit, "agent-registry/register.sh"));
    writeFileSync(
      join(scriptDir, "readiness.template.json"),
      textFile(kit, "agent-registry/readiness.template.json"),
    );
    writeFileSync(
      join(stateDir, "readiness.json"),
      textFile(kit, "agent-registry/readiness.template.json"),
    );
    chmodSync(scriptPath, 0o700);
    const marker = join(root, "provider-called");
    for (const command of ["gcloud", "curl"]) {
      const path = join(fakeBin, command);
      writeFileSync(
        path,
        `#!/usr/bin/env bash\nprintf called >${JSON.stringify(marker)}\nexit 99\n`,
      );
      chmodSync(path, 0o700);
    }

    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        ANVIL_STATE_DIR: join(root, "state"),
        ANVIL_RECONCILE_REGISTRY_GATEWAY: "1",
        ANVIL_CONFIRM_REGISTRY_GATEWAY_RECONCILE: "1",
      },
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("readiness evidence is incomplete or mismatched");
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses an engine bind when the etag changes after read-only preflights", () => {
    const target = config({ surface: "agent-gateway" });
    const kit = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, target);
    const root = mkdtempSync(join(tmpdir(), "anvil-target-concurrent-bind-"));
    const scriptDir = join(root, "bundle", "targets", "gemini-enterprise", "agent-registry");
    const stateDir = join(root, "state", "gemini-enterprise", engineStateKey(target));
    const fakeBin = join(root, "bin");
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    const scriptPath = join(scriptDir, "register.sh");
    writeFileSync(scriptPath, textFile(kit, "agent-registry/register.sh"));
    chmodSync(scriptPath, 0o700);
    const readiness = JSON.parse(textFile(kit, "agent-registry/readiness.template.json")) as {
      checks: Record<string, boolean>;
      verifiedAt: string;
    };
    for (const check of Object.keys(readiness.checks)) readiness.checks[check] = true;
    readiness.verifiedAt = "2026-07-23T00:00:00Z";
    writeFileSync(join(stateDir, "readiness.json"), `${JSON.stringify(readiness)}\n`);

    const mutationMarker = join(root, "provider-mutated");
    const engineReads = join(root, "engine-reads");
    const registry = JSON.stringify({
      name: "refunds-mcp",
      displayName: "Refunds (MCP)",
      interfaces: [{ url: "https://x.example/mcp", protocolBinding: "JSONRPC" }],
      mcpServerSpec: { type: "TOOL_SPEC" },
    });
    const gateway = JSON.stringify({
      name: "refunds-agent-gateway",
      googleManaged: { governedAccessPath: "AGENT_TO_ANYWHERE" },
      registries: ["//agentregistry.googleapis.com/projects/acme-proj/locations/global"],
    });
    const gcloudPath = join(fakeBin, "gcloud");
    writeFileSync(
      gcloudPath,
      `#!/usr/bin/env bash
if [[ "$1" == "auth" && "$2" == "print-access-token" ]]; then
  printf token
  exit 0
fi
if [[ "$1" == "agent-registry" && "$2" == "services" && "$3" == "describe" ]]; then
  printf '%s\\n' ${JSON.stringify(registry)}
  exit 0
fi
if [[ "$1" == "network-services" && "$2" == "agent-gateways" && "$3" == "describe" ]]; then
  printf '%s\\n' ${JSON.stringify(gateway)}
  exit 0
fi
printf called >${JSON.stringify(mutationMarker)}
exit 99
`,
    );
    chmodSync(gcloudPath, 0o700);
    const curlPath = join(fakeBin, "curl");
    const engineResource =
      "projects/123456789/locations/global/collections/default_collection/engines/eng-1";
    writeFileSync(
      curlPath,
      `#!/usr/bin/env bash
OUTPUT=
METHOD=GET
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) OUTPUT="$2"; shift 2 ;;
    -X) METHOD="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ "$METHOD" == "PATCH" ]]; then
  printf called >${JSON.stringify(mutationMarker)}
  printf '{"name":"unexpected"}' >"$OUTPUT"
  printf 200
  exit 0
fi
COUNT=0
if [[ -f ${JSON.stringify(engineReads)} ]]; then
  read -r COUNT <${JSON.stringify(engineReads)}
fi
COUNT=$((COUNT + 1))
printf '%s' "$COUNT" >${JSON.stringify(engineReads)}
if [[ "$COUNT" == "1" ]]; then ETAG=etag-a; else ETAG=etag-b; fi
printf '{"name":"%s","etag":"%s","agentGatewaySetting":{}}' \
  ${JSON.stringify(engineResource)} "$ETAG" >"$OUTPUT"
printf 200
`,
    );
    chmodSync(curlPath, 0o700);

    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        ANVIL_STATE_DIR: join(root, "state"),
        ANVIL_CONFIRM_ENGINE_EGRESS_REROUTE: "1",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Engine changed after preflight");
    expect(existsSync(mutationMarker)).toBe(false);
    expect(existsSync(join(stateDir, "engine-before.json"))).toBe(false);
  });

  it("refuses rollback when another actor has changed the live gateway", () => {
    const target = config({ surface: "agent-gateway" });
    const kit = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, target);
    const root = mkdtempSync(join(tmpdir(), "anvil-target-concurrent-rollback-"));
    const scriptDir = join(root, "bundle", "targets", "gemini-enterprise", "agent-registry");
    const stateDir = join(root, "state", "gemini-enterprise", engineStateKey(target));
    const fakeBin = join(root, "bin");
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    const scriptPath = join(scriptDir, "rollback.sh");
    writeFileSync(scriptPath, textFile(kit, "agent-registry/rollback.sh"));
    chmodSync(scriptPath, 0o700);
    const engineResource =
      "projects/123456789/locations/global/collections/default_collection/engines/eng-1";
    writeFileSync(
      join(stateDir, "engine-before.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        name: engineResource,
        capturedAt: "2026-07-23T00:00:00Z",
        previousDefaultEgressAgentGateway: null,
      })}\n`,
    );
    const mutationMarker = join(root, "provider-mutated");
    const gcloudPath = join(fakeBin, "gcloud");
    writeFileSync(
      gcloudPath,
      '#!/usr/bin/env bash\nif [[ "$1" == "auth" ]]; then printf token; exit 0; fi\nexit 99\n',
    );
    chmodSync(gcloudPath, 0o700);
    const curlPath = join(fakeBin, "curl");
    writeFileSync(
      curlPath,
      `#!/usr/bin/env bash
OUTPUT=
METHOD=GET
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) OUTPUT="$2"; shift 2 ;;
    -X) METHOD="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ "$METHOD" == "PATCH" ]]; then
  printf called >${JSON.stringify(mutationMarker)}
fi
printf '{"name":"%s","etag":"etag-new","agentGatewaySetting":{"defaultEgressAgentGateway":{"name":"projects/acme-proj/locations/us-central1/agentGateways/someone-elses-gateway"}}}' \
  ${JSON.stringify(engineResource)} >"$OUTPUT"
printf 200
`,
    );
    chmodSync(curlPath, 0o700);

    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        ANVIL_STATE_DIR: join(root, "state"),
        ANVIL_CONFIRM_ENGINE_EGRESS_ROLLBACK: "1",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Engine no longer routes through this kit's gateway");
    expect(existsSync(mutationMarker)).toBe(false);
  });

  it("uses a 128-bit SHA-256 state-key suffix over the complete engine resource", () => {
    const first = config({
      engine: "projects/123456789/locations/global/collections/default_collection/engines/shared",
      projectNumber: undefined,
    });
    const second = config({
      engine: "projects/987654321/locations/global/collections/default_collection/engines/shared",
      projectNumber: undefined,
    });
    expect(engineStateKey(first)).toMatch(/^shared-[0-9a-f]{32}$/);
    expect(engineStateKey(second)).toMatch(/^shared-[0-9a-f]{32}$/);
    expect(engineStateKey(first)).not.toBe(engineStateKey(second));
    expect(engineStateKey(first)).toBe(engineStateKey(first));
  });

  it("refuses a rollback snapshot owned by a different engine before any provider call", () => {
    const target = config({ surface: "agent-gateway" });
    const kit = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, target);
    const root = mkdtempSync(join(tmpdir(), "anvil-target-rollback-"));
    const scriptDir = join(root, "bundle", "targets", "gemini-enterprise", "agent-registry");
    const stateRoot = join(root, "state");
    const fakeBin = join(root, "bin");
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(join(stateRoot, "gemini-enterprise", engineStateKey(target)), {
      recursive: true,
    });
    mkdirSync(fakeBin, { recursive: true });
    const scriptPath = join(scriptDir, "rollback.sh");
    writeFileSync(scriptPath, textFile(kit, "agent-registry/rollback.sh"));
    chmodSync(scriptPath, 0o700);
    const marker = join(root, "provider-called");
    for (const command of ["gcloud", "curl"]) {
      const path = join(fakeBin, command);
      writeFileSync(
        path,
        `#!/usr/bin/env bash\nprintf called >${JSON.stringify(marker)}\nexit 99\n`,
      );
      chmodSync(path, 0o700);
    }
    writeFileSync(
      join(stateRoot, "gemini-enterprise", engineStateKey(target), "engine-before.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        name: "projects/999999999/locations/global/collections/default_collection/engines/other",
        capturedAt: "2026-07-23T00:00:00Z",
        previousDefaultEgressAgentGateway: null,
      })}\n`,
    );
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        ANVIL_STATE_DIR: stateRoot,
        ANVIL_CONFIRM_ENGINE_EGRESS_ROLLBACK: "1",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("belongs to another engine");
    expect(result.stdout).not.toContain("called");
  });

  it("escapes Terraform interpolation in operator-supplied IAM strings", () => {
    const kit = generateTargetKit(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({
        agentIdentityPrincipalSet:
          "principalSet://agents.global.org-123.system.id.goog/${unexpected}",
      }),
    );
    const terraform = textFile(kit, "agent-registry/agent-registry.tf");
    const cloudRunTfvars = textFile(kit, "cloud-run.tfvars");
    expect(terraform).toContain("$${unexpected}");
    expect(terraform).not.toContain('system.id.goog/${unexpected}"');
    expect(cloudRunTfvars).toContain("$${unexpected}");
    expect(cloudRunTfvars).not.toContain('system.id.goog/${unexpected}"');
  });

  it("projects max-length underscore service ids to stable RFC-1034 provider names", () => {
    const namesFor = (serviceId: string) => {
      const document = structuredClone(air);
      document.service.id = serviceId;
      const kit = generateTargetKit(document, GEMINI_ENTERPRISE_PROFILE, config());
      const gatewayYaml = textFile(kit, "agent-registry/agent-gateway.yaml");
      const register = textFile(kit, "agent-registry/register.sh");
      return {
        gateway: gatewayYaml.match(/^name: ([a-z0-9-]+)$/m)?.[1] ?? "",
        service: register.match(/^SERVICE='([a-z0-9-]+)'$/m)?.[1] ?? "",
      };
    };
    const first = namesFor(`a_${"x".repeat(62)}`);
    const second = namesFor(`a_${"x".repeat(61)}y`);
    for (const name of Object.values(first)) {
      expect(name).toMatch(/^[a-z][a-z0-9-]{0,62}$/);
      expect(name.length).toBeLessThanOrEqual(63);
    }
    expect(first.service).toMatch(/-[0-9a-f]{8}-mcp$/);
    expect(first.gateway).toMatch(/-[0-9a-f]{8}-agent-gateway$/);
    expect(second).not.toEqual(first);
    expect(namesFor(`a_${"x".repeat(62)}`)).toEqual(first);
  });

  it("keeps generated custom-MCP templates free of persisted runtime secrets", () => {
    const kit = generateTargetKit(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({ surface: "custom-mcp" }),
    );
    const template = textFile(kit, "registration.request.template.json");
    const script = textFile(kit, "registration.curl.sh");
    expect(template).toContain("${ANVIL_PRIVATE_APP_ACCESS_TOKEN}");
    expect(template).toContain("${ANVIL_OAUTH_CLIENT_ID}");
    expect(template).toContain("${ANVIL_OAUTH_CLIENT_SECRET}");
    expect(template).not.toContain("private-app-token");
    expect(script).toContain("mounted Secret Manager file");
    expect(script).toContain('-d @"$TEMP_BODY"');
  });

  it("builds a console-first plan with connector OAuth separate from WIF", () => {
    const plan = buildConnectorPlan(air, GEMINI_ENTERPRISE_PROFILE, config());
    expect(plan.identity.authUri).toContain("login.microsoftonline.com/tenant-123");
    expect(plan.identity.notes.join("\n")).toContain("does not choose the OAuth token");
    expect(plan.run.map((step) => step.command).join("\n")).not.toContain("registration.curl.sh");
    const custom = plan.console.find((step) => step.surface === "custom-mcp");
    expect(custom?.url).toContain("engines/eng-1");
    const fields = Object.fromEntries(
      custom?.copy.map((field) => [field.label, field.value]) ?? [],
    );
    expect(fields.Scopes).toBe("api://anvil-mcp/mcp.invoke");
    expect(fields["MCP API audience"]).toBe("api://anvil-mcp");
    const rendered = renderConnectorPlanText(plan);
    expect(rendered).toContain("console-first");
    expect(rendered).not.toContain("User.Read");
    const runCommands = plan.run.map((step) => step.command).join("\n");
    expect(runCommands.indexOf("anvil certify")).toBeLessThan(
      runCommands.indexOf('terraform -chdir="$ANVIL_TF_WORK_DIR" plan'),
    );
    expect(runCommands).not.toContain("terraform -chdir=<bundle>/deploy");
    expect(runCommands).not.toContain("terraform -chdir=<bundle>/targets");
    expect(runCommands).toContain("set -euo pipefail");
    expect(runCommands).toContain("ANVIL_TF_STATE_BUCKET");
    expect(runCommands).toContain("ANVIL_TF_STATE_PREFIX");
    expect(runCommands).toContain("TF_VAR_project_id='acme-proj'");
    expect(runCommands).toContain("TF_VAR_image_tag");
    expect(runCommands).toContain("-backend-config=");
    expect(runCommands).not.toContain("init; terraform");
    const registrySteps = plan.run.filter((step) => step.command.includes("register.sh"));
    expect(registrySteps).toHaveLength(3);
    expect(registrySteps[0]?.command).toContain("ANVIL_RECONCILE_REGISTRY_GATEWAY=1");
    expect(registrySteps[0]?.command).toContain("ANVIL_CONFIRM_REGISTRY_GATEWAY_RECONCILE=1");
    expect(registrySteps[0]?.command).not.toContain("ANVIL_CONFIRM_ENGINE_EGRESS_REROUTE");
    expect(registrySteps[1]?.command).toBe(registrySteps[0]?.command);
    expect(registrySteps[2]?.command).toContain("ANVIL_CONFIRM_ENGINE_EGRESS_REROUTE=1");
    expect(registrySteps[2]?.command).not.toContain("ANVIL_RECONCILE_REGISTRY_GATEWAY");
  });

  it("lists every approved action for selection", () => {
    const kit = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, config());
    const parsed = JSON.parse(textFile(kit, "action-selection.json")) as {
      actions: { name: string }[];
    };
    expect(parsed.actions.map((action) => action.name).sort()).toEqual([
      "refunds_create_refund",
      "refunds_list_refunds",
    ]);
  });
});

describe("target validation", () => {
  it("passes a well-formed target", () => {
    expect(validateTarget(air, GEMINI_ENTERPRISE_PROFILE, config()).ok).toBe(true);
  });

  it("rejects missing required config and an invalid endpoint", () => {
    const result = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      createGeminiEnterpriseTargetConfig({
        surface: "custom-mcp",
        serverAuth: "no-auth",
        allowUnauthenticatedMcp: true,
        endpoint: "http://x.example/mcp",
      }),
    );
    const codes = result.findings.map((finding) => finding.code);
    expect(result.ok).toBe(false);
    expect(codes).toContain("target/missing_project");
    expect(codes).toContain("target/missing_app_location");
    expect(codes).toContain("target/missing_engine");
    expect(codes).toContain("target/insecure_transport");
  });

  it("parses exact provider coordinates rather than trusting prefixes", () => {
    expect(isGcpProjectId("acme-proj")).toBe(true);
    expect(isGcpProjectId("ABC")).toBe(false);
    expect(isGcpProjectNumber("123456789")).toBe(true);
    expect(isGcpProjectNumber("123")).toBe(false);
    expect(
      parseCanonicalEngineResource(
        "projects/123456789/locations/global/collections/default_collection/engines/eng-1",
      ),
    ).toEqual({
      projectNumber: "123456789",
      location: "global",
      collection: "default_collection",
      engineId: "eng-1",
    });
    expect(
      parseCanonicalEngineResource(
        "projects/999/locations/global/collections/default_collection/engines/eng-1",
      ),
    ).toBeUndefined();
    expect(parseAgentIdentityPrincipalSet(AGENT_PRINCIPAL_SET)).toMatchObject({
      projectNumber: "123456789",
      scope: "container",
    });
    expect(parseAgentIdentityPrincipalSet("principalSet://garbage")).toBeUndefined();
    expect(
      parseGatewayAuthorizationPolicyResource(
        "projects/acme-proj/locations/us-central1/authzPolicies/mcp-egress",
      ),
    ).toEqual({
      project: "acme-proj",
      location: "us-central1",
      policyId: "mcp-egress",
    });
    expect(parseGatewayAuthorizationPolicyResource("garbage")).toBeUndefined();
    expect(isWorkforcePoolResource("locations/global/workforcePools/ge-users")).toBe(true);
    expect(isWorkforcePoolResource("garbage")).toBe(false);
  });

  it.each([
    [{ project: "ABC" }, "target/invalid_project"],
    [{ projectNumber: "123" }, "target/invalid_project_number"],
    [{ appLocation: "!!!" }, "target/invalid_app_location"],
    [{ engine: "/bad" }, "target/invalid_engine_resource"],
    [
      {
        engine: "projects/999/locations/global/collections/default_collection/engines/eng-1",
        projectNumber: undefined,
      },
      "target/invalid_engine_resource",
    ],
    [{ workforcePool: "garbage" }, "target/invalid_workforce_pool"],
    [
      { agentIdentityPrincipalSet: "principalSet://garbage" },
      "target/invalid_agent_identity_principal_set",
    ],
    [{ gatewayAuthorizationPolicy: "garbage" }, "target/invalid_gateway_authorization_policy"],
    [
      { connectorOAuth: { tenant: "tenant@evil.example" } },
      "target/invalid_connector_oauth_tenant",
    ],
    [{ connectorOAuth: { inboundIssuer: "garbage" } }, "target/invalid_inbound_issuer"],
    [
      { connectorOAuth: { inboundIssuer: "https://login.microsoftonline.com/other/v2.0" } },
      "target/inbound_issuer_tenant_mismatch",
    ],
    [{ connectorOAuth: { inboundAudience: "x" } }, "target/invalid_inbound_audience"],
    [{ connectorOAuth: { scopes: ["x"] } }, "target/invalid_connector_oauth_scope"],
    [
      { connectorOAuth: { scopes: ["api://other-api/mcp.invoke"] } },
      "target/oauth_scope_audience_mismatch",
    ],
  ] as const)("rejects malformed provider coordinate %#", (overrides, expectedCode) => {
    const result = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config(overrides as GeminiEnterpriseTargetConfigInput),
    );
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain(expectedCode);
  });

  it("rejects runtime-invalid gateway and registry locations", () => {
    const gateway = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({ gatewayLocation: "moon-1" as never }),
    );
    expect(gateway.findings.map((finding) => finding.code)).toContain(
      "target/invalid_gateway_location",
    );
    const registry = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({ registryLocation: "moon" as never }),
    );
    expect(registry.findings.map((finding) => finding.code)).toContain(
      "target/invalid_registry_location",
    );
  });

  it("binds canonical engine and authorization-policy coordinates to CLI fields", () => {
    const engineProjectMismatch = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({
        engine: "projects/987654321/locations/global/collections/default_collection/engines/eng-1",
      }),
    );
    expect(engineProjectMismatch.findings.map((finding) => finding.code)).toContain(
      "target/engine_project_number_mismatch",
    );

    const engineLocationMismatch = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({
        engine: "projects/123456789/locations/eu/collections/default_collection/engines/eng-1",
      }),
    );
    expect(engineLocationMismatch.findings.map((finding) => finding.code)).toContain(
      "target/engine_location_mismatch",
    );

    const policyProjectMismatch = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({
        gatewayAuthorizationPolicy:
          "projects/other-proj/locations/us-central1/authzPolicies/mcp-egress",
      }),
    );
    expect(policyProjectMismatch.findings.map((finding) => finding.code)).toContain(
      "target/gateway_authorization_policy_project_mismatch",
    );

    const policyLocationMismatch = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({
        gatewayAuthorizationPolicy:
          "projects/acme-proj/locations/europe-west1/authzPolicies/mcp-egress",
      }),
    );
    expect(policyLocationMismatch.findings.map((finding) => finding.code)).toContain(
      "target/gateway_authorization_policy_location_mismatch",
    );

    const principalProjectMismatch = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({
        agentIdentityPrincipalSet:
          "principalSet://agents.global.org-123456789012.system.id.goog/attribute.container/projects/987654321",
      }),
    );
    expect(principalProjectMismatch.findings.map((finding) => finding.code)).toContain(
      "target/agent_identity_principal_project_mismatch",
    );

    const broadPrincipal = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({
        agentIdentityPrincipalSet: "principalSet://agents.global.org-123456789012.system.id.goog/*",
      }),
    );
    expect(broadPrincipal.findings.map((finding) => finding.code)).toContain(
      "target/agent_identity_principal_scope_too_broad",
    );
  });

  it.each([
    ["https://x.example/mcp/", "target/invalid_mcp_endpoint_path"],
    ["https://x.example/other", "target/invalid_mcp_endpoint_path"],
    ["https://x.example/mcp?tenant=acme", "target/endpoint_query_or_fragment"],
    ["https://x.example/mcp#fragment", "target/endpoint_query_or_fragment"],
    ["https://127.0.0.1/mcp", "target/non_public_endpoint"],
    ["https://10.20.30.40/mcp", "target/non_public_endpoint"],
    ["https://localhost/mcp", "target/non_public_endpoint"],
    ["https://[::1]/mcp", "target/non_public_endpoint"],
  ])("rejects a non-public or non-exact MCP endpoint: %s", (endpoint, expectedCode) => {
    const result = validateTarget(air, GEMINI_ENTERPRISE_PROFILE, config({ endpoint }));
    expect(result.findings.map((finding) => finding.code)).toContain(expectedCode);
  });

  it("rejects zero approved tools", () => {
    const empty = structuredClone(air);
    for (const operation of empty.operations) operation.state = "review_required";
    const result = validateTarget(empty, GEMINI_ENTERPRISE_PROFILE, config());
    expect(result.findings.map((finding) => finding.code)).toContain("target/no_approved_tools");
  });

  it("keeps irreversible confirmation in the contract as defense in depth", () => {
    const weakened = structuredClone(air);
    const refund = weakened.operations.find(
      (operation) => operation.sourceRef.operationId === "createRefund",
    );
    if (refund) {
      refund.effect.reversible = false;
      refund.confirmation.required = false;
    }
    const result = validateTarget(weakened, GEMINI_ENTERPRISE_PROFILE, config());
    expect(result.findings.map((finding) => finding.code)).toContain(
      "target/unconfirmed_irreversible_action",
    );
  });

  it("rejects a surface over the action budget", () => {
    const profile = {
      ...GEMINI_ENTERPRISE_PROFILE,
      actionLimits: { maxActions: 1, requiresActionDescriptions: true },
    };
    const result = validateTarget(air, profile, config());
    expect(result.findings.map((finding) => finding.code)).toContain(
      "target/action_budget_exceeded",
    );
  });

  it("accepts an arbitrary Custom MCP app location with a live-validation warning", () => {
    const result = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({
        surface: "custom-mcp",
        appLocation: "asia-southeast1",
        gatewayLocation: undefined,
        registryLocation: undefined,
        projectNumber: undefined,
        confirmEngineEgressReroute: false,
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.findings.map((finding) => finding.code)).toContain(
      "target/provider_location_validation_required",
    );
  });

  it("fails Agent Gateway closed outside the verified location matrix", () => {
    const result = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({
        surface: "agent-gateway",
        appLocation: "asia-southeast1",
        gatewayLocation: "us-central1",
        registryLocation: "global",
      }),
    );
    expect(result.findings.map((finding) => finding.code)).toContain(
      "target/unsupported_gateway_app_location",
    );
  });

  it("enforces gateway and registry compatibility, including global registry", () => {
    const validEu = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({
        surface: "agent-gateway",
        appLocation: "eu",
        gatewayLocation: "europe-west1",
        registryLocation: "global",
        gatewayAuthorizationPolicy:
          "projects/acme-proj/locations/europe-west1/authzPolicies/mcp-egress",
      }),
    );
    expect(validEu.ok).toBe(true);

    const wrongGateway = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({
        surface: "agent-gateway",
        appLocation: "eu",
        gatewayLocation: "us-central1",
        registryLocation: "global",
      }),
    );
    expect(wrongGateway.findings.map((finding) => finding.code)).toContain(
      "target/gateway_location_mismatch",
    );

    const unsupportedManualRegistry = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({ surface: "agent-gateway", registryLocation: "us" }),
    );
    expect(unsupportedManualRegistry.findings.map((finding) => finding.code)).toContain(
      "target/registry_location_mismatch",
    );
  });

  it("requires egress confirmation and a project number for synthesized engines", () => {
    const result = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({
        surface: "agent-gateway",
        projectNumber: undefined,
        confirmEngineEgressReroute: false,
      }),
    );
    const codes = result.findings.map((finding) => finding.code);
    expect(codes).toContain("target/missing_project_number");
    expect(codes).toContain("target/engine_egress_confirmation_required");
  });

  it("accepts a canonical engine resource without a separate project number", () => {
    const result = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({
        surface: "agent-gateway",
        projectNumber: undefined,
        engine: "projects/987654321/locations/global/collections/default_collection/engines/eng-2",
        agentIdentityPrincipalSet:
          "principalSet://agents.global.org-123456789012.system.id.goog/attribute.container/projects/987654321",
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a slash-containing engine that is not an exact canonical resource", () => {
    const result = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({
        surface: "agent-gateway",
        engine: "projects/acme-proj/locations/global/collections/default_collection/engines/eng-2",
      }),
    );
    expect(result.findings.map((finding) => finding.code)).toContain(
      "target/invalid_engine_resource",
    );
  });

  it("rejects an oversized Agent Registry toolspec", () => {
    const oversized = structuredClone(air);
    oversized.operations[0]!.description = "x".repeat(TOOLSPEC_MAX_BYTES);
    const result = validateTarget(
      oversized,
      GEMINI_ENTERPRISE_PROFILE,
      config({ surface: "agent-gateway" }),
    );
    expect(result.findings.map((finding) => finding.code)).toContain("target/toolspec_too_large");
  });

  it("rejects Microsoft Graph scopes for the MCP API", () => {
    const result = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({ connectorOAuth: { scopes: ["User.Read"] } }),
    );
    expect(result.findings.map((finding) => finding.code)).toContain(
      "target/unrelated_graph_scope",
    );
  });

  it("rejects Google OAuth until the server has a verified opaque-token path", () => {
    const result = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({ connectorOAuth: { provider: "google", tenant: undefined } }),
    );
    expect(result.findings.map((finding) => finding.code)).toContain(
      "target/unsupported_google_oauth_access_token",
    );
  });

  it("requires explicit HTTPS authorization and token URLs for other OAuth providers", () => {
    const missing = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({
        connectorOAuth: {
          provider: "other",
          tenant: undefined,
          authorizationUrl: undefined,
          tokenUrl: undefined,
        },
      }),
    );
    const missingCodes = missing.findings.map((finding) => finding.code);
    expect(missingCodes).toContain("target/missing_connector_oauth_authorization_url");
    expect(missingCodes).toContain("target/missing_connector_oauth_token_url");

    const valid = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({
        connectorOAuth: {
          provider: "other",
          tenant: undefined,
          authorizationUrl: "https://idp.example/authorize",
          tokenUrl: "https://idp.example/token",
        },
      }),
    );
    expect(valid.ok).toBe(true);
  });

  it("requires an explicit acknowledgement for no-auth", () => {
    const result = validateTarget(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({
        surface: "custom-mcp",
        serverAuth: "no-auth",
        allowUnauthenticatedMcp: false,
        connectorOAuth: { provider: undefined, scopes: [] },
      }),
    );
    expect(result.findings.map((finding) => finding.code)).toContain(
      "target/unauthenticated_mcp_confirmation_required",
    );
    expect(result.findings.map((finding) => finding.code)).not.toContain(
      "target/no_auth_in_contract",
    );
  });

  it("keeps platform requirements in the versioned profile and warns on drafts", () => {
    expect(GEMINI_ENTERPRISE_PROFILE.version).toMatch(/^\d{4}\./);
    const draft = { ...GEMINI_ENTERPRISE_PROFILE, verificationStatus: "provisional" as const };
    const result = validateTarget(air, draft, config());
    expect(result.ok).toBe(true);
    expect(result.findings.map((finding) => finding.code)).toContain("target/unverified_profile");
  });
});
