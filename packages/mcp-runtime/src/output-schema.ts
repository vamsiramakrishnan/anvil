/**
 * The served side of the published output schema (`@anvil/air`'s
 * `publishedOutputSchema` decides WHAT is declared; this module declares it to
 * the SDK and shapes every successful result to conform).
 *
 * The SDK validates `structuredContent` against a tool's `outputSchema` on both
 * ends of the wire and turns a mismatch into a tool error, so once a schema is
 * declared, every non-error result this server returns has to satisfy it. The
 * builders here are the only way a handler produces a successful result, which
 * is what keeps that true: a dry-run plan and a caller's projection travel under
 * their reserved keys, and a response the upstream returned off-contract is
 * served under `anvil_unvalidated` with the text saying where it differed —
 * never refused, because an agent that can read the data is better off than one
 * holding a validation error about it.
 *
 * `truncateResultText` still governs only the text channel. `structuredContent`
 * is the payload the schema describes, whole, exactly as before this module.
 */
import {
  type JsonSchema,
  MCP_OUTPUT_VIEWS,
  materializeSchemaBranches,
  type Operation,
  publishedOutputSchema,
  publishedWorkflowOutputSchema,
} from "@anvil/air";
import { z } from "zod";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  /** MCP's `CallToolResult` is an open shape by protocol; this one is servable as-is. */
  [key: string]: unknown;
}

/** The SDK-ready `outputSchema` for an operation's tool, or undefined when none is published. */
export function toolOutputSchema(op: Operation, budgetTokens: number): z.ZodType | undefined {
  return toZod(publishedOutputSchema(op, budgetTokens).schema);
}

/** The SDK-ready `outputSchema` for a workflow's composite tool. */
export function workflowOutputSchema(
  lastStep: Operation,
  budgetTokens: number,
): z.ZodType | undefined {
  return toZod(publishedWorkflowOutputSchema(lastStep, budgetTokens).schema);
}

function toZod(schema: JsonSchema | undefined): z.ZodType | undefined {
  if (!schema) return undefined;
  return z.fromJSONSchema(
    materializeSchemaBranches(schema) as Parameters<typeof z.fromJSONSchema>[0],
  );
}

/**
 * A normal response: a record at the top level, anything else under `result`
 * — the placement the published schema describes. When a schema is declared
 * and the payload does not satisfy it, the payload moves under
 * `anvil_unvalidated` and the text says why.
 */
export function responseResult(
  text: string,
  data: unknown,
  declared: z.ZodType | undefined,
): ToolResult {
  const structured = isRecord(data) ? data : { result: data };
  return conforming(text, structured, data, declared);
}

/** A workflow's final response beside its step trace, under the same rule. */
export function workflowResponseResult(
  text: string,
  data: unknown,
  trace: string,
  declared: z.ZodType | undefined,
): ToolResult {
  return conforming(text, { result: data, trace }, data, declared, { trace });
}

/** A dry run's plan, under its reserved key; never validated as a response. */
export function dryRunResult(text: string, plan: unknown): ToolResult {
  return { content: textContent(text), structuredContent: { [MCP_OUTPUT_VIEWS.dryRun]: plan } };
}

/** A caller's projected view, under its reserved key; its shape is the caller's. */
export function projectedResult(
  text: string,
  view: unknown,
  extra: Record<string, unknown> = {},
): ToolResult {
  return {
    content: textContent(text),
    structuredContent: { [MCP_OUTPUT_VIEWS.projection]: view, ...extra },
  };
}

function conforming(
  text: string,
  structured: Record<string, unknown>,
  payload: unknown,
  declared: z.ZodType | undefined,
  extra: Record<string, unknown> = {},
): ToolResult {
  if (!declared) return { content: textContent(text), structuredContent: structured };
  const parsed = declared.safeParse(structured);
  if (parsed.success) return { content: textContent(text), structuredContent: structured };
  const issue = parsed.error.issues[0];
  const where = issue?.path?.length ? `at '${issue.path.join(".")}'` : "at the top level";
  const notice =
    `[output schema: the upstream payload did not match the declared response schema ${where}` +
    `${issue ? ` (${issue.message})` : ""}; served under '${MCP_OUTPUT_VIEWS.unvalidated}']`;
  return {
    content: textContent(`${text}\n\n${notice}`),
    structuredContent: { [MCP_OUTPUT_VIEWS.unvalidated]: payload, ...extra },
  };
}

function textContent(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text" as const, text }];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
