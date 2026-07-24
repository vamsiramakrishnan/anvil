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
  canonicalEngineProjectNumber,
  GEMINI_AGENT_GATEWAY_LOCATION_COMPATIBILITY,
  GEMINI_GATEWAY_LOCATIONS,
  GEMINI_REGISTRATION_SURFACES,
  GEMINI_REGISTRY_LOCATIONS,
  type GeminiEnterpriseTargetConfig,
  includesSurface,
  isCanonicalEngineResource,
  isGatewayCompatibleAppLocation,
  MCP_SERVER_AUTH_MODES,
} from "./config.js";
import {
  isEngineId,
  isGcpProjectId,
  isGcpProjectNumber,
  isGeminiAppLocation,
  isHttpsIssuer,
  isMcpApiScope,
  isMcpAudience,
  isWorkforcePoolResource,
  parseAgentIdentityPrincipalSet,
  parseGatewayAuthorizationPolicyResource,
} from "./coordinates.js";
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

  if (
    config.surface &&
    !GEMINI_REGISTRATION_SURFACES.some((surface) => surface === config.surface)
  ) {
    findings.push({
      level: "error",
      code: "target/invalid_surface",
      message: `--surface must be one of ${GEMINI_REGISTRATION_SURFACES.join(", ")}; got ${config.surface}.`,
    });
  }
  if (
    config.serverAuth &&
    !MCP_SERVER_AUTH_MODES.some((serverAuth) => serverAuth === config.serverAuth)
  ) {
    findings.push({
      level: "error",
      code: "target/invalid_server_auth",
      message: `--server-auth must be one of ${MCP_SERVER_AUTH_MODES.join(", ")}; got ${config.serverAuth}.`,
    });
  }
  if (config.project && !isGcpProjectId(config.project)) {
    findings.push({
      level: "error",
      code: "target/invalid_project",
      message:
        "--project must be a 6-30 character Google Cloud project ID: lowercase letters, digits, or hyphens; start with a letter and do not end with a hyphen.",
    });
  }
  if (config.projectNumber && !isGcpProjectNumber(config.projectNumber)) {
    findings.push({
      level: "error",
      code: "target/invalid_project_number",
      message: `--project-number must be a complete positive numeric Google Cloud project identity; got ${config.projectNumber}.`,
    });
  }
  if (config.appLocation && !isGeminiAppLocation(config.appLocation)) {
    findings.push({
      level: "error",
      code: "target/invalid_app_location",
      message: `--location must be global, us, eu, or a Google Cloud region such as us-central1; got ${config.appLocation}.`,
    });
  }
  if (config.engine) {
    const canonical = isCanonicalEngineResource(config.engine);
    if (config.engine.includes("/") && !canonical) {
      findings.push({
        level: "error",
        code: "target/invalid_engine_resource",
        message:
          "--engine must be an RFC-1034 engine id or an exact projects/<number>/locations/<location>/collections/<collection>/engines/<engine> resource.",
      });
    } else if (!config.engine.includes("/") && !isEngineId(config.engine)) {
      findings.push({
        level: "error",
        code: "target/invalid_engine_id",
        message:
          "--engine must start with a lowercase letter and contain at most 63 lowercase letters, digits, hyphens, or underscores.",
      });
    }
    const resourceProjectNumber = canonicalEngineProjectNumber(config.engine);
    if (
      resourceProjectNumber &&
      config.projectNumber &&
      resourceProjectNumber !== config.projectNumber
    ) {
      findings.push({
        level: "error",
        code: "target/engine_project_number_mismatch",
        message: `Canonical engine project number ${resourceProjectNumber} does not match --project-number ${config.projectNumber}.`,
      });
    }
    const resourceLocation = canonicalEngineLocation(config.engine);
    if (resourceLocation && config.appLocation && resourceLocation !== config.appLocation) {
      findings.push({
        level: "error",
        code: "target/engine_location_mismatch",
        message: `Canonical engine location ${resourceLocation} does not match --location ${config.appLocation}.`,
      });
    }
  }
  if (config.workforcePool && !isWorkforcePoolResource(config.workforcePool)) {
    findings.push({
      level: "error",
      code: "target/invalid_workforce_pool",
      message:
        "--wif must be an exact locations/global/workforcePools/<pool-id> resource; it describes Gemini Enterprise sign-in, not /mcp auth.",
    });
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

  if (
    includesSurface(config, "custom-mcp") &&
    config.appLocation &&
    isGeminiAppLocation(config.appLocation)
  ) {
    findings.push({
      level: "warning",
      code: "target/provider_location_validation_required",
      message: `Confirm that Gemini Enterprise currently supports Custom MCP in app location ${config.appLocation}; Anvil records the location but does not probe the live provider.`,
    });
  }

  if (includesSurface(config, "agent-gateway") && config.appLocation) {
    if (
      config.gatewayLocation &&
      !GEMINI_GATEWAY_LOCATIONS.some((location) => location === config.gatewayLocation)
    ) {
      findings.push({
        level: "error",
        code: "target/invalid_gateway_location",
        message: `--gateway-location must be one of ${GEMINI_GATEWAY_LOCATIONS.join(", ")}; got ${config.gatewayLocation}.`,
      });
    }
    if (
      config.registryLocation &&
      !GEMINI_REGISTRY_LOCATIONS.some((location) => location === config.registryLocation)
    ) {
      findings.push({
        level: "error",
        code: "target/invalid_registry_location",
        message: `--registry-location must be one of ${GEMINI_REGISTRY_LOCATIONS.join(", ")}; got ${config.registryLocation}.`,
      });
    }
    if (!config.agentIdentityPrincipalSet) {
      findings.push({
        level: "error",
        code: "target/missing_agent_identity_principal_set",
        message:
          "Agent Gateway requires --agent-identity-principal-set so generated IAM and readiness evidence identify the exact deployed-agent principal.",
      });
    } else {
      const principal = parseAgentIdentityPrincipalSet(config.agentIdentityPrincipalSet);
      if (!principal) {
        findings.push({
          level: "error",
          code: "target/invalid_agent_identity_principal_set",
          message:
            "--agent-identity-principal-set must be a documented principalSet://agents.global.org-<organization-number>.system.id.goog/<agent-scope> resource.",
        });
      } else if (!principal.projectNumber) {
        findings.push({
          level: "error",
          code: "target/agent_identity_principal_scope_too_broad",
          message:
            "Agent Gateway IAM requires a project-scoped deployed-agent principalSet; organization-wide and platform-wide principal sets are too broad.",
        });
      } else {
        const declaredProjectNumbers = [
          config.projectNumber,
          canonicalEngineProjectNumber(config.engine),
        ].filter((value): value is string => value !== undefined);
        const mismatched = declaredProjectNumbers.find(
          (projectNumber) => projectNumber !== principal.projectNumber,
        );
        if (mismatched) {
          findings.push({
            level: "error",
            code: "target/agent_identity_principal_project_mismatch",
            message:
              `Agent identity principal project ${principal.projectNumber} does not match ` +
              `the target engine/project identity ${mismatched}.`,
          });
        }
      }
    }
    if (!config.gatewayAuthorizationPolicy) {
      findings.push({
        level: "error",
        code: "target/missing_gateway_authorization_policy",
        message:
          "Agent Gateway requires --gateway-authorization-policy naming the exact attached authorization-policy resource.",
      });
    } else {
      const policy = parseGatewayAuthorizationPolicyResource(config.gatewayAuthorizationPolicy);
      if (!policy) {
        findings.push({
          level: "error",
          code: "target/invalid_gateway_authorization_policy",
          message:
            "--gateway-authorization-policy must be an exact projects/<project>/locations/<region>/authzPolicies/<policy> resource.",
        });
      } else {
        if (policy.project !== config.project) {
          findings.push({
            level: "error",
            code: "target/gateway_authorization_policy_project_mismatch",
            message: `Authorization policy project ${policy.project} does not match --project ${config.project}.`,
          });
        }
        if (config.gatewayLocation && policy.location !== config.gatewayLocation) {
          findings.push({
            level: "error",
            code: "target/gateway_authorization_policy_location_mismatch",
            message: `Authorization policy location ${policy.location} does not match --gateway-location ${config.gatewayLocation}.`,
          });
        }
      }
    }
    if (!isCanonicalEngineResource(config.engine) && !config.projectNumber) {
      findings.push({
        level: "error",
        code: "target/missing_project_number",
        message:
          "Agent Gateway binding needs --project-number to synthesize the canonical engine resource; alternatively pass the full projects/.../engines/... resource to --engine.",
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
    if (provider === "entra" || provider === "okta") {
      if (!config.connectorOAuth.tenant) {
        findings.push({
          level: "error",
          code: "target/missing_connector_oauth_tenant",
          message: `Connector OAuth provider ${provider} requires --tenant.`,
        });
      } else if (!isSafeConnectorTenant(provider, config.connectorOAuth.tenant)) {
        findings.push({
          level: "error",
          code: "target/invalid_connector_oauth_tenant",
          message:
            provider === "okta"
              ? "--tenant must be an exact credential-free Okta hostname, with no path, port, query, or fragment."
              : "--tenant must be an exact Entra tenant id or verified domain, with no URL delimiters.",
        });
      }
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
    } else if (!isHttpsIssuer(config.connectorOAuth.inboundIssuer)) {
      findings.push({
        level: "error",
        code: "target/invalid_inbound_issuer",
        message:
          "--inbound-issuer must be a credential-free HTTPS issuer URL without a query string or fragment.",
      });
    } else if (
      (provider === "entra" || provider === "okta") &&
      config.connectorOAuth.tenant &&
      isSafeConnectorTenant(provider, config.connectorOAuth.tenant) &&
      !issuerMatchesConnectorTenant(
        provider,
        config.connectorOAuth.tenant,
        config.connectorOAuth.inboundIssuer,
      )
    ) {
      findings.push({
        level: "error",
        code: "target/inbound_issuer_tenant_mismatch",
        message:
          "The inbound issuer does not match the authorization-server tenant selected by --idp and --tenant.",
      });
    }
    if (!config.connectorOAuth.inboundAudience) {
      findings.push({
        level: "error",
        code: "target/missing_inbound_audience",
        message: "OAuth server auth requires the MCP API audience via --inbound-audience.",
      });
    } else if (!isMcpAudience(config.connectorOAuth.inboundAudience)) {
      findings.push({
        level: "error",
        code: "target/invalid_inbound_audience",
        message:
          "--inbound-audience must be a URI that uniquely identifies this MCP API, such as api://anvil-mcp.",
      });
    }
    for (const scope of config.connectorOAuth.scopes) {
      if (!isMcpApiScope(scope)) {
        findings.push({
          level: "error",
          code: "target/invalid_connector_oauth_scope",
          message: `OAuth scope ${JSON.stringify(scope)} must be a resource-qualified MCP API scope, such as mcp.invoke or api://anvil-mcp/mcp.invoke.`,
        });
      } else if (
        config.connectorOAuth.inboundAudience &&
        /^[a-z][a-z0-9+.-]*:\/\//i.test(scope) &&
        !scope.startsWith(`${config.connectorOAuth.inboundAudience.replace(/\/+$/, "")}/`)
      ) {
        findings.push({
          level: "error",
          code: "target/oauth_scope_audience_mismatch",
          message: `OAuth scope ${JSON.stringify(scope)} is qualified for a different resource than --inbound-audience ${JSON.stringify(config.connectorOAuth.inboundAudience)}.`,
        });
      }
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

function isSafeConnectorTenant(provider: "entra" | "okta", tenant: string): boolean {
  if (provider === "entra") {
    return (
      tenant.length <= 253 &&
      /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(tenant) &&
      !tenant.includes("..")
    );
  }
  try {
    const url = new URL(`https://${tenant}`);
    return (
      tenant.includes(".") &&
      url.hostname === tenant.toLowerCase() &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function issuerMatchesConnectorTenant(
  provider: "entra" | "okta",
  tenant: string,
  issuer: string,
): boolean {
  const url = new URL(issuer);
  if (provider === "okta") return url.hostname === tenant.toLowerCase();
  const expectedPath = `/${tenant.toLowerCase()}/v2.0`;
  return (
    url.hostname === "login.microsoftonline.com" &&
    url.pathname.replace(/\/+$/, "").toLowerCase() === expectedPath
  );
}
