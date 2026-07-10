import type { Operation } from "@anvil/air";
import type { ArtifactKind, ArtifactRef } from "./model.js";
import { describeTarget, type SemanticTarget } from "./target.js";

/**
 * Which generated projections a semantic patch on `target` re-derives. This is
 * what makes one patch align the CLI, the MCP tool, and the skill reference
 * instead of drifting apart: the reconciler re-runs exactly these artifacts,
 * never "everything", and never nothing.
 */
const KINDS_BY_TARGET_KIND: Record<SemanticTarget["kind"], ArtifactKind[]> = {
  field: ["json_schema", "mcp_tool", "cli_help", "skill_reference", "mock"],
  enum: ["json_schema", "mcp_tool", "cli_help", "skill_reference", "mock"],
  operation: ["mcp_tool", "cli_help", "skill_reference"],
  error: ["mcp_tool", "skill_reference", "mock"],
  capability: ["skill_reference", "cli_help"],
  service: ["skill_reference"],
  workflow: ["skill_reference"],
};

/** A short, human-readable pointer to one artifact kind's ref for `target`/`op`. */
function refFor(kind: ArtifactKind, target: SemanticTarget, op?: Operation): string {
  if (!op) return `${kind}:${describeTarget(target)}`;
  switch (kind) {
    case "json_schema":
      return `schema:${op.mcp.toolName}.input`;
    case "mcp_tool":
      return `mcp:${op.mcp.toolName}`;
    case "cli_help":
      return `cli:${op.cli.command}`;
    case "mock":
      return `mock:${op.mcp.toolName}`;
    case "skill_reference":
    case "eval":
      return `skill:${describeTarget(target)}`;
  }
}

/**
 * The set of generated projections a semantic patch on `target` re-derives, in a
 * deterministic, de-duplicated, stable order. `op` (when available) grounds the
 * refs in concrete tool/command names; without it, refs fall back to the
 * target's human-readable coordinate so the shape stays useful even before an
 * operation is resolved.
 */
export function affectedArtifacts(target: SemanticTarget, op?: Operation): ArtifactRef[] {
  const kinds = KINDS_BY_TARGET_KIND[target.kind];
  return kinds.map((kind) => ({ kind, ref: refFor(kind, target, op) }));
}
