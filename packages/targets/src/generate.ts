/**
 * Generate the registration + operations kit for a target platform. Pure and
 * deterministic: sorted, no timestamps, so the same contract + profile produce
 * byte-identical kit files. The files become pack artifacts under
 * `targets/<id>/`.
 */
import type { AirDocument } from "@anvil/air";
import { surfaceSignatureFor } from "@anvil/compiler";
import {
  renderAgentGatewayReadinessJson,
  renderAgentGatewayRollbackScript,
  renderAgentGatewayRunbook,
  renderAgentGatewayYaml,
  renderAgentRegistryScript,
  renderAgentRegistryTf,
  renderToolSpecJson,
} from "./agent-registry.js";
import {
  connectorOAuthEndpoints,
  connectorScopes,
  engineResource,
  engineStateKey,
  GEMINI_SURFACE_LABELS,
  type GeminiEnterpriseTargetConfig,
  type GeminiRegistrationSurface,
  geminiEnterpriseTargetDisplayName,
  includesSurface,
  isCanonicalEngineResource,
  targetStateRelativePath,
} from "./config.js";
import type { AgentPlatformTargetProfile, TargetKit, TargetKitFile } from "./model.js";
import {
  buildRegistrationRequest,
  renderRegistrationCurl,
  renderRegistrationJson,
} from "./registration.js";
import { validateTarget } from "./validate.js";

const enc = (s: string) => new TextEncoder().encode(s);
const json = (v: unknown) => enc(`${JSON.stringify(v, null, 2)}\n`);
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const terraformString = (value: string) => JSON.stringify(value).replaceAll("${", () => "$${");

