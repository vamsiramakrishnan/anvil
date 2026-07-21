/**
 * Generate the registration + operations kit for a target platform. Pure and
 * deterministic: sorted, no timestamps, so the same contract + profile produce
 * byte-identical kit files. The files become pack artifacts under
 * `targets/<id>/`.
 */
import type { AirDocument } from "@anvil/air";
import { surfaceSignatureFor } from "@anvil/compiler";
import type { AgentPlatformTargetProfile, TargetKit, TargetKitFile } from "./model.js";
import {
  renderAgentGatewayRunbook,
  renderAgentGatewayYaml,
  renderAgentRegistryScript,
  renderAgentRegistryTf,
  renderToolSpecJson,
} from "./agent-registry.js";
import {
  buildRegistrationRequest,
  renderRegistrationCurl,
  renderRegistrationJson,
} from "./registration.js";
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
    // A public connector overlays the generic Cloud Run deploy: flip ingress to
    // public (the server's own OAuth check is the gate) and inject the inbound
    // env. Copy these into deploy/terraform/ and apply.
    ...(isPublicConnector(profile)
      ? [
          {
            path: `${dir}/terraform/connector.auto.tfvars`,
            bytes: enc(connectorTfvars(profile, options.endpoint)),
          },
          { path: `${dir}/terraform/connector.tf`, bytes: enc(connectorTf(profile)) },
        ]
      : []),
    // The programmatic registration: a ready SetUpDataConnector request body and
    // a curl that POSTs it under the operator's own credentials.
    ...(isPublicConnector(profile)
      ? (() => {
          const reg = buildRegistrationRequest(
            air,
            options.endpoint ? { endpoint: options.endpoint } : {},
          );
          return [
            { path: `${dir}/registration.request.json`, bytes: enc(renderRegistrationJson(reg)) },
            { path: `${dir}/registration.curl.sh`, bytes: enc(renderRegistrationCurl(reg)) },
          ];
        })()
      : []),
    // The Agent Registry / Agent Gateway surface: the fully-programmatic
    // alternative to the DataConnector (no interactive OAuth consent). Toolspec is
    // generated from the same approved operations, so it never drifts.
    ...(isPublicConnector(profile)
      ? (() => {
          const ar = options.endpoint ? { endpoint: options.endpoint } : {};
          return [
            { path: `${dir}/agent-registry/toolspec.json`, bytes: enc(renderToolSpecJson(air)) },
            {
              path: `${dir}/agent-registry/agent-gateway.yaml`,
              bytes: enc(renderAgentGatewayYaml(air, ar)),
            },
            {
              path: `${dir}/agent-registry/agent-registry.tf`,
              bytes: enc(renderAgentRegistryTf(air, ar)),
            },
            {
              path: `${dir}/agent-registry/register.sh`,
              bytes: enc(renderAgentRegistryScript(air, ar)),
            },
            {
              path: `${dir}/agent-registry/agent-gateway.md`,
              bytes: enc(renderAgentGatewayRunbook(air, ar)),
            },
          ];
        })()
      : []),
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
    "The kit builds the Discovery Engine `setUpDataConnector` body",
    "(registration.request.json). NOTE: the raw API creates the connector record but",
    "an OAUTH connector reaches ACTIVE only after the console's interactive OAuth",
    "Authorize step, so the console is the reliable path for step 5, not just an",
    "alternative.",
    "",
    "1. Deploy the generated StreamableHTTP MCP server to a public HTTPS endpoint",
    `   (${url}). SSE is not supported by ${profile.displayName}. The server is`,
    "   session-based (mints an mcp-session-id on initialize) so the platform can",
    "   fetch the tool list — do not make it stateless.",
    "2. Configure the server's inbound auth from inbound-auth.env. For auth_type=OAUTH",
    "   the platform presents the user's IdP token to /mcp; the server validates it",
    "   as an OIDC resource server (issuer/audience from your IdP).",
    "3. Prerequisites: grant the admin discoveryengine.editor, ensure the server URL",
    "   is reachable (a 'protected' project also requires it allowlisted — 403",
    "   otherwise; the console's Custom MCP flow allowlists it).",
    "4. Register an OAuth client at your IdP (Entra/Google/Okta) whose redirect URI",
    "   is https://vertexaisearch.cloud.google.com/oauth-redirect. Put its client_id /",
    "   client_secret (Secret Manager) and auth_uri / token_uri / scopes into the",
    "   connector's action_config.action_params. auth_type is OAUTH or NO_AUTH only —",
    "   the API rejects any other value. (Or use NO_AUTH for an unauthenticated server.)",
    "5. Create the connector in the console: Data stores → Create data store →",
    "   Custom MCP Server, using registration.request.json's values, then click",
    "   Authorize to complete OAuth consent. (registration.curl.sh POSTs the same body,",
    "   but the API alone cannot finish the consent / BAP-connection provisioning.)",
    `   The platform then fetches the tool list from the server; keep it under ${profile.actionLimits.maxActions} actions.`,
    "6. Confirm compatibility-report.json has no errors before enabling for agents.",
    "",
  ].join("\n");
}

/** A connector whose platform reaches the server over the public internet. */
function isPublicConnector(profile: AgentPlatformTargetProfile): boolean {
  return profile.transportRequirements.some((t) => t.publicEndpoint);
}

/**
 * The inbound-auth env map (Terraform `var.env`), from the primary auth scheme.
 * For Gemini Enterprise's `OAUTH` connector the platform presents the user's IdP
 * token to `/mcp`, so the server validates it as an OIDC resource server: the
 * issuer and audience come from YOUR IdP / OAuth client, not from the endpoint.
 */
