/**
 * Validate a contract against a target profile. Findings are data. The checks that
 * matter for a self-enforcing custom MCP: transport/HTTPS, action budget, action
 * descriptions, connector configuration, and contract-level confirmation as
 * defense in depth independent of platform UI defaults.
 */
import { isIP } from "node:net";
import type { AirDocument } from "@anvil/air";
import { renderToolSpecJson, TOOLSPEC_MAX_BYTES } from "./agent-registry.js";
import {
  canonicalEngineLocation,
  GEMINI_AGENT_GATEWAY_LOCATION_COMPATIBILITY,
  type GeminiEnterpriseTargetConfig,
  includesSurface,
  isCanonicalEngineResource,
  isGatewayCompatibleAppLocation,
} from "./config.js";
import type {
  AgentPlatformTargetProfile,
  TargetValidationFinding,
  TargetValidationResult,
} from "./model.js";

export function validateTarget(
  air: AirDocument,
  profile: AgentPlatformTargetProfile,
  config: GeminiEnterpriseTargetConfig,
): TargetValidationResult {
  const findings: TargetValidationFinding[] = [];
  const served = air.operations.filter((o) => o.state === "approved");

  for (const [field, value] of [
    ["surface", config.surface],
    ["server auth", config.serverAuth],
    ["endpoint", config.endpoint],
    ["project", config.project],
    ["app location", config.appLocation],
    ["engine", config.engine],
  ] as const) {
    if (!value) {
      findings.push({
        level: "error",
        code: `target/missing_${field.replace(" ", "_")}`,
        message: `Gemini Enterprise target configuration requires ${field}.`,
      });
    }
  }

  if (served.length === 0) {
    findings.push({
      level: "error",
      code: "target/no_approved_tools",
      message: "The target would expose zero approved tools; approve at least one operation first.",
    });
  }

  // Profile provenance: a profile whose requirements were never verified against
  // current platform docs is a draft. Surface that as a structured warning so a
  // green validation can never be mistaken for "checked against the real platform".
  if (profile.verificationStatus !== "verified") {
    findings.push({
      level: "warning",
      code: "target/unverified_profile",
      message: `${profile.displayName} profile is ${profile.verificationStatus}${
        profile.verifiedAgainst ? ` (${profile.verifiedAgainst})` : ""
      }; re-verify its requirements against current platform docs before registration.`,
    });
  }

  // Transport / HTTPS.
  const needsHttps = profile.transportRequirements.some((t) => t.requiresHttps);
  if (config.endpoint) {
    let endpoint: URL | undefined;
    try {
      endpoint = new URL(config.endpoint);
    } catch {
      findings.push({
        level: "error",
        code: "target/insecure_transport",
        message: `${profile.displayName} requires a valid HTTPS endpoint; got ${config.endpoint}.`,
      });
    }
    if (
      endpoint &&
      needsHttps &&
      (endpoint.protocol !== "https:" ||
        !endpoint.hostname ||
        endpoint.username ||
        endpoint.password)
    ) {
      findings.push({
        level: "error",
        code: "target/insecure_transport",
        message: `${profile.displayName} requires a credential-free HTTPS endpoint; got ${config.endpoint}.`,
      });
    } else if (endpoint) {
      if (endpoint.pathname !== "/mcp") {
        findings.push({
          level: "error",
          code: "target/invalid_mcp_endpoint_path",
          message: `Gemini Enterprise must call the exact StreamableHTTP resource path /mcp; got ${endpoint.pathname || "/"}.`,
        });
      }
      if (endpoint.search || endpoint.hash) {
        findings.push({
          level: "error",
          code: "target/endpoint_query_or_fragment",
          message: "The public MCP endpoint must not contain a query string or fragment.",
        });
      }
      if (isPrivateEndpointHost(endpoint.hostname)) {
        findings.push({
          level: "error",
          code: "target/non_public_endpoint",
          message: `The Gemini Enterprise MCP endpoint must be publicly routable; ${endpoint.hostname} is local or a private-address literal.`,
        });
      }
    }
  }

  if (includesSurface(config, "custom-mcp") && config.appLocation) {
    findings.push({
      level: "warning",
      code: "target/provider_location_validation_required",
      message: `Confirm that Gemini Enterprise currently supports Custom MCP in app location ${config.appLocation}; Anvil records the location but does not probe the live provider.`,
    });
  }

  if (includesSurface(config, "agent-gateway") && config.appLocation) {
    if (config.engine.includes("/") && !isCanonicalEngineResource(config.engine)) {
      findings.push({
        level: "error",
        code: "target/invalid_engine_resource",
        message:
          "--engine must be a simple engine id or an exact projects/<number>/locations/<location>/collections/<collection>/engines/<engine> resource.",
      });
    }
    if (!config.agentIdentityPrincipalSet) {
      findings.push({
        level: "error",
        code: "target/missing_agent_identity_principal_set",
        message:
          "Agent Gateway requires --agent-identity-principal-set so generated IAM and readiness evidence identify the exact deployed-agent principal.",
      });
    } else if (!config.agentIdentityPrincipalSet.startsWith("principalSet://")) {
      findings.push({
        level: "error",
        code: "target/invalid_agent_identity_principal_set",
        message: "--agent-identity-principal-set must be an exact principalSet:// resource.",
      });
    }
    if (!config.gatewayAuthorizationPolicy) {
      findings.push({
        level: "error",
        code: "target/missing_gateway_authorization_policy",
        message:
          "Agent Gateway requires --gateway-authorization-policy naming the exact attached authorization-policy resource.",
      });
    }
    if (!isCanonicalEngineResource(config.engine) && !config.projectNumber) {
      findings.push({
        level: "error",
        code: "target/missing_project_number",
        message:
          "Agent Gateway binding needs --project-number to synthesize the canonical engine resource; alternatively pass the full projects/.../engines/... resource to --engine.",
      });
    }
    if (config.projectNumber && !/^\d+$/.test(config.projectNumber)) {
      findings.push({
        level: "error",
        code: "target/invalid_project_number",
        message: `--project-number must be numeric; got ${config.projectNumber}.`,
      });
    }
    const resourceLocation = canonicalEngineLocation(config.engine);
    if (resourceLocation && resourceLocation !== config.appLocation) {
      findings.push({
        level: "error",
        code: "target/engine_location_mismatch",
        message: `Canonical engine location ${resourceLocation} does not match --location ${config.appLocation}.`,
      });
    }
    if (!isGatewayCompatibleAppLocation(config.appLocation)) {
      findings.push({
        level: "error",
        code: "target/unsupported_gateway_app_location",
        message: `Agent Gateway has no verified routing map for Gemini Enterprise app location ${config.appLocation}; use custom-mcp or choose a verified location (${Object.keys(
          GEMINI_AGENT_GATEWAY_LOCATION_COMPATIBILITY,
        ).join(", ")}).`,
      });
    } else {
      const compatibility = GEMINI_AGENT_GATEWAY_LOCATION_COMPATIBILITY[config.appLocation];
      if (config.gatewayLocation !== compatibility.gatewayLocation) {
        findings.push({
          level: "error",
          code: "target/gateway_location_mismatch",
          message: `${config.appLocation} apps require Agent Gateway in ${compatibility.gatewayLocation}; got ${config.gatewayLocation ?? "no gateway location"}.`,
        });
      }
      if (
        !config.registryLocation ||
        !compatibility.registryLocations.some((location) => location === config.registryLocation)
      ) {
        findings.push({
          level: "error",
          code: "target/registry_location_mismatch",
          message: `${config.appLocation} apps support manual Agent Registry registration in ${compatibility.registryLocations.join(
            " or ",
          )}; got ${config.registryLocation ?? "no registry location"}.`,
        });
      }
    }
    if (!config.confirmEngineEgressReroute) {
      findings.push({
        level: "error",
        code: "target/engine_egress_confirmation_required",
        message:
          "Agent Gateway binding reroutes all engine agent egress; pass --confirm-engine-egress-reroute after reviewing the generated rollback path.",
      });
    }

    const toolSpecBytes = new TextEncoder().encode(renderToolSpecJson(air)).byteLength;
    if (toolSpecBytes > TOOLSPEC_MAX_BYTES) {
      findings.push({
        level: "error",
        code: "target/toolspec_too_large",
        message: `Agent Registry toolspec is ${toolSpecBytes} bytes; manual registration allows at most ${TOOLSPEC_MAX_BYTES} bytes.`,
      });
    }
  }

  const provider = config.connectorOAuth.provider;
  if (config.serverAuth === "oauth") {
    if (provider === "google") {
      findings.push({
        level: "error",
        code: "target/unsupported_google_oauth_access_token",
        message:
          "Google connector OAuth access tokens may be opaque, but the generated server currently validates JWTs only; use a JWT-issuing provider or no-auth until a verified Google token verifier exists.",
      });
    }
    if ((provider === "entra" || provider === "okta") && !config.connectorOAuth.tenant) {
      findings.push({
        level: "error",
        code: "target/missing_connector_oauth_tenant",
        message: `Connector OAuth provider ${provider} requires --tenant.`,
      });
    }
    if (!provider) {
      findings.push({
        level: "error",
        code: "target/missing_connector_oauth_provider",
        message: "OAuth server auth requires the authorization server protecting /mcp via --idp.",
      });
    }
    if (provider === "other") {
      for (const [field, value, flag] of [
        ["authorization URL", config.connectorOAuth.authorizationUrl, "--oauth-authorization-url"],
        ["token URL", config.connectorOAuth.tokenUrl, "--oauth-token-url"],
      ] as const) {
        if (!value) {
          findings.push({
            level: "error",
            code: `target/missing_connector_oauth_${field.replace(" ", "_").toLowerCase()}`,
            message: `Connector OAuth provider other requires ${flag}.`,
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
            message: `${flag} must be a valid HTTPS URL; got ${value}.`,
          });
        }
      }
    }
    if (config.connectorOAuth.scopes.length === 0) {
      findings.push({
        level: "error",
        code: "target/missing_connector_oauth_scope",
        message: "OAuth server auth requires at least one MCP API scope via --oauth-scope.",
      });
    }
    const graphScope = config.connectorOAuth.scopes.find(
      (scope) => scope === "User.Read" || scope.includes("graph.microsoft.com"),
    );
    if (graphScope) {
      findings.push({
        level: "error",
        code: "target/unrelated_graph_scope",
        message: `${graphScope} is a Microsoft Graph scope, not an audience/scope for this MCP API.`,
      });
    }
    if (!config.connectorOAuth.inboundIssuer) {
      findings.push({
        level: "error",
        code: "target/missing_inbound_issuer",
        message:
          "OAuth server auth requires the issuer validated by the MCP server via --inbound-issuer.",
      });
    }
    if (!config.connectorOAuth.inboundAudience) {
      findings.push({
        level: "error",
        code: "target/missing_inbound_audience",
        message: "OAuth server auth requires the MCP API audience via --inbound-audience.",
      });
    }
  } else if (config.serverAuth === "no-auth") {
    if (!config.allowUnauthenticatedMcp) {
      findings.push({
        level: "error",
        code: "target/unauthenticated_mcp_confirmation_required",
        message:
          "No-auth exposes /mcp without a bearer token; pass --allow-unauthenticated-mcp only after reviewing compensating controls.",
      });
    }
    findings.push({
      level: "warning",
      code: "target/unauthenticated_mcp",
      message:
        "The MCP server accepts unauthenticated calls. Gemini Enterprise sign-in or Workforce Identity Federation does not protect /mcp.",
    });
  }

  // Action-selection budget.
  if (served.length > profile.actionLimits.maxActions) {
    findings.push({
      level: "error",
      code: "target/action_budget_exceeded",
      message: `${served.length} actions exceed the ${profile.actionLimits.maxActions}-action budget; split the capability.`,
    });
  }
  if (profile.actionLimits.requiresActionDescriptions) {
    const undescribed = served
      .filter((o) => o.description.trim().length === 0)
      .map((o) => o.mcp.toolName);
    if (undescribed.length > 0) {
      findings.push({
        level: "warning",
        code: "target/missing_action_descriptions",
        message: `Actions need descriptions for selection: ${undescribed.join(", ")}.`,
      });
    }
  }

  // OAuth coverage: if this target configures OAuth but nothing in the contract
  // requires auth, the server may be unintentionally open.
  const requiresOauth = config.serverAuth === "oauth";
  const contractHasAuth = served.some((o) => o.auth.type !== "none");
  if (requiresOauth && served.length > 0 && !contractHasAuth) {
    findings.push({
      level: "warning",
      code: "target/no_auth_in_contract",
      message:
        "The target configures OAuth but no operation declares auth — confirm the server is not open.",
    });
  }

  // Safety self-enforcement: keep irreversible/high-risk confirmation in the
  // contract as defense in depth, independent of platform UI defaults.
  const unconfirmed = served.filter(
    (o) =>
      o.effect.kind === "mutation" &&
      (o.effect.reversible === false ||
        o.effect.risk === "financial" ||
        o.effect.risk === "destructive") &&
      !o.confirmation.required,
  );
  for (const op of unconfirmed) {
    findings.push({
      level: "error",
      code: "target/unconfirmed_irreversible_action",
      message: `${op.mcp.toolName} is an irreversible ${op.effect.risk} mutation without contract-level confirmation; Anvil requires this defense in depth even when the platform confirms actions by default.`,
    });
  }

  return { ok: !findings.some((f) => f.level === "error"), findings };
}

function isPrivateEndpointHost(hostname: string): boolean {
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
