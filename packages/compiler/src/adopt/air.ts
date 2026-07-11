/**
 * Bridge a captured MCP surface into AIR. Each advertised tool becomes one AIR
 * operation whose `mcp.toolName` is the adopted name verbatim — so a
 * `SurfaceSignature` derived from this AIR matches the provider's tool surface,
 * and any generated CLI/skill references exactly the adopted tools.
 *
 * Safety is inferred conservatively from MCP tool annotations: absent a
 * `readOnlyHint`, a tool is treated as a non-idempotent mutation (confirm, never
 * auto-retry) — unknown side effect beats assumed safety.
 */
import {
  type AirDocument,
  type AuthRequirement,
  type Effect,
  type Idempotency,
  loadAirDocument,
  type Operation,
  snakeCase,
} from "@anvil/air";
import { classifyConfirmation, classifyRetry } from "../classify.js";
import type { McpSurfaceSnapshot, McpTool } from "./model.js";

function inferEffect(tool: McpTool): { effect: Effect; idempotency: Idempotency } {
  const a = tool.annotations ?? {};
  if (a.readOnlyHint) {
    return {
      effect: { kind: "read", action: "get", risk: "none", reversible: true },
      idempotency: { mode: "natural", mechanism: "none", keyDerivation: "none" },
    };
  }
  const risk = a.destructiveHint ? "destructive" : "medium";
  return {
    effect: { kind: "mutation", action: "execute", risk, reversible: !a.destructiveHint },
    idempotency: a.idempotentHint
      ? { mode: "key_supported", mechanism: "none", keyDerivation: "request_fingerprint" }
      : { mode: "none", mechanism: "none", keyDerivation: "none" },
  };
}

const UNKNOWN_AUTH: AuthRequirement = {
  type: "none",
  scopes: [],
  principal: "service",
  secretSource: "none",
};

function operationFromTool(serviceId: string, capabilityId: string, tool: McpTool): Operation {
  const canonicalName = snakeCase(tool.name);
  const { effect, idempotency } = inferEffect(tool);
  return {
    id: `${serviceId}.${canonicalName}`,
    canonicalName,
    displayName: tool.name,
    description: tool.description ?? "",
    tags: [],
    sourceRef: { kind: "mcp", operationId: tool.name },
    effect,
    input: { params: [], schema: tool.inputSchema },
    output: {},
    errors: [],
    idempotency,
    retries: classifyRetry(effect, idempotency),
    confirmation: classifyConfirmation(effect, idempotency),
    auth: UNKNOWN_AUTH,
    cli: { command: canonicalName, aliases: [] },
    mcp: { toolName: tool.name },
    skill: { intentExamples: [] },
    streaming: false,
    longRunning: false,
    deprecated: false,
    reviewNotes: [],
    state: "generated",
    capabilityId,
    evidence: {
      claims: [
        {
          subject: `${serviceId}.${canonicalName}`,
          predicate: "adopted",
          value: true,
          source: "spec",
          sourceRef: "mcp-adopt",
          method: "mcp_adopt",
          note: "adopted from an upstream MCP server surface",
          confidence: 0.9,
          review: "accepted",
        },
      ],
    },
  };
}

/**
 * Build an AIR document from an MCP surface snapshot. One capability groups all
 * adopted tools; operations are `generated` (they need review/approval before
 * any surface exposes them), preserving Anvil's approval contract for a BYO
 * server exactly as for a compiled spec.
 */
export function airFromMcpSurface(
  snapshot: McpSurfaceSnapshot,
  options: { serviceId?: string } = {},
): AirDocument {
  const serviceId = options.serviceId ?? (snakeCase(snapshot.server.name) || "adopted");
  const capabilityId = `${serviceId}.adopted`;
  const operations = snapshot.tools.map((t) => operationFromTool(serviceId, capabilityId, t));

  return loadAirDocument({
    anvilVersion: "0.1.0",
    service: {
      id: serviceId,
      version: snapshot.server.version || "0.0.0",
      displayName: snapshot.server.name,
      source: {
        kind: "mcp",
        uri: snapshot.endpoint,
        origin: { kind: "mcp", uri: snapshot.endpoint },
      },
      auth: UNKNOWN_AUTH,
      servers: [],
    },
    operations,
    capabilities: [
      {
        id: capabilityId,
        displayName: snapshot.server.name,
        description: `Adopted from the ${snapshot.server.name} MCP server.`,
        source: "service",
        resources: [],
        operationIds: operations.map((o) => o.id),
        workflowIds: [],
        intentExamples: [],
        lifecycle: "proposed",
      },
    ],
    workflows: [],
    schemas: {},
    diagnostics: [],
  });
}