function inboundEnvEntries(
  profile: AgentPlatformTargetProfile,
  endpoint?: string,
): Record<string, string> {
  const primary = profile.authRequirements[0];
  const mode = profile.authRequirements.find((a) => a.inboundMode)?.inboundMode ?? "oidc";
  // A profile whose primary scheme is NO_AUTH (kind "none") admits everything.
  if (primary && primary.kind === "none") {
    return { ANVIL_INBOUND_AUTH_MODE: "none" };
  }
  if (mode === "google_service_account") {
    return {
      ANVIL_INBOUND_AUTH_MODE: "google_service_account",
      ANVIL_INBOUND_AUDIENCE: endpoint ?? "<the connector's public URL>",
    };
  }
  return {
    ANVIL_INBOUND_AUTH_MODE: "oidc",
    ANVIL_INBOUND_ISSUER: "<your IdP issuer, e.g. https://login.microsoftonline.com/<tenant>/v2.0>",
    ANVIL_INBOUND_AUDIENCE: "<your OAuth client id / resource audience>",
  };
}

/**
 * The public-connector overlay for the generic Cloud Run deploy: flip ingress to
 * public and inject the inbound-auth env. The server's own OAuth resource-server
 * check is the gate — Cloud Run only admits the request at the edge.
 */
function connectorTfvars(profile: AgentPlatformTargetProfile, endpoint?: string): string {
  const env = inboundEnvEntries(profile, endpoint);
  return `${[
    `# ${profile.displayName} — public-connector overlay for the generic Cloud Run deploy.`,
    "# Copy into deploy/terraform/ (auto-loaded) before `terraform apply`.",
    "# The platform reaches /mcp over the internet; the server's inbound OAuth check",
    "# (ANVIL_INBOUND_*) is the real gate, never network reachability alone.",
    'ingress               = "INGRESS_TRAFFIC_ALL"',
    "allow_unauthenticated = true",
    "env = {",
    ...Object.entries(env).map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`),
    "}",
    "",
  ].join("\n")}`;
}

/** Platform IAM + org-policy overlay Terraform for the connector. */
function connectorTf(profile: AgentPlatformTargetProfile): string {
  return `${[
    `# ${profile.displayName} connector — platform IAM + org-policy overlay.`,
    "# Copy into deploy/terraform/ and apply alongside the generic module.",
    "#",
    "# The admin who registers the custom MCP data store needs discoveryengine.editor",
    '# (or the "Gemini Enterprise Admin" role). Scope it to a named principal.',
    'variable "gemini_registrar_member" {',
    "  type    = string",
    '  default = ""',
    "}",
    'resource "google_project_iam_member" "gemini_registrar" {',
    '  count   = var.gemini_registrar_member == "" ? 0 : 1',
    "  project = var.project_id",
    '  role    = "roles/discoveryengine.editor"',
    "  member  = var.gemini_registrar_member",
    "}",
    "",
    "# Org policy: the platform requires the FQDNs of the server URL, authorization",
    "# URL, and token URL to be allowlisted for custom MCP. That is an organization",
    "# policy set per current Google docs (see organization-policy-checklist.md),",
    "# not a per-service resource — configure it at the org level.",
    "",
  ].join("\n")}`;
}

/**
 * The inbound-auth environment contract for the connector's MCP server. These
 * are non-secret configuration values read by `@anvil/mcp-runtime`'s resource
 * server; the actual token is presented by the platform at call time. Defaults
 * to the profile's first auth scheme, with the alternative shown commented.
 */
function inboundAuthEnv(profile: AgentPlatformTargetProfile, _endpoint?: string): string {
  const noAuthPrimary = profile.authRequirements[0]?.kind === "none";
  const lines = [
    `# Inbound auth for the ${profile.displayName} connector's MCP server.`,
    "# The server is an OAuth 2 resource server: it validates the bearer token the",
    "# platform presents on /mcp. These are non-secret config values, not secrets.",
    "",
  ];
  if (noAuthPrimary) {
    lines.push(
      "# auth_type=NO_AUTH — the platform calls /mcp without a token. Only safe",
      "# behind other controls (private network, mTLS, etc.).",
      "ANVIL_INBOUND_AUTH_MODE=none",
      "",
      "# To require a token instead, switch the connector to auth_type=OAUTH and:",
      "# ANVIL_INBOUND_AUTH_MODE=oidc",
      "# ANVIL_INBOUND_ISSUER=<your IdP issuer>",
      "# ANVIL_INBOUND_AUDIENCE=<your OAuth client id / resource audience>",
    );
  } else {
    lines.push(
      "# auth_type=OAUTH — the platform runs a user-delegated OAuth flow with your",
      "# IdP and presents the user's token to /mcp. The server validates it as an",
      "# OIDC resource server; issuer + audience come from YOUR IdP / OAuth client.",
      "ANVIL_INBOUND_AUTH_MODE=oidc",
      "ANVIL_INBOUND_ISSUER=<your IdP issuer, e.g. https://login.microsoftonline.com/<tenant>/v2.0>",
      "ANVIL_INBOUND_AUDIENCE=<your OAuth client id / resource audience>",
      "# ANVIL_INBOUND_JWKS_URI=<override; otherwise discovered from the issuer>",
      "# ANVIL_INBOUND_REQUIRED_SCOPES=<space-separated scopes the token must carry>",
      "",
      "# Alternative: auth_type=NO_AUTH (no token presented).",
      "# ANVIL_INBOUND_AUTH_MODE=none",
    );
  }
  return `${lines.join("\n")}\n`;
}
