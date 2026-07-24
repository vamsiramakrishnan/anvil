import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type GatewayApiSummary, type GatewayImportReceipt, gatewaySha256 } from "@anvil/compiler";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

interface CliResult {
  code: number;
  out: string;
  err: string;
}

interface ProjectOptions {
  definitions?: Record<string, Uint8Array>;
  mtime?: Date;
  supportingFiles?: number;
}

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-wso2-formal-lineage-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function estate(...args: string[]): Promise<CliResult> {
  const io = bufferIO();
  const code = await runAnvilCli(["estate", ...args], { io });
  return {
    code,
    out: io.stdout.join("\n"),
    err: io.stderr.join("\n"),
  };
}

function parseJson<T = Record<string, unknown>>(result: CliResult): T {
  expect(result.out.trim()).not.toBe("");
  return JSON.parse(result.out) as T;
}

function apiYaml(): string {
  return `type: api
version: v4.2.0
data:
  name: Orders
  context: /orders
  version: "1.0.0"
  provider: platform-team
  isRevision: true
  revisionId: 3
  operations:
    - target: /{id}
      verb: GET
`;
}

function deploymentEnvironmentsYaml(): string {
  return `type: deployment_environments
version: v4.2.0
data:
  - deploymentEnvironment: Prod
`;
}

function openApi(description = "ok"): string {
  return `openapi: 3.0.3
info:
  title: Orders
  version: 1.0.0
paths:
  /orders/{id}:
    get:
      operationId: getOrder
      responses:
        "200": { description: ${description} }
`;
}

function swagger(): string {
  return `swagger: "2.0"
info:
  title: Orders
  version: 1.0.0
paths:
  /orders/{id}:
    get:
      operationId: getOrderSwagger
      responses:
        "200": { description: ok }
`;
}

function projectMembers(options: ProjectOptions = {}): Record<string, Uint8Array> {
  const root = "Orders-1.0.0";
  const definitions =
    options.definitions === undefined
      ? { "Definitions/openapi.yaml": strToU8(openApi()) }
      : options.definitions;
  const members: Record<string, Uint8Array> = {
    [`${root}/api.yaml`]: strToU8(apiYaml()),
    [`${root}/deployment_environments.yaml`]: strToU8(deploymentEnvironmentsYaml()),
  };
  for (const [path, bytes] of Object.entries(definitions)) {
    members[`${root}/${path}`] = bytes;
  }
  for (let index = 0; index < (options.supportingFiles ?? 0); index += 1) {
    members[`${root}/Docs/evidence-${String(index).padStart(5, "0")}.txt`] = strToU8("x");
  }
  return members;
}

function projectZip(options: ProjectOptions = {}): Uint8Array {
  return zipSync(projectMembers(options), {
    level: 0,
    mtime: options.mtime ?? new Date("2020-01-01T00:00:00.000Z"),
  });
}

function writeExtractedProject(root: string, options: ProjectOptions = {}): void {
  for (const [path, bytes] of Object.entries(projectMembers(options))) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
}

function importArgs(source: string, output: string, spec?: string, extra: string[] = []): string[] {
  return [
    "import",
    source,
    "--vendor",
    "wso2",
    "--gateway-id",
    "bank-wso2",
    "--api",
    "Orders",
    "--api-version",
    "1.0.0",
    "--revision",
    "revision-3",
    "--environment",
    "Prod",
    ...(spec ? ["--spec", spec, "--gateway-url", "https://gateway.example.test"] : []),
    "--root",
    work,
    "--out",
    output,
    "--json",
    ...extra,
  ];
}

function privateReceipt(report: { receipt: { directory: string } }): GatewayImportReceipt {
  return JSON.parse(
    readFileSync(join(report.receipt.directory, "import.receipt.json"), "utf8"),
  ) as GatewayImportReceipt;
}

