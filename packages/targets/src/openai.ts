/**
 * The OpenAI (Responses API) target profile.
 *
 * Emits a remote MCP tool declaration (`type: "mcp"`, `server_url`,
 * `require_approval`) for clients that call the Responses API directly, plus
 * a function-tool fallback (one `type: "function"` tool per approved
 * operation, with its JSON Schema drawn from AIR) for clients that cannot
 * attach a remote MCP server.
 *
 * `require_approval` is derived per operation from AIR confirmation and can
 * only ever be `"always"` for a confirmation-required (or human-approval-
 * gated) operation — it is never downgraded to `"never"` by anything
 * platform-specific. See `requireApprovalTier` in `mcp-connector.ts` and the
 * `targets/approval-never-downgraded` mutant.
 *
 * NOT verified against a live platform API (no network calls are made by
 * this package, ever). The Responses API `type: "mcp"` tool shape and the
 * flat `type: "function"` tool shape are this package's documented-minimum
 * best effort; review against current OpenAI documentation before use.
 */

import type { AirDocument } from "@anvil/air";
import { operationInputSchema } from "@anvil/air";
import {
  createMcpConnectorConfig,
  enc,
  json,
  type McpConnectorConfig,
  type McpConnectorConfigInput,
  requireApprovalTier,
  servedOperations,
  validateMcpConnectorConfig,
} from "./mcp-connector.js";
import type {
  AgentPlatformTargetProfile,
  TargetKit,
  TargetKitFile,
  TargetValidationFinding,
  TargetValidationResult,
} from "./model.js";

export const OPENAI_PROFILE: AgentPlatformTargetProfile = {
  id: "openai",
  version: "2026.09.1",
  displayName: "OpenAI",
  transportRequirements: [{ kind: "streamable-http", requiresHttps: true, publicEndpoint: true }],
  authRequirements: [
    {
      kind: "oauth2",
      oauthFields: ["authorization_url", "token_url", "scopes"],
      inboundMode: "oidc",
    },
    { kind: "none", oauthFields: [] },
  ],
  // Not verified against current OpenAI documentation — unenforced upper bound.
  actionLimits: { maxActions: 128, requiresActionDescriptions: true },
  networkingRequirements: [
    {
      id: "public-https",
      description: "A publicly reachable HTTPS endpoint the Responses API can call.",
    },
  ],
  unsupportedAssumptions: [
    "The platform does not enforce the API's auth for you — the MCP server must self-enforce it.",
    "The platform's own approval prompt does not replace contract-level confirmation for irreversible actions.",
  ],
  interactiveSteps: [
    {
      surface: "agent-registry",
      action: "Attach the MCP tool (or the function-tool fallback) to a Responses API request",
      where: "Your application's Responses API integration",
      why: "There is no registry to import into; the tool declaration is supplied per request by the caller.",
    },
  ],
  verificationStatus: "unverified",
};

export type OpenAiTargetConfig = McpConnectorConfig;
export type OpenAiTargetConfigInput = McpConnectorConfigInput;

export function createOpenAiTargetConfig(input: OpenAiTargetConfigInput): OpenAiTargetConfig {
  return createMcpConnectorConfig(input);
}

export function validateOpenAiTarget(
  air: AirDocument,
  config: OpenAiTargetConfig,
): TargetValidationResult {
  const findings = [
    ...validateMcpConnectorConfig(air, config),
    ...checkApprovalNeverDowngraded(air),
  ];
  return { ok: !findings.some((f) => f.level === "error"), findings };
}

/**
 * Defense in depth, independent of `generateOpenAiTargetKit`'s own mapping:
 * re-derive the approval tier from AIR and refuse if any confirmation-required
 * operation would map to anything but `"always"`.
 */
function checkApprovalNeverDowngraded(air: AirDocument): TargetValidationFinding[] {
  const findings: TargetValidationFinding[] = [];
  for (const op of servedOperations(air)) {
    const requiresConfirmation = op.confirmation.required || op.confirmation.humanApproval === true;
    if (requiresConfirmation && requireApprovalTier(op) !== "always") {
      findings.push({
        level: "error",
        code: "target/approval_downgraded",
        message: `${op.mcp.toolName} requires contract-level confirmation but its require_approval tier is not "always".`,
      });
    }
  }
  return findings;
}

/** Build the OpenAI target kit: pure projection of AIR + profile + config. */
export function generateOpenAiTargetKit(
  air: AirDocument,
  profile: AgentPlatformTargetProfile,
  config: OpenAiTargetConfig,
): TargetKit {
  const dir = `targets/${profile.id}`;
  const served = servedOperations(air);
  const serverLabel = serviceSlug(air);
  const validation = validateOpenAiTarget(air, config);

  const files: TargetKitFile[] = [
    { path: `${dir}/target-profile.json`, bytes: json(profile) },
    {
      path: `${dir}/setup.json`,
      bytes: json({
        target: profile.id,
        version: profile.version,
        serverLabel,
        config,
        actionCount: served.length,
      }),
    },
    {
      path: `${dir}/responses-tool.json`,
      bytes: json(responsesTool(air, serverLabel, config, served)),
    },
    { path: `${dir}/function-tools.json`, bytes: json(functionTools(served)) },
    { path: `${dir}/compatibility-report.json`, bytes: json(validation) },
    { path: `${dir}/README.md`, bytes: enc(readme(air, profile)) },
  ].sort((a, b) => a.path.localeCompare(b.path));

  return { targetId: profile.id, targetVersion: profile.version, files };
}

function serviceSlug(air: AirDocument): string {
  return air.service.id.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function responsesTool(
  air: AirDocument,
  serverLabel: string,
  config: OpenAiTargetConfig,
  served: ReturnType<typeof servedOperations>,
): Record<string, unknown> {
  const always = served
    .filter((op) => requireApprovalTier(op) === "always")
    .map((op) => op.mcp.toolName);
  const never = served
    .filter((op) => requireApprovalTier(op) === "never")
    .map((op) => op.mcp.toolName);
  return {
    type: "mcp",
    server_label: serverLabel,
    server_description: `${air.service.displayName ?? air.service.id} — MCP tool surface compiled by Anvil.`,
    server_url: config.httpEndpoint || "<https://your-connector-host/mcp>",
    require_approval:
      always.length === 0
        ? "never"
        : never.length === 0
          ? "always"
          : { always: { tool_names: always }, never: { tool_names: never } },
  };
}

function functionTools(served: ReturnType<typeof servedOperations>): Record<string, unknown> {
  return {
    tools: served.map((op) => ({
      type: "function",
      name: op.mcp.toolName,
      description: op.description || op.displayName,
      parameters: op.input.schema ?? operationInputSchema(op),
    })),
  };
}

function readme(air: AirDocument, profile: AgentPlatformTargetProfile): string {
  return `# ${air.service.displayName ?? air.service.id} — ${profile.displayName} target

This directory is the deterministic, non-secret target projection for
${profile.displayName}. It does not prove that the server is deployed or
reachable; it records configuration.

## Start here

1. Confirm \`compatibility-report.json\` has no errors.
2. Attach \`responses-tool.json\`'s object as one entry of a Responses API
   request's \`tools\` array for MCP-capable clients, or \`function-tools.json\`'s
   \`tools\` array for clients that call approved operations as functions.

\`require_approval\` in \`responses-tool.json\` is derived from contract-level
confirmation and can only ever be stricter than the platform default, never
looser — see \`targets/approval-never-downgraded\`.
`;
}
