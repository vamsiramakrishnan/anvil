/**
 * Provider-coordinate parsers for the Gemini Enterprise target.
 *
 * These checks deliberately validate the shape and cross-field identity that
 * Anvil can prove offline. They do not claim that a syntactically valid
 * resource exists or that the caller can access it; live readiness remains a
 * separate provider check.
 */

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const PROJECT_NUMBER = /^[1-9][0-9]{5,19}$/;
const RESOURCE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const ENGINE_ID = /^[a-z][a-z0-9_-]{0,62}$/;
const REGIONAL_LOCATION = /^[a-z]+(?:-[a-z]+)+[0-9]+$/;
const WORKFORCE_POOL_ID = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
const AUTHZ_POLICY_ID = /^[a-z][a-z0-9-]{0,62}$/;
const RFC6749_SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

export interface CanonicalEngineResource {
  projectNumber: string;
  location: string;
  collection: string;
  engineId: string;
}

export interface GatewayAuthorizationPolicyResource {
  project: string;
  location: string;
  policyId: string;
}

export interface AgentIdentityPrincipalSet {
  organizationNumber: string;
  projectNumber?: string;
  scope: "all" | "platform" | "platform-container" | "container";
}

/** Current Google Cloud project-id grammar. Existence is checked live. */
export function isGcpProjectId(value: string): boolean {
  return PROJECT_ID.test(value);
}

/**
 * Numeric provider identity used in canonical resources.
 *
 * Google does not publish a fixed display width. Requiring at least six digits
 * rejects project IDs, examples/placeholders, and accidentally truncated
 * values while accepting historical and current provider-assigned numbers.
 */
export function isGcpProjectNumber(value: string): boolean {
  return PROJECT_NUMBER.test(value);
}

/**
 * Gemini Enterprise supports global/multi-region names and Google-style
 * regional names such as us-central1 and asia-southeast1.
 */
export function isGeminiAppLocation(value: string): boolean {
  return value === "global" || value === "us" || value === "eu" || REGIONAL_LOCATION.test(value);
}

/** Discovery Engine app/engine id (RFC-1034-compatible, with legacy `_`). */
export function isEngineId(value: string): boolean {
  return ENGINE_ID.test(value);
}

/** Parse the exact Discovery Engine resource used by the gateway binding. */
export function parseCanonicalEngineResource(value: string): CanonicalEngineResource | undefined {
  const match =
    /^projects\/([^/]+)\/locations\/([^/]+)\/collections\/([^/]+)\/engines\/([^/]+)$/.exec(value);
  if (!match) return undefined;
  const [, projectNumber = "", location = "", collection = "", engineId = ""] = match;
  if (
    !isGcpProjectNumber(projectNumber) ||
    !isGeminiAppLocation(location) ||
    !RESOURCE_SEGMENT.test(collection) ||
    !isEngineId(engineId)
  ) {
    return undefined;
  }
  return { projectNumber, location, collection, engineId };
}

/** Workforce pool resource recorded for Gemini Enterprise sign-in. */
export function isWorkforcePoolResource(value: string): boolean {
  const match = /^locations\/global\/workforcePools\/([^/]+)$/.exec(value);
  return match !== null && WORKFORCE_POOL_ID.test(match[1] ?? "");
}

/**
 * Parse a Google-managed agent-identity principal set. Only documented scopes
 * are accepted; a `principalSet://` prefix by itself conveys no identity.
 */
export function parseAgentIdentityPrincipalSet(
  value: string,
): AgentIdentityPrincipalSet | undefined {
  const match =
    /^principalSet:\/\/agents\.global\.org-([1-9][0-9]{5,19})\.system\.id\.goog\/(.+)$/.exec(value);
  if (!match) return undefined;
  const organizationNumber = match[1] ?? "";
  const suffix = match[2] ?? "";
  if (suffix === "*") return { organizationNumber, scope: "all" };
  if (suffix === "attribute.platform/aiplatform") {
    return { organizationNumber, scope: "platform" };
  }
  const platformContainer =
    /^attribute\.platformContainer\/aiplatform\/projects\/([1-9][0-9]{5,19})$/.exec(suffix);
  if (platformContainer) {
    return {
      organizationNumber,
      projectNumber: platformContainer[1],
      scope: "platform-container",
    };
  }
  const container = /^attribute\.container\/projects\/([1-9][0-9]{5,19})$/.exec(suffix);
  if (container) {
    return {
      organizationNumber,
      projectNumber: container[1],
      scope: "container",
    };
  }
  return undefined;
}

/** Parse the regional AuthzPolicy resource attached to an Agent Gateway. */
export function parseGatewayAuthorizationPolicyResource(
  value: string,
): GatewayAuthorizationPolicyResource | undefined {
  const match = /^projects\/([^/]+)\/locations\/([^/]+)\/authzPolicies\/([^/]+)$/.exec(value);
  if (!match) return undefined;
  const [, project = "", location = "", policyId = ""] = match;
  if (
    !(isGcpProjectId(project) || isGcpProjectNumber(project)) ||
    !REGIONAL_LOCATION.test(location) ||
    !AUTHZ_POLICY_ID.test(policyId)
  ) {
    return undefined;
  }
  return { project, location, policyId };
}

/** OIDC issuer URL: HTTPS, credential-free, and without query or fragment. */
export function isHttpsIssuer(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/**
 * Audience identifying the MCP API. Require a URI form (for example
 * api://anvil-mcp or https://mcp.example/audience), not an ambiguous label.
 */
export function isMcpAudience(value: string): boolean {
  if (value.length > 512 || /\s/.test(value)) return false;
  const match = /^([a-z][a-z0-9+.-]*):(.+)$/i.exec(value);
  if (!match) return false;
  if (match[1]?.toLowerCase() === "http") return false;
  if (match[1]?.toLowerCase() === "https") {
    try {
      const url = new URL(value);
      return Boolean(url.hostname) && !url.username && !url.password && !url.hash;
    } catch {
      return false;
    }
  }
  return (match[2]?.length ?? 0) >= 3;
}

/**
 * OAuth scope syntax plus a minimal resource qualifier. `mcp.invoke` and
 * `api://anvil-mcp/mcp.invoke` are accepted; an opaque `x` is not enough to
 * establish that the scope belongs to this MCP API.
 */
export function isMcpApiScope(value: string): boolean {
  return (
    value.length >= 3 &&
    value.length <= 256 &&
    RFC6749_SCOPE_TOKEN.test(value) &&
    /[.:/]/.test(value)
  );
}
