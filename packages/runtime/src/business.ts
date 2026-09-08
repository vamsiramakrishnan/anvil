import { randomUUID } from "node:crypto";
import {
  type AirDocument,
  type BusinessAction,
  type BusinessBinding,
  type BusinessPlan,
  businessPointer,
  hashCanonical,
  loadBusinessPlan,
  type Operation,
  operationInputSchema,
  operationSafetyInputKeys,
  validateBusinessValue,
} from "@anvil/air";
import { type ExecuteContext, execute } from "./executor.js";
import { type IdempotencyLedger, idempotencyKeyIsTransportSafe } from "./idempotency.js";

/** Constructed by the trusted host from verified identity and operator policy, never tool arguments. */
export interface BusinessContext {
  tenant: string;
  principal: string;
  policyVersion: string;
  /** Trusted identity of deployment environment, source targets, and source grants. */
  executionBinding: string;
  scopes: string[];
}
export interface BusinessApproval {
  digest: string;
  approvedBy: string;
  expiresAt: number;
}
export interface BusinessResult {
  status: "completed" | "rejected" | "partial" | "reconciliation_required" | "approval_required";
  trace_id: string;
  completed_effects: string[];
  result?: Record<string, unknown>;
  message?: string;
  next_action?: string;
  approval_digest?: string;
}
export interface BusinessHost {
  context: BusinessContext;
  ledger?: IdempotencyLedger;
  env: "dev" | "staging" | "prod";
  /** Source credentials, grants, transport, timeout, policy, and observer remain host-owned. */
  contextFor(source: string, air: AirDocument, operation: Operation): ExecuteContext;
  /** A trusted approval broker; a model-supplied confirm boolean is never accepted here. */
  approvalFor?(digest: string): Promise<BusinessApproval | undefined>;
  now?(): number;
}

/** Binds authorization to the complete request, identity, policy version, and exact private plan. */
export function businessApprovalDigest(
  plan: BusinessPlan,
  action: string,
  input: Record<string, unknown>,
  context: BusinessContext,
  idempotencyKey?: string,
): string {
  return hashCanonical({
    intentKey: idempotencyKey ?? null,
    plan: plan.digest,
    action,
    input,
    tenant: context.tenant,
    principal: context.principal,
    policyVersion: context.policyVersion,
    executionBinding: context.executionBinding,
  });
}

function bind(
  binding: BusinessBinding,
  input: Record<string, unknown>,
  context: BusinessContext,
  outputs: Map<string, unknown>,
): unknown {
  if (binding.from === "literal") return structuredClone(binding.value);
  if (binding.from === "input") return businessPointer(input, binding.pointer);
  if (binding.from === "context") return context[binding.field];
  if (!outputs.has(binding.step)) throw new Error("Unresolved step binding.");
  return businessPointer(outputs.get(binding.step), binding.pointer);
}

function project(
  bindings: Record<string, BusinessBinding>,
  input: Record<string, unknown>,
  context: BusinessContext,
  outputs: Map<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(bindings).map(([key, binding]) => [key, bind(binding, input, context, outputs)]),
  );
}

/**
 * One bounded execution engine behind every language and agent surface. A reserved intent is
 * never automatically re-entered after uncertainty. Completed partial outcomes replay as-is.
 * Ledger retention bounds deduplication; this is not an exactly-once transaction protocol.
 */
