/**
 * The pieces of a workflow's composite tool that are about the workflow, not
 * about serving it: its input shape, how one step's output binds into the
 * next, and what an optional step's failure leaves behind.
 *
 * `WorkflowStep.optional` (packages/air/src/schema.ts) means the workflow may
 * proceed without that step's result. Honoured here as: a failed optional step
 * does not fail the workflow — it is recorded, under `anvil_step_failed`, where
 * its output would have been, so a later step's binding against it resolves to
 * nothing rather than to a stale value, and the trace and the caller both see
 * that it failed. A failed REQUIRED step still ends the run where it always
 * did. `rollbackStrategy` is advisory prose for the agent and the reviewer;
 * this runner never executes it.
 */
import {
  extractFieldName,
  type Operation,
  operationInputSchema,
  operationSafetyInputKeys,
  type WorkflowStep,
} from "@anvil/air";
import { z } from "zod";
import { projectionShape } from "./projection.js";
import { MCP_RESERVED } from "./zodshape.js";

/** The key under which a failed optional step's error envelope stands in for its output. */
export const STEP_FAILURE_KEY = "anvil_step_failed";

export interface StepResult {
  operationId: string;
  success: boolean;
  /** Whether the step was optional; a failed optional step keeps the run going. */
  optional: boolean;
  data?: unknown;
}

/** The output slot of a failed optional step: the failure, not a value. */
export function optionalStepFailure(step: WorkflowStep, envelope: unknown): StepResult {
  return {
    operationId: step.operationId,
    success: false,
    optional: true,
    data: { [STEP_FAILURE_KEY]: envelope },
  };
}

/** The one-line trace the composite appends: `<operationId>:ok|failed` per step. */
export function stepTrace(results: readonly StepResult[]): string {
  return results.map((sr) => `${sr.operationId}:${sr.success ? "ok" : "failed"}`).join(", ");
}

/**
 * Resolve a step's declared bindings from the previous step's output into
 * its input. A binding against a failed optional step resolves to undefined —
 * the failure marker is not a value a later step should receive as one.
 */
export function bindStepInput(
  step: WorkflowStep,
  previous: StepResult | undefined,
  input: Record<string, unknown>,
): void {
  const source = previous?.success ? previous.data : undefined;
  for (const [paramName, bindingValue] of Object.entries(step.bindings)) {
    input[paramName] = getFieldFromResult(source, extractFieldName(bindingValue));
  }
}

/**
 * Get a value from a potentially nested result, handling both objects and arrays.
 * If the result is an array, reads from the first element.
 */
function getFieldFromResult(result: unknown, fieldName: string): unknown {
  let obj: unknown = result;
  if (Array.isArray(obj) && obj.length > 0) {
    obj = obj[0];
  }
  if (isRecord(obj)) {
    return obj[fieldName];
  }
  return undefined;
}

/**
 * Build the input schema for a workflow tool. Uses the first step's input
 * schema, and — when a later step requires confirmation — exposes ONE confirm
 * key whose value the handler forwards to every confirming step under that
 * step's own safety key. The key name follows the same allocation rule as
 * single operations: the first step's own confirm key when it confirms itself,
 * else the stable "confirm" name unless a business field occupies it.
 */
export function buildWorkflowInputShape(
  firstStepOp: Operation,
  anyStepRequiresConfirmation: boolean,
): { shape: z.ZodRawShape; confirmKey: string | undefined } {
  const schema = operationInputSchema(firstStepOp);
  const properties = (schema.properties as Record<string, unknown>) ?? {};
  const required = new Set((schema.required as string[]) ?? []);
  const shape: Record<string, z.ZodType> = {};

  for (const [key, prop] of Object.entries(properties)) {
    if (typeof prop !== "object" || prop === null) continue;
    const propObj = prop as Record<string, unknown>;
    let t = z.fromJSONSchema(propObj as Parameters<typeof z.fromJSONSchema>[0]);
    if (typeof propObj.description === "string") t = t.describe(propObj.description as string);
    shape[key] = required.has(key) ? t : t.optional();
  }

  // Add the dry-run reserved control
  shape[MCP_RESERVED.dryRun] = z
    .boolean()
    .optional()
    .describe("Preview the wire request without executing it (no upstream call).");

  // …and the projection view control. A composite's final payload is the last
  // step's response and is exactly as expensive; the caller needs the same knob
  // here that it has on a single operation. It applies only to that final
  // payload — intermediate step outputs are bindings, not disclosure.
  Object.assign(shape, projectionShape());

  if (!anyStepRequiresConfirmation) return { shape, confirmKey: undefined };

  if (firstStepOp.confirmation.required) {
    // The first step's schema already carries its collision-allocated confirm
    // key; the composite reuses it rather than exposing a second one.
    return { shape, confirmKey: operationSafetyInputKeys(firstStepOp).confirm };
  }

  const confirmKey = "confirm" in shape ? "anvil_confirm" : "confirm";
  shape[confirmKey] = z
    .boolean()
    .optional()
    .describe(
      "Explicit confirmation. This workflow contains steps with side effects and requires confirm=true.",
    );
  return { shape, confirmKey };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
