/**
 * The Agent Registry / Agent Gateway registration surface for a Gemini Enterprise
 * connector — the scripted registration surface alongside the console-first
 * custom-MCP DataConnector.
 *
 * Instead of `setUpDataConnector`, the MCP server is registered as an Agent
 * Registry `Service` (with a `toolspec.json`), and a governed **Agent Gateway**
 * (egress / AGENT_TO_ANYWHERE, referencing the registry) fronts agent→tool calls.
 * Deployed agents authenticate with a Google-managed agent-identity principalSet
 * + IAM (`agentregistry.viewer`, `iap.egressor`, `run.invoker`). MCP resource-server
 * authentication remains a separate concern, and importing the registered tool
 * into Gemini Enterprise remains console-only.
 *
 * Confirmed against the live Agent Registry API (2026-07-21) — see
 * docs/backtesting/GEMINI_ENTERPRISE_VALIDATION.md. The `toolspec.json` reuses
 * Anvil's shared MCP tool descriptors (`@anvil/air`), so it never drifts from the
 * tools the deployed server actually serves.
 */
import { createHash } from "node:crypto";
import {
  type AirDocument,
  mcpToolAnnotations,
  mcpToolDescription,
  operationInputSchema,
} from "@anvil/air";

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
  /** Agent Registry location referenced by the gateway. */
  registryLocation?: string;
  /** The Gemini Enterprise engine resource to bind the gateway to (optional). */
  engine?: string;
  /** Numeric project identity, used for the Discovery Engine service agent. */
  projectNumber?: string;
  /** Stable filesystem segment derived from the canonical engine resource. */
  stateKey?: string;
  /** Exact deployed-agent identity expected by the readiness evidence. */
  agentIdentityPrincipalSet?: string;
  /** Exact authorization-policy resource expected to be attached to the gateway. */
  gatewayAuthorizationPolicy?: string;
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

/** Suffix-aware, deterministic RFC-1034 projection for provider resource IDs. */
function providerResourceId(serviceId: string, suffix: string): string {
  const normalized =
    serviceId
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent";
  const rooted = /^[a-z]/.test(normalized) ? normalized : `a-${normalized}`;
  if (`${rooted}${suffix}`.length <= 63) return `${rooted}${suffix}`;
  const digest = createHash("sha256").update(serviceId).digest("hex").slice(0, 8);
  const prefixBudget = 63 - suffix.length - digest.length - 1;
  const prefix = rooted.slice(0, prefixBudget).replace(/-+$/g, "") || "a";
  return `${prefix}-${digest}${suffix}`;
}

/** RFC-1034 service id for the registry Service. */
function serviceId(air: AirDocument): string {
  return providerResourceId(air.service.id, "-mcp");
}

