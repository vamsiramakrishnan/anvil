import {
  type AirDocument,
  mcpToolAnnotations,
  mcpToolDescription,
  type Operation,
  operationInputSchema,
  operationSafetyInputKeys,
} from "@anvil/air";
import { type ExecuteContext, execute } from "@anvil/runtime";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { truncateResultText } from "./truncation.js";
import { MCP_RESERVED, operationZodShape, reservedSafetyShape } from "./zodshape.js";

/**
 * A resource the MCP server advertises to agents (skill, catalog, CLI install
 * manifest). It is **precomputed data**, not built here — the build-time
 * generators produce it and the deployed runtime just serves it. That keeps the
 * serving path free of any dependency on the artifact foundry.
 */
export interface ServedResource {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  text: string;
  /** MCP annotation: who this is for and how important. */
  audience: Array<"user" | "assistant">;
  priority: number;
}

export interface McpBuildOptions {
  /**
   * Produces the execution context for an operation call. In production this
   * wires FetchTransport + credential resolver + ledger + observer; in tests it
   * injects a MockTransport. This is the only seam between MCP and upstream.
   */
  contextFor: (op: Operation) => ExecuteContext;
  /** Expose non-approved operations too (dev only). Default false (spec §17). */
  includeUnapproved?: boolean;
  /**
   * Precomputed resources to advertise (skill + CLI install manifest + catalog),
   * so agents can discover and materialize them adjacent to themselves. The
   * generators build these at compile time; pass an empty list (or omit) to
   * serve tools only.
   */
  resources?: ServedResource[];
  /**
   * Character budget for serialized results (default 50_000; 0 disables
   * truncation). Results exceeding this budget are truncated at the boundary
   * without splitting UTF-16 surrogate pairs, with a marker appended.
   */
  resultCharacterBudget?: number;
  /**
   * Optional callback for logging skipped workflows (ineligible or unapproved).
   * Called with workflow id and reason.
   */
  onSkipWorkflow?: (workflowId: string, reason: string) => void;
}

/**
 * Check if a binding value matches the required format: $.output.<fieldName>
 */
function isValidFieldMapping(binding: string): boolean {
  return /^\$\.output\.[A-Za-z0-9_]+$/.test(binding);
}

/**
 * Extract the field name from a binding value like $.output.fieldName
 */
