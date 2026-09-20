/**
 * Confirmation over MCP elicitation.
 *
 * A confirmation-required operation called without `confirm` is refused by the
 * executor with `confirmation_required`; that refusal is the safety contract
 * and nothing here changes it. What this module adds is one more chance to
 * satisfy it before the executor runs: when the connected client advertised
 * the `elicitation` capability, the server asks the human — a one-field form —
 * and only an explicit accept with `confirm: true` sets the safety key. Any
 * other answer (declined, cancelled, malformed, a client that errored on the
 * request) leaves the input exactly as it arrived, and the executor refuses
 * exactly as it always has.
 *
 * Asymmetric trust, checkable here: elicitation can only ADD a confirmation
 * step. It never removes one — a client that cannot elicit sees behaviour
 * byte-identical to a server without this module — and for an operation the
 * spec marks `humanApproval`, it is asked even when the model already passed
 * `confirm: true`, because that field's whole meaning is that a model's word is
 * not enough. A human who then declines revokes the model's confirmation, so
 * the refusal that follows is the one the spec asked for.
 *
 * The decision is recorded on the `ExecutionRecord` through the policy-hook
 * seam (`policyDecisions`), which is where every other "who decided this call
 * may proceed" fact already lives.
 */
import { type Operation, operationSafetyInputKeys, type Workflow } from "@anvil/air";
import type { ExecuteContext, PolicyContext } from "@anvil/runtime";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

export type ToolCallExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** A registered tool whose published input schema requires a confirm key. */
export interface ConfirmingTool {
  tool: Pick<RegisteredTool, "update">;
  shape: z.ZodRawShape;
  confirmKey: string;
}

/**
 * The published input schema of a confirming tool requires `confirm: true`
 * (`operationInputSchema`), so the SDK refuses a call without it before any
 * handler runs — which is the right contract for a client that cannot be
 * asked, and exactly what it sees today. A client that CAN be asked has
 * another way to satisfy the key: once such a client has initialized, the
 * confirm key becomes optional on the listed schema, and the handler asks.
 * Runs on `initialized`, the first moment the client's capabilities are known;
 * a client without elicitation leaves every schema exactly as registered.
 */
export function relaxConfirmationForElicitingClients(
  server: McpServer,
  tools: readonly ConfirmingTool[],
): void {
  if (tools.length === 0) return;
  const previous = server.server.oninitialized;
  server.server.oninitialized = () => {
    previous?.();
    if (!clientCanElicit(server)) return;
    for (const { tool, shape, confirmKey } of tools) {
      // `ZodRawShape`'s values are typed as the internal `$ZodType`, which
      // does not carry the builder methods; every value a shape is actually
      // built from is a `ZodType`, which does.
      const confirm = shape[confirmKey] as z.ZodType | undefined;
      if (confirm) tool.update({ paramsSchema: { ...shape, [confirmKey]: confirm.optional() } });
    }
  };
}

/** How an elicited confirmation ended, as recorded in `policyDecisions`. */
export type ElicitationDecision =
  | "elicitation:accepted"
  | "elicitation:declined"
  | "elicitation:cancelled"
  | "elicitation:failed";

export interface ElicitedConfirmation {
  /** The input to execute with: the safety key set only on an explicit accept. */
  input: Record<string, unknown>;
  /** Present when the client was asked; absent when nothing was asked. */
  decision?: ElicitationDecision;
}

/** Whether the connected client can answer a form elicitation at all. */
function clientCanElicit(server: McpServer): boolean {
  const elicitation = server.server.getClientCapabilities()?.elicitation;
  if (!elicitation || typeof elicitation !== "object") return false;
  // An empty capability object is the pre-`form`/`url` spelling of form support.
  return "form" in elicitation || Object.keys(elicitation).length === 0;
}

/**
 * Ask for confirmation of ONE operation when its contract needs more than the
 * caller supplied. Returns the input unchanged, and no decision, when nothing
 * needs asking or the client cannot be asked.
 */
