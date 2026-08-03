import type { Operation } from "./schema.js";

/**
 * MCP tool annotations for an operation, derived from its effect / idempotency
 * classification. This is the SINGLE source of truth for the hints — the live
 * MCP server (`@anvil/mcp-runtime`) and the Agent Registry `toolspec.json`
 * (`@anvil/targets`) both consume it, so a tool's advertised safety never drifts
 * between the two surfaces.
 */
export interface McpToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export function mcpToolAnnotations(op: Operation): McpToolAnnotations {
  return {
    title: op.displayName,
    readOnlyHint: op.effect.kind === "read",
    destructiveHint: op.effect.kind === "mutation" && !op.effect.reversible,
    idempotentHint: op.idempotency.mode !== "none",
    // Anvil calls are closed-domain: one pinned upstream host, gated by the
    // ANVIL_ALLOWED_HOSTS egress allowlist. The spec default is true, so emitting
    // false is the informative value for well-behaved clients.
    openWorldHint: false,
  };
}

/**
 * The tool description Anvil advertises for an operation: the human summary plus
 * the compiled safety posture (mutation risk, reversibility, idempotency,
 * confirmation, retry-safety). Shared by the live server and the toolspec.
 */
export function mcpToolDescription(op: Operation): string {
  const parts = [op.description || op.displayName];
  if (op.effect.kind === "mutation") {
    parts.push(
      `This is a ${op.effect.reversible ? "" : "irreversible "}${op.effect.risk} mutation.`,
    );
    if (op.idempotency.mode === "required") parts.push("Requires an idempotency key.");
    if (op.confirmation.required) parts.push("Requires confirm=true.");
    parts.push(op.retries.mode === "safe" ? "Retry-safe." : "Not retry-safe.");
  } else {
    parts.push("Read-only.");
  }
  // Interaction-shape facts (never invented: pagination only *names* params the
  // spec already declares). The skill reference teaches the same lines, so the
  // MCP and skill surfaces stay in agreement about how to call the operation.
  if (op.pagination) {
    if (op.pagination.style === "link" || !op.pagination.cursorParam) {
      parts.push(`Paginated (${op.pagination.style}).`);
    } else {
      const items = op.pagination.itemsField ? `; items at '${op.pagination.itemsField}'` : "";
      parts.push(
        `Paginated (${op.pagination.style}): pass '${op.pagination.cursorParam}'${items}.`,
      );
    }
  }
  if (op.longRunning) parts.push("Long-running: returns before completion; poll for status.");
  if (op.archetype === "search") parts.push("Narrow with filters before paging.");
  return parts.join(" ");
}
