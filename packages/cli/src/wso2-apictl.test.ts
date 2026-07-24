import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

interface ProjectOptions {
  name: string;
  version?: string;
  revisionId?: number;
  apiPolicies?: boolean;
  malformed?: boolean;
}

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-wso2-apictl-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function estate(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(["estate", ...argv], { io });
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

function apiYaml(options: ProjectOptions): string {
  if (options.malformed) {
    return `type: api
version: v4.2.0
data:
  version: ${options.version ?? "1.0.0"}
  isRevision: false
  revisionId: 0
`;
  }
  return `type: api
version: v4.2.0
data:
  name: ${options.name}
  context: /${options.name.toLowerCase()}
  version: ${options.version ?? "1.0.0"}
  provider: platform-team
  isRevision: ${options.revisionId ? "true" : "false"}
  revisionId: ${options.revisionId ?? 0}
  lifeCycleStatus: PUBLISHED
  securityScheme: [oauth2]
  operations:
    - target: /{id}
      verb: GET
      scopes: [records:read]
${
  options.apiPolicies
    ? `  apiPolicies:
    request:
      - policyName: addHeader
        policyVersion: v1
        parameters:
          headerName: x-estate
          headerValue: banking
`
    : ""
}`;
}

const DEPLOYMENT_ENVIRONMENTS = `type: deployment_environments
version: v4.2.0
data:
  - displayOnDevportal: true
    deploymentEnvironment: Default
    deploymentVhost: gateway.example.test
`;

function openApi(name: string, version = "1.0.0"): string {
  return `openapi: 3.0.3
info:
  title: ${name}
  version: ${version}
paths:
  /${name.toLowerCase()}/{id}:
    get:
      operationId: get${name}
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        "200": { description: ok }
`;
}

function projectMembers(options: ProjectOptions): Record<string, Uint8Array> {
  const version = options.version ?? "1.0.0";
  const root = `${options.name}-${version}`;
  const text = (value: string) => strToU8(value);
  return {
    [`${root}/api.yaml`]: text(apiYaml(options)),
    [`${root}/api_meta.yaml`]: text(
      `type: api_meta\nversion: v4.2.0\ndata:\n  createdTime: 1720000000\n`,
    ),
    [`${root}/deployment_environments.yaml`]: text(DEPLOYMENT_ENVIRONMENTS),
    [`${root}/Definitions/openapi.yaml`]: text(openApi(options.name, version)),
    [`${root}/Docs/index.md`]: text(`# ${options.name}\n`),
    [`${root}/Image/icon.svg`]: text("<svg xmlns='http://www.w3.org/2000/svg'/>"),
    [`${root}/EndpointCertificates/README.md`]: text("No embedded private material.\n"),
    [`${root}/GraphQL/schema.graphql`]: text("type Query { health: String }\n"),
    [`${root}/WSDL/service.wsdl`]: text("<definitions/>"),
    [`${root}/TestKey/key.txt`]: text("non-secret-fixture\n"),
    [`${root}/README.md`]: text("Native apictl project fixture.\n"),
    [`${root}/metadata.json`]: text('{"fixture":true}\n'),
    ...(options.apiPolicies
      ? {
          [`${root}/Policies/add-header.yaml`]: text(
            "name: addHeader\nversion: v1\nimplementation: opaque\n",
          ),
        }
      : {}),
  };
}

function projectZip(options: ProjectOptions): Uint8Array {
  return zipSync(projectMembers(options), { level: 0 });
}

function writeExtractedProject(directory: string, options: ProjectOptions): void {
  for (const [path, bytes] of Object.entries(projectMembers(options))) {
    const absolute = join(directory, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, bytes);
  }
}

function writeMixedCollection(directory: string, revisionZip: Uint8Array): void {
  mkdirSync(directory, { recursive: true });
  writeExtractedProject(join(directory, "extracted"), {
    name: "Orders",
    version: "2.1.0",
  });
  writeFileSync(join(directory, "Orders_2.1.0_Revision-7.zip"), revisionZip);
  writeFileSync(
    join(directory, "Broken_1.0.0.zip"),
    projectZip({ name: "Broken", malformed: true }),
  );
  writeFileSync(join(directory, "legacy-mediation.car"), strToU8("opaque-car-fixture"));
}

describe("native WSO2 apictl collection journey", () => {
  it("inventories mixed native projects deterministically and isolates malformed/opaque siblings", async () => {
    const first = join(work, "first");
    const second = join(work, "second");
    const revisionZip = projectZip({
      name: "Orders",
      version: "2.1.0",
      revisionId: 7,
      apiPolicies: true,
    });
    writeMixedCollection(first, revisionZip);
    writeMixedCollection(second, revisionZip);

    const firstResult = await estate(
      "inventory",
      first,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--json",
      "--all",
    );
    const secondResult = await estate(
      "inventory",
      second,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--json",
      "--all",
    );
    // Inventory remains complete, but truthfully exits non-zero because one
    // independently scoped project is malformed.
    expect(firstResult.code, firstResult.err || firstResult.out).toBe(1);
    expect(secondResult.code, secondResult.err || secondResult.out).toBe(1);
    const inventory = JSON.parse(firstResult.out);
    const repeated = JSON.parse(secondResult.out);
    expect(inventory.digest).toBe(repeated.digest);
    expect(inventory.apis).toEqual(repeated.apis);
    expect(inventory.apis).toHaveLength(2);
    expect(
      inventory.apis
        .map((api: { version: string; revision: string; environmentIds: string[] }) => ({
          version: api.version,
          revision: api.revision,
          environments: api.environmentIds,
        }))
        .sort((left: { revision: string }, right: { revision: string }) =>
          left.revision.localeCompare(right.revision),
        ),
    ).toEqual([
      {
        version: "2.1.0",
        revision: "revision-7",
        environments: ["Default"],
      },
      {
        version: "2.1.0",
        revision: "working-copy",
        environments: ["Default"],
      },
    ]);
    const working = inventory.apis.find(
      (api: { revision: string }) => api.revision === "working-copy",
    );
    expect(working.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "container",
          role: "api_project",
          digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        }),
        expect.objectContaining({
          kind: "member",
          role: "formal_definition",
          path: "Definitions/openapi.yaml",
          origin: expect.stringContaining("Definitions/openapi.yaml"),
        }),
      ]),
    );
    expect(
      inventory.diagnostics.find(
        (diagnostic: { code: string }) => diagnostic.code === "wso2/invalid_export",
      ),
    ).toMatchObject({
      level: "error",
      subject: {
        artifact: {
          origin: expect.stringContaining("Broken_1.0.0.zip"),
          digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        },
      },
    });
    expect(
      inventory.diagnostics.find(
        (diagnostic: { code: string; coordinate?: { pointer?: string } }) =>
          diagnostic.code === "gateway/opaque_policy" &&
          diagnostic.coordinate?.pointer === "/data/apiPolicies",
      ),
    ).toMatchObject({
      subject: {
        api: {
          id: "Orders",
          apiVersion: "2.1.0",
          revision: "revision-7",
        },
      },
    });

    const human = await estate(
      "inventory",
      first,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--all",
    );
    expect(human.out).toContain("API version 2.1.0");
    expect(human.out).toContain("gateway revision working-copy");
    expect(human.out).toContain("embedded definition gateway-export://");
    expect(human.out).toContain("Definitions/openapi.yaml");

    const audit = await estate(
      "audit",
      first,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--json",
    );
    expect(audit.code).toBe(0);
    const auditReport = JSON.parse(audit.out);
    expect(auditReport.gate).toBe("blocked");
    expect(
      auditReport.findings.find(
        (finding: { code: string }) => finding.code === "wso2/invalid_export",
      ),
    ).toMatchObject({ severity: "blocking", scope: { kind: "artifact" } });
    expect(
      auditReport.apis.find((api: { revision: string }) => api.revision === "working-copy"),
    ).toMatchObject({
      apiVersion: "2.1.0",
      disposition: expect.not.stringMatching(/^blocked$/),
    });
    expect(
      auditReport.apis.find((api: { revision: string }) => api.revision === "revision-7"),
    ).toMatchObject({
      apiVersion: "2.1.0",
      disposition: "blocked",
      reasons: expect.arrayContaining(["gateway/opaque_policy"]),
    });
    expect(
      auditReport.findings.find(
        (finding: { category: string; scope: { id: string } }) =>
          finding.category === "contract" &&
          finding.scope.id.includes("Orders:2.1.0@working-copy#Default"),
      ),
    ).toMatchObject({
      action: expect.stringContaining("Definitions/openapi.yaml"),
      evidence: expect.arrayContaining([
        expect.objectContaining({ origin: expect.stringContaining("Definitions/openapi.yaml") }),
      ]),
    });

    const cleanImport = await estate(
      "import",
      first,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--api",
      "Orders",
      "--api-version",
      "2.1.0",
      "--revision",
      "working-copy",
      "--environment",
      "Default",
      "--root",
      work,
      "--out",
      join(work, "clean-bundle"),
      "--json",
    );
    expect(cleanImport.code).toBe(0);
    const cleanReport = JSON.parse(cleanImport.out);
    expect(cleanReport.receipt.identity).toMatchObject({
      apiVersion: "2.1.0",
      revision: "working-copy",
    });
    expect(cleanReport.receipt.export.format).toBe("wso2_apictl_collection");
    expect(
      cleanReport.diagnostics.filter(
        (diagnostic: { code: string }) => diagnostic.code === "gateway/opaque_policy",
      ),
    ).toEqual([]);
    const cleanReceipt = JSON.parse(
      readFileSync(join(cleanReport.receipt.directory, "import.receipt.json"), "utf8"),
    );
    expect(cleanReceipt.selection.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "formal_definition",
          origin: expect.stringContaining("Definitions/openapi.yaml"),
        }),
      ]),
    );
    expect(
      cleanReceipt.selection.artifacts.every(
        (artifact: { origin: string }) =>
          !artifact.origin.includes("Revision-7") && !artifact.origin.includes("Broken"),
      ),
    ).toBe(true);

    const opaqueImport = await estate(
      "import",
      first,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--api",
      "Orders",
      "--api-version",
      "2.1.0",
      "--revision",
      "revision-7",
      "--environment",
      "Default",
      "--root",
      work,
      "--out",
      join(work, "opaque-bundle"),
      "--json",
    );
    expect(opaqueImport.code).toBe(0);
    const opaqueReport = JSON.parse(opaqueImport.out);
    expect(
      opaqueReport.diagnostics.some(
        (diagnostic: { code: string; coordinate?: { pointer?: string } }) =>
          diagnostic.code === "gateway/opaque_policy" &&
          diagnostic.coordinate?.pointer === "/data/apiPolicies",
      ),
    ).toBe(true);
    expect(opaqueReport.operations.blocked).toBeGreaterThan(0);

    const selectionPath = join(work, "selection.yaml");
    const planPath = join(work, "plan.json");
    const plan = await estate(
      "plan",
      first,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--init-selection",
      selectionPath,
      "--out",
      planPath,
      "--json",
    );
    expect(plan.code).toBe(0);
    const selection = parseYaml(readFileSync(selectionPath, "utf8")) as {
      apis: Array<{ apiVersion?: string; revision: string }>;
    };
    expect(selection.apis).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ apiVersion: "2.1.0", revision: "working-copy" }),
        expect.objectContaining({ apiVersion: "2.1.0", revision: "revision-7" }),
      ]),
    );
    expect(JSON.parse(readFileSync(planPath, "utf8")).apis).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          apiVersion: "2.1.0",
          revision: "working-copy",
          coordinateKey: "Orders:2.1.0@working-copy#Default",
        }),
      ]),
    );
  }, 120_000);

  it("does not let an unrelated duplicate coordinate poison a uniquely selected API", async () => {
    const collection = join(work, "duplicate-sibling");
    mkdirSync(collection, { recursive: true });
    writeExtractedProject(join(collection, "clean"), {
      name: "Orders",
      version: "2.1.0",
    });
    const duplicate = projectZip({ name: "Payments", version: "1.0.0" });
    writeFileSync(join(collection, "Payments-A.zip"), duplicate);
    writeFileSync(join(collection, "Payments-B.zip"), duplicate);

    const inventory = await estate(
      "inventory",
      collection,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--json",
      "--all",
    );
    expect(inventory.code).toBe(1);
    expect(JSON.parse(inventory.out).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "gateway/duplicate_api_coordinate",
          subject: {
            api: {
              id: "Payments",
              apiVersion: "1.0.0",
              revision: "working-copy",
              environment: "Default",
            },
          },
        }),
      ]),
    );

    const imported = await estate(
      "import",
      collection,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--api",
      "Orders",
      "--api-version",
      "2.1.0",
      "--revision",
      "working-copy",
      "--environment",
      "Default",
      "--root",
      work,
      "--out",
      join(work, "unique-bundle"),
      "--json",
    );
    expect(imported.code, imported.err || imported.out).toBe(0);
    expect(
      JSON.parse(imported.out).diagnostics.some(
        (diagnostic: { code: string }) => diagnostic.code === "gateway/duplicate_api_coordinate",
      ),
    ).toBe(false);
  });

  it("aggregates 1,000 realistic per-API ZIPs through inventory, audit, and plan", async () => {
    const collection = join(work, "bulk-export");
    mkdirSync(collection, { recursive: true });
    for (let index = 999; index >= 0; index -= 1) {
      const id = `EstateApi${String(index).padStart(4, "0")}`;
      writeFileSync(
        join(collection, `${id}_1.0.0.zip`),
        projectZip({ name: id, version: "1.0.0" }),
      );
    }

    const inventory = await estate(
      "inventory",
      collection,
      "--vendor",
      "wso2",
      "--gateway-id",
      "enterprise-wso2",
      "--summary",
      "--json",
    );
    expect(inventory.code).toBe(0);
    const inventorySummary = JSON.parse(inventory.out);
    expect(inventorySummary.summary).toMatchObject({
      apis: 1000,
      routes: 1000,
    });
    expect(inventorySummary.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "wso2/collection_expansion_limit" }),
      ]),
    );

    const repeated = await estate(
      "inventory",
      collection,
      "--vendor",
      "wso2",
      "--gateway-id",
      "enterprise-wso2",
      "--summary",
      "--json",
    );
    expect(JSON.parse(repeated.out).inventoryDigest).toBe(inventorySummary.inventoryDigest);

    const audit = await estate(
      "audit",
      collection,
      "--vendor",
      "wso2",
      "--gateway-id",
      "enterprise-wso2",
      "--json",
    );
    expect(audit.code).toBe(0);
    expect(JSON.parse(audit.out).summary).toMatchObject({
      apis: 1000,
      routes: 1000,
    });

    const planPath = join(work, "bulk-plan.json");
    const plan = await estate(
      "plan",
      collection,
      "--vendor",
      "wso2",
      "--gateway-id",
      "enterprise-wso2",
      "--out",
      planPath,
    );
    expect(plan.code).toBe(0);
    const planReport = JSON.parse(readFileSync(planPath, "utf8"));
    expect(planReport.summary.apis).toBe(1000);
    expect(planReport.apis).toHaveLength(1000);
    expect(planReport.apis[0]).toMatchObject({
      apiVersion: "1.0.0",
      revision: "working-copy",
    });
  }, 180_000);
});
