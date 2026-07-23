/**
 * The connector "plan" — the intuitive, copy-paste-first guide the CLI shows after
 * generating a Gemini Enterprise kit. It turns the profile + what the operator
 * supplied in the validated target config into a sequenced, sectioned plan:
 * what Anvil already did, what the operator RUNS, and what is CONSOLE-only
 * (interactive) — each console step with a pre-assembled deep link and aligned
 * copy-paste fields, plus separate connector-OAuth and GE Workforce guidance.
 *
 * Pure and deterministic (no I/O, no timestamps) so it is testable and can be
 * rendered as text or JSON.
 */
import type { AirDocument } from "@anvil/air";
import {
  connectorOAuthEndpoints,
  connectorScopes,
  type GeminiEnterpriseTargetConfig,
  type GeminiRegistrationSurface,
  includesSurface,
} from "./config.js";
import type { AgentPlatformTargetProfile } from "./model.js";

export interface CopyField {
  label: string;
  value: string;
}
export interface ConsoleStep {
  surface: Exclude<GeminiRegistrationSurface, "both">;
  action: string;
  /** Pre-assembled console deep link (best-effort; the breadcrumb in `where` guides the rest). */
  url: string;
  where: string;
  why: string;
  copy: CopyField[];
}
export interface RunStep {
  step: string;
  command: string;
}
export interface IdentityGuidance {
  resolved: boolean;
  summary: string;
  authUri: string;
  tokenUri: string;
  createClientWhere: string;
  redirectUri: string;
  notes: string[];
}
export interface ConnectorPlan {
  service: string;
  toolCount: number;
  actionBudget: number;
  selectedSurface: GeminiRegistrationSurface | "";
  surfaces: { id: string; label: string; when: string }[];
  identity: IdentityGuidance;
  run: RunStep[];
  console: ConsoleStep[];
}

const REDIRECT_URI = "https://vertexaisearch.cloud.google.com/oauth-redirect";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** The GE console deep link for the app/engine. */
function consoleUrl(config: GeminiEnterpriseTargetConfig): string {
  if (config.project && config.engine && config.appLocation) {
    const engineId = config.engine.split("/").pop();
    return `https://console.cloud.google.com/gemini-enterprise/locations/${config.appLocation}/engines/${engineId}/data?project=${config.project}`;
  }
  return "https://console.cloud.google.com/gemini-enterprise (open your app)";
}

function identityGuidance(config: GeminiEnterpriseTargetConfig): IdentityGuidance {
  const provider = config.connectorOAuth.provider;
  const endpoints = connectorOAuthEndpoints(config);
  const workforceNote = config.workforcePool
    ? [
        `GE sign-in uses Workforce pool ${config.workforcePool}. This controls access to Gemini Enterprise; it does not choose the OAuth token accepted by /mcp.`,
      ]
    : [
        "If GE sign-in uses Workforce Identity Federation, record it with --wif <pool>; connector OAuth remains a separate configuration.",
      ];
  if (config.serverAuth === "no-auth") {
    return {
      resolved: true,
      summary:
        "MCP server auth: explicitly unauthenticated. Gemini Enterprise sign-in does not protect the public /mcp endpoint.",
      redirectUri: "(not used)",
      authUri: "(not used)",
      tokenUri: "(not used)",
      createClientWhere: "(no OAuth client)",
      notes: workforceNote,
    };
  }
  const base = {
    resolved:
      provider !== undefined &&
      provider !== "google" &&
      (provider !== "other" ||
        Boolean(config.connectorOAuth.authorizationUrl && config.connectorOAuth.tokenUrl)),
    redirectUri: REDIRECT_URI,
    authUri: endpoints.authUri,
    tokenUri: endpoints.tokenUri,
    createClientWhere: endpoints.createClientWhere,
    notes: workforceNote,
  };
  switch (provider) {
    case "google":
      return {
        ...base,
        summary:
          "Unsupported connector OAuth client: Google access tokens may be opaque, but the generated server currently validates JWTs only.",
      };
    case "entra":
      return {
        ...base,
        summary:
          "Connector OAuth client: Microsoft Entra. Expose and request a scope for this MCP API, not Microsoft Graph.",
      };
    case "okta":
      return {
        ...base,
        summary: "Connector OAuth client: Okta. Request a scope whose audience is this MCP API.",
      };
    case "other":
      return {
        ...base,
        summary:
          "Connector OAuth client: explicit authorization server. Both HTTPS endpoints must be operator-supplied.",
      };
    default:
      return {
        ...base,
        resolved: false,
        summary:
          "Connector OAuth provider not specified. --idp describes the authorization server protecting /mcp, not how users sign in to Gemini Enterprise.",
      };
  }
}

