import {
  DEFAULT_RESPONSE_BUDGET_TOKENS,
  type Operation,
  type PageSizeBasis,
  propKey,
  safePageSize,
} from "@anvil/air";

/**
 * Budget-derived page sizing — the *control* path that truncation is the failure
 * path for.
 *
 * The failure path fetches everything, pays the upstream cost, serializes it,
 * and then throws most of it away. The control path asks for less in the first
 * place. That is only possible when the contract names the knob
 * (`pagination.pageSizeParam`) and something measured the cost of a row; when
 * either is missing this module returns nothing rather than picking a number,
 * because a fabricated page size is exactly the kind of guess Anvil exists to
 * stop. The arithmetic itself lives in `@anvil/air` so the size served here is
 * the same size the certification pass asserts.
 */

export interface PageSizeInjection {
  /** The upstream parameter name, as the contract states it. */
  param: string;
  /** The input key that carries it — `propKey` normalization, as the executor reads it. */
  key: string;
  size: number;
  basis: PageSizeBasis;
  projectedTokens?: number;
}

/**
 * Decide the page size to inject for a call, or undefined to inject nothing.
 *
 * Three refusals, each deliberate:
 *
 *  - The caller already supplied a size. An explicit value is a statement of
 *    intent and is never overridden; a serving surface that quietly shrinks a
 *    requested page is lying about what it fetched, which is the same class of
 *    harm as the silent upstream cap below.
 *  - The operation does not actually expose the parameter in its input schema.
 *    A `pageSizeParam` that no declared param matches has no wire location, so
 *    injecting it would set a value the request builder silently drops.
 *  - `safePageSize` reports `unmeasured`. We know the operation pages but not
 *    what a page costs, and a confident-looking default would be indistinguishable
 *    to the caller from a measured one.
 */
export function derivePageSize(
  op: Operation,
  input: Record<string, unknown>,
  budgetTokens: number = DEFAULT_RESPONSE_BUDGET_TOKENS,
): PageSizeInjection | undefined {
  const param = op.pagination?.pageSizeParam;
  if (!param) return undefined;

  const key = propKey(param);
  if (input[key] !== undefined) return undefined;

  const declared = op.input.params.some((p) => propKey(p.name) === key);
  if (!declared) return undefined;

  const solved = safePageSize(op, budgetTokens);
  if (solved.basis === "unmeasured" || solved.size === undefined) return undefined;

  // `safePageSize` already clamps a budget-derived size, but an `upstream_default`
  // comes straight out of the contract and a contract can contradict itself
  // (a stated default above a stated maximum). Clamping again here is cheap and
  // means no path can emit a size the upstream would reject or silently cap.
  const max = op.pagination?.maxPageSize;
  const size = Math.max(1, max !== undefined ? Math.min(solved.size, max) : solved.size);

  return {
    param,
    key,
    size,
    basis: solved.basis,
    ...(solved.projectedTokens !== undefined ? { projectedTokens: solved.projectedTokens } : {}),
  };
}

export interface SilentCapSignal {
  returned: number;
  maxPageSize: number;
  /** Present when the contract models a continuation parameter the caller can use. */
  cursorParam?: string;
  /** True when the contract models no continuation field, so emptiness could not be observed. */
  continuationUnobservable: boolean;
}

/**
 * Detect the silent-cap failure: a response holding exactly the upstream's
 * maximum page with no continuation marker.
 *
 * This is the failure mode that makes partial reads look complete. An agent that
 * asks for 500 rows, receives the upstream's cap of 100, and sees no "next"
 * field has no way to distinguish "that was everything" from "that was the first
 * fifth" — and it will confidently report the capped read as the full answer.
 * The signal is heuristic by nature (a collection whose size happens to equal
 * the cap trips it), which is why it is surfaced as a warning the caller can
 * reason about rather than an error that fails a legitimate result.
 */
export function detectSilentCap(op: Operation, data: unknown): SilentCapSignal | undefined {
  const pagination = op.pagination;
  const max = pagination?.maxPageSize;
  if (!pagination || max === undefined) return undefined;

  const items = extractItems(data, pagination.itemsField);
  if (items === undefined || items.length !== max) return undefined;

  const nextField = pagination.nextField;
  if (nextField !== undefined) {
    const next = isRecord(data) ? data[nextField] : undefined;
    // A present continuation marker is the honest case: the response is capped
    // and says so, and the caller has everything it needs to continue.
    if (next !== undefined && next !== null && next !== "") return undefined;
  }

  return {
    returned: items.length,
    maxPageSize: max,
    ...(pagination.cursorParam !== undefined ? { cursorParam: pagination.cursorParam } : {}),
    continuationUnobservable: nextField === undefined,
  };
}

/**
 * The warning appended to a suspiciously-capped result. Phrased as an
 * instruction to the reader rather than a statistic, because the reader is a
 * model about to summarize this page as a complete answer.
 */
export function silentCapNotice(signal: SilentCapSignal): string {
  const observation = signal.continuationUnobservable
    ? "the contract models no continuation field, so completeness cannot be confirmed from the response"
    : "the response carried no continuation marker";

  const action = signal.cursorParam
    ? `request the next page with '${signal.cursorParam}' before concluding this is the full set`
    : "confirm completeness another way before concluding this is the full set";

  return (
    `[disclosure warning: returned ${signal.returned} items, exactly the upstream maximum ` +
    `page size (${signal.maxPageSize}), and ${observation}. A capped read is ` +
    `indistinguishable from a complete one — ${action}.]`
  );
}

function extractItems(data: unknown, itemsField?: string): unknown[] | undefined {
  if (itemsField !== undefined && isRecord(data)) {
    const field = data[itemsField];
    return Array.isArray(field) ? field : undefined;
  }
  return Array.isArray(data) ? data : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
