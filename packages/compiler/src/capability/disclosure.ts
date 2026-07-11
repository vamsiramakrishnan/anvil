/**
 * Build the one `DisclosurePlan` a capability's surfaces share. Every surface
 * resolves the same `contentRef` pointers its own way — the CLI to `--schema`/
 * `--examples`/`--errors`, MCP to detailed resources, the skill to reference
 * files — so progressive disclosure has a single owner and cannot drift between
 * surfaces.
 */
import type { AirDocument, Operation } from "@anvil/air";
import type { DisclosureNode, DisclosurePlan } from "./model.js";

const ref = (...parts: string[]) => `anvil://${parts.join("/")}`;

/** The per-operation disclosure nodes: operation, schema, examples, errors, policy. */
function operationNodes(op: Operation): DisclosureNode[] {
  const nodes: DisclosureNode[] = [
    {
      id: `${op.id}.operation`,
      kind: "operation",
      title: op.displayName,
      summary: op.description || op.displayName,
      contentRef: ref("op", op.id),
    },
    {
      id: `${op.id}.schema`,
      kind: "schema",
      title: `${op.displayName} — input`,
      summary: `Input schema for ${op.mcp.toolName}.`,
      contentRef: ref("op", op.id, "schema"),
    },
  ];
  if (op.skill.intentExamples.length > 0) {
    nodes.push({
      id: `${op.id}.examples`,
      kind: "examples",
      title: `${op.displayName} — examples`,
      summary: op.skill.intentExamples.slice(0, 3).join("; "),
      contentRef: ref("op", op.id, "examples"),
    });
  }
  if (op.errors.length > 0) {
    nodes.push({
      id: `${op.id}.errors`,
      kind: "errors",
      title: `${op.displayName} — errors`,
      summary: `${op.errors.length} normalized error(s).`,
      contentRef: ref("op", op.id, "errors"),
    });
  }
  if (op.confirmation.required || op.auth.type !== "none") {
    nodes.push({
      id: `${op.id}.policy`,
      kind: "policy",
      title: `${op.displayName} — policy`,
      summary: policySummary(op),
      contentRef: ref("op", op.id, "policy"),
    });
  }
  return nodes;
}

function policySummary(op: Operation): string {
  const parts: string[] = [];
  if (op.confirmation.required) parts.push("confirmation required");
  if (op.auth.type !== "none") parts.push(`auth: ${op.auth.type}`);
  if (op.idempotency.mode === "none" && op.effect.kind === "mutation") parts.push("not idempotent");
  return parts.join("; ") || "no special policy";
}

/**
 * Build the disclosure plan for one capability. `summary` opens with the
 * capability overview (and a procedures node when it owns workflows); `operations`
 * maps each approved member op to its disclosure nodes.
 */
export function disclosurePlanFor(air: AirDocument, capabilityId: string): DisclosurePlan {
  const capability = air.capabilities.find((c) => c.id === capabilityId);
  const memberIds = new Set(capability?.operationIds ?? []);
  const members = air.operations
    .filter((op) => op.state === "approved" && memberIds.has(op.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  return disclosurePlanForMembers(air, capabilityId, members);
}

/**
 * Build a disclosure plan for an *explicit* member set (#7). An edited capability
 * — one that moved an operation in — must disclose that operation, so membership
 * comes from the caller, never re-derived from the AIR capability grouping. Hard
 * invariant: `keys(plan.operations) === member ids`.
 */
export function disclosurePlanForMembers(
  air: AirDocument,
  capabilityId: string,
  members: readonly Operation[],
): DisclosurePlan {
  const capability = air.capabilities.find((c) => c.id === capabilityId);
  const sortedMembers = [...members].sort((a, b) => a.id.localeCompare(b.id));

  const summary: DisclosureNode[] = [
    {
      id: `${capabilityId}.overview`,
      kind: "overview",
      title: capability?.displayName ?? capabilityId,
      summary: capability?.description || `The ${capabilityId} capability.`,
      contentRef: ref("capability", capabilityId, "overview"),
    },
  ];
  const workflows = air.workflows.filter((w) => w.capabilityId === capabilityId);
  for (const wf of workflows.sort((a, b) => a.id.localeCompare(b.id))) {
    summary.push({
      id: `${wf.id}.procedure`,
      kind: "procedure",
      title: wf.displayName,
      summary: wf.description || `${wf.steps.length}-step procedure.`,
      contentRef: ref("procedure", wf.id),
    });
  }

  const operations: Record<string, DisclosureNode[]> = {};
  for (const op of sortedMembers) operations[op.id] = operationNodes(op);
  return { summary, operations };
}
