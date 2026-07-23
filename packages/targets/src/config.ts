/**
 * One configuration object owns the Gemini Enterprise target journey. The CLI,
 * validator, plan renderer, and artifact generator all consume this exact shape
 * so flags cannot be acknowledged in prose while disappearing from the kit.
 *
 * Secrets are deliberately absent. This config is safe to persist in setup.json
 * for regeneration, status checks, and resumable operator handoff.
 */
import { createHash } from "node:crypto";

export const GEMINI_REGISTRATION_SURFACES = ["custom-mcp", "agent-gateway", "both"] as const;
export type GeminiRegistrationSurface = (typeof GEMINI_REGISTRATION_SURFACES)[number];

export const GEMINI_GATEWAY_LOCATIONS = ["us-central1", "europe-west1"] as const;
export type GeminiGatewayLocation = (typeof GEMINI_GATEWAY_LOCATIONS)[number];

export const GEMINI_REGISTRY_LOCATIONS = [
  "global",
  "us",
  "eu",
  "us-central1",
  "europe-west1",
] as const;
export type GeminiRegistryLocation = (typeof GEMINI_REGISTRY_LOCATIONS)[number];

/**
 * Locations with a documented Gemini Enterprise → Agent Gateway pairing.
 * Custom MCP accepts other current app locations, but the gateway path fails
 * closed until its routing and registry compatibility have been verified.
 *
 * Multi-region registries (`us` / `eu`) are intentionally excluded: manual
 * service registration is unsupported there.
 */
export const GEMINI_AGENT_GATEWAY_LOCATION_COMPATIBILITY = {
  global: {
    gatewayLocation: "us-central1",
    registryLocations: ["global", "us-central1"],
  },
  us: {
    gatewayLocation: "us-central1",
    registryLocations: ["global", "us-central1"],
  },
  eu: {
    gatewayLocation: "europe-west1",
    registryLocations: ["global", "europe-west1"],
  },
} as const satisfies Record<
  string,
  {
    gatewayLocation: GeminiGatewayLocation;
    registryLocations: readonly GeminiRegistryLocation[];
  }
>;
export type GatewayCompatibleAppLocation = keyof typeof GEMINI_AGENT_GATEWAY_LOCATION_COMPATIBILITY;

/** The authorization server protecting the MCP API, not the GE sign-in IdP. */
export type ConnectorOAuthProvider = "google" | "entra" | "okta" | "other";
export const MCP_SERVER_AUTH_MODES = ["oauth", "no-auth"] as const;
export type McpServerAuthMode = (typeof MCP_SERVER_AUTH_MODES)[number];

export interface ConnectorOAuthConfig {
  provider?: ConnectorOAuthProvider;
  /** Entra tenant id or Okta domain, when that provider is selected. */
  tenant?: string;
  /** Explicit endpoints required when provider is `other`. */
  authorizationUrl?: string;
  tokenUrl?: string;
  /** MCP-API scopes supplied by the operator. Never synthesized from Graph. */
  scopes: string[];
  /** Expected JWT issuer for the MCP resource server, when JWT validation is used. */
  inboundIssuer?: string;
  /** Audience identifying this MCP API, never an unrelated upstream API. */
  inboundAudience?: string;
}

