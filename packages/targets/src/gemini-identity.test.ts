import { type AirDocument, IdentityProfile } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createGeminiEnterpriseTargetConfig,
  type GeminiEnterpriseTargetConfigInput,
} from "./config.js";
import { buildConnectorPlan } from "./connector-plan.js";
import { GEMINI_ENTERPRISE_PROFILE } from "./gemini-enterprise.js";
import { generateTargetKit } from "./generate.js";
import { validateTarget } from "./validate.js";
import { verifyTargetKit } from "./verify.js";

const endpoint = "https://ultimatix-tools-123.run.app/mcp";
let air: AirDocument;
let identity: IdentityProfile;

beforeEach(async () => {
  const compiled = await compile({
    serviceId: "employee-demo",
    spec: `openapi: 3.0.3
info: {title: Employees, version: "1"}
paths:
  /employees:
    get:
      operationId: listEmployees
      description: List employees in a test system.
      responses: {"200": {description: OK}}
`,
  });
  air = approveOperations(
    compiled,
    compiled.operations.map((operation) => operation.id),
  );
  identity = IdentityProfile.parse({
    version: 1,
    id: "siteminder-connector",
    authentication: {
      provider: "oidc",
      issuer: "https://siteminder.example/issuer",
      audience: "api://ultimatix-mcp",
      resource: endpoint,
      jwksUri: "https://siteminder.example/keys",
      requiredScopes: ["mcp.invoke"],
    },
    mapping: { tenant: { source: "fixed", value: "tcs-demo" }, upstreamScopes: [] },
    authorization: {
      rules: [
        {
          id: "read",
          service: air.service.id,
          operations: [air.operations[0]!.id],
          effect: "allow",
        },
      ],
    },
  });
});

function config(overrides: GeminiEnterpriseTargetConfigInput = {}) {
  return createGeminiEnterpriseTargetConfig({
    surface: "custom-mcp",
    serverAuth: "oauth",
    endpoint,
    project: "tcs-demo",
    projectNumber: "123456789",
    appLocation: "global",
    engine: "employees",
    workforcePool: "locations/global/workforcePools/entra-users",
    identityProfile: identity,
    ...overrides,
    connectorOAuth: {
      provider: "other",
      authorizationUrl: "https://siteminder.example/authorize",
      tokenUrl: "https://siteminder.example/token",
      scopes: ["mcp.invoke"],
      ...overrides.connectorOAuth,
    },
  });
}

const textFile = (kit: ReturnType<typeof generateTargetKit>, suffix: string) =>
  Buffer.from(kit.files.find((file) => file.path.endsWith(suffix))!.bytes).toString("utf8");