function gatewayName(air: AirDocument): string {
  return providerResourceId(air.service.id, "-agent-gateway");
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

export interface AgentGatewayReadiness {
  schemaVersion: 1;
  project: string;
  gatewayResource: string;
  registryResource: string;
  authorizationPolicyResource: string;
  agentIdentityPrincipalSet: string;
  discoveryEngineServiceAgent: string;
  checks: {
    authorizationPolicyAttached: boolean;
    agentRegistryViewerGranted: boolean;
    iapEgressorGranted: boolean;
    runInvokerGranted: boolean;
    discoveryEngineServiceAgentGranted: boolean;
    mcpEndpointReady: boolean;
  };
  verifiedAt: string;
}

/** Exact, non-secret inputs that must be verified before engine egress is rebound. */
export function buildAgentGatewayReadiness(
  air: AirDocument,
  options: AgentRegistryOptions = {},
): AgentGatewayReadiness {
  const project = options.project ?? "<PROJECT_ID>";
  const gatewayLocation = options.gatewayLocation ?? "us-central1";
  const registryLocation = options.registryLocation ?? gatewayLocation;
  const projectNumber =
    options.projectNumber ?? options.engine?.match(/^projects\/(\d+)\//)?.[1] ?? "<PROJECT_NUMBER>";
  return {
    schemaVersion: 1,
    project,
    gatewayResource: `projects/${project}/locations/${gatewayLocation}/agentGateways/${gatewayName(air)}`,
    registryResource: `//agentregistry.googleapis.com/projects/${project}/locations/${registryLocation}`,
    authorizationPolicyResource:
      options.gatewayAuthorizationPolicy ?? "<ATTACHED_AUTHORIZATION_POLICY_RESOURCE>",
    agentIdentityPrincipalSet:
      options.agentIdentityPrincipalSet ?? "<DEPLOYED_AGENT_PRINCIPAL_SET>",
    discoveryEngineServiceAgent: `service-${projectNumber}@gcp-sa-discoveryengine.iam.gserviceaccount.com`,
    checks: {
      authorizationPolicyAttached: false,
      agentRegistryViewerGranted: false,
      iapEgressorGranted: false,
      runInvokerGranted: false,
      discoveryEngineServiceAgentGranted: false,
      mcpEndpointReady: false,
    },
    verifiedAt: "",
  };
}

export function renderAgentGatewayReadinessJson(
  air: AirDocument,
  options: AgentRegistryOptions = {},
): string {
  return `${JSON.stringify(buildAgentGatewayReadiness(air, options), null, 2)}\n`;
}

/** The egress Agent Gateway config (imported with `network-services agent-gateways import`). */
export function renderAgentGatewayYaml(
  air: AirDocument,
  options: AgentRegistryOptions = {},
): string {
  const project = options.project ?? "<project>";
  const gwLoc = options.gatewayLocation ?? "us-central1";
  const registryLoc = options.registryLocation ?? gwLoc;
  return `# Gemini Enterprise Agent Gateway — egress (Agent-to-Anywhere) mode.
# Import with:
#   gcloud network-services agent-gateways import ${gatewayName(air)} \\
#     --source=agent-gateway.yaml --location=${gwLoc}
# GE supports egress mode only; the gateway blocks agent traffic to any host not
# registered in the referenced Agent Registry. The verified app/gateway/registry
# matrix is recorded in the adjacent runbook.
name: ${gatewayName(air)}
protocols:
  - MCP
googleManaged:
  governedAccessPath: AGENT_TO_ANYWHERE
registries:
  - //agentregistry.googleapis.com/projects/${project}/locations/${registryLoc}
`;
}

/**
 * Terraform for project IAM only. register.sh is the sole owner of the Agent
 * Registry service/tool spec, avoiding NO_SPEC vs TOOL_SPEC control conflicts.
 */
export function renderAgentRegistryTf(
  _air: AirDocument,
  options: AgentRegistryOptions = {},
): string {
  const principalSet = options.agentIdentityPrincipalSet ?? "";
  return `# Project IAM required before Agent Gateway engine binding.
# register.sh is the sole owner of the Agent Registry service and TOOL_SPEC.
variable "project_id" { type = string }
variable "agent_identity_principal_set" {
  type        = string
  description = "The deployed agents' identity principalSet (principalSet://agents.global.org-<ORG>.system.id.goog/...)."
  default     = ${hclString(principalSet)}
}

resource "google_project_iam_member" "agent_registry_viewer" {
  count   = var.agent_identity_principal_set == "" ? 0 : 1
  project = var.project_id
  role    = "roles/agentregistry.viewer"
  member  = var.agent_identity_principal_set
}
# roles/iap.egressor and the gateway authorization-policy attachment are
# resource-specific and intentionally not guessed here. Verify them in the
# stable readiness.json before register.sh may bind engine egress. Cloud Run
# invocation is service-scoped by deploy/terraform using the target overlay's
# invoker_members; never grant roles/run.invoker project-wide.
`;
}

function hclString(value: string): string {
  return JSON.stringify(value).replaceAll("${", () => "$${");
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** The guarded registration path (registry → gateway → GE link). */
export function renderAgentRegistryScript(
  air: AirDocument,
  options: AgentRegistryOptions = {},
): string {
  const project = options.project ?? "<PROJECT_ID>";
  const location = options.location ?? "global";
  const gwLoc = options.gatewayLocation ?? "us-central1";
  const registryLoc = options.registryLocation ?? gwLoc;
  const endpoint = options.endpoint ?? "https://<your-connector-host>/mcp";
  const svc = serviceId(air);
  const gw = gatewayName(air);
  const engine =
    options.engine ??
    "projects/<PROJECT_NUMBER>/locations/<LOC>/collections/<COLLECTION>/engines/<ENGINE>";
  const stateKey = options.stateKey ?? "engine-state";
  const readiness = buildAgentGatewayReadiness(air, options);
  return `#!/usr/bin/env bash
# Register this MCP server with Gemini Enterprise via the Agent Registry / Agent
# Gateway. Importing the tool into the app remains console-only. Runs under YOUR
# credentials; Anvil holds none. Requires: roles/agentregistry.editor,
# roles/networkservices.agentGateways.create, and project edit on the GE engine.
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
STATE_ROOT="\${ANVIL_STATE_DIR:-}"
STATE_KEY=${shellLiteral(stateKey)}

for required_command in gcloud curl jq install date; do
  command -v "$required_command" >/dev/null 2>&1 || {
    echo "Missing required command: $required_command" >&2
    exit 1
  }
done

if [[ -z "$STATE_ROOT" ]]; then
  echo "ANVIL_STATE_DIR is required for rollback and readiness evidence." >&2
  echo "Set it to an existing absolute directory outside the generated bundle." >&2
  exit 1
fi
if [[ "$STATE_ROOT" != /* || ! -d "$STATE_ROOT" ]]; then
  echo "ANVIL_STATE_DIR must name an existing absolute directory: $STATE_ROOT" >&2
  exit 1
fi
STATE_ROOT="$(cd -- "$STATE_ROOT" && pwd -P)"
case "$STATE_ROOT/" in
  "$BUNDLE_ROOT/"*)
    echo "ANVIL_STATE_DIR must be outside the generated bundle: $BUNDLE_ROOT" >&2
    exit 1
    ;;
esac
STATE_DIR="$STATE_ROOT/gemini-enterprise/$STATE_KEY"
READINESS_TEMPLATE="$SCRIPT_DIR/readiness.template.json"
READINESS_FILE="$STATE_DIR/readiness.json"
SNAPSHOT_FILE="$STATE_DIR/engine-before.json"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
STATE_DIR="$(cd -- "$STATE_DIR" && pwd -P)"
case "$STATE_DIR/" in
  "$STATE_ROOT/"*) ;;
  *)
    echo "Resolved target state escaped ANVIL_STATE_DIR; refusing to continue." >&2
    exit 1
    ;;
esac
TEMP_DIR="$(mktemp -d)"
chmod 700 "$TEMP_DIR"
REGISTRY_READBACK="$TEMP_DIR/registry-service.json"
REGISTRY_ERROR="$TEMP_DIR/registry-service.err"
GATEWAY_READBACK="$TEMP_DIR/gateway.json"
GATEWAY_ERROR="$TEMP_DIR/gateway.err"
ENGINE_READBACK="$TEMP_DIR/engine.json"
MUTATION_RESPONSE="$TEMP_DIR/mutation-response.json"
SNAPSHOT_TEMP=""
cleanup() {
  unset TOKEN PATCH_BODY
  [[ -z "$SNAPSHOT_TEMP" ]] || rm -f "$SNAPSHOT_TEMP"
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

RECONCILE_ONLY="\${ANVIL_RECONCILE_REGISTRY_GATEWAY:-0}"
if [[ "$RECONCILE_ONLY" == "1" &&
      "\${ANVIL_CONFIRM_REGISTRY_GATEWAY_RECONCILE:-}" != "1" ]]; then
  echo "Refusing registry/gateway reconciliation without explicit confirmation." >&2
  echo "Review generated ownership checks, then run:" >&2
  echo "  ANVIL_RECONCILE_REGISTRY_GATEWAY=1 ANVIL_CONFIRM_REGISTRY_GATEWAY_RECONCILE=1 bash \\"$SCRIPT_DIR/register.sh\\"" >&2
  exit 2
fi
if [[ "$RECONCILE_ONLY" != "1" &&
      "\${ANVIL_CONFIRM_ENGINE_EGRESS_REROUTE:-}" != "1" ]]; then
  echo "Refusing to reroute all engine egress without explicit confirmation." >&2
  echo "Review register.sh and rollback.sh, then run:" >&2
  echo "  ANVIL_CONFIRM_ENGINE_EGRESS_REROUTE=1 bash \\"$SCRIPT_DIR/register.sh\\"" >&2
  exit 2
fi

PROJECT=${shellLiteral(project)}
APP_LOCATION=${shellLiteral(location)}
GATEWAY_LOCATION=${shellLiteral(gwLoc)}
REGISTRY_LOCATION=${shellLiteral(registryLoc)}
SERVICE=${shellLiteral(svc)}
GATEWAY=${shellLiteral(gw)}
ENGINE=${shellLiteral(engine)}
ENDPOINT=${shellLiteral(endpoint)}
EXPECTED_REGISTRY="//agentregistry.googleapis.com/projects/$PROJECT/locations/$REGISTRY_LOCATION"
DESIRED_GATEWAY="projects/$PROJECT/locations/$GATEWAY_LOCATION/agentGateways/$GATEWAY"
EXPECTED_AUTHORIZATION_POLICY=${shellLiteral(readiness.authorizationPolicyResource)}
EXPECTED_AGENT_PRINCIPAL=${shellLiteral(readiness.agentIdentityPrincipalSet)}
EXPECTED_DISCOVERY_ENGINE_AGENT=${shellLiteral(readiness.discoveryEngineServiceAgent)}
EXPECTED_DISPLAY_NAME=${shellLiteral(`${air.service.displayName ?? air.service.id} (MCP)`)}

if [[ ! "$ENGINE" =~ ^projects/[0-9]+/locations/[a-z0-9-]+/collections/[A-Za-z0-9_-]+/engines/[A-Za-z0-9_-]+$ ]]; then
  echo "Refusing malformed canonical engine resource: $ENGINE" >&2
  exit 1
fi

is_not_found() {
  grep -Eqi 'NOT_FOUND|not found|was not found' "$1"
}

verify_registry_owner() {
  jq -e \\
    --arg service "$SERVICE" \\
    --arg display "$EXPECTED_DISPLAY_NAME" '
      ((.name == $service) or (.name | strings | endswith("/services/" + $service))) and
      .displayName == $display
    ' "$REGISTRY_READBACK" >/dev/null
}

verify_registry_desired() {
  jq -e \\
    --arg endpoint "$ENDPOINT" '
      ([.interfaces[]? |
        select((.url == $endpoint) and
          ((.protocolBinding // .protocol_binding) == "JSONRPC"))] | length == 1) and
      ([.. | strings | select(. == "TOOL_SPEC" or . == "tool-spec")] | length > 0)
    ' "$REGISTRY_READBACK" >/dev/null
}

verify_gateway_desired() {
  jq -e \\
    --arg gateway "$GATEWAY" \\
    --arg registry "$EXPECTED_REGISTRY" '
      ((.name == $gateway) or (.name | strings | endswith("/agentGateways/" + $gateway))) and
      .googleManaged.governedAccessPath == "AGENT_TO_ANYWHERE" and
      (.registries | type == "array" and length == 1 and .[0] == $registry)
    ' "$GATEWAY_READBACK" >/dev/null
}

emit_provider_error() {
  local body="$1"
  local http_status="$2"
  jq -c --arg httpStatus "$http_status" \\
    '{httpStatus:$httpStatus,errorCode:(.error.code // null),errorStatus:(.error.status // null)}' \\
    "$body" 2>/dev/null ||
    printf '{"httpStatus":"%s","errorCode":null,"errorStatus":null}\\n' "$http_status"
}

fetch_engine() {
  local http_status
  http_status="$(curl -sS -o "$ENGINE_READBACK" -w "%{http_code}" \\
    "https://discoveryengine.googleapis.com/v1/$ENGINE" \\
    -H "Authorization: Bearer $TOKEN" \\
    -H "X-Goog-User-Project: $PROJECT")"
  if [[ "$http_status" != "200" ]]; then
    echo "Discovery Engine read failed." >&2
    emit_provider_error "$ENGINE_READBACK" "$http_status" >&2
    return 1
  fi
  if ! jq -e --arg engine "$ENGINE" '.name == $engine' "$ENGINE_READBACK" >/dev/null; then
    echo "Discovery Engine readback does not belong to the configured engine." >&2
    return 1
  fi
}

validate_snapshot() {
  jq -e --arg engine "$ENGINE" '
    .schemaVersion == 1 and
    .name == $engine and
    (.capturedAt | type == "string" and length > 0) and
    has("previousDefaultEgressAgentGateway") and
    (
      .previousDefaultEgressAgentGateway == null or
      (
        (.previousDefaultEgressAgentGateway | type) == "object" and
        (.previousDefaultEgressAgentGateway.name | type) == "string" and
        (.previousDefaultEgressAgentGateway.name | length) > 0
      )
    )
  ' "$SNAPSHOT_FILE" >/dev/null
}

# 1) LOCAL READINESS PREFLIGHT. No provider read or mutation occurs until the
#    independently verified evidence exactly matches this generated kit.
if [[ ! -s "$READINESS_FILE" ]]; then
  install -m 600 "$READINESS_TEMPLATE" "$READINESS_FILE"
  echo "Provider operations are blocked. Verify authz/IAM, then update:" >&2
  echo "  $READINESS_FILE" >&2
  echo "Required exact inputs were copied from $READINESS_TEMPLATE." >&2
  exit 3
fi
if ! jq -e \\
  --arg project "$PROJECT" \\
  --arg gateway "$DESIRED_GATEWAY" \\
  --arg registry "$EXPECTED_REGISTRY" \\
  --arg policy "$EXPECTED_AUTHORIZATION_POLICY" \\
  --arg principal "$EXPECTED_AGENT_PRINCIPAL" \\
  --arg discovery_agent "$EXPECTED_DISCOVERY_ENGINE_AGENT" \\
  '.schemaVersion == 1 and
   .project == $project and
   .gatewayResource == $gateway and
   .registryResource == $registry and
   .authorizationPolicyResource == $policy and
   .agentIdentityPrincipalSet == $principal and
   .discoveryEngineServiceAgent == $discovery_agent and
   .checks.authorizationPolicyAttached == true and
   .checks.agentRegistryViewerGranted == true and
   .checks.iapEgressorGranted == true and
   .checks.runInvokerGranted == true and
   .checks.discoveryEngineServiceAgentGranted == true and
   .checks.mcpEndpointReady == true and
   (.verifiedAt | type == "string" and length > 0)' \\
  "$READINESS_FILE" >/dev/null; then
  echo "Engine binding is blocked: readiness evidence is incomplete or mismatched." >&2
  echo "Expected project: $PROJECT" >&2
  echo "Expected gateway: $DESIRED_GATEWAY" >&2
  echo "Expected registry: $EXPECTED_REGISTRY" >&2
  echo "Expected authorization policy: $EXPECTED_AUTHORIZATION_POLICY" >&2
  echo "Expected agent principal: $EXPECTED_AGENT_PRINCIPAL" >&2
  echo "Expected Discovery Engine service agent: $EXPECTED_DISCOVERY_ENGINE_AGENT" >&2
  echo "Set every readiness check true only after independent verification: $READINESS_FILE" >&2
  exit 3
fi

# 2) READ-ONLY PREFLIGHTS. Establish live engine concurrency evidence and exact
#    ownership/existence for every registry and gateway resource before mutation.
TOKEN="$(gcloud auth print-access-token)"
fetch_engine
PREFLIGHT_ETAG="$(jq -r '.etag // ""' "$ENGINE_READBACK")"
PREFLIGHT_GATEWAY="$(jq -r '.agentGatewaySetting.defaultEgressAgentGateway.name // ""' "$ENGINE_READBACK")"
if [[ -z "$PREFLIGHT_ETAG" ]]; then
  echo "Discovery Engine returned no etag; refusing a mutation without optimistic concurrency evidence." >&2
  exit 1
fi
if [[ -e "$SNAPSHOT_FILE" ]] && ! validate_snapshot; then
  echo "Rollback snapshot has an invalid schema or belongs to another engine: $SNAPSHOT_FILE" >&2
  exit 1
fi

REGISTRY_ACTION="none"
if gcloud agent-registry services describe "$SERVICE" \\
     --project="$PROJECT" --location="$REGISTRY_LOCATION" --format=json \\
     >"$REGISTRY_READBACK" 2>"$REGISTRY_ERROR"; then
  if ! verify_registry_owner; then
    echo "Agent Registry service id collision: $SERVICE is not owned by this exact Anvil display identity." >&2
    exit 1
  fi
  verify_registry_desired || REGISTRY_ACTION="update"
else
  if ! is_not_found "$REGISTRY_ERROR"; then
    echo "Agent Registry ownership preflight failed; refusing to treat an unreadable service as absent." >&2
    exit 1
  fi
  REGISTRY_ACTION="create"
fi

GATEWAY_ACTION="none"
if gcloud network-services agent-gateways describe "$GATEWAY" \\
     --location="$GATEWAY_LOCATION" --project="$PROJECT" --format=json \\
     >"$GATEWAY_READBACK" 2>"$GATEWAY_ERROR"; then
  if ! verify_gateway_desired; then
    echo "Agent Gateway id collision: $GATEWAY does not exactly match the generated egress gateway and registry." >&2
    exit 1
  fi
else
  if ! is_not_found "$GATEWAY_ERROR"; then
    echo "Agent Gateway ownership preflight failed; refusing to treat an unreadable gateway as absent." >&2
    exit 1
  fi
  GATEWAY_ACTION="create"
fi

# 3a) EXPLICIT RECONCILIATION PHASE. This phase never binds the engine; a later
#     normal invocation must re-run every preflight before the engine mutation.
if [[ "$RECONCILE_ONLY" == "1" ]]; then
  if [[ "$REGISTRY_ACTION" == "update" ]]; then
    gcloud agent-registry services update "$SERVICE" \\
      --project="$PROJECT" --location="$REGISTRY_LOCATION" \\
      --display-name="$EXPECTED_DISPLAY_NAME" \\
      --interfaces="url=$ENDPOINT,protocolBinding=JSONRPC" \\
      --mcp-server-spec-type=tool-spec \\
      --mcp-server-spec-content="$SCRIPT_DIR/toolspec.json" \\
      --quiet --format=none
  elif [[ "$REGISTRY_ACTION" == "create" ]]; then
    gcloud agent-registry services create "$SERVICE" \\
      --project="$PROJECT" --location="$REGISTRY_LOCATION" \\
      --display-name="$EXPECTED_DISPLAY_NAME" \\
      --interfaces="url=$ENDPOINT,protocolBinding=JSONRPC" \\
      --mcp-server-spec-type=tool-spec \\
      --mcp-server-spec-content="$SCRIPT_DIR/toolspec.json" \\
      --quiet --format=none
  fi
  if [[ "$GATEWAY_ACTION" == "create" ]]; then
    gcloud network-services agent-gateways import "$GATEWAY" \\
      --source="$SCRIPT_DIR/agent-gateway.yaml" \\
      --location="$GATEWAY_LOCATION" --project="$PROJECT" \\
      --quiet --format=none
  fi
  if ! gcloud agent-registry services describe "$SERVICE" \\
       --project="$PROJECT" --location="$REGISTRY_LOCATION" --format=json \\
       >"$REGISTRY_READBACK" 2>"$REGISTRY_ERROR" ||
     ! verify_registry_owner ||
     ! verify_registry_desired; then
    echo "Agent Registry readback failed exact verification after reconciliation." >&2
    exit 1
  fi
  if ! gcloud network-services agent-gateways describe "$GATEWAY" \\
       --location="$GATEWAY_LOCATION" --project="$PROJECT" --format=json \\
       >"$GATEWAY_READBACK" 2>"$GATEWAY_ERROR" ||
     ! verify_gateway_desired; then
    echo "Agent Gateway readback failed exact verification after reconciliation." >&2
    exit 1
  fi
  echo "Registry service and gateway exactly reconciled; no engine mutation was sent."
  echo "Rerun without ANVIL_RECONCILE_REGISTRY_GATEWAY to perform the separately confirmed bind."
  exit 0
fi

if [[ "$REGISTRY_ACTION" != "none" || "$GATEWAY_ACTION" != "none" ]]; then
  echo "Binding is blocked: registry/gateway resources do not exactly exist yet." >&2
  echo "Run the explicit reconciliation phase first:" >&2
  echo "  ANVIL_RECONCILE_REGISTRY_GATEWAY=1 ANVIL_CONFIRM_REGISTRY_GATEWAY_RECONCILE=1 bash \\"$SCRIPT_DIR/register.sh\\"" >&2
  exit 1
fi

if [[ ! -s "$SNAPSHOT_FILE" && "$PREFLIGHT_GATEWAY" == "$DESIRED_GATEWAY" ]]; then
  if [[ "\${ANVIL_ACKNOWLEDGE_NO_ROLLBACK:-}" != "1" ]]; then
    echo "Engine already routes through $DESIRED_GATEWAY, but no verified pre-bind snapshot exists." >&2
    echo "Refusing to fabricate rollback evidence from the already-bound state." >&2
    echo "Import a verified minimal pre-bind snapshot at $SNAPSHOT_FILE, or explicitly accept no rollback:" >&2
    echo "  ANVIL_ACKNOWLEDGE_NO_ROLLBACK=1 ANVIL_CONFIRM_ENGINE_EGRESS_REROUTE=1 bash \\"$SCRIPT_DIR/register.sh\\"" >&2
    exit 4
  fi
  echo "Engine already routes through $DESIRED_GATEWAY; the operator explicitly accepted that rollback is unavailable."
  echo "No engine mutation was sent and no rollback snapshot was fabricated."
  exit 0
fi

# 3b) FINAL ENGINE MUTATION. Re-read after ownership preflights and refuse any
#     concurrent change. The PATCH carries both the provider etag and If-Match.
fetch_engine
ENGINE_ETAG="$(jq -r '.etag // ""' "$ENGINE_READBACK")"
CURRENT_GATEWAY="$(jq -r '.agentGatewaySetting.defaultEgressAgentGateway.name // ""' "$ENGINE_READBACK")"
if [[ "$ENGINE_ETAG" != "$PREFLIGHT_ETAG" ||
      "$CURRENT_GATEWAY" != "$PREFLIGHT_GATEWAY" ]]; then
  echo "Engine changed after preflight; refusing to overwrite concurrent state." >&2
  exit 1
fi
if [[ ! -s "$SNAPSHOT_FILE" ]]; then
  SNAPSHOT_TEMP="$(mktemp "$STATE_DIR/.engine-before.XXXXXX")"
  CAPTURED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  jq -c --arg engine "$ENGINE" --arg capturedAt "$CAPTURED_AT" \\
    '{
      schemaVersion: 1,
      name: $engine,
      capturedAt: $capturedAt,
      previousDefaultEgressAgentGateway:
        (.agentGatewaySetting.defaultEgressAgentGateway // null)
    }' "$ENGINE_READBACK" >"$SNAPSHOT_TEMP"
  chmod 600 "$SNAPSHOT_TEMP"
  mv "$SNAPSHOT_TEMP" "$SNAPSHOT_FILE"
  SNAPSHOT_TEMP=""
  validate_snapshot || {
    echo "Generated rollback snapshot failed schema validation." >&2
    exit 1
  }
fi

if [[ "$CURRENT_GATEWAY" == "$DESIRED_GATEWAY" ]]; then
  echo "Engine already routes through $DESIRED_GATEWAY; no binding change needed."
else
  PATCH_BODY="$(jq -nc --arg name "$DESIRED_GATEWAY" --arg etag "$ENGINE_ETAG" \
    '{etag:$etag,agentGatewaySetting:{defaultEgressAgentGateway:{name:$name}}}')"
  PATCH_STATUS="$(curl -sS -o "$MUTATION_RESPONSE" -w "%{http_code}" -X PATCH \\
    "https://discoveryengine.googleapis.com/v1/$ENGINE?updateMask=agentGatewaySetting.defaultEgressAgentGateway.name" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -H "X-Goog-User-Project: $PROJECT" \\
    -H "If-Match: $ENGINE_ETAG" \\
    -d "$PATCH_BODY")"
  if [[ "$PATCH_STATUS" != 2?? ]]; then
    echo "Discovery Engine gateway binding failed." >&2
    emit_provider_error "$MUTATION_RESPONSE" "$PATCH_STATUS" >&2
    exit 1
  fi
  fetch_engine
  ACTUAL_GATEWAY="$(jq -r '.agentGatewaySetting.defaultEgressAgentGateway.name // ""' "$ENGINE_READBACK")"
  if [[ "$ACTUAL_GATEWAY" != "$DESIRED_GATEWAY" ]]; then
    echo "Discovery Engine readback did not confirm the requested gateway binding." >&2
    exit 1
  fi
fi

# Console-only after binding: import the server into the app —
#    Connected data stores -> + New data store -> MCP servers -> Show all -> Add tool.
echo "Registered $SERVICE in $REGISTRY_LOCATION; gateway $GATEWAY bound to the engine."
echo "Rollback evidence is retained outside generated files at $STATE_DIR/engine-before.json."
echo "Now import it in the console: Connected data stores -> MCP servers -> Show all -> Add tool."
`;
}

/** Restore the exact pre-bind gateway setting captured by register.sh. */
export function renderAgentGatewayRollbackScript(
  air: AirDocument,
  options: AgentRegistryOptions = {},
): string {
  const project = options.project ?? "<PROJECT_ID>";
  const gatewayLocation = options.gatewayLocation ?? "us-central1";
  const desiredGateway = `projects/${project}/locations/${gatewayLocation}/agentGateways/${gatewayName(air)}`;
  const engine =
    options.engine ??
    "projects/<PROJECT_NUMBER>/locations/<LOC>/collections/<COLLECTION>/engines/<ENGINE>";
  const stateKey = options.stateKey ?? "engine-state";
  return `#!/usr/bin/env bash
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
STATE_ROOT="\${ANVIL_STATE_DIR:-}"
STATE_KEY=${shellLiteral(stateKey)}
PROJECT=${shellLiteral(project)}
ENGINE=${shellLiteral(engine)}
DESIRED_GATEWAY=${shellLiteral(desiredGateway)}

if [[ -z "$STATE_ROOT" ]]; then
  echo "ANVIL_STATE_DIR is required to locate rollback evidence." >&2
  exit 1
fi
if [[ "$STATE_ROOT" != /* || ! -d "$STATE_ROOT" ]]; then
  echo "ANVIL_STATE_DIR must name an existing absolute directory: $STATE_ROOT" >&2
  exit 1
fi
STATE_ROOT="$(cd -- "$STATE_ROOT" && pwd -P)"
case "$STATE_ROOT/" in
  "$BUNDLE_ROOT/"*)
    echo "ANVIL_STATE_DIR must be outside the generated bundle: $BUNDLE_ROOT" >&2
    exit 1
    ;;
esac
STATE_DIR="$STATE_ROOT/gemini-enterprise/$STATE_KEY"
STATE_DIR="$(cd -- "$STATE_DIR" 2>/dev/null && pwd -P)" || {
  echo "No retained target state directory at $STATE_ROOT/gemini-enterprise/$STATE_KEY." >&2
  exit 1
}
case "$STATE_DIR/" in
  "$STATE_ROOT/"*) ;;
  *)
    echo "Resolved target state escaped ANVIL_STATE_DIR; refusing to continue." >&2
    exit 1
    ;;
esac
STATE_FILE="$STATE_DIR/engine-before.json"

if [[ "\${ANVIL_CONFIRM_ENGINE_EGRESS_ROLLBACK:-}" != "1" ]]; then
  echo "Review $STATE_FILE, then set ANVIL_CONFIRM_ENGINE_EGRESS_ROLLBACK=1 to restore it." >&2
  exit 2
fi
if [[ ! -s "$STATE_FILE" ]]; then
  echo "No pre-bind engine snapshot at $STATE_FILE; refusing to guess rollback state." >&2
  exit 1
fi
for required_command in gcloud curl jq; do
  command -v "$required_command" >/dev/null 2>&1 || {
    echo "Missing required command: $required_command" >&2
    exit 1
  }
done

if [[ ! "$ENGINE" =~ ^projects/[0-9]+/locations/[a-z0-9-]+/collections/[A-Za-z0-9_-]+/engines/[A-Za-z0-9_-]+$ ]]; then
  echo "Refusing malformed canonical engine resource: $ENGINE" >&2
  exit 1
fi
if ! jq -e --arg engine "$ENGINE" '
  .schemaVersion == 1 and
  .name == $engine and
  (.capturedAt | type == "string" and length > 0) and
  has("previousDefaultEgressAgentGateway") and
  (
    .previousDefaultEgressAgentGateway == null or
    (
      (.previousDefaultEgressAgentGateway | type) == "object" and
      (.previousDefaultEgressAgentGateway.name | type) == "string" and
      (.previousDefaultEgressAgentGateway.name | length) > 0
    )
  )
' "$STATE_FILE" >/dev/null; then
  echo "Rollback snapshot has an invalid schema or belongs to another engine: $STATE_FILE" >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d)"
chmod 700 "$TEMP_DIR"
MUTATION_RESPONSE="$TEMP_DIR/mutation-response.json"
ENGINE_READBACK="$TEMP_DIR/engine.json"
cleanup() {
  unset TOKEN PATCH_BODY
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

TOKEN="$(gcloud auth print-access-token)"
READ_STATUS="$(curl -sS -o "$ENGINE_READBACK" -w "%{http_code}" \\
  "https://discoveryengine.googleapis.com/v1/$ENGINE" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "X-Goog-User-Project: $PROJECT")"
if [[ "$READ_STATUS" != "200" ]] ||
   ! jq -e --arg engine "$ENGINE" '.name == $engine' "$ENGINE_READBACK" >/dev/null; then
  echo "Discovery Engine ownership read failed before rollback." >&2
  exit 1
fi
CURRENT_GATEWAY="$(jq -r '.agentGatewaySetting.defaultEgressAgentGateway.name // ""' "$ENGINE_READBACK")"
if [[ "$CURRENT_GATEWAY" != "$DESIRED_GATEWAY" ]]; then
  echo "Engine no longer routes through this kit's gateway; refusing rollback over concurrent state." >&2
  echo "Expected current gateway: $DESIRED_GATEWAY" >&2
  echo "Observed current gateway: \${CURRENT_GATEWAY:-<unset>}" >&2
  exit 1
fi
ENGINE_ETAG="$(jq -r '.etag // ""' "$ENGINE_READBACK")"
if [[ -z "$ENGINE_ETAG" ]]; then
  echo "Discovery Engine returned no etag; refusing rollback without optimistic concurrency evidence." >&2
  exit 1
fi

PATCH_BODY="$(jq -c --arg etag "$ENGINE_ETAG" \
  '{etag:$etag,agentGatewaySetting:{defaultEgressAgentGateway:.previousDefaultEgressAgentGateway}}' \
  "$STATE_FILE")"
EXPECTED_GATEWAY="$(jq -r '.previousDefaultEgressAgentGateway.name // ""' "$STATE_FILE")"
PATCH_STATUS="$(curl -sS -o "$MUTATION_RESPONSE" -w "%{http_code}" -X PATCH \\
  "https://discoveryengine.googleapis.com/v1/$ENGINE?updateMask=agentGatewaySetting.defaultEgressAgentGateway" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -H "X-Goog-User-Project: $PROJECT" \\
  -H "If-Match: $ENGINE_ETAG" \\
  -d "$PATCH_BODY")"
if [[ "$PATCH_STATUS" != 2?? ]]; then
  echo "Discovery Engine rollback failed." >&2
  jq -c --arg httpStatus "$PATCH_STATUS" \\
    '{httpStatus:$httpStatus,errorCode:(.error.code // null),errorStatus:(.error.status // null)}' \\
    "$MUTATION_RESPONSE" 2>/dev/null >&2 ||
    printf '{"httpStatus":"%s","errorCode":null,"errorStatus":null}\\n' "$PATCH_STATUS" >&2
  exit 1
fi
READ_STATUS="$(curl -sS -o "$ENGINE_READBACK" -w "%{http_code}" \\
  "https://discoveryengine.googleapis.com/v1/$ENGINE" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "X-Goog-User-Project: $PROJECT")"
if [[ "$READ_STATUS" != "200" ]] ||
   ! jq -e --arg engine "$ENGINE" '.name == $engine' "$ENGINE_READBACK" >/dev/null; then
  echo "Discovery Engine readback failed after rollback." >&2
  exit 1
fi
ACTUAL_GATEWAY="$(jq -r '.agentGatewaySetting.defaultEgressAgentGateway.name // ""' "$ENGINE_READBACK")"
if [[ "$ACTUAL_GATEWAY" != "$EXPECTED_GATEWAY" ]]; then
  echo "Discovery Engine readback did not confirm the retained rollback setting." >&2
  exit 1
fi
if [[ -n "$EXPECTED_GATEWAY" ]]; then
  echo "Restored engine egress gateway to $EXPECTED_GATEWAY using $STATE_FILE."
else
  echo "Restored engine egress gateway to unset using $STATE_FILE."
fi
`;
}

/** Operator runbook for the Agent Registry / Gateway path. */
export function renderAgentGatewayRunbook(
  air: AirDocument,
  options: AgentRegistryOptions = {},
): string {
  const name = air.service.displayName ?? air.service.id;
  const statePath = `$ANVIL_STATE_DIR/gemini-enterprise/${options.stateKey ?? "engine-state"}`;
  return `# Agent Registry / Agent Gateway — ${name}

This is the guarded Agent Registry + Agent Gateway path. Deployed agents resolve
tools through a governed gateway using a Google-managed agent-identity
principalSet + IAM. OAuth or no-auth at the MCP server remains an independent
choice; gateway IAM does not replace the server's bearer-token validation.

Artifacts in this directory:
- \`toolspec.json\` — the MCP tools (≤10 KB), generated from Anvil's approved
  operations; identical to what the server serves on \`tools/list\`.
- \`agent-gateway.yaml\` — the egress (Agent-to-Anywhere) gateway config.
- \`agent-registry.tf\` — project IAM only; \`register.sh\` is the sole owner of
  the registry service and TOOL_SPEC.
- \`readiness.template.json\` — exact non-secret authz/IAM inputs and checks that
  must be verified before engine binding.
- \`register.sh\` — validate stable readiness evidence, then either reconcile
  registry/gateway resources or snapshot and bind the engine in a separate run.
- \`rollback.sh\` — restores the exact pre-bind engine gateway setting captured
  outside generated files under \`${statePath}/engine-before.json\`.

Regional alignment (app / gateway / registry must line up):

| App location | Gateway location | Registry location |
|---|---|---|
| \`global\`      | \`us-central1\`     | \`global\` or \`us-central1\`         |
| \`us\`          | \`us-central1\`     | \`global\` or \`us-central1\`         |
| \`eu\`          | \`europe-west1\`    | \`global\` or \`europe-west1\`        |

Steps:
1. Deploy the StreamableHTTP MCP server (session-based) to a reachable HTTPS URL.
2. Create an operator-controlled state root outside the bundle and export its
   absolute path as \`ANVIL_STATE_DIR\`. Retain it independently of generated or
   certified artifacts.
3. Run
   \`ANVIL_RECONCILE_REGISTRY_GATEWAY=1 ANVIL_CONFIRM_REGISTRY_GATEWAY_RECONCILE=1 bash register.sh\`
   once. With no readiness file, it copies the template to stable state and
   exits **before any provider read or mutation**.
4. Attach the named authorization policy to the gateway (IAP authz extension →
   \`iap.googleapis.com\`, policyProfile REQUEST_AUTHZ) — required for every gateway.
5. Grant the agent identity \`roles/iap.egressor\` (egress) +
   \`roles/agentregistry.viewer\` (resolve). The generated Cloud Run target overlay
   grants that same principalSet \`roles/run.invoker\` on this one service, never
   project-wide. The Discovery Engine service
   agent (\`service-<PROJECT_NUMBER>@gcp-sa-discoveryengine.iam.gserviceaccount.com\`)
   also needs access to Agent Registry + Agent Gateway.
6. Independently verify every check in \`${statePath}/readiness.json\`, retain
   the exact resource names, and add \`verifiedAt\`.
7. Rerun the explicit reconciliation command from step 3. It performs all
   engine, registry, and gateway ownership preflights before reconciling, verifies
   exact readback, and exits without binding the engine.
8. Separately review and run
   \`ANVIL_CONFIRM_ENGINE_EGRESS_REROUTE=1 bash register.sh\`. This repeats every
   read-only preflight, rejects concurrent engine changes with its etag, snapshots
   the pre-bind gateway, and performs only the engine bind.
   If the engine is already bound but no pre-bind snapshot exists, the script
   refuses to invent one; import a verified snapshot or explicitly acknowledge
   that rollback is unavailable.
9. Import the server into the app: **Connected data stores → + New data store →
   MCP servers → Show all → Add tool** (everything under "MCP servers" other than
   "Custom MCP Server" is sourced from Agent Registry). Choose No authentication or
   OAuth 2.0 as the server requires; finish to import.
10. Apply egress governance on the gateway (IAM agent policies or semantic
   governance) to allow/deny which registry entries the server may reach, then
   verify with a query that triggers the tool.
11. To restore the previous engine setting, inspect the stable engine snapshot
   and run \`ANVIL_CONFIRM_ENGINE_EGRESS_ROLLBACK=1 bash rollback.sh\`. Rollback
   first verifies that the live engine still points at this kit's gateway and
   applies an etag precondition, so it cannot overwrite a newer route.

Custom MCP Server data store vs. this path: a direct Custom MCP Server data store
(instance_uri + OAuth) is NOT governed by the Agent Gateway — only
registry-imported servers are. Use this path when you want gateway governance;
use the console-first Custom MCP Server flow for a quick standalone data store.

Constraints: \`toolspec.json\` ≤ 10 KB; manual registration is unsupported in the
\`us\`/\`eu\` multi-region locations — use a region or \`global\`. Keep enabled tools
under the platform's ${"${maxActions}"}-action budget.
`.replace("${maxActions}", "100");
}
