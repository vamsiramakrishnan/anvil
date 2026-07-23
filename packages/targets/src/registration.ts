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

const TEMPLATE_MARKER = {
  // The generated artifact is a non-secret template. The experimental script
  // replaces these markers only in a mode-0600 temporary body and trap-deletes it.
  oauthAccessToken: "${ANVIL_PRIVATE_APP_ACCESS_TOKEN}",
  clientId: "${ANVIL_OAUTH_CLIENT_ID}",
  clientSecretRef: "${ANVIL_OAUTH_CLIENT_SECRET}",
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
    actionParams.auth_uri = options.authUri ?? TEMPLATE_MARKER.authUri;
    actionParams.token_uri = options.tokenUri ?? TEMPLATE_MARKER.tokenUri;
    actionParams.scopes = (options.scopes ?? ["<scope-for-your-mcp-api>"]).join(" ");
    actionParams.client_id = options.clientId ?? TEMPLATE_MARKER.clientId;
    actionParams.client_secret = options.clientSecretRef ?? TEMPLATE_MARKER.clientSecretRef;
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
      params: {
        oauth_access_token: options.oauthAccessTokenRef ?? TEMPLATE_MARKER.oauthAccessToken,
      },
      actionConfig: { actionParams, createBapConnection: true },
    },
  };

  const prerequisites = [
    "Provide the Private App Access Token to the experimental script through ANVIL_PRIVATE_APP_ACCESS_TOKEN or ANVIL_PRIVATE_APP_ACCESS_TOKEN_FILE; never edit it into the template.",
    ...(authType === "OAUTH"
      ? [
          `Register an OAuth client at your IdP whose redirect URI is ${REMOTE_MCP.oauthRedirectUri}; provide its id and secret at runtime through ANVIL_OAUTH_CLIENT_ID[_FILE] and ANVIL_OAUTH_CLIENT_SECRET[_FILE].`,
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

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * An explicitly experimental reference curl. The supported journey is console-first:
 * the API cannot complete OAuth consent. The script runs under the operator's own
 * credentials, renders secrets only into a protected temporary body, and skips an
 * existing collection.
 */
export function renderRegistrationCurl(req: RegistrationRequest): string {
  const parentUrl = req.url.replace(/:setUpDataConnector$/, "");
  const collectionUrl = `${parentUrl}/collections/${encodeURIComponent(req.body.collectionId)}`;
  const authType = req.body.dataConnector.actionConfig.actionParams.auth_type as McpAuthType;
  return `#!/usr/bin/env bash
# EXPERIMENTAL REFERENCE: create the connector record with setUpDataConnector.
# The supported Custom MCP journey is console-first. This API cannot finish
# interactive OAuth consent / BAP provisioning.
#
# Prerequisites:
${req.prerequisites.map((p) => `#   - ${p}`).join("\n")}
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
REQUEST_TEMPLATE="$SCRIPT_DIR/registration.request.template.json"
COLLECTION_URL=${shellLiteral(collectionUrl)}
SETUP_URL=${shellLiteral(req.url)}
AUTH_TYPE=${shellLiteral(authType)}
COLLECTION_ID=${shellLiteral(req.body.collectionId)}
COLLECTION_DISPLAY_NAME=${shellLiteral(req.body.collectionDisplayName)}
ENDPOINT=${shellLiteral(
    String(req.body.dataConnector.actionConfig.actionParams.instance_uri ?? ""),
  )}

if [[ "\${ANVIL_EXPERIMENTAL_SETUP_DATA_CONNECTOR:-}" != "1" ]]; then
  echo "This reference API path cannot complete OAuth consent." >&2
  echo "Use the Gemini Enterprise console-first Custom MCP flow, or explicitly set:" >&2
  echo "  ANVIL_EXPERIMENTAL_SETUP_DATA_CONNECTOR=1 bash \\"$SCRIPT_DIR/registration.curl.sh\\"" >&2
  exit 2
fi
for required_command in gcloud curl jq; do
  command -v "$required_command" >/dev/null 2>&1 || {
    echo "Missing required command: $required_command" >&2
    exit 1
  }
done

TOKEN="$(gcloud auth print-access-token)"
CHECK_BODY="$(mktemp)"
TEMP_BODY=""
SETUP_RESPONSE="$(mktemp)"
chmod 600 "$CHECK_BODY" "$SETUP_RESPONSE"
cleanup() {
  unset TOKEN ANVIL_RENDER_PRIVATE_APP_ACCESS_TOKEN ANVIL_RENDER_OAUTH_CLIENT_ID ANVIL_RENDER_OAUTH_CLIENT_SECRET
  rm -f "$CHECK_BODY" "$SETUP_RESPONSE"
  [[ -z "$TEMP_BODY" ]] || rm -f "$TEMP_BODY"
}
trap cleanup EXIT

emit_error_summary() {
  local body="$1"
  local status="$2"
  jq -c --arg httpStatus "$status" '
    {
      httpStatus: ($httpStatus | tonumber),
      errorCode: (.error.code // null),
      errorStatus: (.error.status // null)
    }
  ' "$body" 2>/dev/null || printf '{"httpStatus":%s,"errorStatus":"unparseable_response"}\\n' "$status"
}

emit_success_summary() {
  local body="$1"
  jq -c '
    {
      operation: (.name // null),
      done: (.done // null),
      state: (.state // .dataConnector.state // null)
    }
  ' "$body" 2>/dev/null || printf '{"accepted":true,"response":"unparseable"}\\n'
}

verify_owned_collection() {
  jq -e \\
    --arg id "$COLLECTION_ID" \\
    --arg display "$COLLECTION_DISPLAY_NAME" \\
    --arg endpoint "$ENDPOINT" '
      ((.id // .collectionId // (.name | strings | split("/")[-1])) == $id) and
      ((.displayName // .collectionDisplayName) == $display) and
      ((.dataConnector.dataSource // .dataSource) == "custom_mcp") and
      ((.dataConnector.actionConfig.actionParams.instance_uri //
        .dataConnector.actionConfig.actionParams.instanceUri //
        .params.instance_uri //
        .params.instanceUri) == $endpoint)
    ' "$CHECK_BODY" >/dev/null
}

HTTP_STATUS="$(curl -sS -o "$CHECK_BODY" -w "%{http_code}" \\
  "$COLLECTION_URL" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "X-Goog-User-Project: ${req.url.match(/projects\/([^/]+)/)?.[1] ?? "<project>"}")"
case "$HTTP_STATUS" in
  200)
    if ! verify_owned_collection; then
      echo "Collection id collision: $COLLECTION_ID exists but its display name, custom_mcp type, or endpoint is not the exact Anvil target." >&2
      echo "Refusing to reuse or overwrite an unowned collection." >&2
      exit 1
    fi
    echo "Verified existing Anvil collection $COLLECTION_ID; no setup request sent."
    exit 0
    ;;
  404) ;;
  *)
    echo "Collection preflight failed with HTTP $HTTP_STATUS; refusing to create." >&2
    emit_error_summary "$CHECK_BODY" "$HTTP_STATUS" >&2
    exit 1
    ;;
esac

read_secret() {
  local value_name="$1"
  local file_name="\${value_name}_FILE"
  local value="\${!value_name-}"
  local file_value="\${!file_name-}"
  if [[ -n "$value" ]]; then
    printf '%s' "$value"
    return
  fi
  if [[ -n "$file_value" ]]; then
    [[ -f "$file_value" ]] || {
      echo "$file_name does not name a readable secret file." >&2
      return 1
    }
    cat -- "$file_value"
    return
  fi
  echo "Set $value_name or $file_name (for example, a mounted Secret Manager file)." >&2
  return 1
}

export ANVIL_RENDER_PRIVATE_APP_ACCESS_TOKEN="$(read_secret ANVIL_PRIVATE_APP_ACCESS_TOKEN)"
TEMP_BODY="$(mktemp)"
chmod 600 "$TEMP_BODY"
if [[ "$AUTH_TYPE" == "OAUTH" ]]; then
  export ANVIL_RENDER_OAUTH_CLIENT_ID="$(read_secret ANVIL_OAUTH_CLIENT_ID)"
  export ANVIL_RENDER_OAUTH_CLIENT_SECRET="$(read_secret ANVIL_OAUTH_CLIENT_SECRET)"
  jq '
    .dataConnector.params.oauth_access_token = env.ANVIL_RENDER_PRIVATE_APP_ACCESS_TOKEN |
    .dataConnector.actionConfig.actionParams.client_id = env.ANVIL_RENDER_OAUTH_CLIENT_ID |
    .dataConnector.actionConfig.actionParams.client_secret = env.ANVIL_RENDER_OAUTH_CLIENT_SECRET
  ' "$REQUEST_TEMPLATE" >"$TEMP_BODY"
else
  jq '
    .dataConnector.params.oauth_access_token = env.ANVIL_RENDER_PRIVATE_APP_ACCESS_TOKEN
  ' "$REQUEST_TEMPLATE" >"$TEMP_BODY"
fi

SETUP_STATUS="$(curl -sS -o "$SETUP_RESPONSE" -w "%{http_code}" -X POST \\
  "$SETUP_URL" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d @"$TEMP_BODY")"
if [[ "$SETUP_STATUS" != 2?? ]]; then
  echo "Connector setup failed with HTTP $SETUP_STATUS." >&2
  emit_error_summary "$SETUP_RESPONSE" "$SETUP_STATUS" >&2
  exit 1
fi
echo "Connector setup request accepted:"
emit_success_summary "$SETUP_RESPONSE"
`;
}
