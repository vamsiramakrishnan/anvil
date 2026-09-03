/**
 * Shared config/validation for the "remote MCP connector" family of target
 * profiles (`claude`, `openai`, `mcp-registry`). All three describe the same
 * underlying fact — an agent platform reaching Anvil's generated MCP server —
 * so one config shape and one core validator keep their auth/transport rules
 * from drifting into three near-identical copies.
 *
 * Deliberately secret-free: the config carries only environment-variable
 * NAMES for OAuth client credentials, never values. A kit generated from this
 * config is safe to persist in a bundle and inspect in a code review.
 */
import { isIP } from "node:net";
import type { AirDocument, Operation } from "@anvil/air";
import { isHttpsIssuer, isMcpApiScope, isMcpAudience } from "./coordinates.js";
import type { TargetValidationFinding } from "./model.js";

export const MCP_CONNECTOR_AUTH_MODES = ["none", "oauth"] as const;
export type McpConnectorAuthMode = (typeof MCP_CONNECTOR_AUTH_MODES)[number];

/** An environment-variable NAME (never a secret value). */
const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/;

export interface McpConnectorOAuthConfig {
  authorizationUrl?: string;
  tokenUrl?: string;
  /** MCP-API scopes the connector requests. Never a Graph/unrelated scope. */
  scopes: string[];
  /** Issuer the deployed MCP server validates (ANVIL_INBOUND_ISSUER). */
  inboundIssuer?: string;
  /** Audience identifying this MCP API (ANVIL_INBOUND_AUDIENCE). */
  inboundAudience?: string;
  /** Env var NAME the platform-side OAuth client id is read from, never a value. */
  clientIdEnvVar?: string;
  /** Env var NAME the platform-side OAuth client secret is read from, never a value. */
  clientSecretEnvVar?: string;
}

export interface McpConnectorConfig {
  /** Public StreamableHTTP endpoint (e.g. https://host/mcp). Omit for a stdio-only kit. */
  httpEndpoint: string;
  /** How the platform authenticates its calls to the deployed MCP server. */
  authMode: McpConnectorAuthMode | "";
  oauth: McpConnectorOAuthConfig;
}

export interface McpConnectorConfigInput {
  httpEndpoint?: string;
  authMode?: McpConnectorAuthMode;
  oauth?: Partial<McpConnectorOAuthConfig>;
}

export function createMcpConnectorConfig(input: McpConnectorConfigInput): McpConnectorConfig {
  return {
    httpEndpoint: input.httpEndpoint?.trim() ?? "",
    authMode: input.authMode ?? "",
    oauth: {
      authorizationUrl: input.oauth?.authorizationUrl?.trim() || undefined,
      tokenUrl: input.oauth?.tokenUrl?.trim() || undefined,
      scopes: [
        ...new Set(
          (input.oauth?.scopes ?? [])
            .map((scope) => scope.trim())
            .filter((scope) => scope.length > 0),
        ),
      ],
      inboundIssuer: input.oauth?.inboundIssuer?.trim() || undefined,
      inboundAudience: input.oauth?.inboundAudience?.trim() || undefined,
      clientIdEnvVar: input.oauth?.clientIdEnvVar?.trim() || undefined,
      clientSecretEnvVar: input.oauth?.clientSecretEnvVar?.trim() || undefined,
    },
  };
}

/** Operations exposed to a target: approved, sorted by public tool name. */
export function servedOperations(air: AirDocument): Operation[] {
  return [...air.operations]
    .filter((op) => op.state === "approved")
    .sort((a, b) => a.mcp.toolName.localeCompare(b.mcp.toolName));
}

/**
 * The permission-prompt hint a platform's tool-confirmation UI should use for
 * one operation, derived only from `confirmation.required`/`humanApproval` —
 * never loosened by anything platform-specific. `ask` always wins over `allow`.
 */
export function confirmationPermissionHint(op: Operation): "ask" | "allow" {
  return op.confirmation.required ? "ask" : "allow";
}

/**
 * The OpenAI Responses API `require_approval` tier for one operation.
 * Confirmation-required (or human-approval-gated) operations are ALWAYS
 * `"always"` — this mapping must never downgrade a required confirmation to
 * `"never"`; that is the one safety property `targets/approval-never-downgraded`
 * exists to prove.
 */