describe("Gemini connector authority is independent of Entra app sign-in", () => {
  it("preserves profile text literally through the Terraform overlay", () => {
    const literal = structuredClone(identity);
    literal.id = "profile ${not_an_expression} %{ if true }literal%{ endif }";
    const kit = generateTargetKit(
      air,
      GEMINI_ENTERPRISE_PROFILE,
      config({ identityProfile: literal }),
    );
    const overlay = textFile(kit, "cloud-run.tfvars");
    expect(overlay).toContain("$${not_an_expression}");
    expect(overlay).toContain("%%{ if true }literal%%{ endif }");
    expect(JSON.parse(textFile(kit, "setup.json")).config.identityProfile.id).toBe(literal.id);
  });

  it("deploys the shared SiteMinder profile without competing legacy settings", () => {
    const target = config();
    expect(validateTarget(air, GEMINI_ENTERPRISE_PROFILE, target).ok).toBe(true);
    expect(target.connectorOAuth.inboundIssuer).toBe(identity.authentication.issuer);
    const kit = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, target);
    const setup = JSON.parse(textFile(kit, "setup.json"));
    expect(setup.config.workforcePool).toContain("entra-users");
    expect(setup.config.identityProfile).toEqual(identity);
    const env = textFile(kit, "inbound-auth.env");
    expect(env).toContain("ANVIL_IDENTITY_PROFILE_JSON='");
    expect(env).not.toContain("ANVIL_INBOUND_AUTH_MODE=");
    const overlay = textFile(kit, "cloud-run.tfvars");
    expect(overlay).toContain("ANVIL_IDENTITY_PROFILE_JSON =");
    expect(overlay).not.toContain("ANVIL_INBOUND_ISSUER =");
    expect(overlay).toContain("allow_unauthenticated = false");
    expect(overlay).toContain(
      "serviceAccount:service-123456789@gcp-sa-discoveryengine.iam.gserviceaccount.com",
    );
    const notes = buildConnectorPlan(air, GEMINI_ENTERPRISE_PROFILE, target).identity.notes.join(
      "\n",
    );
    expect(notes).toContain("entra-users");
    expect(notes).toContain(identity.authentication.issuer);
    expect(notes).toContain("independent of the GE login authority");
    const files = Object.fromEntries(
      kit.files.map((file) => [file.path, Buffer.from(file.bytes).toString("utf8")]),
    );
    expect(verifyTargetKit(air, GEMINI_ENTERPRISE_PROFILE, files).ok).toBe(true);
  });

  it.each([
    [
      { connectorOAuth: { inboundIssuer: "https://login.microsoftonline.com/entra/v2.0" } },
      "target/identity_issuer_mismatch",
    ],
    [
      { connectorOAuth: { inboundAudience: "api://different-mcp" } },
      "target/identity_audience_mismatch",
    ],
    [{ connectorOAuth: { scopes: ["different.scope"] } }, "target/identity_scope_mismatch"],
    [{ endpoint: "https://different.run.app/mcp" }, "target/identity_resource_mismatch"],
    [{ projectNumber: undefined }, "target/identity_cloud_run_project_number_required"],
    [{ serverAuth: "no-auth", allowUnauthenticatedMcp: true }, "target/identity_requires_oauth"],
  ] satisfies [
    GeminiEnterpriseTargetConfigInput,
    string,
  ][])("refuses inconsistent platform/profile coordinates", (overrides, code) => {
    expect(
      validateTarget(air, GEMINI_ENTERPRISE_PROFILE, config(overrides)).findings.map(
        (finding) => finding.code,
      ),
    ).toContain(code);
  });

  it("rejects machine/IAP profiles and unknown local operation bindings", () => {
    const machine = IdentityProfile.parse({
      ...identity,
      authentication: {
        ...identity.authentication,
        provider: "google_service_account",
        issuer: "https://accounts.google.com",
        jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
      },
      mapping: { ...identity.mapping, subjects: ["123"] },
    });
    expect(
      validateTarget(
        air,
        GEMINI_ENTERPRISE_PROFILE,
        config({ identityProfile: machine }),
      ).findings.map((finding) => finding.code),
    ).toContain("target/identity_requires_user_oauth");
    const bad = structuredClone(identity);
    bad.authorization.rules[0]!.operations = ["invented"];
    expect(
      validateTarget(air, GEMINI_ENTERPRISE_PROFILE, config({ identityProfile: bad })).findings.map(
        (finding) => finding.code,
      ),
    ).toContain("target/identity_operation_binding_invalid");
  });

  it("projects an explicit opaque SiteMinder token verifier without a JWT fallback", () => {
    const opaque = IdentityProfile.parse({
      ...identity,
      authentication: {
        ...identity.authentication,
        provider: "oauth2_introspection",
        jwksUri: undefined,
        introspection: {
          endpoint: "https://siteminder.example/introspect",
          clientIdEnv: "SITEMINDER_CONNECTOR_CLIENT_ID",
          clientSecretEnv: "SITEMINDER_CONNECTOR_CLIENT_SECRET",
        },
      },
    });
    const target = config({ identityProfile: opaque });
    expect(validateTarget(air, GEMINI_ENTERPRISE_PROFILE, target).ok).toBe(true);
    const kit = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, target);
    const setup = JSON.parse(textFile(kit, "setup.json"));
    expect(setup.config.identityProfile.authentication.introspection.clientSecretEnv).toBe(
      "SITEMINDER_CONNECTOR_CLIENT_SECRET",
    );
    expect(textFile(kit, "inbound-auth.env")).toContain("oauth2_introspection");
    expect(textFile(kit, "inbound-auth.env")).not.toContain("ANVIL_INBOUND_JWKS_URI=");
  });

  it("keeps custom-domain reachability explicit while enforcing the same user profile", () => {
    const custom = structuredClone(identity);
    custom.authentication.resource = "https://mcp.example/mcp";
    const target = config({ endpoint: custom.authentication.resource, identityProfile: custom });
    const kit = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, target);
    expect(textFile(kit, "cloud-run.tfvars")).toContain("allow_unauthenticated = true");
    expect(textFile(kit, "cloud-run.tfvars")).toContain(
      "GE does not supply its Cloud Run IAM token for this hostname",
    );
    expect(textFile(kit, "cloud-run.tfvars")).toContain("ANVIL_IDENTITY_PROFILE_JSON");
  });
});
