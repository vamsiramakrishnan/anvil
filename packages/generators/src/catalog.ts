import type { AirDocument, Operation } from "@anvil/air";
import {
  asyncContractSentence,
  evidenceConfidence,
  operationInputSchema,
  operationSafetyInputKeys,
  resolveAsyncContract,
} from "@anvil/air";
import { operationInputSignature } from "./input-signature.js";

/**
 * Strip HTML tags from text (e.g., <p>…</p> → plain text).
 */
function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, "");
}

/**
 * Truncate a description to 160 chars at a word boundary, appending "…" if truncated.
 * Returns undefined if input is empty or falsy.
 * First strips HTML tags if present.
 */
function truncateDescription(text?: string, maxChars = 160): string | undefined {
  if (!text) return undefined;

  // Strip HTML tags first
  const clean = stripHtmlTags(text);
  if (clean.length <= maxChars) return clean;

  // Find the last space before maxChars
  const truncated = clean.substring(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  const cutPoint = lastSpace > 0 ? lastSpace : maxChars;

  return `${clean.substring(0, cutPoint)}…`;
}

export interface CatalogEntry {
  id: string;
  canonicalName: string;
  displayName: string;
  /** Glanceable one-line description (truncated to 160 chars at word boundary). */
  description?: string;
  /** Compact input signature: required params first with `*`, then optional, then body.fields. Capped at 8 entries with ellipsis. */
  inputs?: string;
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
  /** Pagination configuration when present. */
  pagination?: { style: string; cursorParam?: string; nextField?: string; itemsField?: string };
  /** True when the operation returns before completion and requires polling. */
  longRunning?: boolean;
  /**
   * How to finish a call that returned before its work did — present ONLY when
   * the contract resolves. `longRunning` says a wait exists, which is exactly
   * enough information to be stuck; these are the coordinates a consumer can act
   * on: the handle to read, the operation to poll on either surface, the
   * parameter that carries the handle, and the states that mean stop. An
   * unresolvable contract is omitted entirely rather than half-published,
   * because a consumer polling a tool it cannot call is worse off than one told
   * nothing. `instruction` is the shared sentence, carried so a consumer that
   * renders prose renders the *same* prose as the skill and the tool metadata.
   */
  asyncContract?: {
    statusOperationId: string;
    statusTool: string;
    statusCli: string;
    jobIdField: string;
    statusJobIdParam: string;
    stateField?: string;
    terminalStates: string[];
    pendingStates?: string[];
    pollIntervalSeconds?: number;
    instruction: string;
  };
  /** How an agent should interact with this operation. */
  archetype?: string;
  /** REST/GraphQL path and method when available (e.g., "post /v1/charges/{charge}/refunds"). */
  path?: string;
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
  // Built once for the whole document: an async contract only means something
  // relative to the operation it points at, so resolution needs the index — and
  // resolution, not the presence of the field, is what decides publishability.
  const operationsById = new Map<string, Operation>(air.operations.map((op) => [op.id, op]));
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
      const entry: CatalogEntry = {
        id: op.id,
        canonicalName: op.canonicalName,
        displayName: op.displayName,
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
      // Populate description if present, truncated for glanceability
      const truncatedDescription = truncateDescription(op.description);
      if (truncatedDescription) {
        entry.description = truncatedDescription;
      }
      // Populate inputs signature
      const signature = operationInputSignature(op);
      if (signature) {
        entry.inputs = signature;
      }
      // Populate path if sourceRef has both method and path
      if (op.sourceRef.method && op.sourceRef.path) {
        entry.path = `${op.sourceRef.method} ${op.sourceRef.path}`;
      }
      if (op.pagination) {
        entry.pagination = {
          style: op.pagination.style,
          cursorParam: op.pagination.cursorParam,
          nextField: op.pagination.nextField,
          itemsField: op.pagination.itemsField,
        };
      }
      if (op.longRunning) {
        entry.longRunning = true;
      }
      // All-or-nothing, per the contract's own rule: a resolution that failed
      // for any reason (missing, unapproved, or mutating status operation; no
      // parameter to carry the handle; no terminal state) publishes nothing at
      // all. There is deliberately no partial shape and no vague fallback — the
      // absence is the signal, and it is a truthful one.
      const completion = resolveAsyncContract(op, operationsById);
      const instruction = asyncContractSentence(completion);
      if (completion.ok && instruction) {
        entry.asyncContract = {
          statusOperationId: completion.statusOperation.id,
          // Both bindings, because the catalog serves both surfaces: an MCP
          // client needs the tool name, a CLI caller needs the command, and
          // making either derive the other invites the two to disagree.
          statusTool: completion.statusOperation.mcp.toolName,
          statusCli: completion.statusOperation.cli.command,
          jobIdField: completion.contract.jobIdField,
          statusJobIdParam: completion.contract.statusJobIdParam,
          stateField: completion.contract.stateField,
          terminalStates: completion.contract.terminalStates,
          // Advisory and frequently empty; an empty list would read as "nothing
          // is a working state", which is the opposite of "unstated".
          ...(completion.contract.pendingStates.length > 0
            ? { pendingStates: completion.contract.pendingStates }
            : {}),
          pollIntervalSeconds: completion.contract.pollIntervalSeconds,
          instruction,
        };
      }
      if (op.archetype) {
        entry.archetype = op.archetype;
      }
      return entry;
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
      params: op.input.params.map((p) => ({
        name: p.name,
        agentName: p.agentName,
        aliases: p.aliases,
        in: p.in,
        required: p.required,
      })),
      body: op.input.body
        ? {
            required: op.input.body.required,
            projection: op.input.body.projection,
            contentType: op.input.body.contentType,
            fields: op.input.body.fields.map((f) => ({
              name: f.name,
              agentName: f.agentName,
              aliases: f.aliases,
              required: f.required,
            })),
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
