/**
 * Programmatic registration of a custom MCP server as a Gemini Enterprise
 * connector, via the Discovery Engine API.
 *
 * A custom MCP server is a `DataConnector` created by
 * `DataConnectorService.SetUpDataConnector`:
 *   POST https://discoveryengine.googleapis.com/v1/projects/{p}/locations/{l}:setUpDataConnector
 * The system sets `connector_type = REMOTE_MCP` (output-only) from
 * `data_source = custom_mcp`; `dynamic_tools` is output-only — the platform
 * fetches the tool list from the server itself (`tools/list`).
 *
 * This module BUILDS the request; it never sends it. Anvil holds no cloud
 * credentials — the emitted `registration.curl.sh` runs under the operator's own
 * Application Default Credentials.
 *
 * CONFIRMED against the live setUpDataConnector API + 7 real connectors in a live
 * GE project (2026-07-17, see docs/backtesting/GEMINI_ENTERPRISE_VALIDATION.md):
 *   - `data_source` is `"custom_mcp"` (the only identifier the platform resolves).
 *   - `params` carries `oauth_access_token` (the "Private App Access Token") at
 *     create; the server URL (`instance_uri`) is set in `action_config.action_params`
 *     and promoted into `params` by the system afterwards.
 *   - The MCP server URL + auth live in `action_config.action_params`:
 *     `auth_type` is `OAUTH` or `NO_AUTH` (the ONLY two the platform accepts),
 *     with `auth_uri` / `token_uri` / `scopes` / `client_id` / `client_secret`
 *     for OAUTH, plus `instance_uri`, `mcp_server_description`,
 *     `mcp_agent_instructions`, and `mcp_server_source = "BYO_MCP"`.
 *     `create_bap_connection = true`.
 *   - There is NO `end_user_config.auth_params`, and OAUTH client credentials are
 *     NOT accepted under `params` — the API rejects `client_id` there.
 *
 * IMPORTANT: the API creates the connector record but an OAUTH connector reaches
 * ACTIVE only after the interactive OAuth **Authorize** step (BAP-connection
 * provisioning) that the GE console performs — the raw API cannot complete the
 * user consent. That is recorded in `prerequisites`.
 */
import type { AirDocument } from "@anvil/air";

/** The two auth types a custom MCP server accepts (all others are rejected). */
export type McpAuthType = "OAUTH" | "NO_AUTH";

export interface RegistrationOptions {
  /** The MCP server's public URL (→ action_params.instance_uri). */
  endpoint?: string;
  /** GCP project id and location for the `:setUpDataConnector` URL. */
  project?: string;
  location?: string;
  /** Collection id/display name; defaulted from the service when omitted. */
  collectionId?: string;
  collectionDisplayName?: string;
  /** How the platform authenticates to the server. Defaults to `OAUTH`. */
  authType?: McpAuthType;
  /**
   * The static "Private App Access Token" the request seeds in
   * `params.oauth_access_token`. Supply it from Secret Manager at POST time —
   * never commit the token.
   */
  oauthAccessTokenRef?: string;
  /** Human/agent-facing description the platform shows for the server. */
  serverDescription?: string;
  agentInstructions?: string;
  /** OAUTH: the IdP OAuth client + endpoints (ignored when authType is NO_AUTH). */
  clientId?: string;
  /** Client secret as a Secret Manager reference (projects/…/secrets/…/versions/…). */
  clientSecretRef?: string;
  authUri?: string;
  tokenUri?: string;
  scopes?: string[];
}

export interface RegistrationRequest {
  /** The full `:setUpDataConnector` URL (project/location in the path). */
  url: string;
  /** The `SetUpDataConnectorRequest` body (REST/JSON field names). */
  body: SetUpDataConnectorBody;
  /** Operator prerequisites to satisfy before the connector will go ACTIVE. */
  prerequisites: string[];
}

interface SetUpDataConnectorBody {
  collectionId: string;
  collectionDisplayName: string;
  dataConnector: {
    dataSource: string;
    /** Required by the API; minimum 3h, maximum 28d. */
    refreshInterval: string;
    params: Record<string, unknown>;
    actionConfig: {
      actionParams: Record<string, unknown>;
      createBapConnection: boolean;
    };
  };
}

/** The confirmed REMOTE_MCP conventions, in ONE place. */
const REMOTE_MCP = {
  dataSource: "custom_mcp",
  /** BYO (self-hosted) MCP server, as opposed to a registry entry. */
  serverSource: "BYO_MCP",
  /** The API requires a refresh interval in [3h, 28d]; MCP connectors don't sync. */
  refreshInterval: "86400s",
  /** GE's fixed OAuth redirect URI — the IdP app registration must allow it. */
  oauthRedirectUri: "https://vertexaisearch.cloud.google.com/oauth-redirect",
};

