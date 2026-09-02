import type { ConsoleResponse } from "../contract.js";

/**
 * The UI's pure model: hash routing, theme, redaction, and the bulk barrier.
 * Nothing here computes truth — counts, verdicts, deltas, and budgets come
 * from the contract's read models, and the decision queue's items arrive
 * with their `subject` already attached by the server; this file only keys
 * them and decides what a reviewer may select in bulk (a narrowing, never a
 * widening).
 */

/* ------------------------------- routing --------------------------------- */

export type View = "queue" | "inspect" | "confusion";

export type Route =
  | { view: "workspace" }
  | { view: View; bundleId: string; query: URLSearchParams };

export function parseHash(hash: string): Route {
  const [path = "", search = ""] = hash.replace(/^#/, "").split("?");
  const match = /^\/b\/([^/]+)\/(queue|inspect|confusion)$/.exec(path);
  if (!match) return { view: "workspace" };
  return {
    view: match[2] as View,
    bundleId: decodeURIComponent(match[1] ?? ""),
    query: new URLSearchParams(search),
  };
}

export function href(bundleId: string, view: View, query?: Record<string, string>): string {
  const base = `#/b/${encodeURIComponent(bundleId)}/${view}`;
  return query && Object.keys(query).length > 0 ? `${base}?${new URLSearchParams(query)}` : base;
}

/* -------------------------------- theme ---------------------------------- */

export type Theme = "light" | "dark";
export const THEME_KEY = "anvil-console-theme";
export const REVIEWER_KEY = "anvil-console-reviewer";

export function initialTheme(
  storage: Pick<Storage, "getItem"> | undefined,
  prefersDark: boolean,
): Theme {
  const stored = storage?.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : "light";
}

/* ------------------------------ redaction -------------------------------- */

/** Field names whose values are never rendered, whatever record they sit in. */
export const SECRET_KEY = /token|secret|password|authorization/i;
export const REDACTED = "[redacted]";

/** Deep-copies `value`, replacing anything stored under a secret-like key. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redact(child);
    }
    return out;
  }
  return value;
}

export function show(value: unknown): string {
  const safe = redact(value);
  if (safe === undefined) return "—";
  if (typeof safe === "string") return safe;
  return JSON.stringify(safe, null, 2);
}

/* ---------------------------- the read models ---------------------------- */

export type Inspector = ConsoleResponse<"bundle">;
export type Queue = ConsoleResponse<"queue">;
export type DecisionItem = Queue["items"][number];
export type PackList = ConsoleResponse<"packs">;
export type Benchmark = ConsoleResponse<"benchmark">;
export type Cluster = NonNullable<Benchmark>["confusion"]["clusters"][number];
export type RoutingDelta = NonNullable<PackList[number]["items"][number]["delta"]>;

/** A queue item plus the key the list, the selection, and the row's DOM id use. */
export type DecisionRow = DecisionItem & { key: string };

/** One key per decision: a refinement id can recur across packs, so a pack row keys on its pack too. */
export function rowKey(item: DecisionItem): string {
  return item.kind === "pack"
    ? `pack:${item.subject.packHash}:${item.id}`
    : `${item.kind}:${item.id}`;
}

export function toRows(queue: Queue): DecisionRow[] {
  return queue.items.map((item) => ({ ...item, key: rowKey(item) }));
}

/* ----------------------------- the bulk barrier -------------------------- */

/**
 * Why a row can never be picked up by a bulk policy. Anything non-idempotent
 * or destructive is barred here, before any predicate runs — a policy can
 * only narrow this set, never reach past it. Every field read is on the
 * item's own `subject`; the barrier never joins against another view.
 */
export function bulkBarrier(row: DecisionItem): string | undefined {
  switch (row.kind) {
    case "operation": {
      const { effect, idempotency, confirmation } = row.subject;
      if (row.blocking) return "blocked — resolve its diagnostics and recompile";
      if (effect.kind === "mutation" && idempotency.mode === "none") {
        return "non-idempotent mutation — one at a time, with --confirm";
      }
      if (effect.risk === "destructive" || effect.action === "delete") {
        return "destructive — never bulk-approved";
      }
      if (effect.kind === "mutation" && !effect.reversible) {
        return "irreversible mutation — never bulk-approved";
      }
      if (confirmation.required) return "requires confirmation — decide it individually";
      return undefined;
    }
    case "capability":
      if (row.subject.budget.verdict !== "ok") {
        return `budget ${row.subject.budget.verdict} — needs an individual decision`;
      }
      return undefined;
    case "workflow":
      return "workflows are decided by recompiling; the contract has no approve route";
    case "refinement":
      return "a deficiency is resolved by `anvil refine run`, not approved";
    case "pack":
      if (row.subject.tier !== "review") return `tier ${row.subject.tier} — not awaiting a receipt`;
      if (row.subject.delta && row.subject.delta.upliftPts <= 0) {
        return `measured delta ${row.subject.delta.upliftPts} pts — never bulk-approved`;
      }
      return undefined;
    case "cluster":
      return "a case file is exported, not approved";
  }
}

export interface Policy {
  id: string;
  label: string;
  selects: (row: DecisionItem) => boolean;
}

const evidenceBacked = (item: DecisionItem) =>
  item.evidence.some((claim) => claim.source !== "inferred" && claim.confidence >= 0.8);

export const POLICIES: readonly Policy[] = [
  {
    id: "safe-reads",
    label: "reads · naturally idempotent · evidence-backed",
    selects: (row) =>
      row.kind === "operation" &&
      row.subject.effect.kind === "read" &&
      row.subject.idempotency.mode === "natural" &&
      evidenceBacked(row),
  },
  {
    id: "positive-delta",
    label: "positive measured delta",
    selects: (row) =>
      row.kind === "pack" && row.subject.delta !== undefined && row.subject.delta.upliftPts > 0,
  },
  {
    id: "budget-ok",
    label: "capabilities within budget",
    selects: (row) => row.kind === "capability" && row.subject.budget.verdict === "ok",
  },
];

/** The rows a policy selects — always inside the un-barred set. */
export function selectByPolicy(rows: readonly DecisionRow[], policy: Policy): DecisionRow[] {
  return rows.filter((row) => bulkBarrier(row) === undefined && policy.selects(row));
}

/* -------------------------------- keys ----------------------------------- */

export const KEY_MAP: ReadonlyArray<readonly [string, string]> = [
  ["j / k", "next / previous row"],
  ["x", "select or deselect the row"],
  ["a", "approve the row (or focus what it still needs)"],
  ["r", "reject the row (or focus the reason)"],
  ["/", "focus the filter"],
  ["?", "this key map"],
  ["Esc", "close, or clear the selection"],
];

/** Status-ramp chip class for each thing the UI colours. */
export function tone(value: string): string {
  switch (value) {
    case "approved":
    case "passed":
    case "ok":
    case "improved":
      return "passed";
    case "review_required":
    case "proposed":
    case "review":
    case "validated":
      return "queued";
    case "blocked":
    case "warning":
    case "regressed":
      return value === "warning" ? "warning" : "blocked";
    case "rejected":
    case "error":
    case "reject":
      return "failed";
    case "generated":
    case "auto":
    case "neutral":
      return "running";
    case "deprecated":
      return "synthesized";
    default:
      return "queued";
  }
}
