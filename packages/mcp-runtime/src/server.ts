import { randomUUID } from "node:crypto";
import {
  type AirDocument,
  type AsyncContract,
  type AsyncContractResolution,
  asyncContractSentence,
  DEFAULT_RESPONSE_BUDGET_TOKENS,
  estimateTokens,
  mcpToolAnnotations,
  mcpToolDescription,
  type Operation,
  operationInputSchema,
  operationSafetyInputKeys,
  resolveAsyncContract,
} from "@anvil/air";
import {
  type ExecuteContext,
  execute,
  handleJobAnswer,
  type JobAnswerDecision,
} from "@anvil/runtime";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ledgerWithJobIndexing, peekWebhookStatus } from "./async-completion.js";
import {
  createLaneSurface,
  type DisclosableTool,
  type DisclosureMode,
  decideLadder,
} from "./lane.js";
import { derivePageSize, detectSilentCap, silentCapNotice } from "./page-budget.js";
import {
  applyProjection,
  projectionShape,
  takeProjectionArg,
  validateProjection,
} from "./projection.js";
import { type ResultBudget, truncateResultText } from "./truncation.js";
import { extractFieldName, planWorkflowSurface } from "./workflow-surface.js";
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
  /**
   * Optional callback for logging an operation removed from `tools/list` because
   * an approved, registrable workflow supersedes it. The counterpart to
   * `onSkipWorkflow`: a surface that shrank silently is indistinguishable from
   * one that lost a tool by accident.
   */
  onSupersedeOperation?: (operationId: string, workflowId: string) => void;
  /**
   * Optional callback for a supersession this runtime declined to apply, with
   * why. A refusal is a decision, and an operator who authored `supersedes` and
   * still sees the tool needs to be told which rule kept it.
   */
  onRefuseSupersede?: (operationId: string, workflowId: string, reason: string) => void;
  /**
   * How the tool surface is disclosed at rest: `auto` (default) follows the
   * ladder projection, `flat` never ladders, `laddered` ladders whenever lanes
   * can be projected. See `lane.ts` — the ladder decides *when* an approved
   * operation's schema is listed and never whether it may be called.
   */
  disclosure?: DisclosureMode;
  /**
   * Budget for the at-rest surface — everything in `tools/list` before an agent
   * has opened a lane. Only consulted when laddering is in play; the default
   * lives in `@anvil/air` so the served surface and the certified one are
   * measured against the same number.
   */
  surfaceBudgetTokens?: number;
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

  // webhook_receiver operations are compiled and validated like any other
  // operation, but are never a directly-callable tool — receiver-only, per
  // InteractionArchetype's own doc (packages/air/src/enums.ts). They are
  // wired only through AsyncContract.webhook and the generated receiver
  // route (packages/generators/src/entrypoints.ts), never through tools/list.
  const ops = air.operations.filter(
    (op) =>
      (options.includeUnapproved || op.state === "approved") && op.archetype !== "webhook_receiver",
  );
  const opsById = new Map(ops.map((op) => [op.id, op]));
  // The SDK hands back a live handle per tool. Held so the disclosure ladder can
  // close a laned tool *after* it is fully registered — see the ladder block
  // below for why disclosure is a state on a registered tool rather than a
  // decision about whether to register one.
  const opTools = new Map<string, DisclosableTool>();
  const registeredToolNames = new Set<string>();

  // Async contracts resolve against the WHOLE document, never against `ops`.
  // `ops` is the served subset, and `resolveAsyncContract` reports
  // `status_operation_not_approved` — a decision somebody made — separately from
  // `status_operation_missing` — a coordinate that was never real. Handing it a
  // pre-filtered map would relabel the first as the second, and would also make
  // the answer depend on `includeUnapproved`: a dev-mode server would advertise
  // polling instructions that vanish in production. The contract's approval rule
  // is the contract's own, so this map makes the served sentence identical to the
  // one `@anvil/certification` certified from the same function.
  const allOpsById = new Map(air.operations.map((operation) => [operation.id, operation]));

  // ORDERING IS LOAD-BEARING: the workflow surface is planned HERE, before the
  // first tool registers, because a suppression may only be read off a workflow
  // that has already been found registrable. Deciding eligibility later — inside
  // the registration loop, where it used to live — would mean an unapproved or
  // malformed workflow had already removed its members from this loop's input,
  // deleting tools and putting no composite in their place. The plan is pure and
  // is reported below in the same pass that registers the workflows, so the
  // `onSkipWorkflow` call order an observer sees is unchanged.
  const workflowSurface = planWorkflowSurface(air.workflows, opsById, allOpsById);
  for (const [operationId, workflowId] of workflowSurface.superseded) {
    options.onSupersedeOperation?.(operationId, workflowId);
  }
  for (const { operationId, workflowId, reason } of workflowSurface.refused) {
    options.onRefuseSupersede?.(operationId, workflowId, reason);
  }
  // The served surface: approved operations minus the ones an approved workflow
  // now performs on their behalf. `opsById` deliberately keeps them — the
  // workflow's own steps still have to resolve, and the ladder still reads the
  // grouping from the document, not from what happened to register.
  const servedOps = ops.filter((op) => !workflowSurface.superseded.has(op.id));

  // Precomputed in one pass over `ops`, before any tool registers, for three
  // reasons registration itself needs:
  //  - `hybridStatusOperationContracts`: statusOperation.id -> the submitting
  //    operation's own resolved AsyncContract. When `op` (below) IS a status
  //    operation some other operation names, its handler checks the ledger
  //    first (design doc §6/§14) before falling back to the upstream call it
  //    already makes today — the "hybrid" half of this phase's task.
  //  - `syntheticStatusTargets`: submitting operations that resolved a
  //    webhook contract with NO statusOperationId at all (webhook-only) — for
  //    these there is no existing tool to wrap; a brand-new, sourceRef-less
  //    "synthetic" tool is registered for each, after the main loop.
  //  - `hasAwaitingHumanInput`: whether ANY resolved contract in this served
  //    surface names `awaiting_human_input` as a pending state — the gate for
  //    generating any job-answer tool at all (design doc §8).
  const hybridStatusOperationContracts = new Map<string, AsyncContract>();
  const syntheticStatusTargets: Array<{
    op: Operation;
    contract: AsyncContract;
    sentence: string | undefined;
  }> = [];
  let hasAwaitingHumanInput = false;
  for (const op of servedOps) {
    const resolution = resolveAsyncContract(op, allOpsById);
    if (!resolution.ok) continue;
    if (resolution.contract.pendingStates.includes("awaiting_human_input")) {
      hasAwaitingHumanInput = true;
    }
    if (resolution.statusOperation) {
      hybridStatusOperationContracts.set(resolution.statusOperation.id, resolution.contract);
    } else if (resolution.contract.webhook) {
      syntheticStatusTargets.push({
        op,
        contract: resolution.contract,
        sentence: asyncContractSentence(resolution),
      });
    }
  }

  for (const op of servedOps) {
    // Resolved once, outside the handler: it is a pure function of the document,
    // and the tool surface is what carries it. An agent that has to call the
    // operation to find out how to finish it has already spent the round trip
    // this is meant to save.
    const asyncContract = resolveAsyncContract(op, allOpsById);
    const asyncSentence = asyncContractSentence(asyncContract);
    const registered = server.registerTool(
      op.mcp.toolName,
      {
        title: op.displayName,
        // Appended to the compiled description rather than left in `_meta`
        // alone. `_meta` is where a *client* reads Anvil's posture; the
        // description is the only part of a tool a model is guaranteed to see,
        // and "how do I finish this job" is a question the model asks, not the
        // client. Both are emitted, from one resolution, so they cannot disagree.
        //
        // When the contract does not resolve there is no sentence and nothing is
        // appended — deliberately leaving `mcpToolDescription`'s bare
        // "poll for status" line as the only thing said. That line is already
        // vague, but it is honest about being vague; dressing an unusable
        // contract up in the mechanical register of a usable one would make a
        // broken linkage indistinguishable from a working one at the exact
        // moment the difference is a silent poll loop.
        description: asyncSentence
          ? `${mcpToolDescription(op)} ${asyncSentence}`
          : mcpToolDescription(op),
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
          ...asyncContractMeta(asyncContract),
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

        const execContext = options.contextFor(op);
        // Any operation with a resolved AsyncContract indexes its job handle
        // on completion — the write side of the job-handle index
        // (packages/runtime/src/idempotency.ts's `secondaryKey`) that nothing
        // in `execute()` itself performs yet (see async-completion.ts's doc
        // comment on `ledgerWithJobIndexing` for why this wraps the ledger
        // here rather than in `@anvil/runtime`). Skipped when there is no
        // ledger to index into at all.
        const callContext =
          asyncContract.ok && execContext.ledger
            ? {
                ...execContext,
                ledger: ledgerWithJobIndexing(
                  execContext.ledger,
                  asyncContract.contract.jobIdField,
                ),
              }
            : execContext;

        // Hybrid status handler (design doc §6/§14): `op` here IS a status
        // operation some OTHER operation's AsyncContract names. Before making
        // the upstream call this tool has always made, check whether a
        // webhook already answered the job the caller is asking about. Found
        // -> return the cached completion immediately, no upstream call at
        // all. Not found (or no ledger, or a dry run) -> fall through to the
        // unchanged call below, exactly as before this phase.
        const hybridContract = hybridStatusOperationContracts.get(op.id);
        if (hybridContract && !dryRun && execContext.ledger?.findBySecondaryKey) {
          const jobId = input[hybridContract.statusJobIdParam as string];
          if (typeof jobId === "string" && jobId.length > 0) {
            const idempotencyKey = await execContext.ledger.findBySecondaryKey(jobId);
            if (idempotencyKey !== undefined) {
              const peek = await peekWebhookStatus(execContext.ledger, idempotencyKey);
              if (peek.found) {
                let text = JSON.stringify(peek.result, null, 2);
                text = truncateResultText(text, op, budget);
                return {
                  content: [{ type: "text" as const, text }],
                  structuredContent: isRecord(peek.result) ? peek.result : { result: peek.result },
                };
              }
            }
          }
        }

        const result = await execute(op, { input, dryRun }, callContext);
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
    opTools.set(op.id, registered);
    registeredToolNames.add(op.mcp.toolName);
  }

  // A name derived from a real operation's own tool name, disambiguated
  // against whatever is already registered — used by both the synthetic
  // status tools and the job-answer tools below, neither of which has a
  // `sourceRef` of its own to derive a canonical name from.
  const uniqueToolName = (base: string): string => {
    let candidate = base;
    let suffix = 2;
    while (registeredToolNames.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    return candidate;
  };

  // Synthetic status tools (design doc §9/§14): a webhook-only AsyncContract
  // has no statusOperationId, so there is no existing tool from the main loop
  // above to wrap — a genuinely new, sourceRef-less tool is registered
  // instead. Its only two outcomes are "pending" and the cached webhook
  // result; there is deliberately no branch here that calls an upstream
  // status operation at all, because none exists to call — by construction,
  // not by an `if` that happens to never fire.
  for (const { op: submitOp, contract, sentence } of syntheticStatusTargets) {
    const toolName = uniqueToolName(`${submitOp.mcp.toolName}_status`);
    registeredToolNames.add(toolName);
    server.registerTool(
      toolName,
      {
        title: `${submitOp.displayName} — status`,
        description:
          `Check the cached completion for a job submitted by '${submitOp.mcp.toolName}'. ` +
          (sentence ??
            "No poll operation exists for this call; the upstream completes it by calling back."),
        inputSchema: {
          job_id: z.string().describe(`The job handle read from '${contract.jobIdField}'.`),
        },
        annotations: {
          title: `${submitOp.displayName} — status`,
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: {
          "anvil/synthetic_status_tool": true,
          "anvil/async_submit_operation": submitOp.id,
          "anvil/async_terminal_states": contract.terminalStates,
          ...(contract.pendingStates.length > 0
            ? { "anvil/async_pending_states": contract.pendingStates }
            : {}),
        },
      },
      async (args: Record<string, unknown>) => {
        const jobId = args.job_id;
        const pending = () => ({
          content: [
            { type: "text" as const, text: JSON.stringify({ status: "pending", jobId }, null, 2) },
          ],
          structuredContent: { status: "pending" as const, jobId: jobId ?? null },
        });
        if (typeof jobId !== "string" || jobId.length === 0) return pending();
        const execContext = options.contextFor(submitOp);
        if (!execContext.ledger?.findBySecondaryKey) return pending();
        const idempotencyKey = await execContext.ledger.findBySecondaryKey(jobId);
        if (idempotencyKey === undefined) return pending();
        const peek = await peekWebhookStatus(execContext.ledger, idempotencyKey);
        if (!peek.found) return pending();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(peek.result, null, 2) }],
          structuredContent: isRecord(peek.result) ? peek.result : { result: peek.result },
        };
      },
    );
  }

  // Job-answer tools (design doc §8): generated only when SOME resolved
  // contract in this served surface names `awaiting_human_input` — otherwise
  // the mechanism is not in play for this service at all, and there is
  // nothing to gate a tool on. AIR does not model a dedicated
  // "decision operation" link (only AsyncContract, for the poll/webhook
  // side — see packages/runtime/src/job-answer.ts's own doc comment), so the
  // candidate decision operations are every approved mutation the spec itself
  // already marks `confirmation.humanApproval: true` — the one AIR-native
  // signal for "a human must sign off on this before it is submitted",
  // reused here for "a human's decision IS this call" (design doc §5: this is
  // exactly what gives that field "a real, and cheap, channel"). Each such
  // operation gets its own tool, bound unambiguously to it — never a single
  // generic tool that would need the caller to name the operation itself.
  if (hasAwaitingHumanInput) {
    for (const decisionOp of servedOps) {
      if (decisionOp.effect.kind !== "mutation" || decisionOp.confirmation.humanApproval !== true) {
        continue;
      }
      const toolName = uniqueToolName(`job_answer_${decisionOp.mcp.toolName}`);
      registeredToolNames.add(toolName);
      server.registerTool(
        toolName,
        {
          title: `Answer: ${decisionOp.displayName}`,
          description:
            `Submit a human decision for a job awaiting approval, by calling '${decisionOp.mcp.toolName}' ` +
            `('${decisionOp.cli.command}') as the real upstream decision operation — this does not resume ` +
            "anything paused; it places the same call that operation's own tool would. Supply 'job_id', " +
            "'decision' (approve|reject), an optional 'note', and any of the operation's own parameters " +
            "that decision needs.",
          // The operation's own real params, so the caller can supply
          // whatever field(s) the real decision call needs beyond the job
          // id/decision/note this tool adds — same shape a direct call to
          // `decisionOp`'s own tool would expose. Reserved names win on
          // collision, exactly like anvil_dry_run/anvil_confirm elsewhere.
          inputSchema: {
            ...operationZodShape(decisionOp),
            job_id: z.string().describe("The job handle this decision answers."),
            decision: z.enum(["approve", "reject"]).describe("The human's decision."),
            note: z.string().optional().describe("Optional free-text rationale."),
          },
          annotations: mcpToolAnnotations(decisionOp),
          _meta: {
            "anvil/job_answer_operation": decisionOp.id,
            "anvil/effect": decisionOp.effect.kind,
            "anvil/risk": decisionOp.effect.risk,
          },
        },
        async (args: Record<string, unknown>) => {
          const { job_id: jobId, decision, note, ...rest } = args;
          const execContext = options.contextFor(decisionOp);
          const { budget } = resolveResultBudget(options, decisionOp);
          const outcome = await handleJobAnswer({
            operation: decisionOp,
            caller: execContext.inbound,
            decision: decision as JobAnswerDecision,
            note: typeof note === "string" ? note : undefined,
            jobId: typeof jobId === "string" ? jobId : "",
            buildOperationInput: () => rest,
            executeContext: execContext,
          });
          if (outcome.outcome === "invalid_decision" || outcome.outcome === "unauthorized") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ error: outcome.outcome, reason: outcome.reason }, null, 2),
                },
              ],
              isError: true,
            };
          }
          const result = outcome.result;
          if (result.outcome === "success") {
            let text = JSON.stringify(result.data ?? null, null, 2);
            text = truncateResultText(text, decisionOp, budget);
            return {
              content: [{ type: "text" as const, text }],
              structuredContent: isRecord(result.data)
                ? result.data
                : { result: result.data ?? null },
            };
          }
          if (result.outcome === "dry_run") {
            let text = JSON.stringify(result.plan, null, 2);
            text = truncateResultText(text, decisionOp, budget);
            return { content: [{ type: "text" as const, text }] };
          }
          return errorResult(result.envelope, decisionOp, budget);
        },
      );
    }
  }

  // Register workflows as composite tools. Eligibility was decided by
  // `planWorkflowSurface` above — reported here, in document order, so the
  // sequence of `onSkipWorkflow` calls is exactly what it always was.
  for (const registration of workflowSurface.registrations) {
    const { workflow } = registration;
    if (registration.skipReason !== undefined) {
      options.onSkipWorkflow?.(workflow.id, registration.skipReason);
      continue;
    }
    const { stepOps, firstStepOp } = registration;
    // The operation tools this composite replaced, resolved once for its _meta.
    const replacedOperationIds = supersededByThisWorkflow(workflowSurface, workflow.id);

    // Determine if any step requires confirmation
    const requiresConfirmation = stepOps.some((op) => op.confirmation.required);

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
          // What this composite REPLACED on the surface, so a client can see
          // that a tool it remembers was subsumed rather than withdrawn.
          ...(replacedOperationIds.length > 0 ? { "anvil/supersedes": replacedOperationIds } : {}),
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
    registeredToolNames.add(workflowToolName);
  }

  // The disclosure ladder, applied strictly on top of a fully registered
  // surface. Everything above ran exactly as it always has, which is the whole
  // compatibility argument: a flat plan — an unmeasured bundle, a service that
  // fits its budget, an operator who set `disclosure: "flat"` — reaches this
  // point with an untouched server and leaves with one. Laddering only closes
  // tools that are already registered, so nothing it does can change which
  // operations exist, what they accept, or what the runtime enforces on a call.
  const ladder = decideLadder(air, options);
  if (ladder.laddered) {
    const surface = createLaneSurface({
      lanes: ladder.lanes,
      operations: opsById,
      tools: opTools,
      reservedToolNames: registeredToolNames,
    });
    for (const card of surface.cards) {
      server.registerTool(
        card.toolName,
        {
          title: card.title,
          description: card.description,
          // Opening a lane is navigation, not business: it makes no upstream
          // call, changes nothing an agent could regret, and converges on the
          // same surface however many times it runs. Saying so in the standard
          // hints keeps a cautious client from treating routing as risk.
          annotations: {
            title: card.title,
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          _meta: card.meta,
        },
        async () => card.open(),
      );
    }
    // Closing happens after the cards are registered and before the server is
    // connected, so no client ever observes the flat surface it briefly was —
    // and the SDK's `tools/list_changed` notification, which it fires on every
    // enable/disable, is suppressed while disconnected.
    surface.closeLanes();
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

/** The operation ids one workflow actually removed from this server's surface. */
function supersededByThisWorkflow(
  plan: { superseded: ReadonlyMap<string, string> },
  workflowId: string,
): string[] {
  return [...plan.superseded]
    .filter(([, owner]) => owner === workflowId)
    .map(([operationId]) => operationId);
}

/**
 * The machine-readable half of a resolved async contract, in the same `anvil/*`
 * register as the effect/risk/idempotency posture beside it: flat keys, one fact
 * each, values a client can branch on without parsing prose. A client that wants
 * to drive the poll loop itself gets coordinates; the model gets the sentence in
 * the description. Same resolution behind both.
 *
 * An unresolved contract returns `{}` — not a partial block, not a marker saying
 * a contract was attempted. Emitting `anvil/async_status_tool` alone would name
 * a tool with no way to reach it and no way to stop; emitting a "broken" flag
 * would invite a client to route around it. The failure mode this whole shape
 * exists to prevent is an agent acting on half a contract, and the only value
 * that cannot be acted on halfway is nothing at all.
 */
function asyncContractMeta(resolution: AsyncContractResolution): Record<string, unknown> {
  if (!resolution.ok) return {};
  const { contract, statusOperation } = resolution;
  // Webhook-only completions resolve with no `statusOperation` at all — this
  // block is the poll-shaped coordinates a client would drive itself; the
  // webhook-only equivalent lands with the rest of the webhook wiring rather
  // than half-publishing poll keys that name nothing.
  if (!statusOperation) return {};
  return {
    // The tool NAME, not the operation id: this is the string a client passes to
    // `tools/call`. The id is already carried by the status tool's own
    // `anvil/operation_id`, so nothing is lost and nothing must be translated.
    "anvil/async_status_tool": statusOperation.mcp.toolName,
    "anvil/async_job_id_field": contract.jobIdField,
    "anvil/async_status_job_id_param": contract.statusJobIdParam,
    "anvil/async_terminal_states": contract.terminalStates,
    ...(contract.stateField ? { "anvil/async_state_field": contract.stateField } : {}),
    ...(contract.pendingStates.length > 0
      ? { "anvil/async_pending_states": contract.pendingStates }
      : {}),
    // Only ever present when the service stated it. An absent key means "the
    // service did not say", which a client can back off on however it likes; a
    // defaulted number here would be Anvil inventing a rate limit or a stampede
    // and attributing it to the upstream.
    ...(contract.pollIntervalSeconds !== undefined
      ? { "anvil/async_poll_interval_seconds": contract.pollIntervalSeconds }
      : {}),
  };
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
