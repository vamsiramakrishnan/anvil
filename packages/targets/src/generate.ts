/**
 * Generate the registration + operations kit for a target platform. Pure and
 * deterministic: sorted, no timestamps, so the same contract + profile produce
 * byte-identical kit files. The files become pack artifacts under
 * `targets/<id>/`.
 */
import type { AirDocument } from "@anvil/air";
import { surfaceSignatureFor } from "@anvil/compiler";
import type { AgentPlatformTargetProfile, TargetKit, TargetKitFile } from "./model.js";
import { validateTarget } from "./validate.js";

const enc = (s: string) => new TextEncoder().encode(s);
const json = (v: unknown) => enc(`${JSON.stringify(v, null, 2)}\n`);

export interface GenerateTargetOptions {
  endpoint?: string;
  serverDescription?: string;
}

/** Build the target kit for a capability's contract. */
export function generateTargetKit(
  air: AirDocument,
  profile: AgentPlatformTargetProfile,
  options: GenerateTargetOptions = {},
): TargetKit {
  const dir = `targets/${profile.id}`;
  const served = air.operations
    .filter((o) => o.state === "approved")
    .sort((a, b) => a.mcp.toolName.localeCompare(b.mcp.toolName));
  const signature = surfaceSignatureFor(air);
  const compatibility = validateTarget(air, profile, { endpoint: options.endpoint });

  const oauthTemplate = Object.fromEntries(
    (profile.authRequirements.find((a) => a.kind === "oauth2")?.oauthFields ?? []).map((f) => [
      f,
      "",
    ]),
  );

  const files: TargetKitFile[] = [
    { path: `${dir}/target-profile.json`, bytes: json(profile) },
    {
      path: `${dir}/setup.json`,
      bytes: json({
        target: profile.id,
        version: profile.version,
        transport: profile.transportRequirements[0]?.kind ?? "streamable-http",
        endpoint: options.endpoint ?? null,
        auth: profile.authRequirements[0]?.kind ?? "none",
        actionCount: served.length,
        surfaceSignatureDigest: signature.digest,
      }),
    },
    { path: `${dir}/oauth.template.json`, bytes: json(oauthTemplate) },
    { path: `${dir}/inbound-auth.env`, bytes: enc(inboundAuthEnv(profile, options.endpoint)) },
    {
      path: `${dir}/server-description.md`,
      bytes: enc(serverDescription(air, profile, options.serverDescription)),
    },
    {
      path: `${dir}/action-selection.json`,
      bytes: json({
        actions: served.map((o) => ({
          name: o.mcp.toolName,
          description: o.description || o.displayName,
          mutating: o.effect.kind === "mutation",
          confirms: o.confirmation.required,
        })),
      }),
    },
    { path: `${dir}/organization-policy-checklist.md`, bytes: enc(orgPolicyChecklist(profile)) },
    { path: `${dir}/admin-runbook.md`, bytes: enc(adminRunbook(air, profile, options.endpoint)) },
    { path: `${dir}/compatibility-report.json`, bytes: json(compatibility) },
  ].sort((a, b) => a.path.localeCompare(b.path));

  return { targetId: profile.id, targetVersion: profile.version, files };
}

function serverDescription(
  air: AirDocument,
  profile: AgentPlatformTargetProfile,
  override?: string,
): string {
  if (override) return `${override}\n`;
  const caps = air.capabilities.map((c) => `- ${c.displayName}: ${c.description || c.id}`).sort();
  return `# ${air.service.displayName ?? air.service.id}\n\nRegistered with ${profile.displayName}.\n\n## Capabilities\n${caps.join("\n")}\n`;
}

function orgPolicyChecklist(profile: AgentPlatformTargetProfile): string {
  const net = profile.networkingRequirements.map((n) => `- [ ] ${n.description}`).join("\n");
  const assume = profile.unsupportedAssumptions.map((a) => `- [ ] ${a}`).join("\n");
  return `# Organization policy checklist — ${profile.displayName}\n\n## Networking\n${net}\n\n## Do not assume\n${assume}\n`;
}

