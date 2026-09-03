/**
 * The Claude (Desktop / Code) target profile.
 *
 * Claude reaches an MCP server one of two ways: a **stdio** server the client
 * launches itself (the `mcpServers` config's `command`/`args`/`env` shape is
 * the long-stable Claude Desktop / Claude Code convention), or a **remote**
 * server over StreamableHTTP (`"type": "http"`, `"url"`) that Claude connects
 * to directly — OAuth-protected remote servers are discovered and authorized
 * by the client itself via the server's protected-resource metadata, so the
 * emitted config never needs a client secret.
 *
 * A separate **connector manifest** is emitted only when the server requires
 * OAuth: this is the shape an admin registers a remote MCP server under in a
 * connector directory. Its OAuth client credential fields carry environment
 * variable NAMES only (see `mcp-connector.ts`) — never a secret value.
 *
 * NOT verified against a live platform API (no network calls are made by this
 * package, ever). The `mcpServers` config shape is Claude's long-documented,
 * stable convention; the connector-manifest shape is this package's
 * documented-minimum best effort and should be reviewed against current
 * Claude documentation before being registered anywhere.
 */
import type { AirDocument } from "@anvil/air";
import {
  confirmationPermissionHint,
  createMcpConnectorConfig,
  enc,
  json,
  type McpConnectorConfig,
  type McpConnectorConfigInput,
  servedOperations,
  validateMcpConnectorConfig,
} from "./mcp-connector.js";
import type {
  AgentPlatformTargetProfile,
  TargetKit,
  TargetKitFile,
  TargetValidationResult,
} from "./model.js";

export const CLAUDE_PROFILE: AgentPlatformTargetProfile = {
  id: "claude",
  version: "2026.09.1",
  displayName: "Claude",
  transportRequirements: [
    { kind: "stdio", requiresHttps: false, publicEndpoint: false },
    { kind: "streamable-http", requiresHttps: true, publicEndpoint: true },
  ],
  authRequirements: [
    {
      kind: "oauth2",
      oauthFields: ["authorization_url", "token_url", "scopes"],
      inboundMode: "oidc",
    },
    { kind: "none", oauthFields: [] },
  ],
  // Not verified against current Claude documentation — no published hard
  // action-count ceiling is recorded here; this is an unenforced upper bound.
  actionLimits: { maxActions: 200, requiresActionDescriptions: true },
  networkingRequirements: [
    {
      id: "public-https",
      description: "A publicly reachable HTTPS endpoint for the streamable-http transport.",
    },
  ],
  unsupportedAssumptions: [
    "The platform does not enforce the API's auth for you — the MCP server must self-enforce it.",
    "Platform tool-permission defaults do not replace contract-level confirmation for irreversible actions.",
  ],
  interactiveSteps: [
    {
      surface: "agent-registry",
      action: "Add the MCP server to Claude Desktop / Claude Code, or register the connector",
      where: "Claude Desktop settings, `claude mcp add`, or the connector directory",
      why: "Installing a local config file or authorizing a remote connector's OAuth consent is interactive by design.",
    },
  ],
  verificationStatus: "unverified",
};

export type ClaudeTargetConfig = McpConnectorConfig;
export type ClaudeTargetConfigInput = McpConnectorConfigInput;

export function createClaudeTargetConfig(input: ClaudeTargetConfigInput): ClaudeTargetConfig {
  return createMcpConnectorConfig(input);
}

export function validateClaudeTarget(
  air: AirDocument,
  config: ClaudeTargetConfig,
): TargetValidationResult {
  const findings = validateMcpConnectorConfig(air, config);
  return { ok: !findings.some((f) => f.level === "error"), findings };
}