export function requireApprovalTier(op: Operation): "always" | "never" {
  return op.confirmation.required || op.confirmation.humanApproval === true ? "always" : "never";
}

/** Core validation shared by every remote-MCP-connector profile. */
export function validateMcpConnectorConfig(
  air: AirDocument,
  config: McpConnectorConfig,
): TargetValidationFinding[] {
  const findings: TargetValidationFinding[] = [];
  const served = servedOperations(air);

  if (served.length === 0) {
    findings.push({
      level: "error",
      code: "target/no_approved_tools",
      message: "The target would expose zero approved tools; approve at least one operation first.",
    });
  }

  if (!config.httpEndpoint) {
    findings.push({
      level: "error",
      code: "target/missing_endpoint",
      message: "This target requires the deployed MCP server's public HTTPS endpoint (--endpoint).",
    });
  } else {
    let endpoint: URL | undefined;
    try {
      endpoint = new URL(config.httpEndpoint);
    } catch {
      findings.push({
        level: "error",
        code: "target/insecure_transport",
        message: `A valid HTTPS endpoint is required; got ${config.httpEndpoint}.`,
      });
    }
    if (endpoint) {
      if (
        endpoint.protocol !== "https:" ||
        !endpoint.hostname ||
        endpoint.username ||
        endpoint.password
      ) {
        findings.push({
          level: "error",
          code: "target/insecure_transport",
          message: `A credential-free HTTPS endpoint is required; got ${config.httpEndpoint}.`,
        });
      } else if (isPrivateConnectorHost(endpoint.hostname)) {
        findings.push({
          level: "error",
          code: "target/non_public_endpoint",
          message: `The MCP endpoint must be publicly routable; ${endpoint.hostname} is local or a private-address literal.`,
        });
      }
      if (endpoint.search || endpoint.hash) {
        findings.push({
          level: "error",
          code: "target/endpoint_query_or_fragment",
          message: "The public MCP endpoint must not contain a query string or fragment.",
        });
      }
    }
  }

  if (!config.authMode) {
    findings.push({
      level: "error",
      code: "target/missing_server_auth",
      message: "This target requires an explicit server auth mode (--server-auth none|oauth).",
    });
  } else if (!MCP_CONNECTOR_AUTH_MODES.some((mode) => mode === config.authMode)) {
    findings.push({
      level: "error",
      code: "target/invalid_server_auth",
      message: `--server-auth must be one of ${MCP_CONNECTOR_AUTH_MODES.join(", ")}; got ${config.authMode}.`,
    });
  } else if (config.authMode === "oauth") {
    findings.push(...validateMcpConnectorOAuth(config.oauth));
  } else {
    findings.push({
      level: "warning",
      code: "target/unauthenticated_mcp",
      message:
        "The MCP server accepts unauthenticated calls. Review compensating controls before publishing this connector.",
    });
  }

  findings.push(...scanForEmbeddedSecrets(config));
  return findings;
}