/** Build the guided connector plan. Pure; the CLI renders it (text or JSON). */
export function buildConnectorPlan(
  air: AirDocument,
  profile: AgentPlatformTargetProfile,
  config: GeminiEnterpriseTargetConfig,
): ConnectorPlan {
  const dir = `<bundle>/targets/${profile.id}`;
  const toolCount = air.operations.filter((op) => op.state === "approved").length;
  const id = identityGuidance(config);
  const scopes = connectorScopes(config).join(" ");
  const oauth = config.serverAuth === "oauth";
  const authCopy: CopyField[] = oauth
    ? [
        { label: "Auth type", value: "OAuth 2.0" },
        { label: "Authorization URL", value: id.authUri },
        { label: "Token URL", value: id.tokenUri },
        { label: "Scopes", value: scopes },
        {
          label: "MCP API audience",
          value: config.connectorOAuth.inboundAudience ?? "<audience-for-this-mcp-api>",
        },
        { label: "Protected resource URL", value: config.endpoint },
        { label: "Redirect URI (register on the client)", value: id.redirectUri },
        { label: "Client ID / secret", value: `create at: ${id.createClientWhere}` },
      ]
    : [{ label: "Auth type", value: "No authentication (explicitly acknowledged)" }];

  const run: RunStep[] = [
    {
      step: "Certify the bundle including its target and deployment inputs",
      command: "anvil certify <bundle>",
    },
    {
      step: "Validate inputs, copy the module externally, initialize remote state, and create the reviewed plan",
      command: `set -euo pipefail
export ANVIL_BUNDLE_DIR="$(cd <bundle> && pwd -P)"
: "\${ANVIL_TF_WORK_DIR:?Set an absolute empty directory outside the bundle}"
: "\${ANVIL_TF_STATE_BUCKET:?Set the existing GCS Terraform state bucket}"
: "\${TF_VAR_image_tag:?Set the immutable container image tag}"
export ANVIL_TF_STATE_PREFIX=${shellQuote(`anvil/${air.service.id}-tools`)}
export TF_VAR_project_id=${shellQuote(config.project)}
if [[ "$ANVIL_TF_WORK_DIR" != /* ]]
then
  echo "ANVIL_TF_WORK_DIR must be absolute" >&2
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
  -out="$ANVIL_TF_WORK_DIR/tfplan"`,
    },
    {
      step: "After review, apply the external plan to deploy the StreamableHTTP MCP server",
      command: `set -euo pipefail
: "\${ANVIL_TF_WORK_DIR:?Set the external Terraform work directory used for plan}"
terraform -chdir="$ANVIL_TF_WORK_DIR" apply "$ANVIL_TF_WORK_DIR/tfplan"`,
    },
    ...(includesSurface(config, "agent-gateway")
      ? [
          {
            step: "Initialize the external readiness record; this stops before provider reads or mutations",
            command: `ANVIL_STATE_DIR=/absolute/external/state ANVIL_RECONCILE_REGISTRY_GATEWAY=1 ANVIL_CONFIRM_REGISTRY_GATEWAY_RECONCILE=1 bash ${dir}/agent-registry/register.sh`,
          },
          {
            step: "After independently verifying readiness.json, reconcile and read back the registry/gateway without binding the engine",
            command: `ANVIL_STATE_DIR=/absolute/external/state ANVIL_RECONCILE_REGISTRY_GATEWAY=1 ANVIL_CONFIRM_REGISTRY_GATEWAY_RECONCILE=1 bash ${dir}/agent-registry/register.sh`,
          },
          {
            step: "After reviewing the reconciliation evidence, bind engine egress as a separate final mutation",
            command: `ANVIL_STATE_DIR=/absolute/external/state ANVIL_CONFIRM_ENGINE_EGRESS_REROUTE=1 bash ${dir}/agent-registry/register.sh`,
          },
        ]
      : []),
  ];

  const url = consoleUrl(config);
  const console: ConsoleStep[] = [
    ...(includesSurface(config, "custom-mcp")
      ? [
          {
            surface: "custom-mcp" as const,
            action: oauth
              ? "Create the Custom MCP Server data store in the console, then authorize"
              : "Create the Custom MCP Server data store in the console",
            url,
            where:
              "GE app → Data stores → + New data store → Custom MCP Server → Verify Auth → Create",
            why: oauth
              ? "The supported happy path is console-first; the reference setUpDataConnector request is experimental and cannot complete OAuth consent."
              : "The supported happy path is console-first; no-auth leaves the public MCP URL unprotected.",
            copy: [{ label: "MCP Server URL", value: config.endpoint }, ...authCopy],
          },
        ]
      : []),
    ...(includesSurface(config, "agent-gateway")
      ? [
          {
            surface: "agent-gateway" as const,
            action: "Import the registered MCP server into the app",
            url,
            where:
              "GE app → Connected data stores → + New data store → MCP servers → Show all → Add tool",
            why: oauth
              ? "Importing a registry MCP server into a GE app is console-only; server OAuth remains separate from gateway IAP."
              : "Importing a registry MCP server is console-only; gateway governance does not add bearer-token validation at /mcp.",
            copy: [
              {
                label: "Find it under",
                value: `MCP servers → "${air.service.displayName ?? air.service.id} (MCP)"`,
              },
              {
                label: "Registered as",
                value: `the SERVICE id recorded in agent-registry/register.sh (${config.registryLocation})`,
              },
              {
                label: "Auth",
                value: oauth
                  ? "OAuth 2.0 using the connector values above"
                  : "No authentication (explicitly acknowledged)",
              },
              { label: "MCP Server URL", value: config.endpoint },
              ...(oauth ? [{ label: "Scopes", value: scopes }] : []),
            ],
          },
        ]
      : []),
  ];

  return {
    service: air.service.displayName ?? air.service.id,
    toolCount,
    actionBudget: profile.actionLimits.maxActions,
    selectedSurface: config.surface,
    surfaces: [
      {
        id: "custom-mcp",
        label: "Custom MCP DataConnector",
        when: "quick, standalone data store; OAuth setup is console-first",
      },
      {
        id: "agent-gateway",
        label: "Agent Registry + Agent Gateway",
        when: "gateway-governed; engine egress binding requires explicit confirmation",
      },
    ],
    identity: id,
    run,
    console,
  };
}