const PLACEHOLDER = {
  // Clear, non-secret placeholders. The operator substitutes real values at POST
  // time (see registration.curl.sh); Anvil never holds or commits secrets.
  oauthAccessToken: "<PRIVATE_APP_ACCESS_TOKEN — inject from Secret Manager; do not commit>",
  clientId: "<oauth-client-id from your IdP app registration>",
  clientSecretRef: "<client secret — inject from Secret Manager; do not commit>",
  authUri: "<https://your-idp/authorize>",
  tokenUri: "<https://your-idp/token>",
};

function serviceSlug(air: AirDocument): string {
  return air.service.id.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

/**
 * Build the `SetUpDataConnector` request that registers this bundle's MCP server
 * as a Gemini Enterprise connector. Pure and deterministic. Values not supplied
 * become clearly-marked placeholders the operator fills before sending.
 */
export function buildRegistrationRequest(
  air: AirDocument,
  options: RegistrationOptions = {},
): RegistrationRequest {
  const project = options.project ?? "<project>";
  const location = options.location ?? "global";
  const slug = serviceSlug(air);
  const instanceUri = options.endpoint ?? "<https://your-connector-host/mcp>";
  const authType: McpAuthType = options.authType ?? "OAUTH";
  const description =
    options.serverDescription ??
    `${air.service.displayName ?? air.service.id} — MCP tool surface compiled by Anvil.`;

  const actionParams: Record<string, unknown> = {
    auth_type: authType,
    instance_uri: instanceUri,
    mcp_server_description: description,
    mcp_server_source: REMOTE_MCP.serverSource,
  };
  if (options.agentInstructions) actionParams.mcp_agent_instructions = options.agentInstructions;
  if (authType === "OAUTH") {
    actionParams.auth_uri = options.authUri ?? PLACEHOLDER.authUri;
    actionParams.token_uri = options.tokenUri ?? PLACEHOLDER.tokenUri;
    actionParams.scopes = (options.scopes ?? ["openid", "email"]).join(" ");
    actionParams.client_id = options.clientId ?? PLACEHOLDER.clientId;
    actionParams.client_secret = options.clientSecretRef ?? PLACEHOLDER.clientSecretRef;
  }

  const body: SetUpDataConnectorBody = {
    collectionId: options.collectionId ?? `${slug}-mcp`,
    collectionDisplayName:
      options.collectionDisplayName ?? `${air.service.displayName ?? air.service.id} (MCP)`,
    dataConnector: {
      dataSource: REMOTE_MCP.dataSource,
      refreshInterval: REMOTE_MCP.refreshInterval,
      // The token the platform seeds at create; the tool list is fetched from the
      // server (dynamic_tools is output-only), so no actions are enumerated here.
      params: { oauth_access_token: options.oauthAccessTokenRef ?? PLACEHOLDER.oauthAccessToken },
      actionConfig: { actionParams, createBapConnection: true },
    },
  };

  const prerequisites = [
    "Fill params.oauth_access_token from Secret Manager (the Private App Access Token); never commit it.",
    ...(authType === "OAUTH"
      ? [
          `Register an OAuth client at your IdP whose redirect URI is ${REMOTE_MCP.oauthRedirectUri}; put its client_id / client_secret (Secret Manager) and auth_uri / token_uri into the request.`,
          "Reaching ACTIVE requires the interactive OAuth Authorize step: create the connector in the GE console (or complete consent there). The raw API creates the record but cannot finish the OAuth consent / BAP-connection provisioning.",
        ]
      : []),
  ];

  return {
    url: `https://discoveryengine.googleapis.com/v1/projects/${project}/locations/${location}:setUpDataConnector`,
    body,
    prerequisites,
  };
}

/** The JSON request body, pretty-printed. */
export function renderRegistrationJson(req: RegistrationRequest): string {
  return `${JSON.stringify(req.body, null, 2)}\n`;
}

/**
 * A ready-to-run curl that POSTs the request with the operator's own access
 * token. Anvil holds no cloud credentials — this uses `gcloud auth print-access-token`.
 */
export function renderRegistrationCurl(req: RegistrationRequest): string {
  return `#!/usr/bin/env bash
# Register this MCP server as a Gemini Enterprise connector (Discovery Engine
# setUpDataConnector). Runs under YOUR credentials; Anvil holds none.
#
# Prerequisites:
${req.prerequisites.map((p) => `#   - ${p}`).join("\n")}
set -euo pipefail
curl -sS -X POST \\
  "${req.url}" \\
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \\
  -H "Content-Type: application/json" \\
  -d @registration.request.json
`;
}