/** Build the target kit for a capability's contract. */
export function generateTargetKit(
  air: AirDocument,
  profile: AgentPlatformTargetProfile,
  config: GeminiEnterpriseTargetConfig,
): TargetKit {
  const dir = `targets/${profile.id}`;
  const served = air.operations
    .filter((o) => o.state === "approved")
    .sort((a, b) => a.mcp.toolName.localeCompare(b.mcp.toolName));
  const signature = surfaceSignatureFor(air);
  const compatibility = validateTarget(air, profile, config);
  const endpoints = connectorOAuthEndpoints(config);
  const canonicalEngine =
    isCanonicalEngineResource(config.engine) || config.projectNumber
      ? engineResource(config)
      : undefined;
  const mutableStatePath = includesSurface(config, "agent-gateway")
    ? targetStateRelativePath(config)
    : undefined;
  const oauthTemplate =
    config.serverAuth === "oauth"
      ? {
          serverAuth: "oauth",
          provider: config.connectorOAuth.provider ?? null,
          tenant: config.connectorOAuth.tenant ?? null,
          authorizationUrl: endpoints.authUri,
          tokenUrl: endpoints.tokenUri,
          scopes: connectorScopes(config),
          inboundIssuer: config.connectorOAuth.inboundIssuer ?? null,
          inboundAudience: config.connectorOAuth.inboundAudience ?? null,
          inboundResource: config.endpoint,
          redirectUri: "https://vertexaisearch.cloud.google.com/oauth-redirect",
          clientId: "",
          clientSecretRef: "",
        }
      : {
          serverAuth: "no-auth",
          warning: "The public /mcp endpoint accepts calls without a bearer token.",
        };

  const files: TargetKitFile[] = [
    { path: `${dir}/target-profile.json`, bytes: json(profile) },
    {
      path: `${dir}/README.md`,
      bytes: enc(targetReadme(air, profile, config)),
    },
    {
      path: `${dir}/setup.json`,
      bytes: json({
        target: profile.id,
        version: profile.version,
        transport: profile.transportRequirements[0]?.kind ?? "streamable-http",
        config,
        engineResource: canonicalEngine ?? null,
        mutableState: mutableStatePath
          ? {
              rootEnvironmentVariable: "ANVIL_STATE_DIR",
              relativePath: mutableStatePath,
              externalToBundle: true,
            }
          : null,
        auth: config.serverAuth,
        inboundAuth:
          config.serverAuth === "oauth"
            ? {
                mode: "oauth",
                resource: config.endpoint,
                issuer: config.connectorOAuth.inboundIssuer ?? null,
                audience: config.connectorOAuth.inboundAudience ?? null,
                scopes: connectorScopes(config),
              }
            : { mode: "no-auth" },
        actionCount: served.length,
        surfaceSignatureDigest: signature.digest,
        // The human-in-the-loop steps that remain after generation (console-only
        // OAuth consent / registry import) — travels with the kit for a harness.
        interactiveSteps: selectedInteractiveSteps(profile, config),
      }),
    },
    { path: `${dir}/oauth.template.json`, bytes: json(oauthTemplate) },
    { path: `${dir}/inbound-auth.env`, bytes: enc(inboundAuthEnv(profile, config)) },
    {
      path: `${dir}/server-description.md`,
      bytes: enc(serverDescription(air, profile, config)),
    },
    {
      path: `${dir}/action-selection.json`,
      bytes: json({
        actions: served.map((o) => ({
          name: o.mcp.toolName,
          description: o.description || o.displayName,
          mutating: o.effect.kind === "mutation",
          confirms: o.confirmation.required,
        })),
      }),
    },
    {
      path: `${dir}/organization-policy-checklist.md`,
      bytes: enc(orgPolicyChecklist(profile, config)),
    },
    { path: `${dir}/admin-runbook.md`, bytes: enc(adminRunbook(air, profile, config)) },
    { path: `${dir}/compatibility-report.json`, bytes: json(compatibility) },
    // A public connector overlays the generic Cloud Run deploy through an
    // external var-file. Never copy it into compiler-owned deploy/terraform:
    // target artifacts must be present before certification and remain immutable.
    ...(isPublicConnector(profile)
      ? [
          {
            path: `${dir}/terraform/cloud-run.tfvars`,
            bytes: enc(connectorTfvars(profile, config)),
          },
          {
            path: `${dir}/terraform/README.md`,
            bytes: enc(connectorTerraformReadme(air, profile, config)),
          },
        ]
      : []),
    // Experimental API reference only. The normal Custom MCP journey is console-first;
    // the script injects runtime secrets into a trap-deleted temporary body.
    ...(isPublicConnector(profile) && includesSurface(config, "custom-mcp")
      ? (() => {
          const reg = buildRegistrationRequest(air, {
            endpoint: config.endpoint,
            project: config.project,
            location: config.appLocation,
            authType: config.serverAuth === "no-auth" ? "NO_AUTH" : "OAUTH",
            authUri: config.serverAuth === "oauth" ? endpoints.authUri : undefined,
            tokenUri: config.serverAuth === "oauth" ? endpoints.tokenUri : undefined,
            scopes: config.serverAuth === "oauth" ? connectorScopes(config) : undefined,
          });
          return [
            {
              path: `${dir}/registration.request.template.json`,
              bytes: enc(renderRegistrationJson(reg)),
            },
            { path: `${dir}/registration.curl.sh`, bytes: enc(renderRegistrationCurl(reg)) },
          ];
        })()
      : []),
    // The guarded Agent Registry / Agent Gateway surface. Toolspec is generated
    // from the same approved operations, so it never drifts.
    ...(isPublicConnector(profile) && includesSurface(config, "agent-gateway")
      ? (() => {
          const ar = {
            endpoint: config.endpoint,
            project: config.project,
            location: config.appLocation,
            gatewayLocation: config.gatewayLocation,
            registryLocation: config.registryLocation,
            engine: canonicalEngine,
            projectNumber: config.projectNumber,
            stateKey: engineStateKey(config),
            agentIdentityPrincipalSet: config.agentIdentityPrincipalSet,
            gatewayAuthorizationPolicy: config.gatewayAuthorizationPolicy,
          };
          return [
            { path: `${dir}/agent-registry/toolspec.json`, bytes: enc(renderToolSpecJson(air)) },
            {
              path: `${dir}/agent-registry/agent-gateway.yaml`,
              bytes: enc(renderAgentGatewayYaml(air, ar)),
            },
            {
              path: `${dir}/agent-registry/agent-registry.tf`,
              bytes: enc(renderAgentRegistryTf(air, ar)),
            },
            {
              path: `${dir}/agent-registry/readiness.template.json`,
              bytes: enc(renderAgentGatewayReadinessJson(air, ar)),
            },
            {
              path: `${dir}/agent-registry/register.sh`,
              bytes: enc(renderAgentRegistryScript(air, ar)),
            },
            {
              path: `${dir}/agent-registry/rollback.sh`,
              bytes: enc(renderAgentGatewayRollbackScript(air, ar)),
            },
            {
              path: `${dir}/agent-registry/agent-gateway.md`,
              bytes: enc(renderAgentGatewayRunbook(air, ar)),
            },
          ];
        })()
      : []),
  ].sort((a, b) => a.path.localeCompare(b.path));

  return { targetId: profile.id, targetVersion: profile.version, files };
}

