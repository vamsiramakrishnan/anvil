import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

const MULTI_COORDINATE_APIGEE = `proxies:
  - name: orders
    revision: v1
    environments: [prod]
    basePath: /orders
    flows: [{ name: listOrders, method: GET, path: / }]
  - name: orders
    revision: v1
    environments: [test]
    basePath: /orders
    flows: [{ name: listOrders, method: GET, path: / }]
  - name: orders
    revision: v2
    environments: [prod]
    basePath: /orders
    flows: [{ name: listOrders, method: GET, path: / }]
  - name: orders
    revision: v2
    environments: [test]
    basePath: /orders
    flows: [{ name: listOrders, method: GET, path: / }]
products: []
`;

const ORDERS_OPENAPI = `openapi: "3.0.3"
info: { title: Orders, version: "1.0.0" }
paths:
  /orders:
    post:
      operationId: createOrder
      responses: { "200": { description: ok } }
`;

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-estate-identity-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function estate(...args: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(["estate", ...args], { io });
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

describe("gateway estate identity", () => {
  it("requires explicit coordinates and never overwrites another environment, revision, or gateway", async () => {
    const source = join(work, "apigee.yaml");
    const out = join(work, "orders");
    writeFileSync(source, MULTI_COORDINATE_APIGEE);

    const ambiguous = await estate(
      "import",
      source,
      "--vendor",
      "apigee",
      "--api",
      "orders",
      "--gateway-id",
      "apigee-org-a",
      "--strict-identity",
      "--root",
      work,
      "--out",
      out,
    );
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain("gateway_selection/revision_required");

    const baselineArgs = [
      "import",
      source,
      "--vendor",
      "apigee",
      "--api",
      "orders",
      "--revision",
      "v1",
      "--environment",
      "prod",
      "--gateway-id",
      "apigee-org-a",
      "--strict-identity",
      "--root",
      work,
      "--out",
      out,
      "--json",
    ];
    const baseline = await estate(...baselineArgs);
    expect(baseline.code, `${baseline.err}\n${baseline.out}`).toBe(0);
    const report = JSON.parse(baseline.out);
    expect(report.receipt.identity).toMatchObject({
      vendor: "apigee",
      gatewayId: "apigee-org-a",
      gatewayIdSource: "operator",
      apiId: "orders",
      serviceId: expect.stringMatching(/^orders-prod-v1-[0-9a-f]{16}$/),
      environment: "prod",
      revision: "v1",
      exportDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      inventoryDigest: expect.any(String),
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    const statusIo = bufferIO();
    await runAnvilCli(["status", out, "--json"], { io: statusIo });
    expect(JSON.parse(statusIo.stdout.join("\n")).gatewayImport).toMatchObject({
      state: "bound",
      importId: report.receipt.importId,
      identity: {
        digest: report.receipt.identity.digest,
        lineageDigest: report.receipt.identity.lineageDigest,
        environment: "prod",
        revision: "v1",
      },
      verifyCommand: expect.stringContaining("anvil estate verify"),
    });
    const originalView = readFileSync(join(out, "import.receipt.json"));
    const prodGeneration = JSON.parse(readFileSync(join(out, "generation.json"), "utf8"));
    expect(prodGeneration.resourceOptions.deploymentNamespace).toMatch(
      /^orders-prod-v1-[0-9a-f]{16}-[0-9a-f]{24}$/,
    );

    const testOut = join(work, "orders-test");
    const testImport = await estate(
      "import",
      source,
      "--vendor",
      "apigee",
      "--api",
      "orders",
      "--revision",
      "v1",
      "--environment",
      "test",
      "--gateway-id",
      "apigee-org-a",
      "--strict-identity",
      "--root",
      work,
      "--out",
      testOut,
      "--json",
    );
    expect(testImport.code, `${testImport.err}\n${testImport.out}`).toBe(0);
    const testGeneration = JSON.parse(
      readFileSync(join(testOut, "generation.json"), "utf8"),
    );
    expect(testGeneration.resourceOptions.deploymentNamespace).toMatch(
      /^orders-test-v1-[0-9a-f]{16}-[0-9a-f]{24}$/,
    );
    expect(testGeneration.resourceOptions.deploymentNamespace).not.toBe(
      prodGeneration.resourceOptions.deploymentNamespace,
    );
    expect(readFileSync(join(testOut, "deploy/cloudbuild.yaml"), "utf8")).not.toBe(
      readFileSync(join(out, "deploy/cloudbuild.yaml"), "utf8"),
    );

    for (const replacement of [
      ["--revision", "v1", "--environment", "test", "--gateway-id", "apigee-org-a"],
      ["--revision", "v2", "--environment", "prod", "--gateway-id", "apigee-org-a"],
      ["--revision", "v1", "--environment", "prod", "--gateway-id", "apigee-org-b"],
    ]) {
      const attempted = await estate(
        "import",
        source,
        "--vendor",
        "apigee",
        "--api",
        "orders",
        ...replacement,
        "--strict-identity",
        "--root",
        work,
        "--out",
        out,
        "--json",
      );
      expect(attempted.code).toBe(1);
      expect(JSON.parse(attempted.out).diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "gateway_receipt/output_identity_collision",
          }),
        ]),
      );
      expect(readFileSync(join(out, "import.receipt.json"))).toEqual(originalView);
    }

    writeFileSync(
      source,
      MULTI_COORDINATE_APIGEE.replace(
        "products: []",
        `  - name: reporting
    revision: v9
    environments: [prod]
    basePath: /reports
    flows: [{ name: listReports, method: GET, path: / }]
products: []`,
      ),
    );
    const changedEstate = await estate(...baselineArgs);
    expect(changedEstate.code).toBe(1);
    expect(JSON.parse(changedEstate.out).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "gateway_receipt/evidence_transition_requires_replace",
        }),
      ]),
    );
    expect(readFileSync(join(out, "import.receipt.json"))).toEqual(originalView);

    const transitioned = await estate(...baselineArgs, "--replace-derived");
    expect(transitioned.code, `${transitioned.err}\n${transitioned.out}`).toBe(0);
    const transitionedIdentity = JSON.parse(transitioned.out).receipt.identity;
    expect(transitionedIdentity.digest).toBe(report.receipt.identity.digest);
    expect(transitionedIdentity.lineageDigest).not.toBe(report.receipt.identity.lineageDigest);
    expect(existsSync(out)).toBe(true);
  });

  it("marks compatibility identity unscoped and lets strict workflows fail closed", async () => {
    const source = join(work, "apigee.yaml");
    const out = join(work, "orders");
    writeFileSync(source, MULTI_COORDINATE_APIGEE);

    const strict = await estate(
      "import",
      source,
      "--vendor",
      "apigee",
      "--api",
      "orders",
      "--revision",
      "v1",
      "--environment",
      "prod",
      "--strict-identity",
      "--root",
      work,
      "--out",
      out,
    );
    expect(strict.code).toBe(1);
    expect(strict.err).toContain("--gateway-id");
    expect(existsSync(out)).toBe(false);

    const spoofed = await estate(
      "import",
      source,
      "--vendor",
      "apigee",
      "--api",
      "orders",
      "--revision",
      "v1",
      "--environment",
      "prod",
      "--gateway-id",
      " UnScOpEd ",
      "--strict-identity",
      "--root",
      work,
      "--out",
      out,
      "--json",
    );
    expect(spoofed.code).toBe(1);
    expect(JSON.parse(spoofed.out)).toMatchObject({
      code: "gateway_selection/invalid_gateway_id",
    });
    expect(spoofed.out).toContain("reserved");
    expect(existsSync(out)).toBe(false);

    const compatible = await estate(
      "import",
      source,
      "--vendor",
      "apigee",
      "--api",
      "orders",
      "--revision",
      "v1",
      "--environment",
      "prod",
      "--root",
      work,
      "--out",
      out,
      "--json",
    );
    expect(compatible.code).toBe(0);
    const report = JSON.parse(compatible.out);
    expect(report.receipt.identity).toMatchObject({
      gatewayId: "unscoped",
      gatewayIdSource: "unscoped",
    });
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "gateway/unscoped_gateway_identity" }),
      ]),
    );
  });

  it("reserves unscoped as an absence sentinel across estate control commands", async () => {
    const source = join(work, "apigee.yaml");
    writeFileSync(source, MULTI_COORDINATE_APIGEE);

    for (const command of ["inventory", "audit", "plan"]) {
      const result = await estate(
        command,
        source,
        "--vendor",
        "apigee",
        "--gateway-id",
        " UNSCOPED ",
        "--json",
      );
      expect(result.code, `${command}: ${result.err}\n${result.out}`).toBe(1);
      expect(JSON.parse(result.out)).toMatchObject({ code: "estate/invalid_gateway_id" });
      expect(result.out).toContain("reserved");
    }
  });

  it("refuses in-place approval and binds reviewed state through manifest re-import", async () => {
    const source = join(work, "apigee.yaml");
    const spec = join(work, "orders.openapi.yaml");
    const manifest = join(work, "orders.review.yaml");
    const out = join(work, "orders");
    writeFileSync(
      source,
      `proxies:
  - name: orders
    revision: v1
    environments: [prod]
    basePath: /orders
    flows: [{ name: createOrder, method: POST, path: / }]
products: []
`,
    );
    writeFileSync(spec, ORDERS_OPENAPI);
    const importArgs = [
      "import",
      source,
      "--vendor",
      "apigee",
      "--api",
      "orders",
      "--revision",
      "v1",
      "--environment",
      "prod",
      "--gateway-id",
      "apigee-org-a",
      "--strict-identity",
      "--spec",
      spec,
      "--gateway-url",
      "https://gateway.example.test",
      "--root",
      work,
      "--out",
      out,
      "--json",
    ];
    const imported = await estate(...importArgs);
    expect(imported.code, `${imported.err}\n${imported.out}`).toBe(0);
    const firstReport = JSON.parse(imported.out);
    const air = JSON.parse(readFileSync(join(out, "air.json"), "utf8"));
    const operation = air.operations.find(
      (candidate: { sourceRef?: { operationId?: string } }) =>
        candidate.sourceRef?.operationId === "createOrder",
    );
    expect(operation).toMatchObject({ state: "review_required" });
    const boundView = readFileSync(join(out, "import.receipt.json"));

    const approveIo = bufferIO();
    const approveCode = await runAnvilCli(["approve", out, operation.id], {
      io: approveIo,
    });
    expect(approveCode).toBe(1);
    expect(approveIo.stderr.join("\n")).toContain("immutable gateway receipt");
    expect(approveIo.stderr.join("\n")).toContain("--manifest <review.yaml>");
    expect(readFileSync(join(out, "import.receipt.json"))).toEqual(boundView);

    writeFileSync(
      manifest,
      `operations:
  createOrder:
    description: Create one reviewed order through the selected gateway coordinate.
    side_effect: mutation
    risk: high
    reversible: false
    idempotency:
      strategy: required_request_key
      key_location: header
      header: Idempotency-Key
    confirmation:
      required: true
      risk: high
      reason: The operator reviewed the gateway-backed order mutation.
    retries:
      enabled: true
      only_on: [timeout, "429", "503"]
      max_attempts: 3
    state: approved
`,
    );
    const reviewed = await estate(...importArgs, "--manifest", manifest);
    expect(reviewed.code, `${reviewed.err}\n${reviewed.out}`).toBe(0);
    const reviewedReport = JSON.parse(reviewed.out);
    expect(reviewedReport.receipt.importId).not.toBe(firstReport.receipt.importId);
    expect(reviewedReport.receipt.identity.digest).toBe(firstReport.receipt.identity.digest);
    expect(JSON.parse(readFileSync(join(out, "import.receipt.json"), "utf8")).lineage).toEqual({
      status: "bound",
    });
    expect(
      JSON.parse(readFileSync(join(out, "air.json"), "utf8")).operations.find(
        (candidate: { sourceRef?: { operationId?: string } }) =>
          candidate.sourceRef?.operationId === "createOrder",
      ),
    ).toMatchObject({ state: "approved" });
  });
});