export interface GeminiEnterpriseTargetConfig {
  surface: GeminiRegistrationSurface | "";
  /** How Gemini Enterprise authenticates calls to this MCP resource server. */
  serverAuth: McpServerAuthMode | "";
  /** Required acknowledgement when serverAuth is explicitly no-auth. */
  allowUnauthenticatedMcp: boolean;
  endpoint: string;
  /** GCP project id, used by gcloud and quota/billing headers. */
  project: string;
  /** Numeric project identity required in a synthesized Discovery Engine resource. */
  projectNumber?: string;
  /**
   * Gemini Enterprise app/engine location. Custom MCP accepts any nonempty
   * provider-supported location; Agent Gateway uses the strict mapping above.
   */
  appLocation: string;
  /** Engine id or canonical projects/.../engines/... resource. */
  engine: string;
  /** Derived from appLocation unless explicitly supplied. */
  gatewayLocation?: GeminiGatewayLocation;
  /** Registry referenced by the gateway; defaults to the gateway's region. */
  registryLocation?: GeminiRegistryLocation;
  /** Exact deployed-agent identity granted registry, gateway, and runtime access. */
  agentIdentityPrincipalSet?: string;
  /** Exact authorization-policy resource attached to the Agent Gateway. */
  gatewayAuthorizationPolicy?: string;
  connectorOAuth: ConnectorOAuthConfig;
  /**
   * GE sign-in Workforce pool metadata. It is intentionally separate from
   * connectorOAuth and never changes the token accepted by /mcp.
   */
  workforcePool?: string;
  /** Explicit acknowledgement that gateway binding reroutes all engine egress. */
  confirmEngineEgressReroute: boolean;
}

export interface GeminiEnterpriseTargetConfigInput {
  surface?: GeminiRegistrationSurface;
  serverAuth?: McpServerAuthMode;
  allowUnauthenticatedMcp?: boolean;
  endpoint?: string;
  project?: string;
  projectNumber?: string;
  appLocation?: string;
  engine?: string;
  gatewayLocation?: GeminiGatewayLocation;
  registryLocation?: GeminiRegistryLocation;
  agentIdentityPrincipalSet?: string;
  gatewayAuthorizationPolicy?: string;
  connectorOAuth?: Partial<ConnectorOAuthConfig>;
  workforcePool?: string;
  confirmEngineEgressReroute?: boolean;
}

/** Normalize optional CLI/library input into the single persisted config shape. */
export function createGeminiEnterpriseTargetConfig(
  input: GeminiEnterpriseTargetConfigInput,
): GeminiEnterpriseTargetConfig {
  const appLocation = input.appLocation?.trim() ?? "";
  const gatewayLocation =
    input.gatewayLocation ?? (appLocation ? defaultGatewayLocation(appLocation) : undefined);
  return {
    surface: input.surface ?? "",
    serverAuth: input.serverAuth ?? "",
    allowUnauthenticatedMcp: input.allowUnauthenticatedMcp === true,
    endpoint: input.endpoint?.trim() ?? "",
    project: input.project?.trim() ?? "",
    projectNumber: input.projectNumber?.trim() || undefined,
    appLocation,
    engine: input.engine?.trim() ?? "",
    gatewayLocation,
    registryLocation: input.registryLocation ?? gatewayLocation,
    agentIdentityPrincipalSet: input.agentIdentityPrincipalSet?.trim() || undefined,
    gatewayAuthorizationPolicy: input.gatewayAuthorizationPolicy?.trim() || undefined,
    connectorOAuth: {
      provider: input.connectorOAuth?.provider,
      tenant: input.connectorOAuth?.tenant?.trim() || undefined,
      authorizationUrl: input.connectorOAuth?.authorizationUrl?.trim() || undefined,
      tokenUrl: input.connectorOAuth?.tokenUrl?.trim() || undefined,
      scopes: [...(input.connectorOAuth?.scopes ?? [])],
      inboundIssuer: input.connectorOAuth?.inboundIssuer?.trim() || undefined,
      inboundAudience: input.connectorOAuth?.inboundAudience?.trim() || undefined,
    },
    workforcePool: input.workforcePool?.trim() || undefined,
    confirmEngineEgressReroute: input.confirmEngineEgressReroute === true,
  };
}

export function defaultGatewayLocation(appLocation: string): GeminiGatewayLocation | undefined {
  return isGatewayCompatibleAppLocation(appLocation)
    ? GEMINI_AGENT_GATEWAY_LOCATION_COMPATIBILITY[appLocation].gatewayLocation
    : undefined;
}

