/**
 * The context-budget arithmetic, defined once.
 *
 * Four surfaces need to agree on what "fits in the agent's context" means: the
 * compiler that measures it, the simulator that generates a page, the MCP
 * runtime that serves one, and the certification pass that asserts it. If each
 * derived its own page size the certified number would describe a surface
 * nobody actually serves — the same class of drift the surface signature exists
 * to prevent. So the math lives in AIR with the model it reasons about, and
 * every one of those four imports it rather than reimplementing it.
 *
 * Everything here is pure: same operation and same budget always yield the same
 * page size, which is what lets a disclosure figure be certified at all.
 */
import type { Operation } from "./schema.js";

/**
 * Default budget for one operation's *tool surface* — its entry in `tools/list`.
 * Deliberately small: this is the per-operation share of a listing an agent must
 * read before it can route anywhere, so a surface that blows this is expensive
 * before it is useful.
 */
export const DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS = 1_200;

/**
 * Default budget for one *response*. This is the number a page size is solved
 * against, and the ceiling the truncation failsafe measures itself against.
 */
export const DEFAULT_RESPONSE_BUDGET_TOKENS = 8_000;

/**
 * Fallback characters-per-token when an operation was never measured. Four is
 * the conventional English-prose approximation and is intentionally conservative
 * for JSON, which tokenizes denser than prose — under-estimating characters per
 * token over-estimates tokens, which errs toward serving less. Only ever used
 * for the truncation failsafe, never for a certified figure.
 */
export const FALLBACK_CHARS_PER_TOKEN = 4;

/** Smallest page worth requesting: below this, paging costs more than it saves. */
export const MIN_DERIVED_PAGE_SIZE = 1;

/**
 * Cheap serve-time token estimate from character length. The deployed unit
 * carries no BPE table (see `DisclosureCost`), so it scales by the calibration
 * observed at measure time. An estimate — good enough to decide when to cut a
 * payload, never good enough to certify.
 */
export function estimateTokens(chars: number, charsPerToken?: number): number {
  const ratio = charsPerToken && charsPerToken > 0 ? charsPerToken : FALLBACK_CHARS_PER_TOKEN;
  return Math.ceil(chars / ratio);
}

/** Inverse of {@link estimateTokens}: how many characters fit a token budget. */
export function charsForTokenBudget(tokens: number, charsPerToken?: number): number {
  const ratio = charsPerToken && charsPerToken > 0 ? charsPerToken : FALLBACK_CHARS_PER_TOKEN;
  return Math.max(0, Math.floor(tokens * ratio));
}

/** Why a page size came out the way it did — surfaced so a report can explain itself. */
export type PageSizeBasis =
  | "not_paginated"
  | "unmeasured"
  | "budget_derived"
  | "capped_by_upstream"
  | "upstream_default";

export interface SafePageSize {
  /** The page size to request, or undefined when the operation cannot be sized. */
  size?: number;
  basis: PageSizeBasis;
  /** Projected tokens for a page of `size` items, when derivable. */
  projectedTokens?: number;
}

/**
 * Solve for the largest page that fits a token budget.
 *
 * The chain is: measured tokens-per-item → how many items fit → clamped by what
 * the upstream will actually honor. Each link can be missing, and a missing link
 * is reported rather than papered over — an unmeasured operation returns
 * `unmeasured` instead of a confident-looking default, because a fabricated page
 * size is exactly the kind of guess Anvil exists to stop.
 *
 * `itemTokensOverride` lets a caller substitute a per-item cost it measured more
 * directly than the contract could — notably after a projection has shrunk each
 * item, which raises the page size that fits.
 */
export function safePageSize(
  operation: Operation,
  budgetTokens: number = DEFAULT_RESPONSE_BUDGET_TOKENS,
  itemTokensOverride?: number,
): SafePageSize {
  const pagination = operation.pagination;
  if (!pagination) return { basis: "not_paginated" };

  const itemTokens = itemTokensOverride ?? operation.disclosureCost?.responseItemTokens ?? 0;
  const max = pagination.maxPageSize;

  // Nothing measured: we know the operation pages, but not what a page costs.
  // Report the upstream's own default if it stated one — that is a fact about
  // the contract, not an inference — and otherwise decline to invent a number.
  if (itemTokens <= 0 || budgetTokens <= 0) {
    if (pagination.defaultPageSize !== undefined) {
      return { size: pagination.defaultPageSize, basis: "upstream_default" };
    }
    return { basis: "unmeasured" };
  }

  const fits = Math.max(MIN_DERIVED_PAGE_SIZE, Math.floor(budgetTokens / itemTokens));
  if (max !== undefined && fits >= max) {
    // The budget is not the binding constraint — the upstream cap is. Worth
    // distinguishing: it means shrinking each item buys no more rows.
    return { size: max, basis: "capped_by_upstream", projectedTokens: max * itemTokens };
  }
  return { size: fits, basis: "budget_derived", projectedTokens: fits * itemTokens };
}

/** Whether an operation's tool surface fits the per-operation disclosure budget. */
export function toolSurfaceFitsBudget(
  operation: Operation,
  budgetTokens: number = DEFAULT_TOOL_DISCLOSURE_BUDGET_TOKENS,
): boolean {
  const cost = operation.disclosureCost;
  // Unmeasured cannot fail a budget it was never measured against; the
  // refinement layer raises that as its own gap rather than failing here.
  if (!cost) return true;
  return cost.toolTokens <= budgetTokens;
}

/**
 * Whether one response fits the budget. A paginated operation is judged on the
 * page it would actually serve; an unpaginated one on its whole response, since
 * it has no way to return less.
 */
export function responseFitsBudget(
  operation: Operation,
  budgetTokens: number = DEFAULT_RESPONSE_BUDGET_TOKENS,
): boolean {
  const cost = operation.disclosureCost;
  if (!cost) return true;
  if (operation.pagination) {
    const page = safePageSize(operation, budgetTokens);
    if (page.projectedTokens !== undefined) return page.projectedTokens <= budgetTokens;
    // Sized by the upstream's default or not sized at all — fall back to the
    // measured whole response, which is the only figure we actually have.
  }
  return cost.responseTokens === 0 || cost.responseTokens <= budgetTokens;
}
