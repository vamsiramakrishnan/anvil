import { type AirDocument, type Operation, planWorkflowSurface } from "@anvil/air";

/**
 * What a bundle serves, computed the one way every surface computes it: the
 * approved operations, then `planWorkflowSurface` deciding which workflows
 * register as tools and which operation tools they supersede. The console's
 * inspector, the approval preview, and any other reader of "which tools
 * would an agent see" call this so the answer cannot differ between them.
 */
export interface ServedSurface {
  plan: ReturnType<typeof planWorkflowSurface>;
  /** MCP tool names of approved operations before workflows supersede any. */
  before: string[];
  /** MCP tool names actually served: surviving operations plus registered workflows. */
  after: string[];
  /** CLI commands of approved operations. */
  cliCommands: string[];
}

export function servedSurface(air: AirDocument): ServedSurface {
  const opsById = new Map(air.operations.map((op) => [op.id, op]));
  const approved = new Map<string, Operation>(
    [...opsById].filter(([, op]) => op.state === "approved"),
  );
  const plan = planWorkflowSurface(air.workflows, approved, opsById);
  const before = [...approved.values()].map((op) => op.mcp.toolName);
  const after = [
    ...[...approved.values()]
      .filter((op) => !plan.superseded.has(op.id))
      .map((op) => op.mcp.toolName),
    ...plan.registrations
      .filter((r) => r.skipReason === undefined)
      .map((r) => r.workflow.id.replace(/[^A-Za-z0-9_-]/g, "_")),
  ];
  const cliCommands = [...approved.values()].map((op) => op.cli.command);
  return { plan, before, after, cliCommands };
}
