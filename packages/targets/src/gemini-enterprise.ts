/**
 * The Gemini Enterprise target profile.
 *
 * Gemini Enterprise registers a *custom MCP server* as an agent's tool source over
 * a public HTTPS StreamableHTTP endpoint, with OAuth for user/service auth and an
 * action-selection budget. The MCP server must **self-enforce** auth and safety —
 * the platform does not assume an external gateway in front of it.
 *
 * IMPORTANT: at implementation/registration time these requirements MUST be
 * re-verified against the current official Google Cloud "custom MCP server" setup
 * documentation; `verifiedAgainst` records the source. The profile is versioned so
 * a requirements change is a new profile version, never an edit that leaks into
 * Anvil's core contracts.
 */
import type { AgentPlatformTargetProfile } from "./model.js";

export const GEMINI_ENTERPRISE_PROFILE: AgentPlatformTargetProfile = {
  id: "gemini-enterprise",
  version: "2026.07.1",
  displayName: "Gemini Enterprise (custom MCP)",
  // StreamableHTTP ONLY — Gemini Enterprise explicitly does not support the SSE
  // transport, so the connector's remote server must be the StreamableHTTP one.
  transportRequirements: [{ kind: "streamable-http", requiresHttps: true, publicEndpoint: true }],
  authRequirements: [
    {
      // The platform runs a user-delegated OAuth 2 auth-code flow with your IdP;
      // the MCP server validates the resulting token as an OAuth resource server.
      kind: "oauth2",
      oauthFields: ["client_id", "client_secret", "auth_uri", "token_uri", "scopes"],
      inboundMode: "oidc",
    },
    {
      // Since 2026-06, the platform can instead present a Google service-account
      // access token; the server validates it against Google's certs.
      kind: "service_account",
      oauthFields: [],
      inboundMode: "google_service_account",
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
      id: "fqdn-allowlist",
      description:
        "Org policy must allow the FQDNs of the server URL, authorization URL, and token URL.",
    },
  ],
  unsupportedAssumptions: [
    "The platform does not enforce the API's auth for you — the MCP server must self-enforce it.",
    "The platform does not confirm irreversible actions for you — confirmation must be in the contract.",
    "An external gateway in front of the server is not assumed; controls travel in the pack.",
  ],
  // Checked once against the live Google docs (2026-07); re-verify before a real
  // registration, since the custom-MCP feature is in Preview and moving.
  verificationStatus: "provisional",
  verifiedAgainst:
    "https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server (checked 2026-07)",
};