/** Render the plan as the intuitive, copy-paste-first CLI output. */
export function renderConnectorPlanText(plan: ConnectorPlan): string {
  const L: string[] = [];
  L.push(
    `\nConnect "${plan.service}" to Gemini Enterprise — ${plan.toolCount} tool(s), budget ${plan.actionBudget}.`,
  );

  L.push(`\nSelected registration surface: ${plan.selectedSurface}.`);
  L.push("Available surfaces:");
  for (const s of plan.surfaces) L.push(`  • ${s.label} — ${s.when}`);

  L.push("\nMCP server authentication (separate from Gemini Enterprise sign-in identity):");
  L.push(`  ${plan.identity.resolved ? "✓" : "?"} ${plan.identity.summary}`);
  if (plan.identity.resolved) L.push(`      create at: ${plan.identity.createClientWhere}`);
  for (const n of plan.identity.notes) L.push(`      note: ${n}`);

  L.push("\nRun these (Anvil automated what it could):");
  plan.run.forEach((r, i) => {
    L.push(`  ${i + 1}. ${r.step}`);
    L.push(`     $ ${r.command}`);
  });

  L.push("\nConsole-only (interactive — Anvil cannot do these):");
  for (const c of plan.console) {
    L.push(`  ▸ [${c.surface}] ${c.action}`);
    L.push(`      open:  ${c.url}`);
    L.push(`      steps: ${c.where}`);
    const w = Math.max(...c.copy.map((f) => f.label.length));
    L.push("      paste:");
    for (const f of c.copy) L.push(`        ${f.label.padEnd(w)}  ${f.value}`);
    L.push(`      why:   ${c.why}`);
  }
  L.push(
    "\n(Run with --json for this plan as structured data; see the skill's reference/gemini-enterprise.md.)",
  );
  return `${L.join("\n")}\n`;
}
