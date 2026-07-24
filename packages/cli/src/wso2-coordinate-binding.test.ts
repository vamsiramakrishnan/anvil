import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-wso2-coordinate-binding-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function estate(...args: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(["estate", ...args], { io });
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

function writeProject(
  collection: string,
  root: string,
  apiYaml: string,
  environments?: string,
): void {
  const apiPath = join(collection, root, "api.yaml");
  mkdirSync(dirname(apiPath), { recursive: true });
  writeFileSync(apiPath, apiYaml);
  if (environments !== undefined) {
    writeFileSync(join(collection, root, "deployment_environments.yaml"), environments);
  }
}

const PROD_ENVIRONMENTS = `type: deployment_environments
data:
  - deploymentEnvironment: Prod
`;

function apiYaml(input: { name: string; context: string; version?: string }): string {
  return `type: api
data:
  name: ${input.name}
  context: ${input.context}
${input.version === undefined ? "" : `  version: ${input.version}\n`}  isRevision: false
  revisionId: 0
  operations:
    - target: /items
      verb: GET
`;
}

describe("native WSO2 extraction coordinate binding", () => {
  it("binds the selected version/environment to its exact project artifact", async () => {
    const collection = join(work, "collection");
    writeProject(
      collection,
      "00-missing-version",
      apiYaml({ name: "Leak", context: "/wrong-version" }),
      PROD_ENVIRONMENTS,
    );
    writeProject(
      collection,
      "10-correct-version",
      apiYaml({ name: "Leak", context: "/correct", version: "1.0.0" }),
      PROD_ENVIRONMENTS,
    );
    writeProject(
      collection,
      "20-missing-environment",
      apiYaml({ name: "EnvironmentLeak", context: "/wrong-environment", version: "1.0.0" }),
      "type: deployment_environments\ndata: []\n",
    );
    writeProject(
      collection,
      "30-prod-environment",
      apiYaml({ name: "EnvironmentLeak", context: "/prod", version: "1.0.0" }),
      PROD_ENVIRONMENTS,
    );

    const versionOut = join(work, "version-bundle");
    const versionImport = await estate(
      "import",
      collection,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--api",
      "Leak",
      "--api-version",
      "1.0.0",
      "--revision",
      "working-copy",
      "--environment",
      "Prod",
      "--root",
      work,
      "--out",
      versionOut,
      "--json",
    );
    expect(versionImport.code, versionImport.err || versionImport.out).toBe(0);
    expect(readFileSync(join(versionOut, "air.yaml"), "utf8")).toContain("/correct/items");
    expect(readFileSync(join(versionOut, "air.yaml"), "utf8")).not.toContain(
      "/wrong-version/items",
    );
    const versionReport = JSON.parse(versionImport.out);
    const versionReceipt = JSON.parse(
      readFileSync(join(versionReport.receipt.directory, "import.receipt.json"), "utf8"),
    );
    expect(
      versionReceipt.selection.artifacts.some(
        (artifact: { kind: string; path: string }) =>
          artifact.kind === "container" && artifact.path === "10-correct-version",
      ),
    ).toBe(true);
    expect(
      versionReceipt.selection.artifacts.some((artifact: { path: string }) =>
        artifact.path.includes("00-missing-version"),
      ),
    ).toBe(false);

    const environmentOut = join(work, "environment-bundle");
    const environmentImport = await estate(
      "import",
      collection,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--api",
      "EnvironmentLeak",
      "--api-version",
      "1.0.0",
      "--revision",
      "working-copy",
      "--environment",
      "Prod",
      "--root",
      work,
      "--out",
      environmentOut,
      "--json",
    );
    expect(environmentImport.code, environmentImport.err || environmentImport.out).toBe(0);
    expect(readFileSync(join(environmentOut, "air.yaml"), "utf8")).toContain("/prod/items");
    expect(readFileSync(join(environmentOut, "air.yaml"), "utf8")).not.toContain(
      "/wrong-environment/items",
    );
  });

  it("returns structured JSON diagnostics for invalid native coordinate scalars", async () => {
    const invalid = join(work, "numeric-version.yaml");
    writeFileSync(
      invalid,
      `type: api
data:
  name: NumericVersion
  context: /numeric
  version: 1
  isRevision: false
  revisionId: 0
  operations: []
`,
    );

    const result = await estate(
      "inventory",
      invalid,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--json",
      "--all",
    );
    expect(result.code).toBe(1);
    expect(result.err).toBe("");
    expect(JSON.parse(result.out)).toMatchObject({
      apis: [],
      diagnostics: [
        expect.objectContaining({
          level: "error",
          code: "wso2/invalid_api_version",
          coordinate: expect.objectContaining({ pointer: "/data/version" }),
        }),
      ],
    });
  });
});
