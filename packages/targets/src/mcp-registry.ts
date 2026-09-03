/**
 * The MCP registry target profile.
 *
 * Emits `server.json` — the entry a registry publish call would submit — plus
 * a publish PLAN (ordered steps, no execution). This package never performs
 * the publish call: Anvil holds no registry credentials, and a registry
 * submission is a deliberate, reviewed act, not something a compile step
 * should do on an operator's behalf.
 *
 * `server.json`'s core fields (`name`, `description`, `version`, `repository`,
 * `remotes`) follow the documented shape of the MCP registry's server entry.
 * No copy of its published JSON Schema was available to verify against
 * offline, so this is the documented minimum: Anvil-specific auth/transport
 * detail that is not part of the base schema is namespaced under `_meta.anvil`
 * rather than invented as top-level fields. Review the current registry
 * schema before submitting.
 */
import type { AirDocument } from "@anvil/air";
import {
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
  TargetValidationFinding,
  TargetValidationResult,
} from "./model.js";

export const MCP_REGISTRY_PROFILE: AgentPlatformTargetProfile = {
  id: "mcp-registry",
  version: "2026.09.1",
  displayName: "MCP Registry",
  transportRequirements: [{ kind: "streamable-http", requiresHttps: true, publicEndpoint: true }],
  authRequirements: [
    {
      kind: "oauth2",
      oauthFields: ["authorization_url", "token_url", "scopes"],
      inboundMode: "oidc",
    },
    { kind: "none", oauthFields: [] },
  ],
  // The registry itself does not cap a listed server's tool count; this bound
  // exists only so the shared model's positive-integer field has a value.
  actionLimits: { maxActions: 1000, requiresActionDescriptions: true },
  networkingRequirements: [
    {
      id: "public-https",
      description: "A publicly reachable HTTPS endpoint the registered `remotes` entry can call.",
    },
  ],
  unsupportedAssumptions: [
    "The registry does not enforce the API's auth for you — the MCP server must self-enforce it.",
    "Listing a server in the registry does not deploy it, and does not by itself grant any client access.",
  ],
  interactiveSteps: [
    {
      surface: "agent-registry",
      action: "Authenticate to the registry and submit server.json",
      where: "The registry's publish endpoint or CLI",
      why: "Publishing requires the operator's own registry credentials; Anvil holds none and never calls the publish endpoint.",
    },
  ],
  verificationStatus: "unverified",
};

export interface McpRegistryTargetConfig extends McpConnectorConfig {
  /** Registry server name, e.g. `io.github.<owner>/<slug>`. Defaults from the service id. */
  packageName: string;
  /** Semantic version submitted to the registry. Defaults to the AIR service version. */
  registryVersion: string;
  /** Optional source-repository URL recorded in `server.json`. */
  repositoryUrl?: string;
}

export interface McpRegistryTargetConfigInput extends McpConnectorConfigInput {
  packageName?: string;
  registryVersion?: string;
  repositoryUrl?: string;
}

export function createMcpRegistryTargetConfig(
  air: AirDocument,
  input: McpRegistryTargetConfigInput,
): McpRegistryTargetConfig {
  return {
    ...createMcpConnectorConfig(input),
    packageName: input.packageName?.trim() || defaultPackageName(air),
    registryVersion: input.registryVersion?.trim() || air.service.version,
    repositoryUrl: input.repositoryUrl?.trim() || undefined,
  };
}

