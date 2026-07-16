/**
 * Agent-platform target profiles. A target platform (Gemini Enterprise, and later
 * others) has its own transport, auth, action-budget, networking, and
 * organization-policy requirements. Those requirements are modelled as a
 * **versioned profile**, not scattered through a generator — so platform changes
 * never leak into AIR, capability contracts, or the runtime-neutral pack identity.
 *
 * A pack carries a target *kit* (registration + operations artifacts) per target;
 * the profile is what the kit is generated against and validated with.
 */
import { z } from "zod";

/** How the platform reaches the MCP server. */
export const TransportRequirement = z.object({
  kind: z.enum(["streamable-http", "sse", "stdio"]),
  requiresHttps: z.boolean().default(true),
  /** Whether a publicly reachable endpoint is required. */
  publicEndpoint: z.boolean().default(true),
});
export type TransportRequirement = z.infer<typeof TransportRequirement>;

/** An auth scheme the platform can configure for the server. */
export const TargetAuthRequirement = z.object({
  kind: z.enum(["oauth2", "service_account", "api_key", "none"]),
  /** OAuth fields the setup template must supply. */
  oauthFields: z.array(z.string()).default([]),
  /**
   * The inbound-auth mode the generated MCP server enforces for this scheme
   * (`@anvil/mcp-runtime` `InboundAuthMode`): `oidc` validates a user-delegated
   * IdP token, `google_service_account` a Google-issued machine token. The
   * server is an OAuth 2 resource server — it self-enforces this token.
   */
  inboundMode: z.enum(["oidc", "google_service_account"]).optional(),
});
export type TargetAuthRequirement = z.infer<typeof TargetAuthRequirement>;

/** Limits on how many actions/tools the platform surfaces to an agent. */
export const ActionLimitPolicy = z.object({
  maxActions: z.number().int().positive(),
  /** Whether the platform requires per-action descriptions for selection. */
  requiresActionDescriptions: z.boolean().default(true),
});
export type ActionLimitPolicy = z.infer<typeof ActionLimitPolicy>;

export const NetworkingRequirement = z.object({
  id: z.string(),
  description: z.string(),
});
export type NetworkingRequirement = z.infer<typeof NetworkingRequirement>;

/** A versioned target profile. `version` is bound into a pack's target manifest. */
export const AgentPlatformTargetProfile = z.object({
  id: z.string(),
  version: z.string(),
  displayName: z.string(),
  transportRequirements: z.array(TransportRequirement).default([]),
  authRequirements: z.array(TargetAuthRequirement).default([]),
  actionLimits: ActionLimitPolicy,
  networkingRequirements: z.array(NetworkingRequirement).default([]),
  /** Requirements the platform does NOT satisfy — the honest "don't assume" list. */
  unsupportedAssumptions: z.array(z.string()).default([]),
  /**
   * Structured provenance status so a consumer can *gate* on it rather than parse
   * prose: `verified` (checked against current platform docs), `provisional`
   * (checked once but possibly stale), `unverified` (not yet checked — treat the
   * requirements as a best-effort draft). Defaults to `unverified`.
   */
  verificationStatus: z.enum(["verified", "provisional", "unverified"]).default("unverified"),
  /** Where the profile's requirements were verified from (docs URL + date). */
  verifiedAgainst: z.string().optional(),
});
export type AgentPlatformTargetProfile = z.infer<typeof AgentPlatformTargetProfile>;

/** One generated kit file (pack-relative path + bytes). */
export interface TargetKitFile {
  path: string;
  bytes: Uint8Array;
}

/** The generated registration + operations kit for one target. */
export interface TargetKit {
  targetId: string;
  targetVersion: string;
  files: TargetKitFile[];
}

/** One validation finding — data, never a throw. */
export interface TargetValidationFinding {
  level: "error" | "warning";
  code: string;
  message: string;
}

export interface TargetValidationResult {
  ok: boolean;
  findings: TargetValidationFinding[];
}
