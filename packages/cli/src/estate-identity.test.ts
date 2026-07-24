import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, type GatewayIdentityEvidence } from "@anvil/compiler";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runAnvilCli } from "./anvil-cli.js";
import { gatewayIdentityDiagnostics } from "./commands/estate.js";
import { bufferIO } from "./io.js";

const SPEC = `openapi: 3.0.3
info: { title: Payments, version: 1.0.0 }
paths:
  /payments/{id}:
    get:
      operationId: getPayment
      parameters:
        - { in: path, name: id, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
`;

describe("gateway import identity diagnostics", () => {
  it("turns a cited issuer contradiction into a blocking import diagnostic", async () => {
    const air = await compile({
      spec: SPEC,
      serviceId: "payments",
      manifest: `operations:
  getPayment:
    state: approved
    auth:
      type: jwt_bearer
      issuer: https://contract-id.example.com/
`,
    });
    const evidence: GatewayIdentityEvidence[] = [
      {
        coordinate: { origin: "kong.yaml", pointer: "/services/0/plugins/0/config/issuer" },
        basis: "explicit_configuration",
        operationRef: "getPayment",
        type: "jwt_bearer",
        issuer: "https://gateway-id.example.com/",
        carrier: { in: "header", name: "Authorization", scheme: "Bearer" },
      },
    ];
    const diagnostics = gatewayIdentityDiagnostics(air.operations, evidence);
    const issuer = diagnostics.find((diagnostic) =>
      diagnostic.message.includes("issuer conflicts"),
    );
    expect(issuer).toMatchObject({
      level: "error",
      code: "gateway/identity_contradictory",
      coordinate: evidence[0]?.coordinate,
    });
  });

  it("makes missing bank-grade identity dimensions blocking in strict mode", async () => {
    const air = await compile({
      spec: SPEC,
      serviceId: "payments",
      manifest: `operations:
  getPayment:
    state: approved
    auth:
      type: jwt_bearer
      principal: end_user
      issuer: https://identity.example.com/
      audience: api://payments
      carrier: { in: header, name: Authorization, scheme: Bearer }
      scopes: [payments:read]
`,
    });
    const scopesOnly: GatewayIdentityEvidence[] = [
      {
        coordinate: { origin: "wso2/api.yaml", pointer: "/data/operations/0/scopes" },
        basis: "explicit_configuration",
        operationRef: "getPayment",
        type: "jwt_bearer",
        scopes: ["payments:read"],
      },
    ];

    expect(
      gatewayIdentityDiagnostics(air.operations, scopesOnly).filter(
        (diagnostic) => diagnostic.code === "gateway/identity_missing_gateway",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "warning", message: expect.stringContaining("issuer") }),
      ]),
    );
    const strict = gatewayIdentityDiagnostics(air.operations, scopesOnly, { strict: true });
    for (const dimension of ["principal", "issuer", "audience", "carrier"]) {
      expect(strict).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "error",
            code: "gateway/identity_missing_gateway",
            message: expect.stringContaining(dimension),
          }),
        ]),
      );
    }
  });

  it("blocks a real estate import when adapter-emitted issuer evidence contradicts the contract", async () => {
    const work = mkdtempSync(join(tmpdir(), "anvil-estate-identity-"));
    try {
      const gateway = join(work, "kong.yaml");
      const spec = join(work, "refunds.openapi.yaml");
      const manifest = join(work, "anvil.yaml");
      const out = join(work, "bundle");
      writeFileSync(
        gateway,
        `_format_version: "3.0"
services:
  - name: refunds
    routes:
      - name: refunds-route
        paths: ["/refunds/{id}"]
        methods: ["GET"]
    plugins:
      - name: openid-connect
        config:
          issuer: https://gateway-issuer.example.com/
          audience: api://refunds
          token_endpoint: https://unrelated-sts.example.com/oauth/token
          scopes: [refunds:read]
`,
      );
      writeFileSync(
        spec,
        `openapi: 3.0.3
info: { title: Refunds, version: 1.0.0 }
components:
  securitySchemes:
    oidc:
      type: oauth2
      flows:
        clientCredentials:
          tokenUrl: https://contract-sts.example.com/oauth/token
          scopes: { "refunds:read": Read refunds }
security:
  - oidc: [refunds:read]
paths:
  /refunds/{id}:
    get:
      operationId: fetchRefund
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
`,
      );
      writeFileSync(
        manifest,
        `operations:
  fetchRefund:
    auth:
      type: oauth2_client_credentials
      principal: service
      issuer: https://contract-issuer.example.com/
      audience: api://refunds
      carrier: { in: header, name: Authorization, scheme: Bearer }
`,
      );
      const io = bufferIO();
      const code = await runAnvilCli(
        [
          "estate",
          "import",
          gateway,
          "--vendor",
          "kong",
          "--api",
          "refunds",
          "--gateway-id",
          "bank-kong-prod",
          "--strict-identity",
          "--spec",
          spec,
          "--manifest",
          manifest,
          "--gateway-url",
          "https://gateway.example.com",
          "--root",
          work,
          "--out",
          out,
          "--json",
        ],
        { io },
      );
      expect(code).toBe(1);
      const report = JSON.parse(io.stdout.join("\n"));
      expect(report.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "error",
            code: "gateway/identity_contradictory",
            coordinate: expect.objectContaining({
              pointer: "/services/0/plugins/0/config/issuer",
            }),
          }),
        ]),
      );
      expect(JSON.stringify(report.diagnostics)).not.toContain("unrelated-sts");
      const air = parseYaml(readFileSync(join(out, "air.yaml"), "utf8"));
      expect(air.operations[0]).toMatchObject({ state: "blocked" });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("blocks an anonymous contract when a normalized export has exact identity but no auth-policy label", async () => {
    const work = mkdtempSync(join(tmpdir(), "anvil-estate-anonymous-identity-"));
    try {
      const gateway = join(work, "apigee.yaml");
      const spec = join(work, "accounts.openapi.yaml");
      const out = join(work, "bundle");
      writeFileSync(
        gateway,
        `proxies:
  - name: accounts
    revision: "7"
    environments: ["prod"]
    basePath: /accounts
    identity:
      issuer: https://identity.example.com/
      audience: api://accounts
      principal: service
      carrier: { in: header, name: Authorization, scheme: Bearer }
    flows:
      - { method: GET, path: "/{id}" }
products: []
`,
      );
      writeFileSync(
        spec,
        `openapi: 3.0.3
info: { title: Accounts, version: 1.0.0 }
paths:
  /accounts/{id}:
    get:
      operationId: getAccount
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
`,
      );

      const io = bufferIO();
      const code = await runAnvilCli(
        [
          "estate",
          "import",
          gateway,
          "--vendor",
          "apigee",
          "--api",
          "accounts",
          "--gateway-id",
          "bank-apigee-prod",
          "--strict-identity",
          "--revision",
          "7",
          "--environment",
          "prod",
          "--spec",
          spec,
          "--gateway-url",
          "https://gateway.example.com",
          "--root",
          work,
          "--out",
          out,
          "--json",
        ],
        { io },
      );

      expect(code).toBe(1);
      const report = JSON.parse(io.stdout.join("\n"));
      expect(report.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "error",
            code: "gateway/identity_contradictory",
            coordinate: expect.objectContaining({
              pointer: "/proxies/0/identity/issuer",
            }),
            message: expect.stringMatching(/none|anonymous/i),
          }),
        ]),
      );
      const air = parseYaml(readFileSync(join(out, "air.yaml"), "utf8"));
      expect(air.operations[0]).toMatchObject({
        sourceRef: { operationId: "getAccount" },
        state: "blocked",
        auth: { type: "none" },
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