function validateMcpConnectorOAuth(oauth: McpConnectorOAuthConfig): TargetValidationFinding[] {
  const findings: TargetValidationFinding[] = [];
  for (const [field, value, flag] of [
    ["authorization URL", oauth.authorizationUrl, "--oauth-authorization-url"],
    ["token URL", oauth.tokenUrl, "--oauth-token-url"],
  ] as const) {
    if (!value) {
      findings.push({
        level: "error",
        code: `target/missing_connector_oauth_${field.replace(" ", "_").toLowerCase()}`,
        message: `OAuth server auth requires ${flag}.`,
      });
      continue;
    }
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
        throw new Error("not HTTPS");
      }
    } catch {
      findings.push({
        level: "error",
        code: `target/invalid_connector_oauth_${field.replace(" ", "_").toLowerCase()}`,
        message: `${flag} must be a valid credential-free HTTPS URL; got ${value}.`,
      });
    }
  }
  if (oauth.scopes.length === 0) {
    findings.push({
      level: "error",
      code: "target/missing_connector_oauth_scope",
      message: "OAuth server auth requires at least one MCP API scope via --oauth-scope.",
    });
  }
  for (const scope of oauth.scopes) {
    if (!isMcpApiScope(scope)) {
      findings.push({
        level: "error",
        code: "target/invalid_connector_oauth_scope",
        message: `OAuth scope ${JSON.stringify(scope)} must be a resource-qualified MCP API scope, such as mcp.invoke or api://anvil-mcp/mcp.invoke.`,
      });
    }
  }
  if (!oauth.inboundIssuer) {
    findings.push({
      level: "error",
      code: "target/missing_inbound_issuer",
      message:
        "OAuth server auth requires the issuer validated by the MCP server via --inbound-issuer.",
    });
  } else if (!isHttpsIssuer(oauth.inboundIssuer)) {
    findings.push({
      level: "error",
      code: "target/invalid_inbound_issuer",
      message:
        "--inbound-issuer must be a credential-free HTTPS issuer URL without a query string or fragment.",
    });
  }
  if (!oauth.inboundAudience) {
    findings.push({
      level: "error",
      code: "target/missing_inbound_audience",
      message: "OAuth server auth requires the MCP API audience via --inbound-audience.",
    });
  } else if (!isMcpAudience(oauth.inboundAudience)) {
    findings.push({
      level: "error",
      code: "target/invalid_inbound_audience",
      message:
        "--inbound-audience must be a URI that uniquely identifies this MCP API, such as api://anvil-mcp.",
    });
  }
  for (const [field, value, flag] of [
    ["client id env var", oauth.clientIdEnvVar, "--oauth-client-id-env"],
    ["client secret env var", oauth.clientSecretEnvVar, "--oauth-client-secret-env"],
  ] as const) {
    if (value !== undefined && !ENV_VAR_NAME.test(value)) {
      findings.push({
        level: "error",
        code: "target/embedded_secret_value",
        message: `${flag} must be an environment-variable NAME (e.g. ANVIL_OAUTH_CLIENT_SECRET), never a literal value; got a value shaped like a secret for ${field}.`,
      });
    }
  }
  return findings;
}

/**
 * Defense in depth against a config that carries a value where only an env-var
 * NAME belongs. Every OAuth client credential field on this config is typed as
 * an env-var name; this walks the actual strings to catch a value that slipped
 * past the type (e.g. an actual secret string passed as `clientSecretEnvVar`).
 */
function scanForEmbeddedSecrets(config: McpConnectorConfig): TargetValidationFinding[] {
  const findings: TargetValidationFinding[] = [];
  const candidates: Array<[string, string | undefined]> = [
    ["--oauth-client-id-env", config.oauth.clientIdEnvVar],
    ["--oauth-client-secret-env", config.oauth.clientSecretEnvVar],
  ];
  for (const [flag, value] of candidates) {
    if (value !== undefined && looksLikeSecretValue(value)) {
      findings.push({
        level: "error",
        code: "target/embedded_secret_value",
        message: `${flag} looks like a literal secret value, not an environment-variable NAME. Never pass a credential value to a target profile; pass the NAME of the environment variable that holds it.`,
      });
    }
  }
  return findings;
}

/** Heuristic: does this string look like a credential value rather than a NAME? */
export function looksLikeSecretValue(value: string): boolean {
  if (ENV_VAR_NAME.test(value) && value.length <= 64) return false;
  // JWT-shaped, common API-key prefixes, or long high-entropy tokens.
  if (/^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(value)) return true;
  if (/^(sk|pk|rk|api|key|secret|token)[-_][A-Za-z0-9]{12,}$/i.test(value)) return true;
  if (/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return true;
  if (value.length > 64 && /^[A-Za-z0-9+/=_-]+$/.test(value)) return true;
  return false;
}

function isPrivateConnectorHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const version = isIP(host);
  if (version === 4) {
    const [first = 0, second = 0] = host.split(".").map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  if (version === 6) {
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("::ffff:") ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      /^fe[89ab]/.test(host)
    );
  }
  return false;
}

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
export const json = (v: unknown): Uint8Array => enc(`${JSON.stringify(v, null, 2)}\n`);
