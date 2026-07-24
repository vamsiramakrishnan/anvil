import { AuthRequirement } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { reconcileGatewayIdentity } from "./identity-reconciliation.js";
import { GatewayIdentityEvidence } from "./model.js";

const coordinate = (pointer: string) => ({ origin: "kong.yaml", pointer });

describe("gateway identity reconciliation", () => {
  const contract = AuthRequirement.parse({
    type: "oauth2_on_behalf_of",
    principal: "delegated",
    issuer: "https://id.example.com/",
    audience: "api://payments",
    scopes: ["payments.read", "payments.write"],
    provider: {
      grant: "token_exchange",
      tokenEndpoint: "https://sts.example.com/oauth/token",
    },
  });

  it("reconciles every identity dimension from explicit evidence", () => {
    const report = reconcileGatewayIdentity(contract, [
      {
        coordinate: coordinate("/plugins/0"),
        basis: "explicit_configuration",
        type: "oauth2_on_behalf_of",
        principal: "delegated",
        issuer: "https://id.example.com/",
        audience: "api://payments",
        carrier: { in: "header", name: "authorization", scheme: "bearer" },
        scopes: ["payments.write", "payments.read"],
      },
    ]);
    expect(report.status).toBe("reconciled");
    expect(report.dimensions.every((dimension) => dimension.state === "match")).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("distinguishes missing evidence from contradictory evidence", () => {
    const missing = reconcileGatewayIdentity(contract, []);
    expect(missing.status).toBe("needs_evidence");
    expect(missing.dimensions.find((dimension) => dimension.dimension === "issuer")?.state).toBe(
      "missing_gateway",
    );

    const contradictory = reconcileGatewayIdentity(contract, [
      {
        coordinate: coordinate("/plugins/0"),
        basis: "explicit_configuration",
        issuer: "https://other-id.example.com/",
      },
      {
        coordinate: coordinate("/plugins/1"),
        basis: "explicit_configuration",
        issuer: "https://third-id.example.com/",
      },
    ]);
    expect(contradictory.status).toBe("blocked");
    expect(
      contradictory.dimensions.find((dimension) => dimension.dimension === "issuer")?.state,
    ).toBe("contradictory");
    expect(
      contradictory.findings.find((finding) => finding.dimension === "issuer")?.coordinates.length,
    ).toBeGreaterThan(0);
  });

  it("never treats a token endpoint as issuer evidence", () => {
    const noIssuer = AuthRequirement.parse({
      type: "oauth2_client_credentials",
      provider: { tokenEndpoint: "https://id.example.com/oauth/token" },
    });
    const report = reconcileGatewayIdentity(noIssuer, []);
    expect(report.dimensions.find((dimension) => dimension.dimension === "issuer")?.state).toBe(
      "missing_both",
    );
    expect(report.dimensions.find((dimension) => dimension.dimension === "scopes")?.state).toBe(
      "missing_both",
    );
  });

  it("does not manufacture identity debt for an unauthenticated operation", () => {
    expect(reconcileGatewayIdentity(AuthRequirement.parse({ type: "none" }), [])).toEqual({
      status: "not_applicable",
      dimensions: [],
      findings: [],
    });
  });

  it("blocks anonymous contract access when applicable exact gateway identity exists", () => {
    const evidence = [
      {
        coordinate: coordinate("/proxies/0/identity/issuer"),
        basis: "explicit_configuration" as const,
        operationRef: "GET /accounts",
        issuer: "https://identity.example.com/",
      },
    ];
    const blocked = reconcileGatewayIdentity(AuthRequirement.parse({ type: "none" }), evidence, {
      operationRef: "GET /accounts",
    });
    expect(blocked).toMatchObject({
      status: "blocked",
      dimensions: [
        {
          dimension: "type",
          state: "contradictory",
          contractValue: "none",
        },
      ],
      findings: [
        {
          code: "identity/anonymous_contract",
          severity: "error",
          state: "contradictory",
          coordinates: [evidence[0]?.coordinate],
        },
      ],
    });

    expect(
      reconcileGatewayIdentity(AuthRequirement.parse({ type: "none" }), evidence, {
        operationRef: "GET /unrelated",
      }).status,
    ).toBe("not_applicable");
  });

  it("treats AIR's default empty scopes as unknown, not proven empty", () => {
    const report = reconcileGatewayIdentity(AuthRequirement.parse({ type: "jwt_bearer" }), [
      {
        coordinate: coordinate("/plugins/0"),
        basis: "explicit_configuration",
        scopes: [],
      },
    ]);
    expect(report.dimensions.find((dimension) => dimension.dimension === "scopes")?.state).toBe(
      "missing_contract",
    );
  });

  it("never aggregates operation-specific scopes across routes", () => {
    const readContract = AuthRequirement.parse({
      type: "jwt_bearer",
      scopes: ["payments.read"],
    });
    const evidence = [
      {
        coordinate: coordinate("/routes/0/plugins/0"),
        basis: "explicit_configuration" as const,
        operationRef: "payments.get",
        scopes: ["payments.read"],
      },
      {
        coordinate: coordinate("/routes/1/plugins/0"),
        basis: "explicit_configuration" as const,
        operationRef: "payments.refund",
        scopes: ["payments.write"],
      },
    ];
    const targeted = reconcileGatewayIdentity(readContract, evidence, {
      operationRef: "payments.get",
    });
    expect(targeted.dimensions.find((dimension) => dimension.dimension === "scopes")?.state).toBe(
      "match",
    );

    const untargeted = reconcileGatewayIdentity(readContract, evidence);
    expect(untargeted.dimensions.find((dimension) => dimension.dimension === "scopes")?.state).toBe(
      "missing_gateway",
    );
  });

  it("does not let a configured plugin name masquerade as exact identity configuration", () => {
    const result = GatewayIdentityEvidence.safeParse({
      coordinate: coordinate("/plugins/0"),
      basis: "configured_plugin_type",
      type: "jwt_bearer",
      issuer: "https://issuer.example.com/",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/issuer requires explicit_configuration/);
  });
});
