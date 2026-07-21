/**
 * The Agent Registry / Agent Gateway registration surface for a Gemini Enterprise
 * connector — the *fully programmatic* alternative to the custom-MCP DataConnector
 * (which needs an interactive OAuth Authorize step).
 *
 * Instead of `setUpDataConnector`, the MCP server is registered as an Agent
 * Registry `Service` (with a `toolspec.json`), and a governed **Agent Gateway**
 * (egress / AGENT_TO_ANYWHERE, referencing the registry) fronts agent→tool calls.
 * Deployed agents authenticate with a Google-managed agent-identity principalSet
 * + IAM (`agentregistry.viewer`, `iap.egressor`, `run.invoker`) — no user OAuth
 * consent, so the whole path is `gcloud`/Terraform-scriptable.
 *
 * Confirmed against the live Agent Registry API (2026-07-21) — see
 * docs/backtesting/GEMINI_ENTERPRISE_VALIDATION.md. The `toolspec.json` reuses
 * Anvil's shared MCP tool descriptors (`@anvil/air`), so it never drifts from the
 * tools the deployed server actually serves.
 */
import { type AirDocument, mcpToolAnnotations, mcpToolDescription, operationInputSchema } from "@anvil/air";

export interface AgentRegistryOptions {
  /** The MCP server's public URL (the Agent Registry Service interface URL). */
  endpoint?: string;
  /** GCP project id. */
  project?: string;
  /** Agent Registry + GE app location (`global`, or a region). */
  location?: string;
  /**
   * Agent Gateway region. The gateway is regional even for a `global` GE app:
   * a `global`/`us` app pairs with `us-central1`, an `eu` app with `europe-west1`.
   */
  gatewayLocation?: string;
  /** The Gemini Enterprise engine resource to bind the gateway to (optional). */
  engine?: string;
}

/** The MCP `toolspec.json` shape Agent Registry ingests (≤10 KB). */
export interface ToolSpec {
  tools: Array<{
    name: string;
    description: string;
    inputSchema: unknown;
    annotations: ReturnType<typeof mcpToolAnnotations>;
  }>;
}

/** Agent Registry's manual-registration size ceiling for a tool spec. */
export const TOOLSPEC_MAX_BYTES = 10 * 1024;

