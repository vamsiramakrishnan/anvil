import type { Operation } from "./schema.js";

/**
 * The shared, unambiguous operation resolver. Every surface that accepts an
 * operation selector (`anvil assess`, drill-downs, future commands) resolves it
 * through this one function, so "which operation did you mean?" has exactly one
 * answer everywhere — and ambiguity is a refusal, never a silent first-match.
 */

/**
 * How a selector matched, ordered strongest-first. Exact identifiers win
 * outright; suffix forms (`create`, `refunds create`) are conveniences that only
 * resolve when they name a single operation.
 */
export type OperationMatchTier =
  | "id"
  | "canonicalName"
  | "mcpToolName"
  | "cliCommand"
  | "idSuffix"
  | "cliCommandSuffix";

/**
 * The outcome of resolving a selector:
 *   - `resolved`  — exactly one operation matched at the strongest tier that
 *                   matched anything; `matchedBy` names that tier.
 *   - `not_found` — no tier matched.
 *   - `ambiguous` — several operations matched AT the strongest matching tier.
 *                   Resolution stops there (no fall-through to weaker tiers):
 *                   picking between equally-good matches is the caller's — or a
 *                   human's — decision, never the resolver's.
 */
export type OperationResolution =
  | { status: "resolved"; operation: Operation; matchedBy: OperationMatchTier }
  | { status: "not_found" }
  | { status: "ambiguous"; matchedBy: OperationMatchTier; candidates: Operation[] };

/** The tiers in priority order, each with its exact/suffix predicate. */
const TIERS: readonly {
  tier: OperationMatchTier;
  matches: (op: Operation, selector: string) => boolean;
}[] = [
  { tier: "id", matches: (op, s) => op.id === s },
  { tier: "canonicalName", matches: (op, s) => op.canonicalName === s },
  { tier: "mcpToolName", matches: (op, s) => op.mcp.toolName === s },
  { tier: "cliCommand", matches: (op, s) => op.cli.command === s },
  { tier: "idSuffix", matches: (op, s) => op.id.endsWith(`.${s}`) },
  { tier: "cliCommandSuffix", matches: (op, s) => op.cli.command.endsWith(` ${s}`) },
];

/**
 * Resolve a selector against a set of operations. Deterministic and
 * order-independent: the result never depends on the order operations appear in
 * the AIR document (ambiguous candidates are reported sorted by id).
 */
export function resolveOperation(
  operations: readonly Operation[],
  selector: string,
): OperationResolution {
  for (const { tier, matches } of TIERS) {
    const found = operations.filter((op) => matches(op, selector));
    if (found.length === 1) {
      return { status: "resolved", operation: found[0] as Operation, matchedBy: tier };
    }
    if (found.length > 1) {
      const candidates = found.slice().sort((a, b) => a.id.localeCompare(b.id));
      return { status: "ambiguous", matchedBy: tier, candidates };
    }
  }
  return { status: "not_found" };
}