/** Build the Claude target kit: pure projection of AIR + profile + config. */
export function generateClaudeTargetKit(
  air: AirDocument,
  profile: AgentPlatformTargetProfile,
  config: ClaudeTargetConfig,
): TargetKit {
  const dir = `targets/${profile.id}`;
  const served = servedOperations(air);
  const serverId = serviceSlug(air);
  const validation = validateClaudeTarget(air, config);

  const files: TargetKitFile[] = [
    { path: `${dir}/target-profile.json`, bytes: json(profile) },
    {
      path: `${dir}/setup.json`,
      bytes: json({
        target: profile.id,
        version: profile.version,
        serverId,
        config,
        actionCount: served.length,
      }),
    },
    { path: `${dir}/mcp-config.stdio.json`, bytes: json(stdioConfig(serverId)) },
    { path: `${dir}/mcp-config.http.json`, bytes: json(httpConfig(serverId, config)) },
    { path: `${dir}/permissions.json`, bytes: json(permissionsConfig(served)) },
    { path: `${dir}/compatibility-report.json`, bytes: json(validation) },
    { path: `${dir}/README.md`, bytes: enc(readme(air, profile, config)) },
    ...(config.authMode === "oauth"
      ? [
          {
            path: `${dir}/connector-manifest.json`,
            bytes: json(connectorManifest(air, serverId, config)),
          },
        ]
      : []),
  ].sort((a, b) => a.path.localeCompare(b.path));

  return { targetId: profile.id, targetVersion: profile.version, files };
}

function serviceSlug(air: AirDocument): string {
  return air.service.id.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

/**
 * The stdio `mcpServers` entry. `<absolute-path-to-this-bundle>` is a
 * deliberate placeholder: the bundle's install location is not known at
 * generation time, and embedding a local absolute path would make the kit
 * non-deterministic across machines.
 */
function stdioConfig(serverId: string): Record<string, unknown> {
  return {
    mcpServers: {
      [serverId]: {
        command: "anvil",
        args: ["serve", "mcp", "<absolute-path-to-this-bundle>"],
      },
    },
  };
}

function httpConfig(serverId: string, config: ClaudeTargetConfig): Record<string, unknown> {
  return {
    mcpServers: {
      [serverId]: {
        type: "http",
        url: config.httpEndpoint || "<https://your-connector-host/mcp>",
      },
    },
  };
}

function connectorManifest(
  air: AirDocument,
  serverId: string,
  config: ClaudeTargetConfig,
): Record<string, unknown> {
  return {
    name: serverId,
    displayName: air.service.displayName ?? air.service.id,
    description: `${air.service.displayName ?? air.service.id} — MCP tool surface compiled by Anvil.`,
    remoteUrl: config.httpEndpoint,
    auth: {
      type: "oauth2",
      authorizationUrl: config.oauth.authorizationUrl,
      tokenUrl: config.oauth.tokenUrl,
      scopes: config.oauth.scopes,
      // Environment-variable NAMES only — never a secret value. Empty when
      // the operator relies on the client's own dynamic client registration.
      clientIdEnvVar: config.oauth.clientIdEnvVar ?? null,
      clientSecretEnvVar: config.oauth.clientSecretEnvVar ?? null,
    },
  };
}

function permissionsConfig(served: ReturnType<typeof servedOperations>): Record<string, unknown> {
  return {
    // The platform's tool-permission prompt hint per tool, derived only from
    // AIR confirmation — "ask" always wins; nothing here can loosen it.
    toolPermissions: Object.fromEntries(
      served.map((op) => [op.mcp.toolName, confirmationPermissionHint(op)]),
    ),
  };
}

function readme(
  air: AirDocument,
  profile: AgentPlatformTargetProfile,
  config: ClaudeTargetConfig,
): string {
  return `# ${air.service.displayName ?? air.service.id} — ${profile.displayName} target

This directory is the deterministic, non-secret target projection for
${profile.displayName}. It does not prove that the server is deployed or
reachable; it records configuration.

## Start here

1. Confirm \`compatibility-report.json\` has no errors.
2. For local/stdio use, merge \`mcp-config.stdio.json\` into your Claude
   config and replace the bundle path placeholder with this bundle's real
   absolute path.
3. For remote use, merge \`mcp-config.http.json\` into your Claude config.
${config.authMode === "oauth" ? "4. To register a shared connector, review `connector-manifest.json` and complete the interactive OAuth authorization in the connector directory.\n" : ""}
\`permissions.json\` records the tool-permission hint ("ask" | "allow") Claude
should use per tool, derived from contract-level confirmation — never
loosened by a platform default.
`;
}
