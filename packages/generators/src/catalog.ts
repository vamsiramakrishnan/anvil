import type { AirDocument, Operation } from "@anvil/air";
import { evidenceConfidence, operationInputSchema, operationSafetyInputKeys } from "@anvil/air";

export interface CatalogEntry {
  id: string;
  canonicalName: string;
  displayName: string;
  description: string;
  capability?: string;
  effect: string;
  action: string;
  principal: string;
  risk: string;
  reversible: boolean;
  idempotency: string;
  idempotencyKeyRequired: boolean;
  idempotencyKeyInput: string;
  retrySafe: boolean;
  confirmationRequired: boolean;
  confirmationInput: string;
  /** Why confirmation is gated — carried so a harness hook can cite the reason. */
  confirmationReason?: string;
  /** True when the gate needs explicit HUMAN approval, not just a model `confirm`. */
  humanApproval: boolean;
  auth: { type: string; scopes: string[] };
  cli: string;
  mcpTool: string;
  state: string;
  intentExamples: string[];
  confidence: number;
}

/** A capability entry in the catalog — the primary index agents browse. */
export interface CapabilityCatalogEntry {
  id: string;
  displayName: string;
  description: string;
  source: string;
  operations: string[];
  workflows: string[];
  state: string;
  confidence: number;
}

/** The operation catalog (spec §5.5) — the human/agent-readable index. */
export function operationCatalog(air: AirDocument): {
  service: { id: string; version: string; displayName?: string };
  capabilities: CapabilityCatalogEntry[];
  operations: CatalogEntry[];
} {
  const publicWorkflowIds = new Set(
    air.workflows.filter((workflow) => workflow.state !== "blocked").map((workflow) => workflow.id),
  );
  return {
    service: {
      id: air.service.id,
      version: air.service.version,
      displayName: air.service.displayName,
    },
    capabilities: air.capabilities.map((c) => ({
      id: c.id,
      displayName: c.displayName,
      description: c.description,
      source: c.source,
      operations: c.operationIds,
      // Blocked workflows stay in AIR + diagnostics as audit evidence, but the
      // catalog is served over MCP as a discovery surface and must not advertise
      // them as runnable.
      workflows: c.workflowIds.filter((id) => publicWorkflowIds.has(id)),
      state: c.state,
      confidence: evidenceConfidence(c.evidence),
    })),
    operations: air.operations.map((op) => {
      const safety = operationSafetyInputKeys(op);
      return {
        id: op.id,
        canonicalName: op.canonicalName,
        displayName: op.displayName,
        description: op.description,
        capability: op.capabilityId,
        effect: op.effect.kind,
        action: op.effect.action,
        principal: op.auth.principal,
        risk: op.effect.risk,
        reversible: op.effect.reversible,
        idempotency: op.idempotency.mode,
        idempotencyKeyRequired:
          op.idempotency.mode === "required" &&
          op.idempotency.keyDerivation !== "request_fingerprint",
        idempotencyKeyInput: safety.idempotencyKey,
        retrySafe: op.retries.mode === "safe",
        confirmationRequired: op.confirmation.required,
        confirmationInput: safety.confirm,
        confirmationReason: op.confirmation.reason,
        humanApproval: op.confirmation.humanApproval === true,
        auth: { type: op.auth.type, scopes: op.auth.scopes },
        cli: op.cli.command,
        mcpTool: op.mcp.toolName,
        state: op.state,
        intentExamples: op.skill.intentExamples,
        confidence: evidenceConfidence(op.evidence),
      };
    }),
  };
}

/**
 * The compiled operations manifest loaded by the runtime hot path. It is a
 * minimal projection of AIR: no descriptions, examples, or provenance — just
 * what dispatch, validation, and safety enforcement need (spec: "Runtime
 * package layout"). Only approved operations are compiled in.
 */
export function compiledOperations(air: AirDocument): unknown {
  const approved = air.operations.filter((op) => op.state === "approved");
  return {
    service: air.service.id,
    version: air.service.version,
    baseUrl: air.service.servers[0]?.url ?? "",
    operations: approved.map((op) => ({
      id: op.id,
      toolName: op.mcp.toolName,
      cli: op.cli.command,
      sourceRef: op.sourceRef,
      effect: op.effect,
      params: op.input.params.map((p) => ({ name: p.name, in: p.in, required: p.required })),
      body: op.input.body
        ? {
            required: op.input.body.required,
            projection: op.input.body.projection,
            contentType: op.input.body.contentType,
            fields: op.input.body.fields.map((f) => ({ name: f.name, required: f.required })),
          }
        : undefined,
      idempotency: op.idempotency,
      retries: op.retries,
      confirmation: { required: op.confirmation.required },
      auth: op.auth,
    })),
  };
}

/** Compiled input schemas, keyed by operation id — used for runtime validation. */
export function compiledSchemas(air: AirDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const op of air.operations) {
    if (op.state !== "approved") continue;
    out[op.id] = op.input.schema ?? operationInputSchema(op);
  }
  return out;
}

/** Compiled error taxonomy + per-operation documented errors. */
export function compiledErrors(air: AirDocument): unknown {
  return {
    taxonomy: [
      "validation_error",
      "auth_required",
      "permission_denied",
      "not_found",
      "conflict",
      "rate_limited",
      "upstream_timeout",
      "upstream_unavailable",
      "unsafe_retry_blocked",
      "confirmation_required",
      "idempotency_required",
      "schema_mismatch",
      "unsupported_operation",
      "policy_denied",
      "unknown_upstream_error",
    ],
    operations: Object.fromEntries(
      air.operations
        .filter((op: Operation) => op.state === "approved")
        .map((op) => [op.id, op.errors]),
    ),
  };
}