export function isGatewayCompatibleAppLocation(
  appLocation: string,
): appLocation is GatewayCompatibleAppLocation {
  return Object.hasOwn(GEMINI_AGENT_GATEWAY_LOCATION_COMPATIBILITY, appLocation);
}

export function includesSurface(
  config: GeminiEnterpriseTargetConfig,
  surface: Exclude<GeminiRegistrationSurface, "both">,
): boolean {
  return config.surface === surface || config.surface === "both";
}

/** Canonical Discovery Engine resource used by UpdateEngine. */
export function engineResource(config: GeminiEnterpriseTargetConfig): string {
  if (isCanonicalEngineResource(config.engine)) return config.engine;
  return `projects/${config.projectNumber ?? "<project-number>"}/locations/${config.appLocation}/collections/default_collection/engines/${config.engine}`;
}

export function isCanonicalEngineResource(engine: string): boolean {
  return /^projects\/\d+\/locations\/[a-z0-9-]+\/collections\/[A-Za-z0-9_-]+\/engines\/[A-Za-z0-9_-]+$/.test(
    engine,
  );
}

export function canonicalEngineLocation(engine: string): string | undefined {
  return isCanonicalEngineResource(engine) ? engine.split("/")[3] : undefined;
}

/** Stable engine-scoped mutable state key; safe as one filesystem path segment. */
export function engineStateKey(config: GeminiEnterpriseTargetConfig): string {
  const resource = engineResource(config);
  const engineId =
    resource
      .split("/")
      .at(-1)
      ?.replace(/[^a-zA-Z0-9._-]+/g, "-") || "engine";
  const digest = createHash("sha256").update(resource, "utf8").digest("hex").slice(0, 32);
  return `${engineId.slice(0, 48)}-${digest}`;
}

export function targetStateRelativePath(config: GeminiEnterpriseTargetConfig): string {
  return `gemini-enterprise/${engineStateKey(config)}`;
}

export interface ConnectorOAuthEndpoints {
  authUri: string;
  tokenUri: string;
  createClientWhere: string;
}

/** Best-effort OAuth client endpoints; inbound issuer/audience remain independent. */
export function connectorOAuthEndpoints(
  config: GeminiEnterpriseTargetConfig,
): ConnectorOAuthEndpoints {
  const tenant = config.connectorOAuth.tenant;
  switch (config.connectorOAuth.provider) {
    case "google":
      return {
        authUri: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUri: "https://oauth2.googleapis.com/token",
        createClientWhere: `Google Cloud Console → APIs & Services → Credentials → OAuth client${config.project ? ` (project ${config.project})` : ""}`,
      };
    case "entra":
      return {
        authUri: `https://login.microsoftonline.com/${tenant ?? "<tenant>"}/oauth2/v2.0/authorize`,
        tokenUri: `https://login.microsoftonline.com/${tenant ?? "<tenant>"}/oauth2/v2.0/token`,
        createClientWhere:
          "Microsoft Entra admin center → App registrations → New registration; expose an MCP-API scope",
      };
    case "okta": {
      const domain = tenant ?? "<your-okta-domain>";
      return {
        authUri: `https://${domain}/oauth2/v1/authorize`,
        tokenUri: `https://${domain}/oauth2/v1/token`,
        createClientWhere:
          "Okta Admin → Applications → Create App Integration → OIDC Web; authorize an MCP-API scope",
      };
    }
    default:
      return {
        authUri: config.connectorOAuth.authorizationUrl ?? "<your-connector-authorization-url>",
        tokenUri: config.connectorOAuth.tokenUrl ?? "<your-connector-token-url>",
        createClientWhere: "the authorization server that protects this MCP API",
      };
  }
}

export function connectorScopes(config: GeminiEnterpriseTargetConfig): string[] {
  return config.connectorOAuth.scopes.length > 0
    ? config.connectorOAuth.scopes
    : ["<scope-for-your-mcp-api>"];
}
