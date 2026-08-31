import type { Claim, Operation } from "@anvil/air";
import type { WorkflowManifest } from "@anvil/compiler";
import { pickSearchTool } from "./agent.js";
import { reliabilityOf } from "./evidence.js";
import type { McpSource } from "./mcp-source.js";
import { profileFor } from "./profiles.js";
import type { SourceConfig } from "./sources.js";
import type { WorkflowCandidate } from "./workflow-candidates.js";

/** Evidence that a connected source describes/implements `fromOperationId` and `toOperationId` together. */
export interface WorkflowFinding {
  candidate: WorkflowCandidate;
  sourceId: string;
  evidence: Claim;
}

/**
 * Same evidence bar as any other non-safety-loosening claim (see `reconcile.ts`'s
 * `TIGHTEN_THRESHOLD`) — a workflow candidate never loosens a safety semantic, but
 * it is still business logic Anvil "does not fabricate... it cannot prove" (per
 * the `Workflow` schema doc), so a bare structural match is not enough on its own;
 * at least one connected source must corroborate it before it is proposed at all.
 */
export const WORKFLOW_EVIDENCE_THRESHOLD = 0.4;

/**
 * Probe one source for evidence that a structural workflow candidate is a real,
 * documented/implemented sequence — not just a data-shape coincidence. Weak by
 * design: a bare co-occurrence hit is corroborating, never proof, exactly like the
 * heuristic per-operation agent's bare "exists" claim.
 */
export async function probeWorkflowCandidate(
  candidate: WorkflowCandidate,
  fromOp: Operation,
  toOp: Operation,
  source: McpSource,
  config: SourceConfig,
  tools: Array<{ name: string; description?: string }>,
): Promise<WorkflowFinding[]> {
  const tool = pickSearchTool(tools, config);
  if (!tool) return [];
  const scope = config.hints.scope.join(" ");
  const query = `${fromOp.canonicalName} ${toOp.canonicalName} ${scope}`.trim();

  let text: string;
  try {
    text = await source.call(tool, { query });
  } catch {
    return [];
  }
  if (!text) return [];

  const mentionsFrom = text.includes(fromOp.canonicalName) || text.includes(fromOp.displayName);
  const mentionsTo = text.includes(toOp.canonicalName) || text.includes(toOp.displayName);
  if (!mentionsFrom || !mentionsTo) return [];

  const profile = profileFor(config.system);
  const evidence: Claim = {
    subject: `${fromOp.id}->${toOp.id}`,
    predicate: "workflow.sequence",
    value: true,
    source: profile.evidenceKind,
    sourceRef: `${source.id}:${tool}`,
    method: "doc_scan",
    confidence: profile.floor,
    reliability: profile.floor,
    note: `${source.id} mentions ${fromOp.canonicalName} and ${toOp.canonicalName} together`,
  };
  return [{ candidate, sourceId: source.id, evidence }];
}

export interface WorkflowDecision {
  candidate: WorkflowCandidate;
  accepted: boolean;
  reason: string;
  evidenceReliability: number;
}

/**
 * Turn a candidate's findings into an accept/reject decision and, if accepted, a
 * `WorkflowManifest` entry — always `state: "review_required"`. Enrichment never
 * proposes an `approved` workflow: same "authored or enriched, never guessed"
 * discipline the AIR schema itself declares, just enforced at the one place that
 * could otherwise slip past it.
 *
 * That single rule is also what makes carrying `supersedes` here safe. The entry
 * names the tools the composite would replace, so a reviewer sees the whole
 * trade in one place — but `review_required` is not `approved`, and
 * `@anvil/mcp-runtime` suppresses nothing for an unapproved workflow. No
 * strength of evidence changes that: the same reason `reconcileWorkflow` cannot
 * propose `approved` at all is the reason it cannot make a suppression take
 * effect.
 */
export function reconcileWorkflow(
  candidate: WorkflowCandidate,
  fromOp: Operation,
  toOp: Operation,
  findings: WorkflowFinding[],
): { manifestEntry?: WorkflowManifest; decision: WorkflowDecision } {
  const best = findings.reduce((max, f) => Math.max(max, reliabilityOf(f.evidence)), 0);
  const accepted = findings.length > 0 && best >= WORKFLOW_EVIDENCE_THRESHOLD;
  const reason = accepted
    ? `accepted: corroborated by ${findings.length} source(s) at reliability ${best.toFixed(2)} ≥ ${WORKFLOW_EVIDENCE_THRESHOLD}`
    : findings.length === 0
      ? "rejected: no connected source corroborates this sequence"
      : `rejected: best corroborating reliability ${best.toFixed(2)} < ${WORKFLOW_EVIDENCE_THRESHOLD}`;

  const decision: WorkflowDecision = { candidate, accepted, reason, evidenceReliability: best };
  if (!accepted) return { decision };

  const manifestEntry: WorkflowManifest = {
    display_name: `${fromOp.displayName} → ${toOp.displayName}`,
    description: `Candidate discovered by enrichment: call ${fromOp.canonicalName}, then ${toOp.canonicalName} using its output.`,
    capability: fromOp.capabilityId,
    state: "review_required",
    // Proposed, never applied — `review_required` gates it (see above).
    ...(candidate.supersedes.length > 0 ? { supersedes: candidate.supersedes } : {}),
    steps: [
      { operation: fromOp.canonicalName, description: fromOp.description || fromOp.displayName },
      {
        operation: toOp.canonicalName,
        description: toOp.description || toOp.displayName,
        bindings: candidate.bindings,
      },
    ],
  };
  return { manifestEntry, decision };
}
