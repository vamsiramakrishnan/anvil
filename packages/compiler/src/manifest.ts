import type { Capability, Diagnostic, Operation, RetryCondition, Workflow } from "@anvil/air";
import { snakeCase } from "@anvil/air";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { classifyConfirmation, classifyRetry } from "./classify.js";

/**
 * The supplemental Anvil manifest (spec §4). Specs are incomplete; this is how
 * humans or classifiers enrich the model. Enrichment is explicit, diffable, and
 * overrides inference. Matching is by operationId, canonicalName, or AIR id.
 */
export const OperationManifest = z.object({
  side_effect: z.enum(["read", "mutation"]).optional(),
  risk: z.enum(["none", "low", "medium", "high", "financial", "destructive"]).optional(),
  reversible: z.boolean().optional(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  idempotency: z
    .object({
      strategy: z
        .enum(["natural", "required_request_key", "key_supported", "client_id", "none"])
        .optional(),
      key_location: z.enum(["header", "query", "body", "path"]).optional(),
      header: z.string().optional(),
    })
    .optional(),
  confirmation: z
    .object({
      required: z.boolean().optional(),
      risk: z.enum(["none", "low", "medium", "high", "financial", "destructive"]).optional(),
      reason: z.string().optional(),
    })
    .optional(),
  /** Override the descriptive action verb (list/get/create/send/…). */
  action: z
    .enum([
      "list",
      "get",
      "search",
      "export",
      "simulate",
      "validate",
      "poll",
      "create",
      "update",
      "replace",
      "delete",
      "send",
      "execute",
      "approve",
      "cancel",
      "reserve",
      "other",
    ])
    .optional(),
  /** Whose authority the call runs under, and how it is credentialed. */
  auth: z
    .object({
      principal: z
        .enum(["anonymous", "service", "end_user", "delegated", "impersonation"])
        .optional(),
      audience: z.string().optional(),
      secret_source: z
        .enum(["none", "env", "secret_manager", "workload_identity", "vault"])
        .optional(),
      tenant: z.string().optional(),
      actor: z.string().optional(),
      subject: z.string().optional(),
    })
    .optional(),
  retries: z
    .object({
      enabled: z.boolean().optional(),
      only_on: z.array(z.string()).optional(),
      max_attempts: z.number().int().optional(),
    })
    .optional(),
  state: z.enum(["generated", "review_required", "approved", "deprecated", "blocked"]).optional(),
});
export type OperationManifest = z.infer<typeof OperationManifest>;

/**
 * A workflow authored in the manifest. Anvil never *guesses* multi-step
 * business logic; this is how a human/harness declares it. Each step names an
 * operation (by operationId / canonicalName / AIR id).
 */
export const WorkflowManifest = z.object({
  display_name: z.string().optional(),
  description: z.string().optional(),
  /** Capability id/name to attach to. Defaults to the first step's capability. */
  capability: z.string().optional(),
  intent_examples: z.array(z.string()).optional(),
  human_approval: z.boolean().optional(),
  rollback: z.string().optional(),
  state: z.enum(["generated", "review_required", "approved", "deprecated", "blocked"]).optional(),
  steps: z
    .array(
      z.object({
        operation: z.string(),
        description: z.string().optional(),
        optional: z.boolean().optional(),
        bindings: z.record(z.string(), z.string()).optional(),
      }),
    )
    .default([]),
});
export type WorkflowManifest = z.infer<typeof WorkflowManifest>;

export const AnvilManifest = z.object({
  service: z
    .object({
      name: z.string().optional(),
      display_name: z.string().optional(),
      owner: z.string().optional(),
      environment: z.string().optional(),
    })
    .optional(),
  auth: z
    .object({
      type: z.string().optional(),
      scopes: z.array(z.string()).optional(),
    })
    .optional(),
  operations: z.record(z.string(), OperationManifest).default({}),
  workflows: z.record(z.string(), WorkflowManifest).default({}),
});
export type AnvilManifest = z.infer<typeof AnvilManifest>;

export function parseManifest(text: string): AnvilManifest {
  return AnvilManifest.parse(parseYaml(text));
}

const STRATEGY_TO_MODE = {
  natural: "natural",
  required_request_key: "required",
  key_supported: "key_supported",
  client_id: "client_id",
  none: "none",
} as const;

function normalizeCondition(entry: string): RetryCondition | null {
  const map: Record<string, RetryCondition> = {
    timeout: "timeout",
    connection_reset: "connection_reset",
    dns_failure: "dns_failure",
    unavailable: "grpc_unavailable",
    deadline_exceeded: "grpc_deadline_exceeded",
    soap_transport_fault: "soap_transport_fault",
  };
  const lower = entry.toLowerCase();
  if (map[lower]) return map[lower] as RetryCondition;
  if (/^\d{3}$/.test(entry)) return `http_${entry}` as RetryCondition;
  if (lower.startsWith("http_")) return lower as RetryCondition;
  return null;
}

/**
 * Which manifest keys match an operation: its AIR id, canonical name, or the
 * source's own operationId. Exported so the overlay layer resolves an operation
 * target with exactly the same rule the manifest uses (one matcher, no drift).
 */
export function operationMatchesKey(op: Operation, key: string): boolean {
  return op.id === key || op.canonicalName === key || op.sourceRef.operationId === key;
}
const matches = operationMatchesKey;

/**
 * Apply one operation's manifest entry, returning a new enriched operation.
 * Manifest values win over inference; anything left unset is recomputed so the
 * result stays internally consistent (idempotency/retry/confirmation coherent).
 *
 * This is the single semantic-override *application* path. The overlay layer
 * (`contract/`) resolves any number of policy overlays into one effective
 * `OperationManifest` per operation and applies it through exactly this
 * function, so a manifest override and a gateway/investigation overlay never
 * diverge in how they mutate an operation.
 */
export function applyOperationManifest(original: Operation, m: OperationManifest): Operation {
  const op: Operation = structuredClone(original);

  if (m.side_effect) op.effect.kind = m.side_effect;
  if (m.risk) op.effect.risk = m.risk;
  if (m.reversible !== undefined) op.effect.reversible = m.reversible;
  if (m.action) op.effect.action = m.action;
  if (m.display_name) op.displayName = m.display_name;
  if (m.description) op.description = m.description;

  if (m.auth) {
    if (m.auth.principal) op.auth.principal = m.auth.principal;
    if (m.auth.audience) op.auth.audience = m.auth.audience;
    if (m.auth.secret_source) op.auth.secretSource = m.auth.secret_source;
    if (m.auth.tenant) op.auth.tenant = m.auth.tenant;
    if (m.auth.actor || m.auth.subject) {
      op.auth.delegation = { actor: m.auth.actor, subject: m.auth.subject };
    }
  }

  if (m.idempotency?.strategy) {
    op.idempotency.mode = STRATEGY_TO_MODE[m.idempotency.strategy];
    if (m.idempotency.key_location) op.idempotency.mechanism = m.idempotency.key_location;
    if (m.idempotency.header) op.idempotency.key = m.idempotency.header;
    if (op.idempotency.mode === "required" || op.idempotency.mode === "key_supported") {
      op.idempotency.keyDerivation = "request_fingerprint";
    }
  }

  // Recompute derived policy so idempotency/retry/confirmation stay coherent,
  // then let explicit manifest values override.
  op.retries = classifyRetry(op.effect, op.idempotency);
  op.confirmation = classifyConfirmation(op.effect, op.idempotency);

  if (m.retries) {
    if (m.retries.enabled === false) {
      op.retries = { ...op.retries, mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] };
    } else if (m.retries.enabled === true) {
      op.retries.mode = "safe";
      if (op.retries.backoff === "none") op.retries.backoff = "exponential_jitter";
    }
    if (m.retries.only_on) {
      const conds = m.retries.only_on
        .map(normalizeCondition)
        .filter((c): c is RetryCondition => c !== null);
      if (conds.length) op.retries.retryOn = conds;
    }
    if (m.retries.max_attempts) op.retries.maxAttempts = m.retries.max_attempts;
  }

  if (m.confirmation) {
    if (m.confirmation.required !== undefined) op.confirmation.required = m.confirmation.required;
    if (m.confirmation.risk) op.confirmation.risk = m.confirmation.risk;
    if (m.confirmation.reason) op.confirmation.reason = m.confirmation.reason;
  }

  if (m.state) op.state = m.state;

  op.evidence.claims.push({
    subject: op.id,
    predicate: "enriched",
    value: true,
    source: "spec",
    sourceRef: "anvil-manifest",
    method: "manifest",
    note: "enriched by supplemental Anvil manifest",
    confidence: 0.95,
    review: "accepted",
  });

  return op;
}