function serverDescription(
  air: AirDocument,
  _profile: AgentPlatformTargetProfile,
  config: GeminiEnterpriseTargetConfig,
): string {
  const caps = air.capabilities.map((c) => `- ${c.displayName}: ${c.description || c.id}`).sort();
  return `# ${air.service.displayName ?? air.service.id}\n\nTargeted for ${geminiEnterpriseTargetDisplayName(config)}.\n\n## Capabilities\n${caps.join("\n")}\n`;
}

function orgPolicyChecklist(
  profile: AgentPlatformTargetProfile,
  config: GeminiEnterpriseTargetConfig,
): string {
  const net = profile.networkingRequirements.map((n) => `- [ ] ${n.description}`).join("\n");
  const assumptions = [...profile.unsupportedAssumptions];
  if (includesSurface(config, "custom-mcp")) {
    assumptions.push(
      "An external gateway in front of the direct Custom MCP endpoint is not assumed; controls travel in the pack.",
      "The raw setUpDataConnector API cannot finish OAuth consent; the connector reaches ACTIVE only after the console's interactive Authorize step.",
    );
  }
  if (includesSurface(config, "agent-gateway")) {
    assumptions.push(
      "Agent Gateway IAM does not replace the MCP server's bearer-token validation.",
      "Registering a service does not import it into a Gemini Enterprise app; that step remains console-only.",
    );
  }
  const assume = assumptions.map((assumption) => `- [ ] ${assumption}`).join("\n");
  return `# Organization policy checklist — ${geminiEnterpriseTargetDisplayName(config)}\n\n## Networking\n${net}\n\n## Do not assume\n${assume}\n`;
}

function adminRunbook(
  air: AirDocument,
  profile: AgentPlatformTargetProfile,
  config: GeminiEnterpriseTargetConfig,
): string {
  const steps = [
    [
      "Retain `terraform/cloud-run.tfvars` as the deployment input; do not copy",
      "target files into compiler-owned output. Certify the complete bundle, then",
      "copy `deploy/terraform` into an empty external work directory and run init,",
      "plan, and apply only there. This keeps `.terraform`, lockfiles, and `tfplan`",
      `out of the immutable trees. Deploy the MCP server at ${config.endpoint}.`,
      "The server is Streamable HTTP and session-based; SSE and stateless mode are",
      "not compatible with this target.",
    ].join(" "),
    config.serverAuth === "oauth"
      ? "Verify the applied `ANVIL_INBOUND_*` contract. RESOURCE is the public MCP URL used for discovery; AUDIENCE is the distinct JWT audience. Gemini Enterprise sign-in and Workforce Identity Federation are separate."
      : "WARNING: `inbound-auth.env` explicitly sets no-auth. The public `/mcp` endpoint has no bearer-token gate; Gemini Enterprise sign-in and Workforce Identity Federation do not protect it.",
    "Grant the registering administrator `roles/discoveryengine.editor` and ensure the server URL is reachable. A protected project also requires the endpoint to be allowlisted.",
  ];
  if (includesSurface(config, "custom-mcp")) {
    steps.push(
      config.serverAuth === "oauth"
        ? "Create the connector OAuth client at the provider in `oauth.template.json`. Its redirect URI is `https://vertexaisearch.cloud.google.com/oauth-redirect`; store its secret outside this kit."
        : "Review and retain the explicit no-auth acknowledgement and compensating controls.",
      [
        "In the Gemini Enterprise console, create a Custom MCP Server data store",
        "using the plan's copy fields. This console-first path is the supported",
        config.serverAuth === "oauth"
          ? "path because OAuth authorization is interactive."
          : "path; choose No authentication.",
        "`registration.curl.sh` is an opt-in experimental API reference, not part",
        "of the supported console-first path.",
      ].join(" "),
    );
  }
  if (includesSurface(config, "agent-gateway")) {
    steps.push(
      "Review `agent-registry/register.sh`, `rollback.sh`, and the canonical engine resource in `setup.json`. Set `ANVIL_STATE_DIR` to an absolute directory outside the bundle, then run `ANVIL_RECONCILE_REGISTRY_GATEWAY=1 ANVIL_CONFIRM_REGISTRY_GATEWAY_RECONCILE=1 bash agent-registry/register.sh`. With no readiness file, this copies the template to external state and exits before any provider read or mutation.",
      "Provision and independently verify the exact authorization policy, IAM grants, service-agent access, and MCP readiness in `readiness.json`. Rerun the explicit reconciliation command; it reconciles and readback-verifies the registry and gateway only, without binding the engine.",
      "Separately bind after review with `ANVIL_CONFIRM_ENGINE_EGRESS_REROUTE=1 bash agent-registry/register.sh`. This repeats all read-only preflights and uses the engine etag as a concurrency precondition.",
      "Complete the console-only registry import. To restore the previous route, run `ANVIL_CONFIRM_ENGINE_EGRESS_ROLLBACK=1 bash agent-registry/rollback.sh` after inspecting the retained snapshot.",
    );
  }
  return [
    `# Admin runbook — ${air.service.displayName ?? air.service.id} on ${geminiEnterpriseTargetDisplayName(config)}`,
    "",
    ...steps.flatMap((step, index) => [`${index + 1}. ${step}`, ""]),
    `Final check: keep the enabled surface under ${profile.actionLimits.maxActions} actions and confirm \`compatibility-report.json\` has no errors.`,
    "",
  ].join("\n");
}