export async function executeBusiness(
  rawPlan: BusinessPlan,
  actionId: string,
  requestInput: Record<string, unknown>,
  requestHost: BusinessHost,
  idempotencyKey?: string,
): Promise<BusinessResult> {
  // Async hooks must execute the exact values whose digest was reviewed.
  const input = structuredClone(requestInput);
  const host = { ...requestHost, context: structuredClone(requestHost.context) };
  const plan = loadBusinessPlan(rawPlan);
  const trace = randomUUID();
  const result = (
    status: BusinessResult["status"],
    message: string,
    next_action = "Correct the request or contact the capability owner.",
  ): BusinessResult => ({ status, trace_id: trace, completed_effects: [], message, next_action });
  const action = plan.definition.actions.find((a) => a.id === actionId);
  if (action?.state !== "approved")
    return result("rejected", "This business action is not approved.");
  const context = host.context;
  if (
    ![context.tenant, context.principal, context.policyVersion, context.executionBinding].every(
      (v) => typeof v === "string" && v.length > 0,
    )
  )
    return result(
      "rejected",
      "Trusted tenant, principal, policy version, and execution binding are required.",
    );
  if (
    !context.scopes.includes("*") &&
    action.requiredScopes.some((scope) => !context.scopes.includes(scope))
  )
    return result("rejected", "The caller is not authorized for this business action.");
  if (!validateBusinessValue(action.input, input))
    return result("rejected", "Input does not satisfy the business contract.");
  const mutation = action.steps.some(
    (s) =>
      plan.sources[s.source]?.operations.find((op) => op.id === s.operationId)?.effect.kind ===
      "mutation",
  );
  if (mutation && (!idempotencyKey || !idempotencyKeyIsTransportSafe(idempotencyKey)))
    return result("rejected", "Supply one stable idempotency key for this business intent.");
  const digest = businessApprovalDigest(plan, action.id, input, context, idempotencyKey);
  let key: string | undefined;
  if (mutation) {
    if (!idempotencyKey || !idempotencyKeyIsTransportSafe(idempotencyKey))
      return result("rejected", "Supply one stable idempotency key for this business intent.");
    if (!host.ledger || (host.env !== "dev" && !host.ledger.durable))
      return result("rejected", "A durable business execution ledger is required.");
    key = `business-${hashCanonical({ service: plan.definition.id, action: action.id, tenant: context.tenant, principal: context.principal, key: idempotencyKey })}`;
    try {
      const reservation = await host.ledger.reserve(key, digest, {
        operationId: action.id,
        traceId: trace,
      });
      if (reservation.outcome === "replay") return reservation.result as BusinessResult;
      if (reservation.outcome === "conflict")
        return result(
          "rejected",
          "This intent key is already bound to another request or contract.",
          "Inspect the original intent. Use a new key only for a genuinely new, authorized intent.",
        );
      if (reservation.outcome === "in_progress")
        return result(
          "reconciliation_required",
          "This intent is running or its completion is uncertain.",
          "Reconcile the original intent before attempting another mutation; do not rotate its key.",
        );
    } catch {
      return result(
        "rejected",
        "The business execution ledger is unavailable.",
        "Restore ledger availability before retrying the same intent.",
      );
    }
  }
  if (action.humanApproval) {
    let approval: BusinessApproval | undefined;
    try {
      approval = await host.approvalFor?.(digest);
    } catch {
      /* Fail closed without broker details. */
    }
    if (
      !approval ||
      approval.digest !== digest ||
      typeof approval.approvedBy !== "string" ||
      !approval.approvedBy ||
      !Number.isFinite(approval.expiresAt) ||
      approval.expiresAt <= (host.now?.() ?? Date.now())
    ) {
      const refusal: BusinessResult = {
        ...result(
          "approval_required",
          "Human approval is required for this exact request.",
          "Ask the capability owner to review this request and its declared effects; retry the same intent after approval.",
        ),
        approval_digest: digest,
      };
      if (key && host.ledger) {
        try {
          await host.ledger.release(key);
        } catch {
          return {
            ...refusal,
            status: "reconciliation_required",
            message: "The unexecuted intent reservation could not be released.",
            next_action: "Restore the business ledger and reconcile this intent before retrying.",
          };
        }
      }
      return refusal;
    }
  }
  const outcome = await runSteps(plan, action, input, host, trace, key);
  if (key && host.ledger) {
    try {
      await host.ledger.complete(key, outcome);
    } catch {
      return {
        ...outcome,
        status: "reconciliation_required",
        message: "The execution outcome could not be durably recorded.",
        next_action:
          "Reconcile this intent before attempting another mutation; do not rotate its key.",
      };
    }
  }
  return outcome;
}

