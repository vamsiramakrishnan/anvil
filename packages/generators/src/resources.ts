import type { AirDocument } from "@anvil/air";
import type { ServedResource } from "@anvil/mcp-runtime";
import { operationCatalog } from "./catalog.js";
import { generateSkill } from "./skill.js";

/**
 * Serving the skill and CLI *over MCP* (researched design). The deployed MCP
 * server is self-describing: an agent connects, calls `resources/list`, reads
 * SKILL.md first (progressive disclosure), pulls reference files/schemas on
 * demand, and reads the CLI install manifest to materialize the CLI as a
 * process adjacent to itself. MCP resources support exactly this — arbitrary
 * file bundles under a custom URI scheme, with an `assistant` audience hint.
 *
 * URI scheme: anvil://<kind>/<service>/<path>
 *
 * A `ToolResource` is exactly the `ServedResource` the MCP runtime advertises —
 * generators produce the data at build time, the runtime serves it.
 */
export type ToolResource = ServedResource;

export interface ResourceOptions {
  /** Where an installed CLI (and the agent) should reach this MCP server. */
  mcpEndpoint?: string;
  /** Published CLI package name for `npm i -g` next to the agent. */
  cliNpmPackage?: string;
  /** OCI reference for the CLI, if published as a container. */
  cliOci?: string;
}

function mimeFor(path: string): string {
  if (path.endsWith(".md")) return "text/markdown";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "application/yaml";
  return "text/plain";
}

/** Build the full set of MCP resources the deployed server exposes to agents. */
export function buildToolResources(
  air: AirDocument,
  options: ResourceOptions = {},
): ToolResource[] {
  const id = air.service.id;
  const resources: ToolResource[] = [];

  // 1. The skill package — SKILL.md first, then reference/*.
  const skill = generateSkill(air);
  for (const [path, text] of Object.entries(skill)) {
    resources.push({
      uri: `anvil://skill/${id}/${path}`,
      name: `${id} skill: ${path}`,
      title: path === "SKILL.md" ? `${air.service.displayName ?? id} skill` : path,
      description:
        path === "SKILL.md"
          ? "Read this first: routing and safety instructions for this tool."
          : `Skill reference: ${path}`,
      mimeType: mimeFor(path),
      text,
      audience: ["assistant"],
      priority: path === "SKILL.md" ? 0.95 : 0.6,
    });
  }

  // 2. The operation catalog — machine-readable index.
  resources.push({
    uri: `anvil://catalog/${id}`,
    name: `${id} catalog`,
    title: `${id} operation catalog`,
    description: "The full operation catalog: effects, risk, idempotency, and bindings.",
    mimeType: "application/json",
    text: `${JSON.stringify(operationCatalog(air), null, 2)}\n`,
    audience: ["assistant"],
    priority: 0.7,
  });

  // 3. The CLI install manifest — how to run the CLI adjacent to the agent.
  const manifest = {
    service: id,
    version: air.service.version,
    entrypoint: id,
    install: {
      npm: options.cliNpmPackage ?? `@anvil-tools/${id}-cli`,
      oci: options.cliOci,
      local: `cli/${id}.mjs`,
    },
    connectsTo: options.mcpEndpoint ?? "(configure ANVIL endpoint)",
    skill: `anvil://skill/${id}/SKILL.md`,
    usage: [`${id} --help`, `${id} discover "<intent>"`, `${id} explain <operation-id>`],
    note: "Install the CLI next to the agent; it drives the same AIR operations as this MCP server. Use the CLI first for discovery and dry-runs; use MCP tools for structured invocation.",
  };
  resources.push({
    uri: `anvil://cli/${id}/install.json`,
    name: `${id} CLI install manifest`,
    title: `${id} CLI`,
    description: "How to install and run the CLI adjacent to the agent, and where it connects.",
    mimeType: "application/json",
    text: `${JSON.stringify(manifest, null, 2)}\n`,
    audience: ["assistant", "user"],
    priority: 0.8,
  });

  return resources;
}