function targetReadme(
  air: AirDocument,
  profile: AgentPlatformTargetProfile,
  config: GeminiEnterpriseTargetConfig,
): string {
  const selectedSurface =
    GEMINI_SURFACE_LABELS[config.surface as GeminiRegistrationSurface] ?? "Unselected surface";
  const identityLines = [
    "- `inbound-auth.env` configures the token accepted by the MCP resource server.",
    "- `workforcePool` in `setup.json`, when present, identifies Gemini Enterprise sign-in and does not protect `/mcp`.",
    ...(includesSurface(config, "agent-gateway")
      ? [
          "- Agent Gateway IAM controls gateway and runtime reachability; it does not replace OAuth bearer-token validation at the MCP server.",
        ]
      : []),
  ];
  const surfaceSections: string[] = [];
  if (includesSurface(config, "custom-mcp")) {
    surfaceSections.push(`## ${GEMINI_SURFACE_LABELS["custom-mcp"]}

Use the console-first data-store journey. Start with \`oauth.template.json\`,
\`inbound-auth.env\`, and the Custom MCP copy fields printed by \`anvil target\`.
\`registration.request.template.json\` and \`registration.curl.sh\` are
experimental API references; they cannot complete interactive OAuth consent.`);
  }
  if (includesSurface(config, "agent-gateway")) {
    surfaceSections.push(`## ${GEMINI_SURFACE_LABELS["agent-gateway"]}

Start with \`agent-registry/agent-gateway.md\`. Registration, readiness,
reconciliation, engine binding, and rollback are deliberately separate phases.
Mutable readiness and rollback evidence belongs under the external
\`ANVIL_STATE_DIR\`, never inside this certified target subtree.`);
  }
  return `# ${air.service.displayName ?? air.service.id} — Gemini Enterprise target

Selected integration: **${selectedSurface}**

This directory is the deterministic, non-secret target projection for
${profile.displayName}. It records configuration; it does not prove that the
named provider resources exist or that IAM grants are effective.

## Start here

1. Confirm \`compatibility-report.json\` has no errors.
2. Review \`organization-policy-checklist.md\` and \`admin-runbook.md\`.
3. Apply \`terraform/cloud-run.tfvars\` only from the external Terraform work
   directory described in \`terraform/README.md\`.
4. Complete only the selected integration journey below.

## Identity boundaries

${identityLines.join("\n")}

${surfaceSections.join("\n\n")}
`;
}

