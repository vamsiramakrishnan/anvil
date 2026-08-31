import { resolveAsyncContract } from "./async-contract.js";
import type { JsonSchema, Operation, Workflow } from "./schema.js";

/**
 * Which workflows register as composite tools, and which operation tools they
 * REPLACE.
 *
 * Composition used to be purely additive: an approved workflow registered one
 * more tool and suppressed nothing, so the single act meant to shrink the
 * surface an agent routes over grew it by one. `Workflow.supersedes` inverts
 * that — but only if two decisions stay welded together, which is why they live
 * in one module rather than two.
 *
 * **Eligibility is decided before suppression takes effect.** An ineligible
 * workflow — unapproved, a step that is not approved, a malformed binding, a
 * later step that demands the caller's one idempotency key — registers no tool.
 * If such a workflow could still suppress, it would silently delete tools and
 * put nothing in their place: the agent loses the operations *and* the composite
 * that was supposed to stand in for them. So a suppression is only ever read off
 * a workflow that this same pass has already decided will register.
 *
 * This lives in `@anvil/air` — not in the serving runtime — because two surfaces
 * consume the same plan and must never disagree about it. `@anvil/mcp-runtime`
 * serves exactly this plan; the compiler's capability disclosure budget
 * (`capabilityDisclosureBudget`) discounts exactly the operations this plan
 * suppresses and charges exactly the composites it registers. When the two
 * computed supersession independently, a workflow the runtime refused to
 * register could still buy the capability a budget discount, and the capability
 * passed the hard approval limit while the truly served surface was larger than
 * what was reviewed — the budget's one job, violated.
 *
 * Everything here is pure: same document, same plan, every time. It decides only
 * what is *listed*. Whether an operation may be called, under what confirmation,
 * with which idempotency rule, is decided on the call path in `@anvil/runtime`
 * and nothing in this module can reach it — a superseded operation is still in
 * AIR, still generated into the CLI and every client SDK, and still runs under
 * exactly the contract it always did.
 */

/** The one binding format a workflow step may use: `$.output.<fieldName>`. */
const FIELD_MAPPING = /^\$\.output\.([A-Za-z0-9_]+)$/;

/** Check if a binding value matches the required format: $.output.<fieldName> */
function isValidFieldMapping(binding: string): boolean {
  return FIELD_MAPPING.test(binding);
}

/**
 * Extract the field name from a binding value like `$.output.fieldName`.
 *
 * Deliberately beside the validator rather than in the serving path: they are
 * one grammar read twice, and a validator that accepted what the extractor
 * could not parse would bind `undefined` into a step's input.
 */
export function extractFieldName(binding: string): string {
  return binding.match(FIELD_MAPPING)?.[1] ?? "";
}

/**
 * The output fields a `$.output.<field>` binding can address on one operation:
 * one level of property names from its output schema, descending through a
 * single array wrapper (a list/search operation's real payload is
 * `items[].field`, not the envelope itself). Deliberately shallow — a deep walk
 * would match coincidental nested names, the structural-noise problem the
 * capability-composition leaf detector already documents.
 *
 * Lifted (not rewritten) from `@anvil/harness`'s `detectWorkflowCandidates`, and
 * homed HERE because this module owns the binding grammar those field names
 * feed: the serving path extracts `$.output.<field>` with `extractFieldName`
 * above, the harness detector proposes bindings against these names, and
 * refinement's group-proposal validation refuses bindings that do not resolve
 * to one of them. Three consumers, one definition — a validator that accepted a
 * field the detector could not see would bind `undefined` at serve time.
 */
export function bindableOutputFields(schema: JsonSchema | undefined): Set<string> {
  const out = new Set<string>();
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return out;
  const properties = schema.properties;
  if (typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
    for (const key of Object.keys(properties)) out.add(key);
    return out;
  }
  if (schema.type === "array" && typeof schema.items === "object" && schema.items !== null) {
    return bindableOutputFields(schema.items as JsonSchema);
  }
  return out;
}

/**
 * One workflow's registration verdict: the tool it builds, or why it builds
 * none. A discriminated union rather than optional fields, so the caller cannot
 * reach `firstStepOp` on a workflow that was skipped — the guard is the type,
 * not a re-check the registration loop used to have to repeat.
 */
export type WorkflowRegistration =
  | {
      workflow: Workflow;
      /** The `onSkipWorkflow` reason. Present exactly when nothing registers. */
      skipReason: string;
      stepOps?: undefined;
      firstStepOp?: undefined;
    }
  | {
      workflow: Workflow;
      skipReason?: undefined;
      /** The resolved step operations, in order. */
      stepOps: Operation[];
      /** `stepOps[0]`, carried so the caller needs no second existence check. */
      firstStepOp: Operation;
    };

/** One operation removed from the tool surface, and the workflow that replaced it. */
export interface AppliedSupersession {
  operationId: string;
  workflowId: string;
}

/** One suppression this pass declined to apply, and why it declined. */
export interface RefusedSupersession extends AppliedSupersession {
  reason: string;
}

export interface WorkflowSurfacePlan {
  /** Every workflow in document order, each with its verdict. */
  registrations: WorkflowRegistration[];
  /** operationId -> the workflow that supersedes it. Only registrable workflows appear. */
  superseded: Map<string, string>;
  /** Suppressions deliberately not applied — visibility, never silence. */
  refused: RefusedSupersession[];
}

/**
 * Decide, for one served operation set, which workflows register and which
 * operations they remove.
 *
 * `opsById` is the approved, non-receiver candidate set — the surface *before*
 * supersession. It stays whole here on purpose: a workflow's own steps must
 * still resolve after the workflow has agreed to suppress them, or a workflow
 * would invalidate itself by succeeding.
 */
