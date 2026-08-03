import type { Operation } from "@anvil/air";

/**
 * Truncate text at a character budget without splitting UTF-16 surrogate pairs.
 * Returns the original text if under budget or if budget is 0 (disabled).
 *
 * A truncation marker is appended when truncation occurs:
 * `[truncated: served N of M chars. Narrow the request<, or page with '<cursorParam>'>]`
 */
export function truncateResultText(
  text: string,
  operation: Operation,
  budgetChars: number,
): string {
  // Budget 0 disables truncation
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
  const servedChars = truncated.length;
  const totalChars = text.length;

  // Build the marker with pagination hint if available
  const marker = buildTruncationMarker(servedChars, totalChars, operation);

  return truncated + marker;
}

/**
 * Build the truncation marker appended to truncated results.
 * Includes pagination hint only when op.pagination names a cursorParam.
 */
function buildTruncationMarker(
  servedChars: number,
  totalChars: number,
  operation: Operation,
): string {
  const base = `[truncated: served ${servedChars} of ${totalChars} chars. Narrow the request`;

  if (operation.pagination?.cursorParam) {
    return `${base}, or page with '${operation.pagination.cursorParam}']`;
  }

  return `${base}]`;
}
