import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-estate-support-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function anvil(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io });
  return {
    code,
    out: io.stdout.join("\n"),
    err: io.stderr.join("\n"),
  };
}

describe("anvil estate support", () => {
  it("emits one stable machine-readable registry without equating semantics with ingestion", async () => {
    const result = await anvil("estate", "support", "--json");
    expect(result.code, result.err).toBe(0);
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({
      schemaVersion: 1,
      reportType: "anvil.gateway-support",
      registryVersion: "1.0.0",
    });
    expect(report.contracts).toHaveLength(6);
    expect(
      Object.fromEntries(
        report.contracts.map((contract: { vendor: string; releaseTier: string }) => [
          contract.vendor,
          contract.releaseTier,
        ]),
      ),
    ).toEqual({
      kong: "native_single_artifact",
      wso2: "native_estate",
      apigee: "normalized_interchange",
      mulesoft: "normalized_interchange",
      api_connect: "normalized_interchange",
      mashery: "research_only",
    });
  });

  it("renders candid per-vendor binding, proof, and research boundaries", async () => {
    const wso2 = await anvil("estate", "support", "wso2");
    expect(wso2.code).toBe(0);
    expect(wso2.out).toContain("WSO2 API Manager — native estate");
    expect(wso2.out).toContain("single_embedded_digest_or_receipt_attestation");
    expect(wso2.out).toContain("synthetic_native_shape; 1000 APIs");
    expect(wso2.out).toContain("not a captured production estate");

    const apigee = await anvil("estate", "support", "apigee");
    expect(apigee.code).toBe(0);
    expect(apigee.out).toContain("Apigee — normalized interchange");
    expect(apigee.out).toContain("native apiproxy XML");
    expect(apigee.out).toContain("synthetic_normalized");

    const mashery = await anvil("estate", "support", "mashery");
    expect(mashery.code).toBe(0);
    expect(mashery.out).toContain("Mashery (Boomi Cloud API Management) — research only");
    expect(mashery.out).toContain("No input is accepted by estate inventory/import.");
    expect(mashery.out).toContain("No Mashery ingestion or estate-scale claim exists.");
  });

  it("returns a structured error for an unknown support vendor", async () => {
    const result = await anvil("estate", "support", "tyk", "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      reportType: "anvil.gateway-support-error",
      code: "gateway_support/unknown_vendor",
    });
  });
});

describe("unsupported native gateway artifact diagnostics", () => {
  it("recognizes an Apigee apiproxy bundle before offering a misleading --entry path", async () => {
    const archive = join(work, "orders-apigee.zip");
    writeFileSync(
      archive,
      zipSync({
        "orders/apiproxy/proxies/default.xml": strToU8(
          '<ProxyEndpoint name="default"><HTTPProxyConnection /></ProxyEndpoint>',
        ),
        "orders/apiproxy/policies/verify-key.xml": strToU8('<VerifyAPIKey name="verify-key" />'),
      }),
    );
    const result = await anvil("estate", "inventory", archive, "--vendor", "apigee", "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      code: "gateway/unsupported_native_artifact",
      message: expect.stringContaining("Native Apigee apiproxy XML"),
    });
    expect(result.out).not.toContain("pick one with --entry");
  });

  it("recognizes a Mule application JAR before treating mule-artifact.json as interchange", async () => {
    const archive = join(work, "orders-mule.jar");
    writeFileSync(
      archive,
      zipSync({
        "mule-artifact.json": strToU8('{"minMuleVersion":"4.6.0"}'),
        "src/main/mule/orders.xml": strToU8('<mule><flow name="orders" /></mule>'),
      }),
    );
    const result = await anvil("estate", "inventory", archive, "--vendor", "mulesoft", "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      code: "gateway/unsupported_native_artifact",
      message: expect.stringContaining("Native Mule application JAR/project structure"),
    });
  });

  it("recognizes native IBM x-ibm-configuration without rejecting normalized API Connect input", async () => {
    const native = join(work, "orders-ibm.yaml");
    writeFileSync(
      native,
      `openapi: 3.0.0
info: { title: Orders, version: "1" }
paths: {}
x-ibm-configuration:
  gateway: datapower-api-gateway
  assembly: { execute: [] }
`,
    );
    const refused = await anvil("estate", "inventory", native, "--vendor", "api_connect", "--json");
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.out)).toMatchObject({
      code: "gateway/unsupported_native_artifact",
      message: expect.stringContaining("x-ibm-configuration"),
    });

    const normalized = join(work, "orders-normalized.yaml");
    writeFileSync(
      normalized,
      `apis:
  - name: orders
    resources: [{ method: GET, path: /orders }]
products: []
`,
    );
    const accepted = await anvil(
      "estate",
      "inventory",
      normalized,
      "--vendor",
      "api_connect",
      "--json",
    );
    expect(accepted.code, accepted.err || accepted.out).toBe(0);
    expect(JSON.parse(accepted.out).apis).toEqual([expect.objectContaining({ id: "orders" })]);
  });

  it("recognizes x-ibm inside a multi-document native archive before offering --entry", async () => {
    const archive = join(work, "orders-ibm.zip");
    writeFileSync(
      archive,
      zipSync({
        "orders-product.yaml": strToU8(`product: 1.0.0
info: { name: orders-product, version: "1" }
apis: { orders: { $ref: orders-api.yaml } }
plans: {}
`),
        "orders-api.yaml": strToU8(`openapi: 3.0.0
info: { title: Orders, version: "1" }
paths: {}
x-ibm-configuration: { gateway: datapower-api-gateway }
`),
      }),
    );
    const result = await anvil("estate", "inventory", archive, "--vendor", "api_connect", "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      code: "gateway/unsupported_native_artifact",
    });
    expect(result.out).not.toContain("pick one with --entry");
  });
});
