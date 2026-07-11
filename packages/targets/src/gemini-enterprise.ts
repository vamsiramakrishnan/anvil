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
  version: "2026.07.0",
  displayName: "Gemini Enterprise (custom MCP)",
  transportRequirements: [{ kind: "streamable-http", requiresHttps: true, publicEndpoint: true }],
  authRequirements: [
    {
      kind: "oauth2",
      oauthFields: ["client_id", "client_secret", "auth_uri", "token_uri", "scopes"],
    },
  ],
  actionLimits: { maxActions: 50, requiresActionDescriptions: true },
  networkingRequirements: [
    {
      id: "public-https",
      description: "A publicly reachable HTTPS endpoint the platform can call.",
    },
    { id: "egress", description: "Server egress to the upstream API it fronts." },
  ],
  unsupportedAssumptions: [
    "The platform does not enforce the API's auth for you — the MCP server must self-enforce it.",
    "The platform does not confirm irreversible actions for you — confirmation must be in the contract.",
    "An external gateway in front of the server is not assumed; controls travel in the pack.",
  ],
  verifiedAgainst:
    "unverified — re-check against current Google Cloud Gemini Enterprise custom-MCP docs before registration",
};
