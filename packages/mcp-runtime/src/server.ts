import { randomUUID } from "node:crypto";
import {
  type AirDocument,
  DEFAULT_RESPONSE_BUDGET_TOKENS,
  estimateTokens,
  mcpToolAnnotations,
  mcpToolDescription,
  type Operation,
  operationInputSchema,
  operationSafetyInputKeys,
} from "@anvil/air";
import { type ExecuteContext, execute } from "@anvil/runtime";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { derivePageSize, detectSilentCap, silentCapNotice } from "./page-budget.js";
import {
  applyProjection,
  projectionShape,
  takeProjectionArg,
  validateProjection,
} from "./projection.js";
import { type ResultBudget, truncateResultText } from "./truncation.js";
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
   * Token budget for one served result (default `DEFAULT_RESPONSE_BUDGET_TOKENS`;
   * 0 disables both the truncation failsafe and budget-derived page sizing).
   *
   * This is the number the whole disclosure story is denominated in: it sizes
   * the page requested upstream (the control path) and bounds the payload that
   * reaches the agent if that page still came back too large (the failure path).
   * Tokens rather than characters because tokens are what the agent spends —
   * see `truncation.ts` for why the conversion is an estimate and says so.
   */
  resultTokenBudget?: number;
  /**
   * @deprecated Use `resultTokenBudget`. Raw UTF-16 character budget for
   * serialized results (0 disables truncation). Still honored verbatim — the cut
   * lands exactly where it always did — but a character budget cannot describe
   * what a response costs an agent, and it is converted to a token figure for
   * page sizing anyway. When both are set this one wins, since a caller still
   * speaking in characters has calibrated a boundary we should not move.
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
        // Plus the reserved view control (anvil_projection): the caller's only
        // way to lower what a response costs it, as opposed to discovering after
        // the fact that it cost too much.
        inputSchema: { ...operationZodShape(op), ...reservedSafetyShape(op), ...projectionShape() },
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
        // Peel the view control too. Reserved controls never travel upstream.
        const projection = takeProjectionArg(input);
        const { budget, tokens: budgetTokens } = resolveResultBudget(options, op);

        // Parse-check the projection BEFORE the upstream call. A malformed
        // expression is the caller's mistake, and there is no reason to make an
        // upstream request — possibly a rate-limited or metered one — only to
        // discard its result. The trace id is minted here so the refusal carries
        // the same envelope shape as any executor failure.
        if (projection !== undefined) {
          const invalid = validateProjectionArg(projection, op);
          if (invalid) return invalid;
        }

        // Ask upstream for a page that fits, rather than cutting one that does
        // not. Injects nothing unless the contract names the size knob and the
        // operation was measured — see page-budget.ts for each refusal.
        const page = derivePageSize(op, input, budgetTokens);
        if (page) input[page.key] = page.size;

        const result = await execute(op, { input, dryRun }, options.contextFor(op));
        if (result.outcome === "success") {
          const raw = result.data ?? null;

          // ORDERING IS LOAD-BEARING: the projection is applied here, before the
          // payload is serialized and measured against the budget. Applying it
          // after truncation would be pointless — the tokens would already have
          // been counted, and the caller would pay full context cost for a
          // narrowed view. Failure returns a validation_error and never the
          // unprojected payload.
          let data = raw;
          if (projection !== undefined) {
            const projected = applyProjection(raw, projection, op, `trace_${randomUUID()}`);
            if (!projected.ok) return errorResult(projected.envelope, op, budget);
            data = projected.data ?? null;
          }

          let text = JSON.stringify(data, null, 2);
          text = truncateResultText(text, op, budget);

          // Measured on the raw response: a projection can drop the very fields
          // (items, continuation marker) the cap check reads, and the cap is a
          // fact about the upstream page, not about the caller's view of it.
          // Appended after truncation so the warning cannot itself be cut off.
          const cap = detectSilentCap(op, raw);
          if (cap) text = `${text}\n\n${silentCapNotice(cap)}`;

          return {
            content: [{ type: "text" as const, text }],
            structuredContent: isRecord(data) ? data : { result: data },
          };
        }
        if (result.outcome === "dry_run") {
          // The plan is a preview of the wire request, not response data, so a
          // response projection has nothing to say about it. It does show the
          // injected page size, which is the point: a caller can see what the
          // budget decided before spending anything.
          let text = JSON.stringify(result.plan, null, 2);
          text = truncateResultText(text, op, budget);
          return {
            content: [{ type: "text" as const, text }],
          };
        }
        return errorResult(result.envelope, op, budget);
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
        const projection = takeProjectionArg(input);
        // Checked before step 1 runs: a composite may mutate, and refusing a
        // malformed expression after the writes have landed would be a much
        // worse deal than refusing it before any of them do. Attributed to the
        // last step, whose response is the one the expression will address.
        const projectionOp = stepOps[stepOps.length - 1] ?? firstStepOp;
        if (projection !== undefined) {
          const invalid = validateProjectionArg(projection, projectionOp);
          if (invalid) return invalid;
        }

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
            const { budget } = resolveResultBudget(options, stepOp);
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
            text = truncateResultText(text, stepOp, budget);
            return {
              content: [{ type: "text" as const, text }],
              isError: true,
            };
          } else if (result.outcome === "dry_run") {
            // For dry-run, return the plan
            const { budget } = resolveResultBudget(options, stepOp);
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
            text = truncateResultText(text, stepOp, budget);
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
        const rawFinal = lastStepResult.data ?? null;
        const { budget } = resolveResultBudget(options, lastStepOp);

        // Same ordering rule as a single operation: project before measuring.
        let finalData = rawFinal;
        if (projection !== undefined) {
          const projected = applyProjection(
            rawFinal,
            projection,
            lastStepOp,
            `trace_${randomUUID()}`,
          );
          if (!projected.ok) return errorResult(projected.envelope, lastStepOp, budget);
          finalData = projected.data ?? null;
        }

        let text = JSON.stringify(finalData, null, 2);
        text = truncateResultText(text, lastStepOp, budget);

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

/** The one shape every failure takes on the way out: normalized envelope, truncated, flagged. */
function errorResult(
  envelope: unknown,
  op: Operation,
  budget: ResultBudget,
): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const text = truncateResultText(JSON.stringify(envelope, null, 2), op, budget);
  return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * Refuse a malformed projection before anything is executed. Returns the
 * ready-to-serve error result, or undefined when the expression is usable.
 */