/**
 * Apply a manifest to a set of operations, returning the enriched operations.
 * Thin wrapper over {@link applyOperationManifest}: the first manifest entry that
 * matches an operation wins, and non-matching operations pass through untouched.
 */
export function enrich(operations: Operation[], manifest: AnvilManifest): Operation[] {
  return operations.map((original) => {
    const entry = Object.entries(manifest.operations).find(([key]) => matches(original, key));
    if (!entry) return original;
    return applyOperationManifest(original, entry[1]);
  });
}

/**
 * Build first-class workflows from the manifest, resolving each step's operation
 * reference to an AIR operation id and attaching the workflow to a capability.
 * Steps that reference an unknown operation are dropped with a diagnostic — a
 * workflow is only as trustworthy as the operations it names. Returns the
 * workflows plus any diagnostics, and mutates capabilities to record ownership.
 */
export function buildWorkflows(
  manifest: AnvilManifest,
  operations: Operation[],
  capabilities: Capability[],
): { workflows: Workflow[]; diagnostics: Diagnostic[] } {
  const workflows: Workflow[] = [];
  const diagnostics: Diagnostic[] = [];
  const capById = new Map(capabilities.map((c) => [c.id, c]));

  for (const [name, wf] of Object.entries(manifest.workflows)) {
    const steps: Workflow["steps"] = [];
    for (const step of wf.steps) {
      const op = operations.find((o) => matches(o, step.operation));
      if (!op) {
        diagnostics.push({
          level: "warning",
          code: "workflow_step_unresolved",
          message: `Workflow "${name}" references unknown operation "${step.operation}"; step dropped.`,
        });
        continue;
      }
      steps.push({
        operationId: op.id,
        description: step.description ?? op.displayName,
        optional: step.optional ?? false,
        bindings: step.bindings ?? {},
      });
    }

    // Resolve the owning capability: explicit, else the first step's capability.
    const firstOpCap = steps.length
      ? operations.find((o) => o.id === steps[0]?.operationId)?.capabilityId
      : undefined;
    const capabilityId = resolveCapabilityId(wf.capability, firstOpCap, capabilities);
    if (!capabilityId) {
      diagnostics.push({
        level: "warning",
        code: "workflow_capability_unresolved",
        message: `Workflow "${name}" could not be attached to a capability; skipped.`,
      });
      continue;
    }

    const id = `${capabilityId}.${snakeCase(name)}`;
    workflows.push({
      id,
      capabilityId,
      displayName: wf.display_name ?? titleCase(name),
      description: wf.description ?? "",
      intentExamples: wf.intent_examples ?? [],
      steps,
      humanApproval: wf.human_approval ?? false,
      rollbackStrategy: wf.rollback,
      state: wf.state ?? "generated",
      evidence: {
        claims: [
          {
            subject: id,
            predicate: "authored",
            value: true,
            source: "spec",
            sourceRef: "anvil-manifest",
            method: "manifest",
            note: "authored workflow",
            confidence: 0.95,
            review: "accepted",
          },
        ],
      },
    });
    capById.get(capabilityId)?.workflowIds.push(id);
  }

  return { workflows, diagnostics };
}

function resolveCapabilityId(
  explicit: string | undefined,
  fallback: string | undefined,
  capabilities: Capability[],
): string | undefined {
  if (explicit) {
    const hit = capabilities.find(
      (c) => c.id === explicit || c.id.endsWith(`.${explicit}`) || c.displayName === explicit,
    );
    if (hit) return hit.id;
  }
  return fallback;
}

const titleCase = (s: string): string =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