export function planWorkflowSurface(
  workflows: readonly Workflow[],
  opsById: ReadonlyMap<string, Operation>,
  allOpsById: ReadonlyMap<string, Operation>,
): WorkflowSurfacePlan {
  const registrations = workflows.map((workflow) => evaluateWorkflow(workflow, opsById));

  // Pass 1: what the registrable workflows ask for.
  const proposed = new Map<string, string>();
  for (const registration of registrations) {
    if (registration.skipReason !== undefined) continue;
    for (const operationId of registration.workflow.supersedes ?? []) {
      // A supersedes entry naming something outside the served set has nothing
      // to remove. Not an error — an unapproved step already blocked the
      // workflow above — just a no-op.
      if (!opsById.has(operationId)) continue;
      if (proposed.has(operationId)) continue;
      proposed.set(operationId, registration.workflow.id);
    }
  }

  // Pass 2: refuse the suppressions that would leave a served tool pointing at a
  // tool that no longer exists.
  //
  // An operation with a resolved AsyncContract publishes its poll coordinates —
  // `anvil/async_status_tool` names the status operation's tool NAME, the string
  // a client passes to `tools/call`. Suppressing that status operation while its
  // submitter is still served would advertise a tool name absent from
  // `tools/list`: an agent acting on half a contract, which is the exact failure
  // `asyncContractMeta` refuses to create by any other route. Keeping the tool is
  // the conservative direction — the surface stays as large as it was, which is
  // never a safety regression — so the suppression yields, not the contract.
  //
  // Refusals are iterated to a FIXED POINT against the evolving suppression set,
  // never judged once against the proposed one. A refusal changes the served
  // surface: the operation it keeps is a tool again, and if that tool's own
  // async contract names a third operation, *that* suppression must now be
  // refused too, however long the chain runs. Judged against the static
  // proposal — as a single pass once did — the chain A(serves)→B(status)→C
  // ended with B kept but C still suppressed, so the final surface served B
  // whose `anvil/async_status_tool` pointed at the absent C.
  //
  // Termination is monotone: a round either refuses at least one suppression —
  // strictly shrinking `superseded`, which starts finite and is never added
  // to — or refuses none and the loop exits. So the loop runs at most
  // |proposed| + 1 rounds.
  const refused: RefusedSupersession[] = [];
  const superseded = new Map(proposed);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [operationId, workflowId] of superseded) {
      const submitter = servedSubmitterOf(operationId, opsById, allOpsById, superseded);
      if (!submitter) continue;
      superseded.delete(operationId);
      changed = true;
      refused.push({
        operationId,
        workflowId,
        reason:
          `operation '${submitter}' is still served and names '${operationId}' as its async status ` +
          "operation; suppressing it would advertise poll coordinates for a tool that is not listed",
      });
    }
  }

  return { registrations, superseded, refused };
}

/**
 * The id of a still-served operation whose resolved async contract names
 * `operationId` as its status operation, or undefined when none does. A
 * submitter that is itself being superseded does not count: its own coordinates
 * are leaving the surface with it — but only for as long as it actually is;
 * the fixed-point loop above re-asks this question whenever a refusal returns
 * a submitter to the surface.
 */
function servedSubmitterOf(
  operationId: string,
  opsById: ReadonlyMap<string, Operation>,
  allOpsById: ReadonlyMap<string, Operation>,
  superseded: ReadonlyMap<string, string>,
): string | undefined {
  for (const candidate of opsById.values()) {
    if (candidate.id === operationId) continue;
    if (superseded.has(candidate.id)) continue;
    const resolution = resolveAsyncContract(candidate, allOpsById);
    if (!resolution.ok) continue;
    if (resolution.statusOperation?.id === operationId) return candidate.id;
  }
  return undefined;
}

/**
 * The registration eligibility checks, in the order they have always run. Each
 * returns the same reason string the server reported before this module existed,
 * so `onSkipWorkflow` observers see no change.
 */
function evaluateWorkflow(
  workflow: Workflow,
  opsById: ReadonlyMap<string, Operation>,
): WorkflowRegistration {
  const skip = (skipReason: string): WorkflowRegistration => ({ workflow, skipReason });

  // Only approved workflows register — and therefore only approved workflows
  // supersede. This is the check the whole subtractive story rests on.
  if (workflow.state !== "approved") return skip("workflow state is not approved");

  // All steps must exist and be approved.
  const stepOps: Operation[] = [];
  for (const step of workflow.steps) {
    const stepOp = opsById.get(step.operationId);
    if (!stepOp) return skip(`step '${step.operationId}' not found or not approved`);
    stepOps.push(stepOp);
  }

  // All bindings must be valid field mappings.
  for (const step of workflow.steps) {
    for (const [paramName, bindingValue] of Object.entries(step.bindings)) {
      if (!isValidFieldMapping(bindingValue)) {
        return skip(
          `step '${step.operationId}' binding for '${paramName}' has invalid format: '${bindingValue}'`,
        );
      }
    }
  }

  if (stepOps.length === 0) return skip("workflow has no steps");

  // A non-first step that REQUIRES a client idempotency key is ineligible in
  // v1: forwarding the caller's one key to several mutations would make
  // distinct writes share a dedup identity, which is exactly the corruption
  // idempotency keys exist to prevent. (Step 1 receives the caller's input
  // whole, key included, so it stays eligible.)
  const keyedLaterStep = stepOps.find((op, i) => i > 0 && op.idempotency.mode === "required");
  if (keyedLaterStep) {
    return skip(
      `step '${keyedLaterStep.id}' requires a client idempotency key; the composite cannot mint distinct keys`,
    );
  }

  const firstStepOp = stepOps[0];
  if (!firstStepOp) return skip("workflow first step operation not found");

  return { workflow, stepOps, firstStepOp };
}