function extractFieldName(binding: string): string {
  const match = binding.match(/^\$\.output\.([A-Za-z0-9_]+)$/);
  return match?.[1] ?? "";
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
function buildWorkflowInputShape(
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

/**
 * Build a compliant MCP server exposing approved AIR operations as tools. Tool
 * metadata makes risk visible to the model (spec §8): standard hints plus Anvil
 * effect/idempotency semantics in `_meta`. Resource serving is data-driven —
 * pass `options.resources`; this runtime never generates them.
 */
export function buildMcpServer(air: AirDocument, options: McpBuildOptions): McpServer {
  const server = new McpServer({
    name: `${air.service.id}-tools`,
    version: air.service.version,
  });

  const ops = air.operations.filter((op) => options.includeUnapproved || op.state === "approved");
  const opsById = new Map(ops.map((op) => [op.id, op]));

  for (const op of ops) {
    server.registerTool(
      op.mcp.toolName,
      {
        title: op.displayName,
        description: mcpToolDescription(op),
        // Operation input + the reserved safety controls (anvil_dry_run /
        // anvil_confirm / anvil_idempotency_key), so a client — the CLI over its
        // MCP transport, or any direct MCP caller — can dry-run and confirm.
        inputSchema: { ...operationZodShape(op), ...reservedSafetyShape(op) },
        // Shared with the Agent Registry toolspec (@anvil/air) — no drift.
        annotations: mcpToolAnnotations(op),
        _meta: {
          "anvil/effect": op.effect.kind,
          "anvil/action": op.effect.action,
          "anvil/risk": op.effect.risk,
          "anvil/retry_safe": op.retries.mode === "safe",
          "anvil/retry_basis": op.retries.basis,
          "anvil/idempotency": op.idempotency.mode,
          "anvil/principal": op.auth.principal,
          "anvil/operation_id": op.id,
        },
      },
      async (args: Record<string, unknown>) => {
        // Peel the reserved dry-run control off the arguments; the rest is the
        // operation input. `confirm` and `idempotency_key` are ordinary input
        // fields (synthesized by operationInputSchema) that the executor reads
        // straight out of `input`, so they need no special handling here — the
        // same safety contract holds whether an op is invoked directly, over the
        // CLI, or over the CLI routed through this server (local stdio / remote SSE).
        const dryRun = args[MCP_RESERVED.dryRun] === true;
        const input = { ...args };
        delete input[MCP_RESERVED.dryRun];
        const result = await execute(op, { input, dryRun }, options.contextFor(op));
        const charBudget = options.resultCharacterBudget ?? 50_000;
        if (result.outcome === "success") {
          const data = result.data ?? null;
          let text = JSON.stringify(data, null, 2);
          text = truncateResultText(text, op, charBudget);
          return {
            content: [{ type: "text" as const, text }],
            structuredContent: isRecord(data) ? data : { result: data },
          };
        }
        if (result.outcome === "dry_run") {
          let text = JSON.stringify(result.plan, null, 2);
          text = truncateResultText(text, op, charBudget);
          return {
            content: [{ type: "text" as const, text }],
          };
        }
        let text = JSON.stringify(result.envelope, null, 2);
        text = truncateResultText(text, op, charBudget);
        return {
          content: [{ type: "text" as const, text }],
          isError: true,
        };
      },
    );
  }

  // Register workflows as composite tools.
  for (const workflow of air.workflows) {
    // Check eligibility: workflow must be approved
    if (workflow.state !== "approved") {
      options.onSkipWorkflow?.(workflow.id, "workflow state is not approved");
      continue;
    }

    // Check eligibility: all steps must exist and be approved
    let skipReason: string | undefined;
    const stepOps: Operation[] = [];
    for (const step of workflow.steps) {
      const stepOp = opsById.get(step.operationId);
      if (!stepOp) {
        skipReason = `step '${step.operationId}' not found or not approved`;
        break;
      }
      stepOps.push(stepOp);
    }
    if (skipReason) {
      options.onSkipWorkflow?.(workflow.id, skipReason);
      continue;
    }

    // Check eligibility: all bindings must be valid field mappings
    for (const step of workflow.steps) {
      for (const [paramName, bindingValue] of Object.entries(step.bindings)) {
        if (!isValidFieldMapping(bindingValue)) {
          skipReason = `step '${step.operationId}' binding for '${paramName}' has invalid format: '${bindingValue}'`;
          break;
        }
      }
      if (skipReason) break;
    }
    if (skipReason) {
      options.onSkipWorkflow?.(workflow.id, skipReason);
      continue;
    }

    // Guard: stepOps should have at least one element (already checked in eligibility loop)
    if (stepOps.length === 0) {
      options.onSkipWorkflow?.(workflow.id, "workflow has no steps");
      continue;
    }

    // A non-first step that REQUIRES a client idempotency key is ineligible in
    // v1: forwarding the caller's one key to several mutations would make
    // distinct writes share a dedup identity, which is exactly the corruption
    // idempotency keys exist to prevent. (Step 1 receives the caller's input
    // whole, key included, so it stays eligible.)
    const keyedLaterStep = stepOps.find((op, i) => i > 0 && op.idempotency.mode === "required");
    if (keyedLaterStep) {
      options.onSkipWorkflow?.(
        workflow.id,
        `step '${keyedLaterStep.id}' requires a client idempotency key; the composite cannot mint distinct keys`,
      );
      continue;
    }

    // Determine if any step requires confirmation
    const requiresConfirmation = stepOps.some((op) => op.confirmation.required);

    // Get input schema from first step's operation. We know stepOps is non-empty.
    const firstStepOp = stepOps[0];
    if (!firstStepOp) {
      options.onSkipWorkflow?.(workflow.id, "workflow first step operation not found");
      continue;
    }
    const { shape: workflowInputShape, confirmKey: compositeConfirmKey } = buildWorkflowInputShape(
      firstStepOp,
      requiresConfirmation,
    );

    // Tool names follow the same convention as single operations (snake_case,
    // MCP-safe charset); the dotted workflow id stays in _meta.
    const workflowToolName = workflow.id.replace(/[^A-Za-z0-9_-]/g, "_");
    server.registerTool(
      workflowToolName,
      {
        title: workflow.displayName,
        description:
          workflow.description ||
          `Composite workflow: ${workflow.steps.map((s) => s.operationId).join(" → ")}`,
        inputSchema: workflowInputShape,
        _meta: {
          "anvil/workflow": true,
          "anvil/step_count": workflow.steps.length,
          "anvil/requires_confirmation": requiresConfirmation,
        },
      },
      async (args: Record<string, unknown>) => {
        const dryRun = args[MCP_RESERVED.dryRun] === true;
        const input = { ...args };
        delete input[MCP_RESERVED.dryRun];

        const stepResults: Array<{
          operationId: string;
          success: boolean;
          data?: unknown;
        }> = [];
        let currentInput = input;

        // Execute each step in sequence
        for (let i = 0; i < workflow.steps.length; i++) {
          const step = workflow.steps[i];
          const stepOp = stepOps[i];

          // Type guard: should be guaranteed by the eligibility checks
          if (!step || !stepOp) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ error: "Internal error: step or operation is missing" }),
                },
              ],
              isError: true,
            };
          }

          // Resolve bindings from previous step, and forward the caller's one
          // confirmation to each confirming step under that step's own safety
          // key — the runtime still enforces per step, the composite never
          // self-confirms on the caller's behalf.
          if (i > 0) {
            const prevStepData = stepResults[i - 1]?.data;
            for (const [paramName, bindingValue] of Object.entries(step.bindings)) {
              const fieldName = extractFieldName(bindingValue);
              const boundValue = getFieldFromResult(prevStepData, fieldName);
              currentInput[paramName] = boundValue;
            }
            if (stepOp.confirmation.required && compositeConfirmKey !== undefined) {
              const confirmValue = args[compositeConfirmKey];
              if (confirmValue !== undefined) {
                currentInput[operationSafetyInputKeys(stepOp).confirm] = confirmValue;
              }
            }
          }

          // Execute this step
          const result = await execute(
            stepOp,
            { input: currentInput, dryRun },
            options.contextFor(stepOp),
          );

          if (result.outcome === "success") {
            stepResults.push({
              operationId: step.operationId,
              success: true,
              data: result.data,
            });
            // For the next step, use the success data
            currentInput = {};
          } else if (result.outcome === "error") {
            // Step failed: return error with step trace
            stepResults.push({
              operationId: step.operationId,
              success: false,
            });
            const charBudget = options.resultCharacterBudget ?? 50_000;
            let text = JSON.stringify(
              {
                error: "workflow step failed",
                failedStep: step.operationId,
                stepIndex: i,
                priorStepOutputs: stepResults.slice(0, i).map((sr) => ({
                  operationId: sr.operationId,
                  success: sr.success,
                  data: sr.data,
                })),
                stepError: result.envelope,
              },
              null,
              2,
            );
            text = truncateResultText(text, stepOp, charBudget);
            return {
              content: [{ type: "text" as const, text }],
              isError: true,
            };
          } else if (result.outcome === "dry_run") {
            // For dry-run, return the plan
            const charBudget = options.resultCharacterBudget ?? 50_000;
            let text = JSON.stringify(
              {
                dryRun: true,
                workflow: workflow.id,
                stepIndex: i,
                step: step.operationId,
                plan: result.plan,
              },
              null,
              2,
            );
            text = truncateResultText(text, stepOp, charBudget);
            return {
              content: [{ type: "text" as const, text }],
            };
          }
        }

        // All steps succeeded: return final result with trace
        const lastStepResult = stepResults[stepResults.length - 1];
        if (!lastStepResult) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "Internal error: no step results" }),
              },
            ],
            isError: true,
          };
        }
        const lastStepOp = stepOps[stepOps.length - 1];
        if (!lastStepOp) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "Internal error: no step operations" }),
              },
            ],
            isError: true,
          };
        }
        const finalData = lastStepResult.data ?? null;
        const charBudget = options.resultCharacterBudget ?? 50_000;
        let text = JSON.stringify(finalData, null, 2);
        text = truncateResultText(text, lastStepOp, charBudget);

        // Append trace as structured content
        const trace = stepResults
          .map((sr) => `${sr.operationId}:${sr.success ? "ok" : "failed"}`)
          .join(", ");

        return {
          content: [{ type: "text" as const, text: `${text}\n\n[workflow trace: ${trace}]` }],
          structuredContent: isRecord(finalData)
            ? { result: finalData, trace }
            : { result: finalData, trace },
        };
      },
    );
  }

  // Advertise precomputed resources (skill + CLI install manifest + catalog) so
  // the deployed server is self-describing: an agent connects, reads SKILL.md
  // first, then materializes the CLI adjacent to itself.
  for (const resource of options.resources ?? []) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType,
        annotations: { audience: resource.audience, priority: resource.priority },
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: resource.mimeType, text: resource.text }],
      }),
    );
  }

  return server;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
