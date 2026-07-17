/**
 * Programmatic registration of a custom MCP server as a Gemini Enterprise
 * connector, via the Discovery Engine API.
 *
 * A custom MCP server is a `DataConnector` created by
 * `DataConnectorService.SetUpDataConnector`:
 *   POST https://discoveryengine.googleapis.com/v1/projects/{p}/locations/{l}:setUpDataConnector
 * The system sets `connector_type = REMOTE_MCP` from the `data_source`; the MCP
 * server URL and auth live in the connector's free-form Struct params
 * (`instance_uri`, `action_config.action_params`), with the client secret passed
 * as a Secret Manager reference; and `dynamic_tools` is output-only — the
 * platform fetches the tool list from the server itself.
 *
 * This module BUILDS the request; it never sends it. Anvil holds no cloud
 * credentials — the emitted `registration.curl.sh` runs under the operator's own
 * Application Default Credentials.
 *
 * TWO VALUES ARE PROVISIONAL. The RPC reference types these fields as
 * `google.protobuf.Struct` (free-form JSON), so it does not pin down (a) the
 * exact `data_source` identifier for a remote-MCP connector, or (b) whether the
 * OAuth params belong under `action_config.action_params` (server-side) or
 * `end_user_config.auth_params` (user-delegated). Both are isolated in
 * `REMOTE_MCP` below and marked, so a single edit corrects them once confirmed
 * against a live project or a Google sample.
 */
import type { AirDocument } from "@anvil/air";

export interface RegistrationOptions {
  /** The MCP server's public URL (→ params.instance_uri). */
  endpoint?: string;
  /** GCP project id and location for the `:setUpDataConnector` URL. */
  project?: string;
  location?: string;
  /** Collection id/display name; defaulted from the service when omitted. */
  collectionId?: string;
  collectionDisplayName?: string;
  /** OAuth the platform uses to call the server (from your IdP). */
  clientId?: string;
  /** Client secret as a Secret Manager reference (projects/…/secrets/…/versions/…). */
  clientSecretRef?: string;
  authorizationUri?: string;
  tokenUri?: string;
  scopes?: string[];
}

export interface RegistrationRequest {
  /** The full `:setUpDataConnector` URL (project/location in the path). */
  url: string;
  /** The `SetUpDataConnectorRequest` body (REST/JSON field names). */
  body: SetUpDataConnectorBody;
  /** Fields still to be confirmed against a live project (see module docstring). */
  provisional: string[];
}

interface SetUpDataConnectorBody {
  collectionId: string;
  collectionDisplayName: string;
  dataConnector: {
    dataSource: string;
    params: Record<string, unknown>;
    actionConfig?: { isActionConfigured: boolean; actionParams: Record<string, unknown> };
  };
}

/**
 * The two provisional REMOTE_MCP conventions, in ONE place. `dataSource` is the
 * connector identifier the RPC reference says to "refer to the documentation
 * for"; the OAuth params are placed under `action_config.action_params` (the
 * platform authenticating TO the server as an OAuth client), which is the most
 * likely split but is not fixed by the proto. Confirm both against a live
 * project, then delete the `provisional` entries they produce.
 */
const REMOTE_MCP = {
  dataSource: "custom_mcp",
  oauthUnder: "action_config.action_params" as const,
};

const PLACEHOLDER = {
  clientId: "<oauth-client-id>",
  clientSecretRef: "projects/<project>/secrets/<secret>/versions/latest",
  authorizationUri: "<https://your-idp/authorize>",
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

  const actionParams: Record<string, unknown> = {
    client_id: options.clientId ?? PLACEHOLDER.clientId,
    client_secret: options.clientSecretRef ?? PLACEHOLDER.clientSecretRef,
    authorization_uri: options.authorizationUri ?? PLACEHOLDER.authorizationUri,
    token_uri: options.tokenUri ?? PLACEHOLDER.tokenUri,
    scopes: (options.scopes ?? []).join(" "),
  };

  const body: SetUpDataConnectorBody = {
    collectionId: options.collectionId ?? `${slug}-mcp`,
    collectionDisplayName:
      options.collectionDisplayName ?? `${air.service.displayName ?? air.service.id} (MCP)`,
    dataConnector: {
      dataSource: REMOTE_MCP.dataSource,
      // The MCP server URL. The platform fetches the tool list from it
      // (dynamic_tools is output-only), so no actions are enumerated here.
      params: { instance_uri: instanceUri },
      actionConfig: { isActionConfigured: true, actionParams },
    },
  };

  const provisional = [
    `dataConnector.dataSource="${REMOTE_MCP.dataSource}" — confirm the REMOTE_MCP connector identifier`,
    `OAuth params placed under ${REMOTE_MCP.oauthUnder} — confirm vs end_user_config.auth_params`,
  ];

  return {
    url: `https://discoveryengine.googleapis.com/v1/projects/${project}/locations/${location}:setUpDataConnector`,
    body,
    provisional,
  };
}

/** The JSON request body, pretty-printed. */
export function renderRegistrationJson(req: RegistrationRequest): string {
  return `${JSON.stringify(req.body, null, 2)}\n`;
}

/**
 * A ready-to-run curl that POSTs the request with the operator's own access
 * token. Anvil holds no credentials — this uses `gcloud auth print-access-token`.
 */
export function renderRegistrationCurl(req: RegistrationRequest): string {
  return `#!/usr/bin/env bash
# Register this MCP server as a Gemini Enterprise connector (Discovery Engine
# setUpDataConnector). Runs under YOUR credentials; Anvil holds none.
#
# PROVISIONAL — confirm before running:
${req.provisional.map((p) => `#   - ${p}`).join("\n")}
set -euo pipefail
curl -sS -X POST \\
  "${req.url}" \\
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \\
  -H "Content-Type: application/json" \\
  -d @registration.request.json
`;
}
