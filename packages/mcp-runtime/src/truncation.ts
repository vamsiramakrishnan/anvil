import {
  charsForTokenBudget,
  DEFAULT_RESPONSE_BUDGET_TOKENS,
  estimateTokens,
  FALLBACK_CHARS_PER_TOKEN,
  type Operation,
} from "@anvil/air";

/**
 * The truncation failsafe — deliberately the *failure* path, not the control
 * path.
 *
 * By the time this function runs the damage is largely done: the upstream call
 * was made, the full page was paid for, and the payload was serialized. All we
 * can still do is stop the oversized result from entering the agent's context,
 * and tell the agent how to not end up here again. The control paths — the
 * `anvil_projection` view control and the operation's own cursor — are named in
 * the marker for exactly that reason.
 *
 * The budget is denominated in TOKENS, because tokens are what the agent
 * actually spends; characters were only ever a proxy for them. Conversion uses
 * the operation's measured `disclosureCost.charsPerToken` calibration via the
 * AIR helpers, so the arithmetic is the same one the compiler, simulator, and
 * certification pass use. It is an estimate and the marker says so: the deployed
 * unit carries no BPE table on purpose (a multi-megabyte tokenizer in the thin
 * serving path would cost more than it saves), so a marker implying an exact
 * count would be claiming precision this code cannot have.
 */

/**
 * A serving budget for one result.
 *
 * `tokens` is the supported form. `chars` is the legacy raw-character form kept
 * so existing callers keep working; it is converted to a token figure only for
 * the marker, never for the cut itself, so a character budget still cuts at
 * exactly the character it always did.
 */
export interface ResultBudget {
  /** Token budget for the serialized result. 0 disables truncation. */
  tokens?: number;
  /**
   * @deprecated Raw UTF-16 character budget. Prefer `tokens`: characters are a
   * proxy for the quantity that actually matters, and the proxy drifts per
   * operation with how densely its payload tokenizes.
   */
  chars?: number;
}

/**
 * Truncate a serialized result to a budget without splitting UTF-16 surrogate
 * pairs. Returns the original text when it fits, or when the budget is 0
 * (truncation disabled).
 *
 * The third argument accepts a bare number for backward compatibility, which is
 * interpreted as a character budget exactly as before.
 */
export function truncateResultText(
  text: string,
  operation: Operation,
  budget: number | ResultBudget,
): string {
  const charsPerToken = operation.disclosureCost?.charsPerToken;
  const budgetChars = resolveBudgetChars(budget, charsPerToken);

  // Budget 0 disables truncation. A caller that says "no budget" gets no
  // failsafe — that is a deliberate choice, not an oversight to correct here.
  if (budgetChars === 0) {
    return text;
  }

  if (text.length <= budgetChars) {
    return text;
  }

  // Truncate safely without splitting surrogates.
  // UTF-16 surrogate pairs are two 16-bit units (0xD800-0xDBFF followed by 0xDC00-0xDFFF).
  // JavaScript string indexing is in UTF-16 code units, not characters.
  // So we need to check if position budgetChars falls on a high surrogate.
  let safeLength = budgetChars;

  // If the last character (at index safeLength - 1) is a high surrogate (0xD800-0xDBFF),
  // we're about to split a pair, so back up by 1.
  if (safeLength > 0) {
    const lastChar = text.charCodeAt(safeLength - 1);
    // High surrogate range: 0xD800 to 0xDBFF
    if (lastChar >= 0xd800 && lastChar <= 0xdbff) {
      safeLength--;
    }
  }

  const truncated = text.substring(0, safeLength);
  const marker = buildTruncationMarker(truncated.length, text.length, operation, charsPerToken);

  return truncated + marker;
}

/**
 * Resolve a budget onto the character position where the cut lands.
 *
 * An explicit `chars` wins over `tokens` when both are present: a caller who
 * still speaks in characters is asking for the old behavior verbatim, and
 * silently re-deriving their boundary from a token figure would move a cut they
 * had already calibrated.
 */
function resolveBudgetChars(budget: number | ResultBudget, charsPerToken?: number): number {
  if (typeof budget === "number") return budget;
  if (budget.chars !== undefined) return budget.chars;
  if (budget.tokens !== undefined) return charsForTokenBudget(budget.tokens, charsPerToken);
  return charsForTokenBudget(DEFAULT_RESPONSE_BUDGET_TOKENS, charsPerToken);
}

/**
 * Build the marker appended to a truncated result.
 *
 * It names both recovery routes the caller actually has, because "narrow the
 * request" on its own is advice without a mechanism. `anvil_projection` is
 * always available (it is a reserved control on every tool); the cursor param is
 * named only when the operation models one, since inventing a parameter name
 * would be the exact class of guess this system exists to eliminate.
 */
function buildTruncationMarker(
  servedChars: number,
  totalChars: number,
  operation: Operation,
  charsPerToken?: number,
): string {
  const servedTokens = estimateTokens(servedChars, charsPerToken);
  const totalTokens = estimateTokens(totalChars, charsPerToken);
  const ratio = charsPerToken && charsPerToken > 0 ? charsPerToken : FALLBACK_CHARS_PER_TOKEN;
  const calibration = operation.disclosureCost?.charsPerToken
    ? `~${round2(ratio)} chars/token measured for this operation`
    : `~${round2(ratio)} chars/token assumed, this operation was never measured`;

  const recovery =
    `Narrow the request with 'anvil_projection' to select fewer fields` +
    (operation.pagination?.cursorParam
      ? `, or page with '${operation.pagination.cursorParam}'`
      : "");

  return (
    `[truncated: ~${servedTokens} of ~${totalTokens} estimated tokens — ` +
    `served ${servedChars} of ${totalChars} chars (${calibration}; ` +
    `the serving path carries no tokenizer, so token figures are estimates). ` +
    `${recovery}]`
  );
}

/** Two decimals, without the trailing-zero noise of toFixed. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
