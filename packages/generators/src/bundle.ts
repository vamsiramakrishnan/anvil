import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AirDocument, airToJson, airToYaml, operationInputSchema } from "@anvil/air";
import {
  compiledErrors,
  compiledOperations,
  compiledSchemas,
  operationCatalog,
} from "./catalog.js";
import { generateConformanceTest } from "./conformance.js";
import { generateDeploy } from "./deploy.js";
import { generateDocs } from "./docs.js";
import { generateCliSource, generateRuntimeServer } from "./entrypoints.js";
import { generateEvals } from "./evals.js";
import { generateMcpServerSource } from "./mcp.js";
import { exampleInput, generateMockServerSource, generateScenarios } from "./mock.js";
import { buildToolResources, type ResourceOptions } from "./resources.js";
import { generateSkill } from "./skill.js";

export interface GeneratedBundle {
  /** Relative path -> file contents. Deterministic, so builds are diffable. */
  files: Record<string, string>;
}

/**
 * Generate the complete tool bundle from AIR (spec §5.5 + §20 + deployment).
 * Every artifact is a projection of the one AIR model — that alignment is the
 * product.
 */
export function generateBundle(air: AirDocument, options: ResourceOptions = {}): GeneratedBundle {
  const files: Record<string, string> = {};
  const airJson = airToJson(air);
  const id = air.service.id;
  // Resources the deployed MCP server advertises (skill + catalog + CLI install
  // manifest), computed once at build time and served verbatim by the runtime.
  const resourcesJson = `${JSON.stringify(buildToolResources(air, options), null, 2)}\n`;

  // Canonical model.
  files["air.yaml"] = airToYaml(air);
  files["air.json"] = airJson;
  files["catalog.json"] = `${JSON.stringify(operationCatalog(air), null, 2)}\n`;

  // Per-operation input schemas.
  for (const op of air.operations) {
    files[`schemas/${op.id}.schema.json`] = `${JSON.stringify(
      op.input.schema ?? operationInputSchema(op),
      null,
      2,
    )}\n`;
  }

  // CLI — thin entrypoint over the shared engine.
  files["cli/air.json"] = airJson;
  files[`cli/${id}.mjs`] = generateCliSource(air);

  // MCP server (stdio).
  files["mcp/air.json"] = airJson;
  files["mcp/resources.json"] = resourcesJson;
  files["mcp/server.js"] = generateMcpServerSource(air);

  // Thin runtime server (Cloud Run hot path) + compiled manifests.
  files["runtime/air.json"] = airJson;
  files["runtime/resources.json"] = resourcesJson;
  files["runtime/server.js"] = generateRuntimeServer(air);
  files["runtime/operations.manifest.json"] =
    `${JSON.stringify(compiledOperations(air), null, 2)}\n`;
  files["runtime/schemas.compiled.json"] = `${JSON.stringify(compiledSchemas(air), null, 2)}\n`;
  files["runtime/errors.compiled.json"] = `${JSON.stringify(compiledErrors(air), null, 2)}\n`;

  // Skill package (progressive disclosure), served over MCP resources too.
  for (const [path, text] of Object.entries(generateSkill(air))) {
    files[`skill/${path}`] = text;
  }
  for (const op of air.operations) {
    if (op.state !== "approved") continue;
    files[`skill/schemas/${op.canonicalName}.schema.json`] = `${JSON.stringify(
      op.input.schema ?? operationInputSchema(op),
      null,
      2,
    )}\n`;
    files[`skill/examples/${op.canonicalName}.json`] =
      `${JSON.stringify(exampleInput(op), null, 2)}\n`;
  }
  for (const [path, text] of Object.entries(generateEvals(air))) {
    files[`skill/${path}`] = text;
  }

  // Docs, deploy, mocks, conformance.
  Object.assign(files, generateDocs(air));
  Object.assign(files, generateDeploy(air));
  files["mock/scenarios.json"] = `${JSON.stringify(generateScenarios(air), null, 2)}\n`;
  files["mock/server.mjs"] = generateMockServerSource(air);
  files["tests/conformance.test.ts"] = generateConformanceTest(air);

  // A package.json for the generated bundle so it is installable/deployable.
  files["package.json"] = `${JSON.stringify(bundlePackageJson(air), null, 2)}\n`;
  return { files };
}

function bundlePackageJson(air: AirDocument): unknown {
  const id = air.service.id;
  return {
    name: `@anvil-tools/${id}`,
    version: air.service.version,
    private: true,
    type: "module",
    bin: { [id]: `cli/${id}.mjs` },
    scripts: {
      start: "node runtime/server.js",
      mcp: "node mcp/server.js",
      mock: "node mock/server.mjs",
    },
    dependencies: {
      "@anvil/air": "^0.1.0",
      "@anvil/runtime": "^0.1.0",
      "@anvil/mcp-runtime": "^0.1.0",
      "@anvil/cli": "^0.1.0",
      "@modelcontextprotocol/sdk": "^1.22.0",
    },
  };
}

/** Write a generated bundle to disk under `outDir`. */
export function writeBundle(outDir: string, bundle: GeneratedBundle): string[] {
  const written: string[] = [];
  for (const [rel, contents] of Object.entries(bundle.files)) {
    const full = join(outDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
    written.push(rel);
  }
  return written.sort();
}
