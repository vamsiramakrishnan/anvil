import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Enrichment sources are *published* MCP servers you install and point Anvil at
 * — not clients Anvil builds. The harness is an MCP client; each source is a
 * transport to a server that already knows how to reach GitHub, GitLab,
 * Confluence, Notion, Postman, etc.
 *
 * stdio  → spawn a published server, e.g. `npx -y @modelcontextprotocol/server-github`
 * http   → connect to a remote/hosted MCP server (e.g. Atlassian Remote MCP)
 */
export const StdioTransport = z.object({
  kind: z.literal("stdio"),
  command: z.string(),
  args: z.array(z.string()).default([]),
  /** Env passed to the child (e.g. GITHUB_TOKEN). Never logged. */
  env: z.record(z.string(), z.string()).default({}),
});

export const HttpTransport = z.object({
  kind: z.literal("http"),
  url: z.string(),
  headers: z.record(z.string(), z.string()).default({}),
});

export const SourceSystem = z.enum([
  "github",
  "gitlab",
  "confluence",
  "jira",
  "notion",
  "postman",
  "generic",
]);
export type SourceSystem = z.infer<typeof SourceSystem>;

export type Transport = z.infer<typeof StdioTransport> | z.infer<typeof HttpTransport>;

export const SourceConfig = z.object({
  /** Stable id, e.g. "github", "confluence". */
  id: z.string(),
  /** Which system this is. Selects a built-in profile (server + tools + weighting). */
  system: SourceSystem.default("generic"),
  /**
   * Transport to the published MCP server. Optional: if omitted, the system's
   * built-in profile supplies the default (e.g. `npx @modelcontextprotocol/server-github`).
   */
  transport: z.discriminatedUnion("kind", [StdioTransport, HttpTransport]).optional(),
  /**
   * Optional hints: which of the server's tools to prefer for search/read, and
   * scoping (repos, spaces). Keeps Anvil from hard-coding any server's API.
   */
  hints: z
    .object({
      searchTool: z.string().optional(),
      readTool: z.string().optional(),
      scope: z.array(z.string()).default([]),
    })
    .default({ scope: [] }),
});
export type SourceConfig = z.infer<typeof SourceConfig>;

export const SourcesFile = z.object({
  sources: z.array(SourceConfig).default([]),
});
export type SourcesFile = z.infer<typeof SourcesFile>;

/** Parse a `sources:` block from a manifest/config YAML document. */
export function parseSources(text: string): SourceConfig[] {
  const doc = parseYaml(text) as unknown;
  return SourcesFile.parse(doc ?? {}).sources;
}