function validateProjectionArg(
  expression: string,
  op: Operation,
): { content: Array<{ type: "text"; text: string }>; isError: true } | undefined {
  const invalid = validateProjection(expression, op, `trace_${randomUUID()}`);
  if (!invalid) return undefined;
  // No budget conversion needed: a validation envelope is a few hundred
  // characters by construction, and truncating an error message that explains
  // how to fix the request would be self-defeating.
  return {
    content: [{ type: "text" as const, text: JSON.stringify(invalid.envelope, null, 2) }],
    isError: true,
  };
}

/**
 * Collapse the two budget options onto the pair the serving path needs: the
 * budget the truncator cuts against, and the token figure the page solver uses.
 *
 * The legacy character budget still wins when set — a caller who calibrated a
 * character boundary should keep exactly that boundary — but it is converted to
 * tokens for page sizing, because `safePageSize` reasons in tokens and there is
 * no honest way to express a character budget to it otherwise. When truncation
 * is disabled (0), page sizing is disabled with it: a caller who declared no
 * budget should not then find one applied to the page it fetches.
 */
function resolveResultBudget(
  options: McpBuildOptions,
  op: Operation,
): { budget: ResultBudget; tokens: number } {
  if (options.resultCharacterBudget !== undefined) {
    const chars = options.resultCharacterBudget;
    return {
      budget: { chars },
      tokens: chars === 0 ? 0 : estimateTokens(chars, op.disclosureCost?.charsPerToken),
    };
  }
  const tokens = options.resultTokenBudget ?? DEFAULT_RESPONSE_BUDGET_TOKENS;
  return { budget: { tokens }, tokens };
}
