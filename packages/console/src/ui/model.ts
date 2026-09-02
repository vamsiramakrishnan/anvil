import type { ConsoleResponse } from "../contract.js";

/**
 * The UI's pure model: hash routing, theme, redaction, and the decision-queue
 * join. Nothing here computes truth — counts, verdicts, deltas, and budgets
 * come from the contract's read models; this file only joins them by id and
 * decides what a reviewer may select in bulk (a narrowing, never a widening).
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

/* --------------------------- the decision join --------------------------- */

export type Inspector = ConsoleResponse<"bundle">;
type OperationRow = Inspector["operations"][number];
type CapabilityRow = Inspector["capabilities"][number];
type WorkflowRow = Inspector["workflows"][number];
export type Queue = ConsoleResponse<"queue">;
export type DecisionItem = Queue["items"][number];
export type PackList = ConsoleResponse<"packs">;
type PackView = PackList[number];
export type PackItem = PackView["items"][number];
export type Benchmark = ConsoleResponse<"benchmark">;
export type Cluster = NonNullable<Benchmark>["confusion"]["clusters"][number];
export type RoutingDelta = NonNullable<PackItem["delta"]>;

export type DecisionRow =
  | {
      kind: "operation";
      key: string;
      id: string;
      title: string;
      item: DecisionItem;
      op?: OperationRow;
    }
  | {
      kind: "capability";
      key: string;
      id: string;
      title: string;
      item: DecisionItem;
      cap?: CapabilityRow;
    }
  | {
      kind: "workflow";
      key: string;
      id: string;
      title: string;
      item: DecisionItem;
      wf?: WorkflowRow;
    }
  | { kind: "refinement"; key: string; id: string; title: string; item: DecisionItem }
  | { kind: "pack"; key: string; id: string; title: string; pack: PackView; refinement: PackItem }
  | { kind: "cluster"; key: string; id: string; title: string; cluster: Cluster };

export function buildRows(
  queue: Queue,
  inspector: Inspector,
  packs: PackList,
  benchmark: Benchmark,
): DecisionRow[] {
  const ops = new Map(inspector.operations.map((op) => [op.id, op]));
  const caps = new Map(inspector.capabilities.map((cap) => [cap.id, cap]));
  const wfs = new Map(inspector.workflows.map((wf) => [wf.id, wf]));
  const rows: DecisionRow[] = queue.items.map((item): DecisionRow => {
    const base = { key: `${item.kind}:${item.id}`, id: item.id, title: item.title, item };
    if (item.kind === "operation") return { kind: "operation", ...base, op: ops.get(item.id) };
    if (item.kind === "capability") return { kind: "capability", ...base, cap: caps.get(item.id) };
    if (item.kind === "workflow") return { kind: "workflow", ...base, wf: wfs.get(item.id) };
    return { kind: "refinement", ...base };
  });
  for (const pack of packs) {
    const decided = new Set(pack.receipts.map((r) => r.refinementId));
    for (const refinement of pack.items) {
      if (decided.has(refinement.refinementId)) continue;
      if (refinement.status === "approved" || refinement.status === "rejected") continue;
      rows.push({
        kind: "pack",
        key: `pack:${pack.hash}:${refinement.refinementId}`,
        id: refinement.refinementId,
        title: `${refinement.skill} → ${targetLabel(refinement.target)}`,
        pack,
        refinement,
      });
    }
  }
  for (const cluster of benchmark?.confusion.clusters ?? []) {
    rows.push({
      kind: "cluster",
      key: `cluster:${cluster.id}`,
      id: cluster.id,
      title: `${cluster.members.length} confusable tools, ${cluster.taskCount} tasks`,
      cluster,
    });
  }
  return rows;
}

export function targetLabel(target: PackItem["target"]): string {
  switch (target.kind) {
    case "service":
      return "service";
    case "capability":
      return `capability ${target.capabilityId}`;
    case "operation":
      return target.operationId;
    case "field":
    case "enum":
      return `${target.operationId}#${target.path}`;
    case "error":
      return `${target.operationId} error ${target.code}`;
    case "workflow":
      return `workflow ${target.workflowId}`;
    case "group":
      return `group ${target.groupId}`;
  }
}

/**
 * Why a row can never be picked up by a bulk policy. Anything non-idempotent
 * or destructive is barred here, before any predicate runs — a policy can
 * only narrow this set, never reach past it.
 */
export function bulkBarrier(row: DecisionRow): string | undefined {
  switch (row.kind) {
    case "operation": {
      const op = row.op;
      if (!op) return "not present in the inspector";
      if (op.state === "blocked") return "blocked — resolve its diagnostics and recompile";
      if (op.effect.kind === "mutation" && op.idempotency.mode === "none") {
        return "non-idempotent mutation — one at a time, with --confirm";
      }
      if (op.effect.risk === "destructive" || op.effect.action === "delete") {
        return "destructive — never bulk-approved";
      }
      if (op.effect.kind === "mutation" && !op.effect.reversible) {
        return "irreversible mutation — never bulk-approved";
      }
      if (op.confirmation.required) return "requires confirmation — decide it individually";
      return undefined;
    }
    case "capability":
      if (!row.cap) return "not present in the inspector";
      if (row.cap.budget.verdict !== "ok") {
        return `budget ${row.cap.budget.verdict} — needs an individual decision`;
      }
      return undefined;
    case "workflow":
      return "workflows are decided by recompiling; the contract has no approve route";
    case "refinement":
      return "a deficiency is resolved by `anvil refine run`, not approved";
    case "pack":
      if (row.refinement.tier === "reject") return "tier reject — the pack itself refuses it";
      if (row.refinement.delta && row.refinement.delta.upliftPts <= 0) {
        return `measured delta ${row.refinement.delta.upliftPts} pts — never bulk-approved`;
      }
      return undefined;
    case "cluster":
      return "a case file is exported, not approved";
  }
}

export interface Policy {
  id: string;
  label: string;
  selects: (row: DecisionRow) => boolean;
}

const evidenceBacked = (item: DecisionItem) =>
  item.evidence.some((claim) => claim.source !== "inferred" && claim.confidence >= 0.8);

export const POLICIES: readonly Policy[] = [
  {
    id: "safe-reads",
    label: "reads · naturally idempotent · evidence-backed",
    selects: (row) =>
      row.kind === "operation" &&
      row.op?.effect.kind === "read" &&
      row.op.idempotency.mode === "natural" &&
      evidenceBacked(row.item),
  },
  {
    id: "positive-delta",
    label: "positive measured delta",
    selects: (row) =>
      row.kind === "pack" &&
      row.refinement.delta !== undefined &&
      row.refinement.delta.upliftPts > 0,
  },
  {
    id: "budget-ok",
    label: "capabilities within budget",
    selects: (row) => row.kind === "capability" && row.cap?.budget.verdict === "ok",
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
