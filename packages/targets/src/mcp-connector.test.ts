import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AirDocument } from "@anvil/air";
import { approveOperations, compile } from "@anvil/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createMcpConnectorConfig,
  looksLikeSecretValue,
  validateMcpConnectorConfig,
} from "./mcp-connector.js";

const read = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/payments/${rel}`, import.meta.url)),
    "utf8",
  );

let air: AirDocument;

beforeAll(async () => {
  const compiled = await compile({
    spec: read("openapi.yaml"),
    manifest: read("anvil.yaml"),
    serviceId: "payments",
  });
  air = approveOperations(
    compiled,
    compiled.operations.map((operation) => operation.id),
  );
});

function baseConfig(overrides: Parameters<typeof createMcpConnectorConfig>[0] = {}) {
  return createMcpConnectorConfig({
    httpEndpoint: "https://mcp.example.test/mcp",
    authMode: "oauth",
    oauth: {
      authorizationUrl: "https://idp.example.test/authorize",
      tokenUrl: "https://idp.example.test/token",
      scopes: ["api://anvil-mcp/mcp.invoke"],
      inboundIssuer: "https://idp.example.test/",
      inboundAudience: "api://anvil-mcp",
    },
    ...overrides,
  });
}

describe("looksLikeSecretValue", () => {
  it("accepts a plain environment-variable NAME", () => {
    expect(looksLikeSecretValue("ANVIL_OAUTH_CLIENT_SECRET")).toBe(false);
  });

  it("flags a JWT-shaped value", () => {
    expect(
      looksLikeSecretValue(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ),
    ).toBe(true);
  });

  it("flags a common API-key prefix", () => {
    expect(looksLikeSecretValue("sk-abcdefghijklmnopqrstuvwx")).toBe(true);
  });

  it("flags a PEM private key", () => {
    expect(looksLikeSecretValue("-----BEGIN PRIVATE KEY-----")).toBe(true);
  });

  it("flags a long high-entropy blob", () => {
    expect(looksLikeSecretValue("a".repeat(80))).toBe(true);
  });
});

describe("validateMcpConnectorConfig", () => {
  it("passes a well-formed oauth config", () => {
    const findings = validateMcpConnectorConfig(air, baseConfig());
    expect(findings.filter((f) => f.level === "error")).toEqual([]);
  });

  it("requires an https endpoint", () => {
    const findings = validateMcpConnectorConfig(
      air,
      baseConfig({ httpEndpoint: "http://insecure.test/mcp" }),
    );
    expect(findings).toContainEqual(expect.objectContaining({ code: "target/insecure_transport" }));
  });

  it("rejects a private/local endpoint host", () => {
    const findings = validateMcpConnectorConfig(
      air,
      baseConfig({ httpEndpoint: "https://localhost/mcp" }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "target/non_public_endpoint" }),
    );
  });

  it("requires oauth fields when server auth is oauth", () => {
    const findings = validateMcpConnectorConfig(
      air,
      createMcpConnectorConfig({ httpEndpoint: "https://mcp.example.test/mcp", authMode: "oauth" }),
    );
    const codes = findings.map((f) => f.code);
    expect(codes).toContain("target/missing_connector_oauth_authorization_url");
    expect(codes).toContain("target/missing_connector_oauth_token_url");
    expect(codes).toContain("target/missing_connector_oauth_scope");
    expect(codes).toContain("target/missing_inbound_issuer");
    expect(codes).toContain("target/missing_inbound_audience");
  });

  it("warns (does not error) on an explicit no-auth server", () => {
    const findings = validateMcpConnectorConfig(
      air,
      createMcpConnectorConfig({ httpEndpoint: "https://mcp.example.test/mcp", authMode: "none" }),
    );
    expect(findings.filter((f) => f.level === "error")).toEqual([]);
    expect(findings).toContainEqual(
      expect.objectContaining({ level: "warning", code: "target/unauthenticated_mcp" }),
    );
  });

  it("refuses a literal secret value passed where an env-var NAME belongs", () => {
    const findings = validateMcpConnectorConfig(
      air,
      baseConfig({ oauth: { clientSecretEnvVar: "sk-abcdefghijklmnopqrstuvwx" } }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "target/embedded_secret_value" }),
    );
  });

  it("accepts an env-var NAME for client credentials", () => {
    const findings = validateMcpConnectorConfig(
      air,
      baseConfig({
        oauth: {
          clientIdEnvVar: "ANVIL_OAUTH_CLIENT_ID",
          clientSecretEnvVar: "ANVIL_OAUTH_CLIENT_SECRET",
        },
      }),
    );
    expect(findings.filter((f) => f.code === "target/embedded_secret_value")).toEqual([]);
  });
});
