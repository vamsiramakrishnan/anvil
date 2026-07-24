import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

interface CliResult {
  code: number;
  out: string;
  err: string;
}

const ZIP_MTIME = new Date("2020-01-01T00:00:00.000Z");

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-wso2-public-cli-"));
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

function parseJson(result: CliResult): unknown {
  expect(result.out.trim()).not.toBe("");
  expect(result.err).toBe("");
  return JSON.parse(result.out);
}

function apiYaml(name: string, context: string): string {
  return `type: api
version: v4.2.0
data:
  name: ${name}
  context: ${context}
  version: "1.0.0"
  isRevision: true
  revisionId: 3
  operations:
    - target: /health
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

function nativeProjectZip(name = "DirectOrders"): Uint8Array {
  const root = `${name}-1.0.0`;
  return zipSync(
    {
      [`${root}/api.yaml`]: strToU8(apiYaml(name, `/${name.toLowerCase()}`)),
      [`${root}/deployment_environments.yaml`]: strToU8(deploymentEnvironmentsYaml()),
    },
    { level: 0, mtime: ZIP_MTIME },
  );
}

describe("native WSO2 apictl public CLI boundaries", () => {
  it("inventories and imports one top-level per-API ZIP without --entry", async () => {
    const archive = join(work, "DirectOrders_1.0.0_Revision-3.zip");
    const out = join(work, "bundle");
    writeFileSync(archive, nativeProjectZip());

    const inventoried = await estate(
      "inventory",
      archive,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--json",
    );
    expect(inventoried.code).toBe(0);
    expect(parseJson(inventoried)).toMatchObject({
      gateway: { kind: "wso2", id: "bank-wso2" },
      apis: [
        {
          id: "DirectOrders",
          version: "1.0.0",
          revision: "revision-3",
          environmentIds: ["Prod"],
        },
      ],
    });

    const imported = await estate(
      "import",
      archive,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--api",
      "DirectOrders",
      "--api-version",
      "1.0.0",
      "--revision",
      "revision-3",
      "--environment",
      "Prod",
      "--root",
      work,
      "--out",
      out,
      "--json",
    );
    expect(imported.code).toBe(0);
    expect(parseJson(imported)).toMatchObject({
      receipt: {
        export: { format: "zip" },
        identity: {
          apiId: "DirectOrders",
          apiVersion: "1.0.0",
          revision: "revision-3",
          environment: "Prod",
        },
      },
      operations: { total: 1, blocked: 1 },
    });
  });

  it("returns a structured error for a ZIP containing multiple api.yaml projects", async () => {
    const archive = join(work, "ambiguous.zip");
    writeFileSync(
      archive,
      zipSync(
        {
          "Alpha-1.0.0/api.yaml": strToU8(apiYaml("Alpha", "/alpha")),
          "Beta-1.0.0/api.yaml": strToU8(apiYaml("Beta", "/beta")),
        },
        { level: 0, mtime: ZIP_MTIME },
      ),
    );

    const result = await estate(
      "inventory",
      archive,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--json",
    );
    expect(result.code).toBe(1);
    expect(parseJson(result)).toMatchObject({
      apis: [],
      diagnostics: [
        {
          level: "error",
          code: "wso2/ambiguous_apictl_archive",
          subject: {
            artifact: {
              origin: expect.stringMatching(/^gateway-export:\/\/sha256:/),
              digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            },
          },
        },
      ],
    });
  });

  it("returns a structured archive diagnostic for traversal instead of raw failure", async () => {
    const archive = join(work, "traversal.zip");
    writeFileSync(
      archive,
      zipSync(
        {
          "../api.yaml": strToU8(apiYaml("Traversal", "/traversal")),
        },
        { level: 0, mtime: ZIP_MTIME },
      ),
    );

    const result = await estate(
      "inventory",
      archive,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--json",
    );
    expect(result.code).toBe(1);
    expect(parseJson(result)).toMatchObject({
      schemaVersion: 1,
      reportType: "anvil.gateway-estate-error",
      code: "estate/export_unreadable",
      diagnostics: expect.arrayContaining([expect.stringContaining("archive/unsafe_path")]),
    });
  });

  it("rejects a symlink inside an extracted collection with a structured error", async () => {
    const collection = join(work, "collection");
    const apiPath = join(collection, "DirectOrders-1.0.0", "api.yaml");
    const outside = join(work, "outside.yaml");
    mkdirSync(dirname(apiPath), { recursive: true });
    writeFileSync(apiPath, apiYaml("DirectOrders", "/direct-orders"));
    writeFileSync(outside, "outside the collection\n");
    symlinkSync(outside, join(collection, "linked.yaml"));

    const result = await estate(
      "inventory",
      collection,
      "--vendor",
      "wso2",
      "--gateway-id",
      "bank-wso2",
      "--json",
    );
    expect(result.code).toBe(1);
    expect(parseJson(result)).toMatchObject({
      schemaVersion: 1,
      reportType: "anvil.gateway-estate-error",
      code: "estate/export_unreadable",
      message: expect.stringContaining("wso2/collection_symlink_rejected"),
      diagnostics: expect.arrayContaining([
        expect.stringContaining("wso2/collection_symlink_rejected"),
      ]),
    });
  });
});
