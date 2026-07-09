import type { Operation, RetryCondition } from "@anvil/air";
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

/** Which manifest keys match an operation. */
function matches(op: Operation, key: string): boolean {
  return op.id === key || op.canonicalName === key || op.sourceRef.operationId === key;
}

/**
 * Apply a manifest to a set of operations, returning the enriched operations.
 * Manifest values win over inference; anything the manifest leaves unset is
 * recomputed so the result stays internally consistent.
 */
export function enrich(operations: Operation[], manifest: AnvilManifest): Operation[] {
  return operations.map((original) => {
    const entry = Object.entries(manifest.operations).find(([key]) => matches(original, key));
    if (!entry) return original;
    const m = entry[1];
    const op: Operation = structuredClone(original);

    if (m.side_effect) op.effect.kind = m.side_effect;
    if (m.risk) op.effect.risk = m.risk;
    if (m.reversible !== undefined) op.effect.reversible = m.reversible;
    if (m.display_name) op.displayName = m.display_name;
    if (m.description) op.description = m.description;

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

    op.evidence.items.push({
      kind: "spec",
      ref: "anvil-manifest",
      note: "enriched by supplemental Anvil manifest",
      confidence: 0.95,
    });
    op.evidence.confidence = Math.max(op.evidence.confidence, 0.95);

    return op;
  });
}