export async function elicitOperationConfirmation(params: {
  server: McpServer;
  op: Operation;
  input: Record<string, unknown>;
  extra: ToolCallExtra;
}): Promise<ElicitedConfirmation> {
  const { server, op, input, extra } = params;
  const confirmKey = operationSafetyInputKeys(op).confirm;
  if (!needsElicitation(op.confirmation, input[confirmKey] === true)) return { input };
  if (!clientCanElicit(server)) return { input };
  const mutation = `${op.effect.reversible ? "" : "irreversible "}${op.effect.risk} mutation`;
  const why = op.confirmation.reason ?? `This is an ${mutation}.`;
  const decision = await ask(server, extra, {
    subject: `'${op.displayName}' (${op.mcp.toolName})`,
    why,
    humanApproval: op.confirmation.humanApproval === true,
  });
  return { input: applyDecision(input, confirmKey, decision), decision };
}

/**
 * Ask ONCE for a composite: the confirming steps are named together, and the
 * one composite confirm key is what the handler forwards to each of them.
 */
export async function elicitWorkflowConfirmation(params: {
  server: McpServer;
  workflow: Workflow;
  stepOps: Operation[];
  args: Record<string, unknown>;
  confirmKey: string | undefined;
  extra: ToolCallExtra;
}): Promise<ElicitedConfirmation> {
  const { server, workflow, stepOps, args, confirmKey, extra } = params;
  const confirming = stepOps.filter((op) => op.confirmation.required);
  if (confirmKey === undefined || confirming.length === 0) return { input: args };
  const humanApproval =
    workflow.humanApproval || confirming.some((op) => op.confirmation.humanApproval === true);
  if (!needsElicitation({ required: true, humanApproval }, args[confirmKey] === true)) {
    return { input: args };
  }
  if (!clientCanElicit(server)) return { input: args };
  const decision = await ask(server, extra, {
    subject: `workflow '${workflow.displayName}' (${workflow.id})`,
    why: `It performs ${confirming.map((op) => `'${op.displayName}'`).join(", ")}, which require confirmation.`,
    humanApproval,
  });
  return { input: applyDecision(args, confirmKey, decision), decision };
}

/**
 * Carry the decision onto the ExecutionRecord of every execution made under
 * this context, through the policy-hook seam. `preValidate` runs before the
 * confirmation gate, so a declined elicitation is recorded on the very
 * refusal it led to.
 */
export function recordingElicitation(
  context: ExecuteContext,
  decision: ElicitationDecision | undefined,
): ExecuteContext {
  if (!decision) return context;
  const inner = context.policy?.preValidate;
  return {
    ...context,
    policy: {
      ...context.policy,
      preValidate: async (pctx: PolicyContext) => {
        pctx.decide(decision);
        if (inner) await inner(pctx);
      },
    },
  };
}

function needsElicitation(
  confirmation: { required: boolean; humanApproval?: boolean },
  confirmed: boolean,
): boolean {
  if (!confirmation.required) return false;
  return !confirmed || confirmation.humanApproval === true;
}

function applyDecision(
  input: Record<string, unknown>,
  confirmKey: string,
  decision: ElicitationDecision,
): Record<string, unknown> {
  const next = { ...input };
  if (decision === "elicitation:accepted") next[confirmKey] = true;
  // Anything short of an explicit accept revokes whatever the model passed:
  // the human was asked because the model's word was not enough.
  else delete next[confirmKey];
  return next;
}

async function ask(
  server: McpServer,
  extra: ToolCallExtra,
  prompt: { subject: string; why: string; humanApproval: boolean },
): Promise<ElicitationDecision> {
  const message =
    `Confirm ${prompt.subject}? ${prompt.why}` +
    (prompt.humanApproval
      ? " This action requires a human's sign-off; a model's confirmation is not sufficient."
      : "");
  try {
    const result = await server.server.elicitInput(
      {
        mode: "form",
        message,
        requestedSchema: {
          type: "object",
          properties: {
            confirm: {
              type: "boolean",
              title: "Confirm",
              description: "Proceed with this action.",
            },
          },
          required: ["confirm"],
        },
      },
      { signal: extra.signal },
    );
    if (result.action === "cancel") return "elicitation:cancelled";
    if (result.action === "accept" && result.content?.confirm === true) {
      return "elicitation:accepted";
    }
    return "elicitation:declined";
  } catch {
    return "elicitation:failed";
  }
}
