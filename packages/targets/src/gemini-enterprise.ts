/**
 * The Gemini Enterprise target profile.
 *
 * Gemini Enterprise registers a *custom MCP server* (`data_source = custom_mcp`,
 * connector_type REMOTE_MCP) as an agent's tool source over a public HTTPS
 * StreamableHTTP endpoint, with an action-selection budget. The MCP server must
 * **self-enforce** auth and safety — platform action confirmation defaults do
 * not replace contract-level defense in depth.
 *
 * The connector authenticates to the server one of exactly two ways — the ONLY
 * `auth_type` values the platform accepts for a custom MCP server:
 *   - `OAUTH`: a user-delegated OAuth 2 / OIDC flow. The platform runs the
 *     auth-code flow with your IdP (`auth_uri`/`token_uri`/`client_id`) and
 *     presents the user's token to `/mcp`; the server validates it (`oidc`).
 *   - `NO_AUTH`: the platform calls `/mcp` with no token (server mode `none`).
 * Verified against the live Discovery Engine API + 7 real connectors;
 * `verifiedAgainst` records exactly what was and was not observed.
 */
import type { AgentPlatformTargetProfile } from "./model.js";

export const GEMINI_ENTERPRISE_PROFILE: AgentPlatformTargetProfile = {
  id: "gemini-enterprise",
  version: "2026.07.3",
  displayName: "Gemini Enterprise",
  // StreamableHTTP ONLY — Gemini Enterprise explicitly does not support the SSE
  // transport, so the connector's remote server must be the StreamableHTTP one.
  transportRequirements: [{ kind: "streamable-http", requiresHttps: true, publicEndpoint: true }],
  authRequirements: [
    {
      // CONFIRMED primary path: auth_type=OAUTH — a user-delegated OAuth 2 flow.
      // The platform runs the auth-code flow with your IdP and presents the
      // resulting user token to /mcp; the server validates it as an OIDC resource
      // server. The IdP app registration's redirect URI must be GE's fixed
      // https://vertexaisearch.cloud.google.com/oauth-redirect.
      kind: "oauth2",
      oauthFields: ["client_id", "client_secret", "auth_uri", "token_uri", "scopes"],
      inboundMode: "oidc",
    },
    {
      // auth_type=NO_AUTH — the platform calls /mcp with no token. Only safe
      // behind other controls; the server admits everything (inbound mode none).
      kind: "none",
      oauthFields: [],
    },
  ],
  // The platform surfaces at most 100 enabled actions from a custom MCP data
  // store; distillation is what keeps a large surface under this budget.
  actionLimits: { maxActions: 100, requiresActionDescriptions: true },
  networkingRequirements: [
    {
      id: "public-https",
      description: "A publicly reachable HTTPS endpoint the platform can call.",
    },
    { id: "egress", description: "Server egress to the upstream API it fronts." },
    {
      id: "instance-uri-allowlist",
      description:
        "The MCP server URL (instance_uri) must be reachable; a 'protected' project additionally requires it to be allowlisted (403 otherwise).",
    },
  ],
  unsupportedAssumptions: [
    "The platform does not enforce the API's auth for you — the MCP server must self-enforce it.",
    "Platform action confirmation defaults do not replace contract-level confirmation for irreversible actions.",
  ],
  // The human-in-the-loop steps neither Anvil nor a script can perform — the CLI
  // surfaces these as "open steps" so the operator/harness knows what is left.
  interactiveSteps: [
    {
      surface: "data-connector",
      action: "Create the Custom MCP Server data store and click Authorize",
      where: "GE console → Data stores → Create data store → Custom MCP Server",
      why: "The OAUTH authorization-code consent is interactive; the setUpDataConnector API creates the record but cannot complete the user consent (it stops at INITIALIZATION_FAILED).",
    },
    {
      surface: "agent-registry",
      action: "Import the registered MCP server into the app",
      where:
        "GE console → Connected data stores → + New data store → MCP servers → Show all → Add tool",
      why: "Importing a registry MCP server into a GE app is console-only — there is no public API for the import step.",
    },
  ],
  // VERIFIED end to end against a live GE app: an Anvil-generated StreamableHTTP
  // server was deployed to Cloud Run, registered as a custom_mcp connector
  // (auth_type=OAUTH), driven to ACTIVE via the console Authorize step, and GE
  // fetched + enabled its tool (demo_list_pets) and called /mcp with a real user
  // token. See docs/backtesting/GEMINI_ENTERPRISE_VALIDATION.md.
  verificationStatus: "verified",
  verifiedAgainst:
    "Live GE app end-to-end, 2026-07-21 (a real GE project, location global, v1alpha). data_source=custom_mcp; create shape params{oauth_access_token} + action_config.action_params{auth_type, auth_uri, token_uri, scopes, instance_uri, mcp_server_source=BYO_MCP, client_id, client_secret} + create_bap_connection (confirmed by creating connectors + reading back 7 live ones); auth_type is OAUTH or NO_AUTH only. Connector reached ACTIVE and GE fetched+enabled the tool after the console's interactive OAuth Authorize step (raw API create alone hits INITIALIZATION_FAILED — OAuth consent is interactive by design). GE calls /mcp (POST+GET, one session) with the user's OAuth access token: iss=the IdP, aud=the scope's resource (not the server). Current platform action defaults may confirm actions, while Anvil retains contract-level confirmation as defense in depth. See docs/backtesting/GEMINI_ENTERPRISE_VALIDATION.md",
};
