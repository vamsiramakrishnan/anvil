import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
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
import { generateMcpServerSource, generateMcpSseServerSource } from "./mcp.js";
import {
  exampleInput,
  generateMockRoutes,
  generateMockServerSource,
  generateScenarios,
} from "./mock.js";
import { generateHarnessPlugins } from "./plugins.js";
import { buildToolResources, type ResourceOptions } from "./resources.js";
import { generateSkill } from "./skill.js";

export interface GeneratedBundle {
  /** Relative path -> file contents. Deterministic, so builds are diffable. */
  files: Record<string, string>;
}

export const GENERATION_METADATA_FILE = "generation.json";

export interface GenerationMetadata {
  schemaVersion: 1;
  resourceOptions: {
    mcpEndpoint: string | null;
    cliNpmPackage: string | null;
    cliOci: string | null;
    deploymentNamespace: string | null;
  };
}

function generationMetadata(options: ResourceOptions): GenerationMetadata {
  return {
    schemaVersion: 1,
    resourceOptions: {
      mcpEndpoint: options.mcpEndpoint ?? null,
      cliNpmPackage: options.cliNpmPackage ?? null,
      cliOci: options.cliOci ?? null,
      deploymentNamespace: options.deploymentNamespace ?? null,
    },
  };
}

/** Recover the persisted generator inputs without inferring them from projections. */
export function resourceOptionsFromGenerationMetadata(
  text: string | undefined,
): ResourceOptions | undefined {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    return undefined;
  }
  const resourceOptions = (value as { resourceOptions?: unknown }).resourceOptions;
  if (typeof resourceOptions !== "object" || resourceOptions === null) return undefined;
  const record = resourceOptions as Record<string, unknown>;
  for (const key of ["mcpEndpoint", "cliNpmPackage", "cliOci"] as const) {
    if (record[key] !== null && typeof record[key] !== "string") return undefined;
  }
  if (
    record.deploymentNamespace !== undefined &&
    record.deploymentNamespace !== null &&
    (typeof record.deploymentNamespace !== "string" ||
      !/^[a-z][a-z0-9-]{0,127}$/.test(record.deploymentNamespace))
  ) {
    return undefined;
  }
  return {
    ...(typeof record.mcpEndpoint === "string" ? { mcpEndpoint: record.mcpEndpoint } : {}),
    ...(typeof record.cliNpmPackage === "string" ? { cliNpmPackage: record.cliNpmPackage } : {}),
    ...(typeof record.cliOci === "string" ? { cliOci: record.cliOci } : {}),
    ...(typeof record.deploymentNamespace === "string"
      ? { deploymentNamespace: record.deploymentNamespace }
      : {}),
  };
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
  files[GENERATION_METADATA_FILE] = `${JSON.stringify(generationMetadata(options), null, 2)}\n`;
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

  // MCP servers — two transports, one runtime. `server.js` is LOCAL (stdio, for
  // a client that spawns the process); `server-sse.js` is REMOTE (HTTP + SSE, for
  // a client that connects to a URL). Same tools, same safety hot path.
  files["mcp/air.json"] = airJson;
  files["mcp/resources.json"] = resourcesJson;
  files["mcp/server.js"] = generateMcpServerSource(air);
  files["mcp/server-sse.js"] = generateMcpSseServerSource(air);

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
    // JSON cannot carry frontmatter, so each file self-describes in-band:
    // schemas via the standard JSON Schema title/description keywords,
    // examples via a small envelope naming the operation and both surfaces.
    const schema = (op.input.schema ?? operationInputSchema(op)) as Record<string, unknown>;
    files[`skill/schemas/${op.canonicalName}.schema.json`] = `${JSON.stringify(
      {
        title: schema.title ?? `${op.canonicalName} input`,
        description:
          schema.description ??
          `Input JSON Schema for \`${op.cli.command}\` / MCP tool \`${op.mcp.toolName}\` (${op.id}). Validate arguments against this before invoking.`,
        ...schema,
      },
      null,
      2,
    )}\n`;
    files[`skill/examples/${op.canonicalName}.json`] = `${JSON.stringify(
      {
        description: `Worked example input for ${op.displayName || op.id}. Pass \`input\` as the MCP tool arguments for \`${op.mcp.toolName}\`, or map it onto \`${op.cli.command}\` flags.`,
        operation: op.id,
        cli: op.cli.command,
        tool: op.mcp.toolName,
        input: exampleInput(op),
      },
      null,
      2,
    )}\n`;
  }
  for (const [path, text] of Object.entries(generateEvals(air))) {
    files[`skill/${path}`] = text;
  }

  // Harness plugins — the bundle root becomes an installable Claude Code plugin
  // (skill + MCP server + PreToolUse enforcement hook), with a Codex shim and
  // Antigravity guidance sharing one decision core. The outer enforcement ring.
  Object.assign(files, generateHarnessPlugins(air));

  // Docs, deploy, mocks, conformance.
  Object.assign(files, generateDocs(air));
  Object.assign(files, generateDeploy(air, options));
  files["mock/scenarios.json"] = `${JSON.stringify(generateScenarios(air), null, 2)}\n`;
  files["mock/routes.json"] = `${JSON.stringify(generateMockRoutes(air), null, 2)}\n`;
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
    // Self-describing, and honest about the install contract: `npm install`
    // resolves only where the @anvil/* packages are reachable (a registry or
    // packed tarballs); a linked toolchain runs the CLI directly.
    description: `Anvil-generated tool bundle for ${air.service.displayName ?? id}: aligned CLI (bin \`${id}\`), MCP server (mcp/server.js), and skill package (skill/). Run \`node cli/${id}.mjs --help\` after \`npm install\` (or with the @anvil/* toolchain linked); see skill/SKILL.md.`,
    private: true,
    type: "module",
    bin: { [id]: `cli/${id}.mjs` },
    scripts: {
      start: "node runtime/server.js",
      mcp: "node mcp/server.js",
      "mcp:sse": "node mcp/server-sse.js",
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
  mkdirSync(outDir, { recursive: true });
  const root = realpathSync(outDir);
  const written: string[] = [];
  for (const [rel, contents] of Object.entries(bundle.files)) {
    assertSafeBundlePath(rel);
    const full = resolve(root, rel);
    if (full !== root && !full.startsWith(`${root}${sep}`)) {
      throw new Error(`Unsafe generated bundle path: ${JSON.stringify(rel)}`);
    }
    ensureSafeParent(root, dirname(full), rel);
    if (existsSync(full) && lstatSync(full).isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symlink for generated bundle path: ${rel}`);
    }
    writeFileSync(full, contents, "utf8");
    written.push(rel);
  }
  return written.sort();
}

function assertSafeBundlePath(rel: string): void {
  const segments = rel.split("/");
  if (
    rel.length === 0 ||
    isAbsolute(rel) ||
    rel.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe generated bundle path: ${JSON.stringify(rel)}`);
  }
}

/** Create parents one segment at a time, refusing any symlink traversal. */
function ensureSafeParent(root: string, parent: string, rel: string): void {
  const suffix = parent.slice(root.length).split(sep).filter(Boolean);
  let cursor = root;
  for (const segment of suffix) {
    cursor = resolve(cursor, segment);
    if (!existsSync(cursor)) {
      mkdirSync(cursor);
      continue;
    }
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Unsafe parent for generated bundle path: ${rel}`);
    }
  }
}
