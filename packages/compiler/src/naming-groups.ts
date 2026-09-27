import { type Operation, snakeCase } from "@anvil/air";

export const FORMAT_SUFFIX = /\.(json|xml|csv|ya?ml|txt|html?|proto)$/i;

/**
 * Every member's path tokens, and how many members contain each token and
 * each unordered token pair, built once per collision group. The candidate
 * rules below ask "does any other member contain this?", which against these
 * counts is one lookup instead of a scan of the group; a Microsoft Graph
 * compile has collision groups of thousands of operations.
 */
export interface GroupTokenIndex {
  size: number;
  /** Clean path tokens per member, in path order (duplicates kept). */
  clean: Map<Operation, string[]>;
  /** Clean path tokens plus `by_<param>` tokens per member, in path order. */
  full: Map<Operation, string[]>;
  cleanCount: Map<string, number>;
  fullCount: Map<string, number>;
  pairCount: Map<string, number>;
}

export const pairKey = (a: string, b: string): string =>
  a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;

export function groupTokenIndex(group: readonly Operation[]): GroupTokenIndex {
  const index: GroupTokenIndex = {
    size: group.length,
    clean: new Map(),
    full: new Map(),
    cleanCount: new Map(),
    fullCount: new Map(),
    pairCount: new Map(),
  };
  const bump = (counts: Map<string, number>, key: string) =>
    counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const op of group) {
    const clean = cleanPathTokens(op.sourceRef.path);
    const full = [...clean, ...paramTokens(op.sourceRef.path)];
    index.clean.set(op, clean);
    index.full.set(op, full);
    for (const t of new Set(clean)) bump(index.cleanCount, t);
    const distinct = [...new Set(full)];
    for (const t of distinct) bump(index.fullCount, t);
    for (let i = 0; i < distinct.length; i++) {
      for (let j = i + 1; j < distinct.length; j++) {
        bump(index.pairCount, pairKey(distinct[i] as string, distinct[j] as string));
      }
    }
  }
  return index;
}

/** Concrete path segments as cleaned word-tokens: format suffix stripped, RPC
 * dotted segments split into their parts. So a distinguishing token is always
 * a real word (`admin`, `local`), never a raw `Messages.json` or a whole
 * dotted method — the same cleaning the derived names already got. */
function cleanPathTokens(path: string | undefined): string[] {
  return (path ?? "")
    .split("/")
    .filter((s) => s && !s.startsWith("{"))
    .flatMap((s) => s.replace(FORMAT_SUFFIX, "").split(".").filter(Boolean));
}

/** Path parameter names as `by_<name>` pseudo-tokens (`/refunds/{refund}` →
 * `by_refund`). Concrete tokens alone cannot distinguish routes that differ
 * only in their parameters — Stripe's `/application_fees/{fee}/refunds/{id}`
 * vs `/application_fees/{id}/refunds` clean to identical token lists — and the
 * old method+counter fallback produced the meaningless `post`/`post_2` names a
 * consuming agent cannot choose between. */
function paramTokens(path: string | undefined): string[] {
  return (path ?? "")
    .split("/")
    .filter((s) => s.startsWith("{") && s.endsWith("}"))
    .map((s) => `by_${snakeCase(s.slice(1, -1))}`);
}