function selectedInteractiveSteps(
  profile: AgentPlatformTargetProfile,
  config: GeminiEnterpriseTargetConfig,
): AgentPlatformTargetProfile["interactiveSteps"] {
  return profile.interactiveSteps
    .filter(
      (step) =>
        (step.surface === "data-connector" && includesSurface(config, "custom-mcp")) ||
        (step.surface === "agent-registry" && includesSurface(config, "agent-gateway")),
    )
    .map((step) =>
      step.surface === "data-connector" && config.serverAuth === "no-auth"
        ? {
            ...step,
            action: "Create the Custom MCP Server data store with No authentication",
            why: "Creating the Custom MCP data store remains a console-first operation.",
          }
        : step,
    );
}

/** A connector whose platform reaches the server over the public internet. */
function isPublicConnector(profile: AgentPlatformTargetProfile): boolean {
  return profile.transportRequirements.some((t) => t.publicEndpoint);
}

/**
 * The inbound-auth env map (Terraform `var.env`), from the primary auth scheme.
 * For Gemini Enterprise's `OAUTH` connector the platform presents the user's IdP
 * token to `/mcp`, so the server validates it as an OIDC resource server: the
 * issuer and audience come from YOUR IdP / OAuth client, not from the endpoint.
 */
function inboundEnvEntries(config: GeminiEnterpriseTargetConfig): Record<string, string> {
  if (config.serverAuth === "no-auth") {
    return { ANVIL_INBOUND_AUTH_MODE: "none" };
  }
  return {
    ANVIL_INBOUND_AUTH_MODE: "oidc",
    ANVIL_INBOUND_RESOURCE: config.endpoint,
    ANVIL_INBOUND_ISSUER: config.connectorOAuth.inboundIssuer ?? "<mcp-api-issuer>",
    ANVIL_INBOUND_AUDIENCE: config.connectorOAuth.inboundAudience ?? "<mcp-api-audience>",
    ANVIL_INBOUND_REQUIRED_SCOPES: connectorScopes(config).join(" "),
  };
}

/**
 * Surface-specific Cloud Run reachability. A direct Custom MCP connector cannot
 * present Google Cloud Run IAM credentials, so it needs allUsers at the edge and
 * relies on the generated resource-server contract. Agent Gateway-only traffic
 * stays IAM-gated to the exact agent principalSet, preventing a direct public
 * bypass even when the MCP application deliberately uses no-auth.
 */
function connectorTfvars(
  profile: AgentPlatformTargetProfile,
  config: GeminiEnterpriseTargetConfig,
): string {
  const env = inboundEnvEntries(config);
  const directCustomMcp = includesSurface(config, "custom-mcp");
  const gatewayInvoker =
    includesSurface(config, "agent-gateway") && config.agentIdentityPrincipalSet
      ? [config.agentIdentityPrincipalSet]
      : [];
  const authComment = !directCustomMcp
    ? "# Agent Gateway-only: Cloud Run invocation is restricted to the exact agent principalSet."
    : config.serverAuth === "oauth"
      ? "# The server's ANVIL_INBOUND_* OAuth checks are the application gate."
      : "# WARNING: direct Custom MCP + no-auth deliberately exposes /mcp; this requires explicit acknowledgement.";
  return `${[
    `# ${profile.displayName} — surface-specific overlay for the generic Cloud Run deploy.`,
    "# Pass this file explicitly with -var-file; never copy it into deploy/terraform.",
    authComment,
    'ingress               = "INGRESS_TRAFFIC_ALL"',
    `allow_unauthenticated = ${directCustomMcp}`,
    `invoker_members       = [${gatewayInvoker.map(terraformString).join(", ")}]`,
    "env = {",
    ...Object.entries(env).map(([k, v]) => `  ${k} = ${terraformString(v)}`),
    "}",
    "",
  ].join("\n")}`;
}

/** No-copy integration instructions for the compiler-owned deployment module. */
function connectorTerraformReadme(
  air: AirDocument,
  profile: AgentPlatformTargetProfile,
  config: GeminiEnterpriseTargetConfig,
): string {
  return `# ${profile.displayName} Cloud Run deployment inputs

