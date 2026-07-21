import type { AirDocument } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { beforeEach, describe, expect, it } from "vitest";
import { GEMINI_ENTERPRISE_PROFILE } from "./gemini-enterprise.js";
import { generateTargetKit } from "./generate.js";
import { buildRegistrationRequest, renderRegistrationCurl } from "./registration.js";
import { validateTarget } from "./validate.js";

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

let air: AirDocument;

beforeEach(async () => {
  const compiled = await compile({ spec: SPEC, serviceId: "refunds" });
  air = approveOperations(
    compiled,
    compiled.operations.map((o) => o.id),
  );
});

describe("target kit generation", () => {
  it("emits the full Gemini Enterprise kit deterministically", () => {
    const a = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, {
      endpoint: "https://x.example/mcp",
    });
    const b = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, {
      endpoint: "https://x.example/mcp",
    });
    const names = a.files.map((f) => f.path.split("/").pop());
    expect(names).toEqual([
      "action-selection.json",
      "admin-runbook.md",
      "compatibility-report.json",
      "inbound-auth.env",
      "oauth.template.json",
      "organization-policy-checklist.md",
      "registration.curl.sh",
      "registration.request.json",
      "server-description.md",
      "setup.json",
      "target-profile.json",
      "connector.auto.tfvars",
      "connector.tf",
    ]);
    // Deterministic bytes.
    for (let i = 0; i < a.files.length; i++) {
      expect(Buffer.from(a.files[i]!.bytes).equals(Buffer.from(b.files[i]!.bytes))).toBe(true);
    }
  });

  it("overlays the deploy for a public connector: public ingress + inbound-auth env", () => {
    const kit = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, {
      endpoint: "https://x.example/mcp",
    });
    const tfvars = new TextDecoder().decode(
      kit.files.find((f) => f.path.endsWith("connector.auto.tfvars"))!.bytes,
    );
    expect(tfvars).toContain('ingress               = "INGRESS_TRAFFIC_ALL"');
    expect(tfvars).toContain("allow_unauthenticated = true");
    // Confirmed primary inbound for GE's OAUTH connector: the server validates the
    // user's IdP token as an OIDC resource server (issuer/audience from the IdP).
    expect(tfvars).toContain('ANVIL_INBOUND_AUTH_MODE = "oidc"');
    expect(tfvars).toContain("ANVIL_INBOUND_ISSUER");
    const tf = new TextDecoder().decode(
      kit.files.find((f) => f.path.endsWith("connector.tf"))!.bytes,
    );
    expect(tf).toContain("roles/discoveryengine.editor");
  });

  it("builds a SetUpDataConnector registration request with the confirmed custom_mcp shape", () => {
    const reg = buildRegistrationRequest(air, {
      endpoint: "https://x.example/mcp",
      project: "acme-proj",
      location: "global",
      oauthAccessTokenRef: "the-private-app-access-token",
      clientId: "client-123",
      clientSecretRef: "projects/acme-proj/secrets/mcp-oauth/versions/latest",
      authUri: "https://idp.example/authorize",
      tokenUri: "https://idp.example/token",
      scopes: ["openid", "email"],
    });
    expect(reg.url).toBe(
      "https://discoveryengine.googleapis.com/v1/projects/acme-proj/locations/global:setUpDataConnector",
    );
    // Confirmed against 7 live connectors: data_source=custom_mcp; params carries
    // the Private App Access Token; the server URL + OAuth flow live under
    // action_config.action_params. Tools are NOT enumerated (dynamic_tools is output-only).
    const dc = reg.body.dataConnector;
    expect(dc.dataSource).toBe("custom_mcp");
    expect(dc.refreshInterval).toBe("86400s");
    expect(dc.params.oauth_access_token).toBe("the-private-app-access-token");
    const ap = dc.actionConfig.actionParams;
    expect(ap.auth_type).toBe("OAUTH");
    expect(ap.instance_uri).toBe("https://x.example/mcp");
    expect(ap.client_id).toBe("client-123");
    expect(ap.token_uri).toBe("https://idp.example/token");
    expect(ap.mcp_server_source).toBe("BYO_MCP");
    expect(dc.actionConfig.createBapConnection).toBe(true);
    // The remaining work is operator prerequisites (incl. the interactive Authorize).
    expect(reg.prerequisites.join("\n")).toContain("Authorize");
    // The curl runs under the operator's own credentials — Anvil holds none.
    expect(renderRegistrationCurl(reg)).toContain("gcloud auth print-access-token");
  });

  it("supports a NO_AUTH custom MCP connector (no OAuth params)", () => {
    const reg = buildRegistrationRequest(air, {
      endpoint: "https://x.example/mcp",
      authType: "NO_AUTH",
    });
    const ap = reg.body.dataConnector.actionConfig.actionParams;
    expect(ap.auth_type).toBe("NO_AUTH");
    expect(ap.client_id).toBeUndefined();
    expect(ap.auth_uri).toBeUndefined();
  });

  it("emits the registration request + curl in the connector kit", () => {
    const kit = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE, {
      endpoint: "https://x.example/mcp",
    });
    const req = kit.files.find((f) => f.path.endsWith("registration.request.json"));
    expect(req).toBeDefined();
    const parsed = JSON.parse(new TextDecoder().decode(req!.bytes)) as {
      dataConnector: { dataSource: string; actionConfig: { actionParams: { instance_uri: string } } };
    };
    expect(parsed.dataConnector.dataSource).toBe("custom_mcp");
    expect(parsed.dataConnector.actionConfig.actionParams.instance_uri).toBe("https://x.example/mcp");
  });

  it("lists every approved action for selection", () => {
    const kit = generateTargetKit(air, GEMINI_ENTERPRISE_PROFILE);
    const file = kit.files.find((f) => f.path.endsWith("action-selection.json"));
    const parsed = JSON.parse(new TextDecoder().decode(file!.bytes)) as {
      actions: { name: string }[];
    };
    expect(parsed.actions.map((a) => a.name).sort()).toEqual([
      "refunds_create_refund",
      "refunds_list_refunds",
    ]);
  });
});

