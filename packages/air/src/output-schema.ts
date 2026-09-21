/**
 * The MCP `outputSchema` Anvil publishes for an operation's tool — decided
 * here, once, so the serving path (`@anvil/mcp-runtime`) and the compiler's
 * disclosure measurement (`@anvil/compiler`) publish and price the same bytes.
 *
 * Why the published schema is not simply `operation.output.schema`:
 *
 * An MCP tool has ONE output schema, and the SDK validates every non-error
 * result against it on both ends of the wire. Anvil's tools answer three
 * different questions on the same tool — the operation's response, a dry-run
 * plan (`anvil_dry_run`), and a caller-authored view (`anvil_projection`) —
 * and the last two are, by construction, not shaped like the response. A
 * schema that declared the response fields as required would therefore reject
 * every dry run; a schema loose enough to admit an arbitrary projection at the
 * top level would say nothing at all.
 *
 * The contract below threads that: the response fields keep their own schema
 * (types, nested `required`, descriptions) and sit at the top level exactly
 * where `structuredContent` puts them, while each reserved view is carried
 * under its own reserved key. Nothing at the top level is required, because a
 * reserved view REPLACES the response fields rather than sitting beside them,
 * and the description says so. A payload the upstream returns off-contract is
 * served under `anvil_unvalidated` rather than refused: a legacy API that
 * deviates from its own specification is the common case Anvil exists for, and
 * a declared schema must never turn data the agent could read into an error.
 *
 * Not declared at all — and the reason is reported — when the operation has no
 * response schema, when the served shape is an agent projection of it (the
 * wire names in `schema` are not what is served), when the schema says nothing
 * usable, or when publishing it would cost more of the at-rest surface than
 * `outputSchemaBudgetTokens` allows. The budget is checked with the fixed
 * fallback calibration, never a measured one, so the decision is a pure
 * function of the contract and cannot flip between measure time and serve time.
 */
import { estimateTokens, FALLBACK_CHARS_PER_TOKEN } from "./disclosure.js";
import type { JsonSchema, Operation } from "./schema.js";

/**
 * The reserved, `anvil_`-namespaced keys a tool result may carry INSTEAD of the
 * operation's response fields. Same namespace rule as the reserved input
 * controls: a clash with a real response field is effectively impossible.
 */
export const MCP_OUTPUT_VIEWS = {
  /** The redacted request plan of a dry run (`anvil_dry_run: true` was passed). */
  dryRun: "anvil_dry_run",
  /** The caller's own view (`anvil_projection` was passed); shaped by the caller. */
  projection: "anvil_projection",
  /** The upstream payload, verbatim, when it did not match the declared response schema. */
  unvalidated: "anvil_unvalidated",
} as const;

/**
 * Default ceiling for one published output schema, in tokens of the at-rest
 * `tools/list` surface. A third of `DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS`: a
 * response schema is worth reading before a call only when it costs clearly
 * less than the call it describes, and a legacy response model can run to
 * hundreds of fields. Above this the schema is omitted, not trimmed — a partial
 * schema would be validated as if it were whole.
 */
export const DEFAULT_OUTPUT_SCHEMA_BUDGET_TOKENS = 400;

/** Why no output schema is published for an operation. */
export type OutputSchemaOmission =
  | "absent"
  | "agent_projection"
  | "too_weak"
  | "over_budget"
  | "disabled";

export type PublishedOutputSchema =
  | { schema: JsonSchema; omitted?: undefined }
  | { schema?: undefined; omitted: OutputSchemaOmission };

const RESERVED_VIEW_PROPERTIES: Record<string, JsonSchema> = {
  [MCP_OUTPUT_VIEWS.dryRun]: {
    type: "object",
    description:
      "Present instead of the response fields when the call was a dry run: the redacted request plan.",
  },
  [MCP_OUTPUT_VIEWS.projection]: {
    description:
      "Present instead of the response fields when anvil_projection was passed: the caller's own view, shaped by the expression.",
  },
  [MCP_OUTPUT_VIEWS.unvalidated]: {
    description:
      "Present instead of the response fields when the upstream payload did not match this schema; the text content says where it differed.",
  },
};

const TOP_LEVEL_DESCRIPTION =
  "The response fields of a normal call. None is required at this level because a reserved anvil_* view replaces them when present.";

/**
 * The response fields as `structuredContent` places them: a record's own
 * properties at the top level, anything else wrapped as `{ result }`. Returns
 * undefined when the schema is absent or says nothing a schema could check.
 */
export function outputResultProperties(op: Operation): Record<string, JsonSchema> | undefined {
  const source = op.output.schema;
  if (!source) return undefined;
  const properties = source.properties;
  const isObject =
    source.type === "object" || (source.type === undefined && properties !== undefined);
  if (isObject) {
    if (!isRecord(properties) || Object.keys(properties).length === 0) return undefined;
    return properties as Record<string, JsonSchema>;
  }
  if (typeof source.type !== "string") return undefined;
  return { result: source };
}

/**
 * The output schema published for an operation's tool, or the reason none is.
 * Pure: the same operation and budget always yield the same answer.
 */
export function publishedOutputSchema(
  op: Operation,
  budgetTokens: number = DEFAULT_OUTPUT_SCHEMA_BUDGET_TOKENS,
): PublishedOutputSchema {
  if (budgetTokens <= 0) return { omitted: "disabled" };
  if (!op.output.schema) return { omitted: "absent" };
  if (op.output.agentProjection) return { omitted: "agent_projection" };
  const properties = outputResultProperties(op);
  if (!properties) return { omitted: "too_weak" };
  return withinBudget(publishedShape(properties), budgetTokens);
}

/**
 * The output schema published for a workflow's composite tool: the last step's
 * response under `result` — with that step's own `required` intact, since the
 * wrapper key is what a reserved view replaces — plus the step trace.
 */
export function publishedWorkflowOutputSchema(
  lastStep: Operation,
  budgetTokens: number = DEFAULT_OUTPUT_SCHEMA_BUDGET_TOKENS,
): PublishedOutputSchema {
  if (budgetTokens <= 0) return { omitted: "disabled" };
  const source = lastStep.output.schema;
  if (!source) return { omitted: "absent" };
  if (lastStep.output.agentProjection) return { omitted: "agent_projection" };
  if (!outputResultProperties(lastStep)) return { omitted: "too_weak" };
  return withinBudget(
    publishedShape({
      result: source,
      trace: {
        type: "string",
        description: "One entry per executed step: '<operationId>:ok|failed'.",
      },
    }),
    budgetTokens,
  );
}

function publishedShape(properties: Record<string, JsonSchema>): JsonSchema {
  return {
    type: "object",
    description: TOP_LEVEL_DESCRIPTION,
    properties: { ...properties, ...RESERVED_VIEW_PROPERTIES },
  };
}

function withinBudget(schema: JsonSchema, budgetTokens: number): PublishedOutputSchema {
  const tokens = estimateTokens(JSON.stringify(schema).length, FALLBACK_CHARS_PER_TOKEN);
  return tokens > budgetTokens ? { omitted: "over_budget" } : { schema };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
