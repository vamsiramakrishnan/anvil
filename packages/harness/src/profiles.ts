import type { EvidenceKind } from "@anvil/air";
import type { SourceConfig, SourceSystem, Transport } from "./sources.js";

/**
 * A per-system profile: which published MCP server to run, which of its tools to
 * call, and how much to trust what it returns. This is how Anvil "supports"
 * GitHub / GitLab / Confluence / Postman without building a client for any of
 * them — it knows how to *drive the published server* and how to weight it.
 *
 * The weighting is deliberate and asymmetric-trust-aware:
 *   - code hosts (github/gitlab) → implementation-grade; a literal Idempotency-Key
 *     in a repo can clear the reconciler's loosen threshold.
 *   - doc hosts (confluence/jira/notion) → doc-grade; can tighten safety but
 *     never loosen it alone.
 *   - postman → real-usage-grade; corroborates, but a saved request is not proof
 *     the server enforces idempotency, so it stays just below the loosen bar.
 */
export interface SystemProfile {
  system: SourceSystem;
  displayName: string;
  /** How to reach the published MCP server when the config omits a transport. */
  defaultTransport?: Transport;
  /** Candidate search-tool names, tried in order against the server's tool list. */
  searchTools: string[];
  /** Evidence kind produced by this source. */
  evidenceKind: EvidenceKind;
  /** Confidence for a plain hit. */
  floor: number;
  /** Confidence when a strong signal (e.g. the literal Idempotency-Key) is present. */
  strong: number;
}

export const PROFILES: Record<SourceSystem, SystemProfile> = {
  github: {
    system: "github",
    displayName: "GitHub",
    defaultTransport: {
      kind: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" },
    },
    searchTools: ["search_code", "search_issues", "search_repositories", "search"],
    evidenceKind: "source_impl",
    floor: 0.55,
    strong: 0.88,
  },
  gitlab: {
    system: "gitlab",
    displayName: "GitLab",
    defaultTransport: {
      kind: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-gitlab"],
      env: { GITLAB_PERSONAL_ACCESS_TOKEN: "${GITLAB_TOKEN}", GITLAB_API_URL: "${GITLAB_API_URL}" },
    },
    searchTools: ["search_repositories", "search_code", "search"],
    evidenceKind: "source_impl",
    floor: 0.55,
    strong: 0.88,
  },
  confluence: {
    system: "confluence",
    displayName: "Confluence",
    defaultTransport: {
      kind: "stdio",
      command: "npx",
      args: ["-y", "mcp-atlassian"],
      env: {
        CONFLUENCE_URL: "${CONFLUENCE_URL}",
        CONFLUENCE_API_TOKEN: "${CONFLUENCE_API_TOKEN}",
        CONFLUENCE_USERNAME: "${CONFLUENCE_USERNAME}",
      },
    },
    searchTools: ["confluence_search", "search"],
    evidenceKind: "doc_example",
    floor: 0.45,
    strong: 0.6, // stays below the loosen threshold — docs can tighten, not loosen
  },
  jira: {
    system: "jira",
    displayName: "Jira",
    defaultTransport: {
      kind: "stdio",
      command: "npx",
      args: ["-y", "mcp-atlassian"],
      env: { JIRA_URL: "${JIRA_URL}", JIRA_API_TOKEN: "${JIRA_API_TOKEN}" },
    },
    searchTools: ["jira_search", "search"],
    evidenceKind: "incident",
    floor: 0.5,
    strong: 0.6,
  },
  notion: {
    system: "notion",
    displayName: "Notion",
    defaultTransport: {
      kind: "http",
      url: "https://mcp.notion.com/mcp",
      headers: {},
    },
    searchTools: ["notion-search", "search"],
    evidenceKind: "doc_example",
    floor: 0.45,
    strong: 0.6,
  },
  postman: {
    system: "postman",
    displayName: "Postman",
    defaultTransport: {
      kind: "http",
      url: "https://mcp.postman.com/mcp",
      headers: { Authorization: "Bearer ${POSTMAN_API_KEY}" },
    },
    searchTools: ["search", "list-collections", "get-collection"],
    evidenceKind: "postman",
    floor: 0.6,
    // A saved Postman request is strong real-usage evidence but not proof the
    // server enforces the contract, so cap it just below the loosen threshold.
    strong: 0.82,
  },
  generic: {
    system: "generic",
    displayName: "Generic MCP source",
    searchTools: ["search"],
    evidenceKind: "doc_example",
    floor: 0.5,
    strong: 0.6,
  },
};

export function profileFor(system: SourceSystem): SystemProfile {
  return PROFILES[system];
}

/** Substitute ${VAR} placeholders from the environment (secrets stay out of config). */
function subst(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => env[name] ?? "");
}

/**
 * Resolve the transport for a source: use the explicit transport if given, else
 * the system profile's default. Env placeholders are expanded here so tokens
 * live in the environment, never in `sources.yaml`.
 */
export function resolveTransport(
  config: SourceConfig,
  env: NodeJS.ProcessEnv = process.env,
): Transport {
  const transport = config.transport ?? profileFor(config.system).defaultTransport;
  if (!transport) {
    throw new Error(
      `Source '${config.id}' (${config.system}) has no transport and no default profile server.`,
    );
  }
  if (transport.kind === "stdio") {
    return {
      kind: "stdio",
      command: transport.command,
      args: transport.args.map((a) => subst(a, env)),
      env: Object.fromEntries(Object.entries(transport.env).map(([k, v]) => [k, subst(v, env)])),
    };
  }
  return {
    kind: "http",
    url: subst(transport.url, env),
    headers: Object.fromEntries(
      Object.entries(transport.headers).map(([k, v]) => [k, subst(v, env)]),
    ),
  };
}