function defaultPackageName(air: AirDocument): string {
  return `io.github.anvil/${air.service.id.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
}

const REGISTRY_NAME = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;

export function validateMcpRegistryTarget(
  air: AirDocument,
  config: McpRegistryTargetConfig,
): TargetValidationResult {
  const findings: TargetValidationFinding[] = [...validateMcpConnectorConfig(air, config)];
  if (!config.packageName) {
    findings.push({
      level: "error",
      code: "target/missing_registry_name",
      message: "The registry requires a server name via --name.",
    });
  } else if (!REGISTRY_NAME.test(config.packageName)) {
    findings.push({
      level: "error",
      code: "target/invalid_registry_name",
      message: `--name should look like <namespace>/<slug> (e.g. io.github.acme/refunds); got ${config.packageName}.`,
    });
  }
  if (!config.registryVersion) {
    findings.push({
      level: "error",
      code: "target/missing_registry_version",
      message: "The registry requires a version via --registry-version.",
    });
  }
  if (config.repositoryUrl) {
    try {
      const url = new URL(config.repositoryUrl);
      if (url.protocol !== "https:") throw new Error("not HTTPS");
    } catch {
      findings.push({
        level: "error",
        code: "target/invalid_repository_url",
        message: `--repository-url must be a valid HTTPS URL; got ${config.repositoryUrl}.`,
      });
    }
  }
  return { ok: !findings.some((f) => f.level === "error"), findings };
}

/** Build the MCP registry target kit: pure projection of AIR + profile + config. */
export function generateMcpRegistryTargetKit(
  air: AirDocument,
  profile: AgentPlatformTargetProfile,
  config: McpRegistryTargetConfig,
): TargetKit {
  const dir = `targets/${profile.id}`;
  const served = servedOperations(air);
  const validation = validateMcpRegistryTarget(air, config);

  const files: TargetKitFile[] = [
    { path: `${dir}/target-profile.json`, bytes: json(profile) },
    {
      path: `${dir}/setup.json`,
      bytes: json({
        target: profile.id,
        version: profile.version,
        config,
        actionCount: served.length,
      }),
    },
    { path: `${dir}/server.json`, bytes: json(serverJson(air, config)) },
    { path: `${dir}/publish-plan.json`, bytes: json(publishPlan(config)) },
    { path: `${dir}/compatibility-report.json`, bytes: json(validation) },
    { path: `${dir}/README.md`, bytes: enc(readme(air, profile)) },
  ].sort((a, b) => a.path.localeCompare(b.path));

  return { targetId: profile.id, targetVersion: profile.version, files };
}

function serverJson(air: AirDocument, config: McpRegistryTargetConfig): Record<string, unknown> {
  return {
    name: config.packageName,
    description: `${air.service.displayName ?? air.service.id} — MCP tool surface compiled by Anvil.`,
    version: config.registryVersion,
    ...(config.repositoryUrl
      ? { repository: { url: config.repositoryUrl, source: "github" } }
      : {}),
    remotes: [
      {
        type: "streamable-http",
        url: config.httpEndpoint || "<https://your-connector-host/mcp>",
      },
    ],
    // Anvil-specific detail with no home in the base schema. Namespaced so it
    // never collides with a field the registry does define.
    _meta: {
      anvil: {
        serverAuth: config.authMode,
        ...(config.authMode === "oauth"
          ? {
              oauth: {
                authorizationUrl: config.oauth.authorizationUrl,
                tokenUrl: config.oauth.tokenUrl,
                scopes: config.oauth.scopes,
              },
            }
          : {}),
      },
    },
  };
}

function publishPlan(config: McpRegistryTargetConfig): Record<string, unknown> {
  return {
    steps: [
      "Review server.json for accuracy; edit only outside this generated bundle and retarget.",
      "Authenticate to the registry with your own credentials (out of scope for Anvil; it holds none).",
      `Submit server.json to the registry's publish endpoint or CLI for ${config.packageName}@${config.registryVersion}.`,
      "Confirm the listing resolves and its `remotes[0].url` matches the deployed endpoint before announcing it.",
    ],
    executed: false,
    note: "Anvil never calls a registry publish endpoint. This plan is read-only guidance for a human operator.",
  };
}

function readme(air: AirDocument, profile: AgentPlatformTargetProfile): string {
  return `# ${air.service.displayName ?? air.service.id} — ${profile.displayName} target

This directory is the deterministic, non-secret target projection for
${profile.displayName}. It does not publish anything: \`publish-plan.json\`
is guidance for a human operator using their own registry credentials.

## Start here

1. Confirm \`compatibility-report.json\` has no errors.
2. Review \`server.json\`.
3. Follow \`publish-plan.json\`'s steps outside of Anvil.
`;
}