function slug(air: AirDocument): string {
  return air.service.id.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

/** RFC-1034 service id for the registry Service / gateway. */
function serviceId(air: AirDocument): string {
  return `${slug(air)}-mcp`;
}

function gatewayName(air: AirDocument): string {
  return `${slug(air)}-agent-gateway`;
}

/**
 * Build the Agent Registry `toolspec.json` from the approved operations, reusing
 * Anvil's shared MCP tool descriptors so it matches the served `tools/list`.
 */
export function buildToolSpec(air: AirDocument): ToolSpec {
  const tools = air.operations
    .filter((o) => o.state === "approved")
    .sort((a, b) => a.mcp.toolName.localeCompare(b.mcp.toolName))
    .map((op) => ({
      name: op.mcp.toolName,
      description: mcpToolDescription(op),
      inputSchema: op.input.schema ?? operationInputSchema(op),
      annotations: mcpToolAnnotations(op),
    }));
  return { tools };
}

export function renderToolSpecJson(air: AirDocument): string {
  return `${JSON.stringify(buildToolSpec(air), null, 2)}\n`;
}

/** The egress Agent Gateway config (imported with `network-services agent-gateways import`). */
export function renderAgentGatewayYaml(air: AirDocument, options: AgentRegistryOptions = {}): string {
  const project = options.project ?? "<project>";
  const location = options.location ?? "global";
  return `# Gemini Enterprise Agent Gateway — egress (Agent-to-Anywhere) mode.
# Import with:
#   gcloud network-services agent-gateways import ${gatewayName(air)} \\
#     --source=agent-gateway.yaml --location=${options.gatewayLocation ?? "<gateway-region>"}
# GE supports egress mode only; the gateway blocks agent traffic to any host not
# registered in the referenced Agent Registry.
name: ${gatewayName(air)}
protocols:
  - MCP
googleManaged:
  governedAccessPath: AGENT_TO_ANYWHERE
registries:
  - //agentregistry.googleapis.com/projects/${project}/locations/${location}
`;
}

/**
 * Terraform for the Agent Registry Service + the IAM the agent identity needs.
 * The gateway itself has no Terraform resource yet, so it is created via the
 * `network-services agent-gateways import` in register.sh.
 */
export function renderAgentRegistryTf(air: AirDocument, options: AgentRegistryOptions = {}): string {
  const location = options.location ?? "global";
  const endpoint = options.endpoint ?? "https://<your-connector-host>/mcp";
  return `# Agent Registry Service for this MCP server + the agent-identity IAM.
# The tool spec (toolspec.json) is uploaded out-of-band via register.sh; here we
# register the endpoint. Requires roles/agentregistry.editor to apply.
variable "project_id" { type = string }
variable "agent_identity_principal_set" {
  type        = string
  description = "The deployed agents' identity principalSet (principalSet://agents.global.org-<ORG>.system.id.goog/...)."
  default     = ""
}

resource "google_agent_registry_service" "mcp_server" {
  location     = "${location}"
  service_id   = "${serviceId(air)}"
  display_name = "${air.service.displayName ?? air.service.id} (MCP)"
  description  = "Anvil-generated MCP server for ${air.service.displayName ?? air.service.id}."

  interfaces {
    url              = "${endpoint}"
    protocol_binding = "JSONRPC"
  }

  # NO_SPEC registers only the endpoint; register.sh uploads the full toolspec.json
  # (TOOL_SPEC) so the exact tools are discoverable. Keep them in sync.
  mcp_server_spec { type = "NO_SPEC" }
}

# Agents resolve the toolset and call the server through the Agent Gateway.
resource "google_project_iam_member" "agent_registry_viewer" {
  count   = var.agent_identity_principal_set == "" ? 0 : 1
  project = var.project_id
  role    = "roles/agentregistry.viewer"
  member  = var.agent_identity_principal_set
}
resource "google_project_iam_member" "agent_run_invoker" {
  count   = var.agent_identity_principal_set == "" ? 0 : 1
  project = var.project_id
  role    = "roles/run.invoker"
  member  = var.agent_identity_principal_set
}
# roles/iap.egressor (agent→MCP egress through the gateway) is bound on the
# gateway/mcpServer resource at register time — see register.sh.

output "registry_service" {
  value = google_agent_registry_service.mcp_server.id
}
`;
}

/** The scripted, no-console registration path (registry → gateway → GE link → IAM). */
export function renderAgentRegistryScript(air: AirDocument, options: AgentRegistryOptions = {}): string {
  const project = options.project ?? "<PROJECT_ID>";
  const location = options.location ?? "global";
  const gwLoc = options.gatewayLocation ?? "us-central1";
  const endpoint = options.endpoint ?? "https://<your-connector-host>/mcp";
  const svc = serviceId(air);
  const gw = gatewayName(air);
  const engine = options.engine ?? "projects/<PROJECT_ID>/locations/<LOC>/collections/<COLLECTION>/engines/<ENGINE>";
  return `#!/usr/bin/env bash
# Register this MCP server with Gemini Enterprise via the Agent Registry / Agent
# Gateway — the fully programmatic path (no interactive OAuth consent). Runs under
# YOUR credentials; Anvil holds none. Requires: roles/agentregistry.editor,
# roles/networkservices.agentGateways.create, and project edit on the GE engine.
set -euo pipefail
PROJECT="${project}"
LOCATION="${location}"            # Agent Registry + GE app location
GATEWAY_LOCATION="${gwLoc}"       # gateway region (global/us app -> us-central1; eu -> europe-west1)

# 1) Register the MCP server + its tools in Agent Registry (toolspec.json here).
gcloud agent-registry services create ${svc} \\
  --project="$PROJECT" --location="$LOCATION" \\
  --display-name="${air.service.displayName ?? air.service.id} (MCP)" \\
  --interfaces="url=${endpoint},protocolBinding=JSONRPC" \\
  --mcp-server-spec-type=tool-spec --mcp-server-spec-content=toolspec.json

# 2) Create the governed Agent Gateway (egress mode, referencing the registry).
gcloud network-services agent-gateways import ${gw} \\
  --source=agent-gateway.yaml --location="$GATEWAY_LOCATION"

# 3) Bind the gateway to the Gemini Enterprise app (routes agent egress through it).
curl -sS -X PATCH \\
  "https://discoveryengine.googleapis.com/v1alpha/${engine}?updateMask=agentGatewaySetting.defaultEgressAgentGateway.name" \\
  -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "Content-Type: application/json" \\
  -d '{"agentGatewaySetting":{"defaultEgressAgentGateway":{"name":"projects/'"$PROJECT"'/locations/'"$GATEWAY_LOCATION"'/agentGateways/${gw}"}}}'

# 4) Grant the deployed agents' identity egress through the gateway to this server.
#    Replace AGENT_PRINCIPAL_SET with your agent-identity principalSet.
#    gcloud beta iap web add-iam-policy-binding --resource-type=agent-gateway \\
#      --member="AGENT_PRINCIPAL_SET" --role="roles/iap.egressor" ...
echo "Registered ${svc}; gateway ${gw} bound. Import agents/endpoints as needed."
`;
}

/** Operator runbook for the Agent Registry / Gateway path. */
export function renderAgentGatewayRunbook(air: AirDocument, options: AgentRegistryOptions = {}): string {
  const name = air.service.displayName ?? air.service.id;
  return `# Agent Registry / Agent Gateway — ${name}

The **programmatic** alternative to the custom-MCP DataConnector: no interactive
OAuth consent. Deployed agents call this server's tools through a governed Agent
Gateway, authenticated by a Google-managed agent-identity principalSet + IAM.

Artifacts in this directory:
- \`toolspec.json\` — the MCP tools (≤10 KB), generated from Anvil's approved
  operations; identical to what the server serves on \`tools/list\`.
- \`agent-gateway.yaml\` — the egress (Agent-to-Anywhere) gateway config.
- \`agent-registry.tf\` — the Agent Registry Service + agent-identity IAM.
- \`register.sh\` — the scripted path: register the server → create the gateway →
  bind it to the GE app → grant egress.

Regional alignment (app / gateway / registry must line up):

| App location | Gateway location | Registry location |
|---|---|---|
| \`global\`      | \`us-central1\`     | \`us-central1\`, \`us\`, or \`global\` |
| \`us\`          | \`us-central1\`     | \`us-central1\` or \`us\`             |
| \`eu\`          | \`europe-west1\`    | \`europe-west1\` or \`eu\`            |

Steps:
1. Deploy the StreamableHTTP MCP server (session-based) to a reachable HTTPS URL.
2. \`bash register.sh\` — registers the server in Agent Registry, creates the egress
   gateway, and binds it to the GE app (or apply agent-registry.tf + import the
   gateway YAML).
3. Attach an authorization policy to the gateway (IAP authz extension →
   \`iap.googleapis.com\`, policyProfile REQUEST_AUTHZ) — required for every gateway.
4. Grant the agent identity \`roles/iap.egressor\` (egress) + \`roles/agentregistry.viewer\`
   (resolve) + \`roles/run.invoker\` (reach Cloud Run). The Discovery Engine service
   agent (\`service-<PROJECT_NUMBER>@gcp-sa-discoveryengine.iam.gserviceaccount.com\`)
   also needs access to Agent Registry + Agent Gateway.
5. Import the server into the app: **Connected data stores → + New data store →
   MCP servers → Show all → Add tool** (everything under "MCP servers" other than
   "Custom MCP Server" is sourced from Agent Registry). Choose No authentication or
   OAuth 2.0 as the server requires; finish to import.
6. Apply egress governance on the gateway (IAM agent policies or semantic
   governance) to allow/deny which registry entries the server may reach, then
   verify with a query that triggers the tool.

Custom MCP DataConnector vs. this path: a direct custom-MCP DataConnector
(instance_uri + OAuth) is NOT governed by the Agent Gateway — only
registry-imported servers are. Use this path when you want gateway governance and
a fully programmatic registration; use the DataConnector for a quick standalone
data store.

Constraints: \`toolspec.json\` ≤ 10 KB; manual registration is unsupported in the
\`us\`/\`eu\` multi-region locations — use a region or \`global\`. Keep enabled tools
under the platform's ${"${maxActions}"}-action budget.
`.replace("${maxActions}", "100");
}