async function runSteps(
  plan: BusinessPlan,
  action: BusinessAction,
  input: Record<string, unknown>,
  host: BusinessHost,
  trace: string,
  intentKey?: string,
): Promise<BusinessResult> {
  const outputs = new Map<string, unknown>();
  const completed: string[] = [];
  let mutationAttempted = false;
  let current: BusinessAction["steps"][number] | undefined;
  const failure = (message: string, uncertain = false): BusinessResult => ({
    status: uncertain ? "reconciliation_required" : completed.length ? "partial" : "rejected",
    trace_id: trace,
    completed_effects: [...completed],
    message,
    next_action:
      current?.failure.nextAction ??
      "Inspect this execution with the capability owner before retrying.",
  });
  try {
    for (const step of action.steps) {
      current = step;
      mutationAttempted = false;
      const source = plan.sources[step.source];
      const op = source?.operations.find((op) => op.id === step.operationId);
      if (!source || !op || op.state !== "approved")
        return failure("An execution dependency is unavailable or unapproved.");
      for (const guard of step.preconditions) {
        if (
          hashCanonical(bind(guard.value, input, host.context, outputs)) !==
          hashCanonical(bind(guard.equals, input, host.context, outputs))
        )
          return failure(guard.message);
      }
      const stepInput = project(step.input, input, host.context, outputs);
      const keys = operationSafetyInputKeys(op);
      const stepKey = intentKey
        ? `anvil-business-${hashCanonical({ intentKey, step: step.id })}`
        : undefined;
      const validationInput = {
        ...stepInput,
        ...(op.confirmation.required ? { [keys.confirm]: true } : {}),
        ...(op.idempotency.mode === "required" ? { [keys.idempotencyKey]: stepKey } : {}),
      };
      if (!validateBusinessValue(operationInputSchema(op), validationInput))
        return failure("A bound value does not satisfy its execution contract.");
      const sourceContext = host.contextFor(step.source, source, op);
      // Preserve host principal resolution and limits. A configured directory must still fail
      // closed when it cannot resolve a principal; composition cannot manufacture that grant.
      const ctx: ExecuteContext = {
        ...sourceContext,
        remoteIdempotency: false,
        traceId: trace,
        principal:
          sourceContext.principal ??
          (sourceContext.principalDirectoryConfigured
            ? undefined
            : { id: host.context.principal, scopes: [] }),
      };
      mutationAttempted = op.effect.kind === "mutation";
      const output = await execute(
        op,
        {
          input: stepInput,
          confirm: true,
          ...(op.idempotency.mode === "required" || op.idempotency.mode === "key_supported"
            ? { idempotencyKey: stepKey }
            : {}),
        },
        ctx,
      );
      if (output.outcome !== "success") return failure(step.failure.message, mutationAttempted);
      // Validate raw output before binding it into another system. No implicit coercion.
      if (op.output.schema && !validateBusinessValue(op.output.schema, output.data))
        return failure("An execution dependency returned an invalid result.", mutationAttempted);
      if (mutationAttempted && step.effect) completed.push(step.effect);
      outputs.set(step.id, output.data);
    }
    const data = project(action.result, input, host.context, outputs);
    if (!validateBusinessValue(action.output, data))
      return failure(
        "The business outcome did not satisfy its declared contract.",
        completed.length > 0,
      );
    return { status: "completed", trace_id: trace, completed_effects: completed, result: data };
  } catch {
    // Raw vendor error messages, response payloads, and credentials stay out of the public answer.
    return failure(
      current?.failure.message ?? "Business execution could not complete.",
      mutationAttempted,
    );
  }
}
