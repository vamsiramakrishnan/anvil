/**
 * The incremental rebuild planner — the "Bazel, not whole-tree regen" behaviour.
 * Given a previous pack and the next one, decide which build nodes must rebuild
 * and which stay cached, keyed entirely on each node's `inputDigests`,
 * `implementationVersion`, and `configurationDigest`. A node whose inputs did not
 * change stays cached even when a sibling projection changed — so editing the
 * skill never rebuilds the MCP.
 */
import type { AgentSystemPack, BuildNode } from "./model.js";

export interface RebuildReason {
  id: string;
  reason: "new" | "inputs-changed" | "impl-changed" | "config-changed";
  detail?: string;
}

export interface RebuildPlan {
  rebuilt: RebuildReason[];
  cached: string[];
}

function nodeSignature(node: BuildNode): string {
  return JSON.stringify([
    [...node.inputDigests].sort(),
    node.implementationVersion,
    node.configurationDigest,
  ]);
}

/**
 * Explain what a rebuild from `previous` → `next` would do. With no previous
 * pack, everything is new. Otherwise each next node is matched by id: unchanged
 * signature → cached; changed → rebuilt with the specific reason.
 */
export function explainRebuild(
  previous: AgentSystemPack | undefined,
  next: AgentSystemPack,
): RebuildPlan {
  const prevById = new Map((previous?.artifacts.nodes ?? []).map((n) => [n.id, n]));
  const rebuilt: RebuildReason[] = [];
  const cached: string[] = [];

  for (const node of next.artifacts.nodes) {
    const prev = prevById.get(node.id);
    if (!prev) {
      rebuilt.push({ id: node.id, reason: "new" });
      continue;
    }
    if (nodeSignature(prev) === nodeSignature(node)) {
      cached.push(node.id);
      continue;
    }
    if (prev.implementationVersion !== node.implementationVersion) {
      rebuilt.push({ id: node.id, reason: "impl-changed" });
    } else if (prev.configurationDigest !== node.configurationDigest) {
      rebuilt.push({ id: node.id, reason: "config-changed" });
    } else {
      rebuilt.push({
        id: node.id,
        reason: "inputs-changed",
        detail: diffList(prev.inputDigests, node.inputDigests),
      });
    }
  }
  return {
    rebuilt: rebuilt.sort((a, b) => a.id.localeCompare(b.id)),
    cached: cached.sort(),
  };
}

function diffList(prev: string[], next: string[]): string {
  const added = next.filter((d) => !prev.includes(d)).length;
  const removed = prev.filter((d) => !next.includes(d)).length;
  return `+${added}/-${removed} inputs`;
}