function adminRunbook(
  air: AirDocument,
  profile: AgentPlatformTargetProfile,
  endpoint?: string,
): string {
  const url = endpoint ?? "https://<your-connector-host>/mcp";
  return [
    `# Admin runbook — ${air.service.displayName ?? air.service.id} on ${profile.displayName}`,
    "",
    "The final registration of a custom MCP data store has no public API today, so",
    "step 5 is a console (or Agent Registry) action. Everything before it is",
    "scriptable and produced by this kit.",
    "",
    "1. Deploy the generated StreamableHTTP MCP server to a public HTTPS endpoint",
    `   (${url}). SSE is not supported by ${profile.displayName}.`,
    "2. Configure the server's inbound auth from inbound-auth.env — it validates",
    "   the token the platform presents on /mcp as an OAuth 2 resource server.",
    "3. Prerequisites: grant the admin the required IAM role, override the org",
    "   policy that blocks custom MCP, and allowlist the FQDNs of the server URL,",
    "   authorization URL, and token URL (see organization-policy-checklist.md).",
    "4. Register the platform as an OAuth client with your IdP; put its client id /",
    "   secret and the authorization/token URLs into oauth.template.json. The",
    "   client's token audience MUST equal ANVIL_INBOUND_AUDIENCE and its scopes",
    "   MUST cover ANVIL_INBOUND_REQUIRED_SCOPES.",
    `5. In the console: Data stores → Create data store → Custom MCP Server → enter`,
    `   ${url} and the auth details. Enable at most ${profile.actionLimits.maxActions} actions.`,
    "6. Confirm compatibility-report.json has no errors before enabling for agents.",
    "",
  ].join("\n");
}

/**
 * The inbound-auth environment contract for the connector's MCP server. These
 * are non-secret configuration values read by `@anvil/mcp-runtime`'s resource
 * server; the actual token is presented by the platform at call time. Defaults
 * to the profile's first auth scheme, with the alternative shown commented.
 */
function inboundAuthEnv(profile: AgentPlatformTargetProfile, endpoint?: string): string {
  const audience = endpoint ?? "<the connector's public URL, e.g. https://host/mcp>";
  const primary = profile.authRequirements.find((a) => a.inboundMode)?.inboundMode ?? "oidc";
  const lines = [
    `# Inbound auth for the ${profile.displayName} connector's MCP server.`,
    "# The server is an OAuth 2 resource server: it validates the bearer token the",
    "# platform presents on /mcp. These are non-secret config values, not secrets.",
    "",
  ];
  if (primary === "oidc") {
    lines.push(
      "# User-delegated OAuth (OIDC) — per-user identity.",
      "ANVIL_INBOUND_AUTH_MODE=oidc",
      "ANVIL_INBOUND_ISSUER=<your IdP issuer, e.g. https://accounts.google.com>",
      `ANVIL_INBOUND_AUDIENCE=${audience}`,
      "# ANVIL_INBOUND_JWKS_URI=<override; otherwise discovered from the issuer>",
      "# ANVIL_INBOUND_REQUIRED_SCOPES=read write",
      "",
      "# Alternative: Google service-account token (machine identity).",
      "# ANVIL_INBOUND_AUTH_MODE=google_service_account",
      `# ANVIL_INBOUND_AUDIENCE=${audience}`,
    );
  } else {
    lines.push(
      "# Google service-account token (machine identity).",
      "ANVIL_INBOUND_AUTH_MODE=google_service_account",
      `ANVIL_INBOUND_AUDIENCE=${audience}`,
      "",
      "# Alternative: user-delegated OAuth (OIDC).",
      "# ANVIL_INBOUND_AUTH_MODE=oidc",
      "# ANVIL_INBOUND_ISSUER=<your IdP issuer>",
      `# ANVIL_INBOUND_AUDIENCE=${audience}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