\`cloud-run.tfvars\` sets only variables already declared by the generated
\`deploy/terraform\` module. Keep this target subtree intact and pass the file
explicitly. Never copy it into compiler-owned deployment output: that changes
the bundle after targeting and invalidates certification.

\`\`\`bash
set -euo pipefail
export ANVIL_BUNDLE_DIR="$(pwd -P)"
anvil certify "$ANVIL_BUNDLE_DIR"
export ANVIL_TF_WORK_DIR=/absolute/private/path/outside/the/bundle/terraform-work
export ANVIL_TF_STATE_BUCKET=REPLACE_WITH_EXISTING_GCS_BUCKET
export ANVIL_TF_STATE_PREFIX=${shellQuote(`anvil/${air.service.id}-tools`)}
export TF_VAR_project_id=${shellQuote(config.project)}
export TF_VAR_image_tag=REPLACE_WITH_IMMUTABLE_IMAGE_TAG
if [[ "$ANVIL_TF_WORK_DIR" != /* ]]
then
  echo "ANVIL_TF_WORK_DIR must be absolute" >&2
  exit 1
fi
if [[ "$ANVIL_TF_STATE_BUCKET" == REPLACE_* || "$TF_VAR_image_tag" == REPLACE_* ]]
then
  echo "Set the backend bucket and immutable image tag before planning" >&2
  exit 1
fi
install -d -m 700 "$ANVIL_TF_WORK_DIR"
export ANVIL_TF_WORK_DIR="$(cd "$ANVIL_TF_WORK_DIR" && pwd -P)"
if [[ "$ANVIL_TF_WORK_DIR/" == "$ANVIL_BUNDLE_DIR/"* ]]
then
  echo "ANVIL_TF_WORK_DIR must be outside the bundle" >&2
  exit 1
fi
if [[ -n "$(find "$ANVIL_TF_WORK_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]
then
  echo "ANVIL_TF_WORK_DIR must be empty" >&2
  exit 1
fi
cp -R "$ANVIL_BUNDLE_DIR/deploy/terraform/." "$ANVIL_TF_WORK_DIR/"
terraform -chdir="$ANVIL_TF_WORK_DIR" init -input=false \\
  -backend-config="bucket=$ANVIL_TF_STATE_BUCKET" \\
  -backend-config="prefix=$ANVIL_TF_STATE_PREFIX"
terraform -chdir="$ANVIL_TF_WORK_DIR" plan -input=false \\
  -var-file="$ANVIL_BUNDLE_DIR/targets/gemini-enterprise/terraform/cloud-run.tfvars" \\
  -out="$ANVIL_TF_WORK_DIR/tfplan"
# Stop here for plan review and approval before applying.
terraform -chdir="$ANVIL_TF_WORK_DIR" apply "$ANVIL_TF_WORK_DIR/tfplan"
\`\`\`

Terraform may create \`.terraform/\`, \`.terraform.lock.hcl\`, and \`tfplan\`;
all three stay in \`ANVIL_TF_WORK_DIR\`. Do not run Terraform with
\`-chdir=deploy/terraform\` or \`-chdir=targets/...\`.

Provision the registering administrator's \`roles/discoveryengine.editor\` grant
through the organization's IAM workflow. This target kit does not guess or own
that principal. Configure required organization-policy endpoint allowlisting
outside the per-capability Terraform module.
`;
}

/**
 * The inbound-auth environment contract for the connector's MCP server. These
 * are non-secret configuration values read by `@anvil/mcp-runtime`'s resource
 * server; the actual token is presented by the platform at call time. Defaults
 * to the profile's first auth scheme, with the alternative shown commented.
 */
function inboundAuthEnv(
  profile: AgentPlatformTargetProfile,
  config: GeminiEnterpriseTargetConfig,
): string {
  const env = inboundEnvEntries(config);
  const lines = [
    `# Inbound auth for the ${profile.displayName} connector's MCP server.`,
    "# These are non-secret resource-server configuration values.",
    "# GE sign-in / Workforce Identity Federation is separate from this choice.",
    "",
  ];
  if (config.serverAuth === "no-auth") {
    lines.push(
      "# WARNING: explicitly selected NO_AUTH; the public /mcp endpoint accepts",
      "# requests without a bearer token. Use only with reviewed compensating controls.",
    );
  } else {
    lines.push(
      "# OAUTH: validate the connector authorization server's token for this MCP API.",
      "# ANVIL_INBOUND_JWKS_URI=<override; otherwise discovered from the issuer>",
    );
  }
  lines.push(...Object.entries(env).map(([key, value]) => `${key}=${value}`));
  return `${lines.join("\n")}\n`;
}