describe("WSO2 supplied-contract lineage", () => {
  it("binds exact bytes from a direct project ZIP and records a redacted receipt view", async () => {
    const archive = join(work, "Orders_1.0.0_Revision-3.zip");
    const spec = join(work, "orders-openapi.yaml");
    const output = join(work, "bundle");
    const specBytes = strToU8(openApi());
    writeFileSync(archive, projectZip({ definitions: { "Definitions/openapi.yaml": specBytes } }));
    writeFileSync(spec, specBytes);

    const imported = await estate(...importArgs(archive, output, spec));
    expect(imported.code, imported.err || imported.out).toBe(0);
    const report = parseJson<{ receipt: { directory: string } }>(imported);
    const receipt = privateReceipt(report);
    expect(receipt.contract.formalDefinitionLineage).toMatchObject({
      mode: "embedded_digest_match",
      candidates: [
        {
          role: "formal_definition",
          path: "Orders-1.0.0/Definitions/openapi.yaml",
          digest: gatewaySha256(specBytes),
        },
      ],
      supplied: { digest: gatewaySha256(specBytes) },
    });
    expect(receipt.contract.formalDefinitionLineage.override).toBeUndefined();

    const view = JSON.parse(readFileSync(join(output, "import.receipt.json"), "utf8"));
    expect(view.contract.formalDefinitionLineage).toMatchObject({
      mode: "embedded_digest_match",
      supplied: { digest: gatewaySha256(specBytes) },
    });
    expect(view.contract.formalDefinitionLineage.override).toBeUndefined();
  });

  it("rejects a route-compatible byte mismatch unless the operator explicitly attests it", async () => {
    const archive = join(work, "Orders.zip");
    const supplied = join(work, "route-compatible.yaml");
    writeFileSync(archive, projectZip());
    writeFileSync(supplied, openApi("same route, different contract bytes"));

    const rejected = await estate(...importArgs(archive, join(work, "rejected"), supplied));
    expect(rejected.code).toBe(1);
    expect(parseJson(rejected)).toMatchObject({
      reportType: "anvil.gateway-estate-import-error",
      code: "gateway/formal_definition_digest_mismatch",
      output: { created: false },
      receipt: { created: false },
    });

    const accepted = await estate(
      ...importArgs(archive, join(work, "overridden"), supplied, [
        "--attest-spec-override",
        "The reviewed source-of-truth contract lives outside this apictl package.",
      ]),
    );
    expect(accepted.code, accepted.err || accepted.out).toBe(0);
    const report = parseJson<{ receipt: { directory: string } }>(accepted);
    const receipt = privateReceipt(report);
    expect(receipt.contract.formalDefinitionLineage).toMatchObject({
      mode: "operator_override",
      override: {
        attestation: "operator",
        reason: "The reviewed source-of-truth contract lives outside this apictl package.",
      },
    });
    const view = JSON.parse(readFileSync(join(work, "overridden", "import.receipt.json"), "utf8"));
    expect(view.contract.formalDefinitionLineage.override).toMatchObject({
      attestation: "operator",
      reasonDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(view)).not.toContain("reviewed source-of-truth");
  });

  it("supports extracted projects, keeps no-spec imports route-only, and fails closed on zero or multiple candidates", async () => {
    const exactCollection = join(work, "exact-collection");
    const exactSpec = join(work, "exact.yaml");
    writeExtractedProject(exactCollection);
    writeFileSync(exactSpec, openApi());

    const exact = await estate(
      ...importArgs(exactCollection, join(work, "exact-bundle"), exactSpec),
    );
    expect(exact.code, exact.err || exact.out).toBe(0);
    expect(
      privateReceipt(parseJson<{ receipt: { directory: string } }>(exact)).contract
        .formalDefinitionLineage,
    ).toMatchObject({ mode: "embedded_digest_match" });

    const routeOnly = await estate(...importArgs(exactCollection, join(work, "route-only")));
    expect(routeOnly.code, routeOnly.err || routeOnly.out).toBe(0);
    expect(
      privateReceipt(parseJson<{ receipt: { directory: string } }>(routeOnly)).contract
        .formalDefinitionLineage,
    ).toBeUndefined();

    const none = join(work, "none.zip");
    writeFileSync(none, projectZip({ definitions: {} }));
    const missing = await estate(...importArgs(none, join(work, "missing"), exactSpec));
    expect(missing.code).toBe(1);
    expect(parseJson(missing)).toMatchObject({
      code: "gateway/formal_definition_missing",
      output: { created: false },
      receipt: { created: false },
    });
    const missingOverride = await estate(
      ...importArgs(none, join(work, "missing-override"), exactSpec, [
        "--attest-spec-override",
        "The project intentionally delegates its reviewed contract to the central registry.",
      ]),
    );
    expect(missingOverride.code, missingOverride.err || missingOverride.out).toBe(0);
    expect(
      privateReceipt(parseJson<{ receipt: { directory: string } }>(missingOverride)).contract
        .formalDefinitionLineage,
    ).toMatchObject({ mode: "operator_override", candidates: [] });

    const multiple = join(work, "multiple.zip");
    writeFileSync(
      multiple,
      projectZip({
        definitions: {
          "Definitions/openapi.yaml": strToU8(openApi()),
          "Definitions/swagger.yaml": strToU8(swagger()),
        },
      }),
    );
    const ambiguous = await estate(...importArgs(multiple, join(work, "ambiguous"), exactSpec));
    expect(ambiguous.code).toBe(1);
    expect(parseJson(ambiguous)).toMatchObject({
      code: "gateway/formal_definition_ambiguous",
      formalDefinitions: expect.arrayContaining([
        expect.objectContaining({ path: "Orders-1.0.0/Definitions/openapi.yaml" }),
        expect.objectContaining({ path: "Orders-1.0.0/Definitions/swagger.yaml" }),
      ]),
      output: { created: false },
      receipt: { created: false },
    });
    const multipleOverride = await estate(
      ...importArgs(multiple, join(work, "multiple-override"), exactSpec, [
        "--attest-spec-override",
        "Architecture review selected the OpenAPI document over the legacy Swagger copy.",
      ]),
    );
    expect(multipleOverride.code, multipleOverride.err || multipleOverride.out).toBe(0);
    expect(
      privateReceipt(parseJson<{ receipt: { directory: string } }>(multipleOverride)).contract
        .formalDefinitionLineage,
    ).toMatchObject({
      mode: "operator_override",
      candidates: [
        expect.objectContaining({ path: "Orders-1.0.0/Definitions/openapi.yaml" }),
        expect.objectContaining({ path: "Orders-1.0.0/Definitions/swagger.yaml" }),
      ],
    });
  });

  it("does not advertise invalid Definitions bytes or unsupported documents as formal contracts", async () => {
    for (const [name, bytes] of [
      ["invalid-utf8", new Uint8Array([0xff, 0xfe, 0xfd])],
      ["not-openapi", strToU8("kind: view-model\nfields: [title, subtitle]\n")],
    ] as const) {
      const archive = join(work, `${name}.zip`);
      writeFileSync(archive, projectZip({ definitions: { "Definitions/openapi.yaml": bytes } }));
      const inventoried = await estate(
        "inventory",
        archive,
        "--vendor",
        "wso2",
        "--gateway-id",
        "bank-wso2",
        "--json",
        "--all",
      );
      expect(inventoried.code).toBe(1);
      const inventory = parseJson<{
        apis: Array<{ artifacts: Array<{ role: string; path: string }> }>;
        diagnostics: Array<{ code: string; subject?: { artifact?: unknown } }>;
      }>(inventoried);
      expect(inventory.apis[0]?.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "uninterpreted",
            path: "Orders-1.0.0/Definitions/openapi.yaml",
          }),
        ]),
      );
      expect(inventory.apis[0]?.artifacts).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ role: "formal_definition" })]),
      );
      expect(inventory.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "wso2/invalid_formal_definition",
            subject: { artifact: expect.any(Object) },
          }),
        ]),
      );
      expect(inventory.diagnostics).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "wso2/formal_contract_available" }),
        ]),
      );
    }
  });

  it("keeps semantic inventory and plan identity stable when identical members are repacked", async () => {
    const first = join(work, "first", "Orders.zip");
    const second = join(work, "second", "Orders.zip");
    mkdirSync(dirname(first), { recursive: true });
    mkdirSync(dirname(second), { recursive: true });
    const firstBytes = projectZip({ mtime: new Date("2020-01-01T00:00:00.000Z") });
    const secondBytes = projectZip({ mtime: new Date("2024-06-01T12:34:56.000Z") });
    expect(gatewaySha256(firstBytes)).not.toBe(gatewaySha256(secondBytes));
    writeFileSync(first, firstBytes);
    writeFileSync(second, secondBytes);

    const firstInventory = await estate(
      "inventory",
      first,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--json",
      "--all",
    );
    const secondInventory = await estate(
      "inventory",
      second,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--json",
      "--all",
    );
    expect(firstInventory.code, firstInventory.err || firstInventory.out).toBe(0);
    expect(secondInventory.code, secondInventory.err || secondInventory.out).toBe(0);
    const firstReport = parseJson<{ digest: string; apis: GatewayApiSummary[] }>(firstInventory);
    const secondReport = parseJson<{ digest: string; apis: GatewayApiSummary[] }>(secondInventory);
    expect(secondReport.digest).toBe(firstReport.digest);
    const withoutPackaging = (api: GatewayApiSummary): unknown => ({
      ...api,
      artifacts: api.artifacts?.map((artifact) => ({
        kind: artifact.kind,
        role: artifact.role,
        path: artifact.path,
        origin: artifact.origin,
        digest: artifact.digest,
        bytes: artifact.bytes,
        ...(artifact.parent ? { parent: artifact.parent } : {}),
      })),
    });
    expect(withoutPackaging(secondReport.apis[0])).toEqual(withoutPackaging(firstReport.apis[0]));
    expect(firstReport.apis[0].artifacts[0].packaging.digest).not.toBe(
      secondReport.apis[0].artifacts[0].packaging.digest,
    );

    const firstPlanPath = join(work, "first-plan.json");
    const secondPlanPath = join(work, "second-plan.json");
    const firstPlan = await estate(
      "plan",
      first,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--out",
      firstPlanPath,
    );
    const secondPlan = await estate(
      "plan",
      second,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--out",
      secondPlanPath,
    );
    expect(firstPlan.code, firstPlan.err || firstPlan.out).toBe(0);
    expect(secondPlan.code, secondPlan.err || secondPlan.out).toBe(0);
    const firstPlanReport = JSON.parse(readFileSync(firstPlanPath, "utf8"));
    const secondPlanReport = JSON.parse(readFileSync(secondPlanPath, "utf8"));
    expect(secondPlanReport.apis[0].fingerprint).toBe(firstPlanReport.apis[0].fingerprint);

    const firstImported = await estate(...importArgs(first, join(work, "first-bundle")));
    const secondImported = await estate(...importArgs(second, join(work, "second-bundle")));
    expect(firstImported.code, firstImported.err || firstImported.out).toBe(0);
    expect(secondImported.code, secondImported.err || secondImported.out).toBe(0);
    const firstImportReport = parseJson<{ receipt: { directory: string } }>(firstImported);
    const secondImportReport = parseJson<{ receipt: { directory: string } }>(secondImported);
    const firstReceipt = privateReceipt(firstImportReport);
    const secondReceipt = privateReceipt(secondImportReport);
    expect(secondReceipt.inventory.digest).toBe(firstReceipt.inventory.digest);
    expect(secondReceipt.selection.export.sha256).not.toBe(firstReceipt.selection.export.sha256);
    expect(secondReceipt.selection.artifacts[0].digest).toBe(
      firstReceipt.selection.artifacts[0].digest,
    );
    expect(secondReceipt.selection.artifacts[0].packaging.digest).not.toBe(
      firstReceipt.selection.artifacts[0].packaging.digest,
    );
    expect(readFileSync(join(firstImportReport.receipt.directory, "raw", "export.bin"))).toEqual(
      Buffer.from(firstBytes),
    );
    expect(readFileSync(join(secondImportReport.receipt.directory, "raw", "export.bin"))).toEqual(
      Buffer.from(secondBytes),
    );
  });

  it("accepts the exact 10,000-member ZIP boundary as 10,001 structured evidence records", async () => {
    const archive = join(work, "ten-thousand-members.zip");
    // api.yaml + deployment environments + one definition + 9,997 bounded
    // supporting members = the archive reader's exact 10,000-member limit.
    writeFileSync(archive, projectZip({ supportingFiles: 9_997 }));
    const inventoried = await estate(
      "inventory",
      archive,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--json",
      "--all",
    );
    expect(inventoried.code, inventoried.err || inventoried.out).toBe(0);
    const inventory = parseJson<{
      apis: Array<{ artifacts: unknown[] }>;
      diagnostics: Array<{ code: string }>;
    }>(inventoried);
    expect(inventory.apis[0]?.artifacts).toHaveLength(10_001);
    expect(inventory.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: expect.stringContaining("too_many") }),
      ]),
    );

    const imported = await estate(...importArgs(archive, join(work, "boundary-bundle")));
    expect(imported.code, imported.err || imported.out).toBe(0);
    expect(imported.err).toBe("");
    const receipt = privateReceipt(parseJson<{ receipt: { directory: string } }>(imported));
    expect(receipt.selection.artifacts).toHaveLength(10_001);
  }, 120_000);
});