describe("target validation", () => {
  it("passes a well-formed contract on an HTTPS endpoint", () => {
    const result = validateTarget(air, GEMINI_ENTERPRISE_PROFILE, {
      endpoint: "https://x.example/mcp",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a non-HTTPS endpoint", () => {
    const result = validateTarget(air, GEMINI_ENTERPRISE_PROFILE, {
      endpoint: "http://x.example/mcp",
    });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain("target/insecure_transport");
  });

  it("rejects an irreversible mutation that does not confirm (platform won't confirm for you)", () => {
    const weakened = structuredClone(air);
    const refund = weakened.operations.find((o) => o.sourceRef.operationId === "createRefund");
    if (refund) {
      refund.effect.reversible = false;
      refund.confirmation.required = false;
    }
    const result = validateTarget(weakened, GEMINI_ENTERPRISE_PROFILE);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain("target/unconfirmed_irreversible_action");
  });

  it("rejects a surface over the action budget", () => {
    const profile = {
      ...GEMINI_ENTERPRISE_PROFILE,
      actionLimits: { maxActions: 1, requiresActionDescriptions: true },
    };
    const result = validateTarget(air, profile);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain("target/action_budget_exceeded");
  });

  it("keeps platform requirements out of AIR — the profile is versioned data", () => {
    expect(GEMINI_ENTERPRISE_PROFILE.version).toMatch(/^\d{4}\./);
    expect(GEMINI_ENTERPRISE_PROFILE.unsupportedAssumptions.length).toBeGreaterThan(0);
  });

  it("warns that a not-yet-verified profile is a draft, structurally", () => {
    // The Gemini profile is now `verified` end to end, so it does NOT warn.
    expect(GEMINI_ENTERPRISE_PROFILE.verificationStatus).toBe("verified");
    const clean = validateTarget(air, GEMINI_ENTERPRISE_PROFILE, {
      endpoint: "https://x.example/mcp",
    });
    expect(clean.findings.map((f) => f.code)).not.toContain("target/unverified_profile");
    // But the validator still warns on anything that is not `verified`.
    const draft = { ...GEMINI_ENTERPRISE_PROFILE, verificationStatus: "provisional" as const };
    const result = validateTarget(air, draft, { endpoint: "https://x.example/mcp" });
    expect(result.ok).toBe(true);
    expect(result.findings.map((f) => f.code)).toContain("target/unverified_profile");
  });
});
