import type { AirDocument, Operation } from "@anvil/air";

/**
 * Distillation — the mechanistic half of stripping a bloated surface to its
 * eigenbasis. It is a whole-SURFACE analysis (about the SET of operations, not
 * any one node), a peer of `assess`, and like every detector it is deterministic
 * and agent-free: it never mutates AIR, it only *names* which operations are the
 * essential basis and which are reconstructible from it.
 *
 * The model: an API surface is usually rank-deficient. A "view" endpoint carries
 * no new information — it is a projection of underlying reads
 * (`getOrderPage = get(order) ⊕ list(lineItems) ⊕ view(shipping)`). So the
 * eigenbasis splits by a hard asymmetry:
 *
 *   • Reads COLLAPSE. Group by (resource, action); one canonical read spans the
 *     cluster, the rest are `reconstructible` projections (by-status, summary,
 *     detail-view). The canonical is the most GENERAL — fewest required inputs.
 *   • Writes DO NOT collapse. Every mutation is its own basis vector — high
 *     variance, not reproducible from anything else — so all are kept. A cluster
 *     with more than one same-signature mutation is merely FLAGGED for review,
 *     never auto-dropped (dropping a write is never safe to do mechanically).
 *
 * The one thing a mechanical pass must not silently discard is intent: a
 * reconstructible read whose routing phrases appear on NO basis operation is a
 * `residualIntent` — coverage that would be lost. Those are exactly what the
 * Stage-2 coding-harness loop must adjudicate (keep, or re-home the intent).
 */

/** The eigen-coordinate of an operation: what it fundamentally IS. */
export interface OpSignature {
  effectKind: string;
  resource: string;
  action: string;
  /** Single-item read (a required path/key param) vs a collection read. A `get(id)`
   *  and a `list()` are DISTINCT coordinates, never projections of each other — some
   *  adapters (OData) label both `list`, so arity is what keeps them apart. */
  arity: "item" | "collection";
  reversible: boolean;
  risk: string;
}

export type DistilledRole = "basis" | "reconstructible" | "review";

export interface DistilledOp {
  operationId: string;
  toolName: string;
  capabilityId?: string;
  signature: OpSignature;
  role: DistilledRole;
  /** For a reconstructible read: the canonical basis op it is a projection of. */
  reconstructsFrom?: string;
  /** Routing phrases this op carries that appear on NO basis op (lost if dropped). */
  strandedIntents: string[];
  reason: string;
}

export interface RedundancyCluster {
  signature: string;
  canonical: string;
  members: string[];
}

export interface DistillationReport {
  total: number;
  basisSize: number;
  /** Fraction of operations that are NOT in the basis — the flab a clean strip removes. */
  reduction: number;
  basis: DistilledOp[];
  reconstructible: DistilledOp[];
  review: DistilledOp[];
  clusters: RedundancyCluster[];
  /** Intents reachable ONLY through reconstructible ops — the Stage-2 decisions. */
  residualIntents: string[];
  /** Capabilities whose BASIS still exceeds the tool budget — the grouping is a screen, not a basis. */
  overBudgetCapabilities: { capabilityId: string; basisTools: number }[];
}

const TOOL_BUDGET = 20;

/** Required-input count: the generality metric. Fewer required inputs ⇒ more general ⇒ the canonical read. */
function requiredInputs(op: Operation): number {
  const params = op.input.params.filter((p) => p.required).length;
  const body = op.input.body;
  const bodyReq =
    body?.projection === "fields"
      ? body.fields.filter((f) => f.required).length
      : body?.required
        ? 1
        : 0;
  return params + bodyReq;
}

function signatureOf(op: Operation): OpSignature {
  const addressesItem = op.input.params.some((p) => p.required && p.in === "path");
  return {
    effectKind: op.effect.kind,
    resource: op.effect.resource ?? "",
    action: op.effect.action,
    arity: addressesItem ? "item" : "collection",
    reversible: op.effect.reversible,
    risk: op.effect.risk,
  };
}

/** The clustering key: reads that share resource, action, AND arity are the same
 *  eigen-coordinate — a `get(id)` and a `list()` never merge. */
function readClusterKey(sig: OpSignature): string {
  return `${sig.resource}::${sig.action}::${sig.arity}`;
}

/**
 * Choose the canonical member of a read cluster: the most general (fewest required
 * inputs), then the most confidently named (shortest tool name as a stable proxy),
 * then lexicographic on id. Pure function of cluster membership — input order never
 * changes the result.
 */
function pickCanonical(ops: Operation[]): Operation {
  return [...ops].sort(
    (a, b) =>
      requiredInputs(a) - requiredInputs(b) ||
      a.mcp.toolName.length - b.mcp.toolName.length ||
      a.id.localeCompare(b.id),
  )[0] as Operation;
}

export function distill(air: AirDocument): DistillationReport {
  const ops = air.operations;
  const reads = ops.filter((o) => o.effect.kind === "read");
  const writes = ops.filter((o) => o.effect.kind !== "read");

  // Reads collapse by (resource, action).
  const readClusters = new Map<string, Operation[]>();
  for (const op of reads) {
    const key = readClusterKey(signatureOf(op));
    (readClusters.get(key) ?? readClusters.set(key, []).get(key))?.push(op);
  }

  const basisOps = new Set<string>();
  const canonicalByCluster = new Map<string, Operation>();
  for (const [key, group] of readClusters) {
    const canonical = pickCanonical(group);
    canonicalByCluster.set(key, canonical);
    basisOps.add(canonical.id);
  }
  // Every write is a basis vector.
  for (const w of writes) basisOps.add(w.id);

  // Intents carried by any basis op — used to detect stranded coverage.
  const basisIntents = new Set<string>();
  for (const op of ops) {
    if (basisOps.has(op.id))
      for (const i of op.skill.intentExamples) basisIntents.add(i.toLowerCase());
  }

  const distilled: DistilledOp[] = [];
  for (const op of ops) {
    const sig = signatureOf(op);
    const stranded = op.skill.intentExamples.filter((i) => !basisIntents.has(i.toLowerCase()));
    if (op.effect.kind !== "read") {
      distilled.push({
        operationId: op.id,
        toolName: op.mcp.toolName,
        capabilityId: op.capabilityId,
        signature: sig,
        role: "basis",
        strandedIntents: stranded,
        reason: op.effect.reversible
          ? `mutation (${sig.action}) — a distinct write, kept as basis`
          : `irreversible ${sig.risk} mutation — always basis`,
      });
      continue;
    }
    const key = readClusterKey(sig);
    const canonical = canonicalByCluster.get(key);
    if (canonical && canonical.id === op.id) {
      distilled.push({
        operationId: op.id,
        toolName: op.mcp.toolName,
        capabilityId: op.capabilityId,
        signature: sig,
        role: "basis",
        strandedIntents: [],
        reason: `canonical ${sig.action} of "${sig.resource}" — the most general read spans its projections`,
      });
    } else {
      distilled.push({
        operationId: op.id,
        toolName: op.mcp.toolName,
        capabilityId: op.capabilityId,
        signature: sig,
        role: "reconstructible",
        reconstructsFrom: canonical?.id,
        strandedIntents: stranded,
        reason: `projection of ${canonical?.id ?? "?"} — same (resource, action), reconstructible by field selection`,
      });
    }
  }

  // Same-signature write clusters: not dropped, but surfaced for human review.
  const writeSigCounts = new Map<string, Operation[]>();
  for (const w of writes) {
    const s = signatureOf(w);
    const k = `${s.resource}::${s.action}::${s.arity}`;
    (writeSigCounts.get(k) ?? writeSigCounts.set(k, []).get(k))?.push(w);
  }
  for (const [, group] of writeSigCounts) {
    if (group.length > 1) {
      for (const w of group) {
        const d = distilled.find((x) => x.operationId === w.id);
        if (d) {
          d.role = "review";
          d.reason = `${group.length} same-signature mutations (${signatureOf(w).action} ${signatureOf(w).resource}) — review for redundancy; never auto-dropped`;
        }
      }
    }
  }

  const clusters: RedundancyCluster[] = [];
  for (const [key, group] of readClusters) {
    if (group.length > 1) {
      clusters.push({
        signature: key,
        canonical: (canonicalByCluster.get(key) as Operation).id,
        members: group.map((o) => o.id).sort(),
      });
    }
  }

  const basis = distilled.filter((d) => d.role === "basis");
  const reconstructible = distilled.filter((d) => d.role === "reconstructible");
  const review = distilled.filter((d) => d.role === "review");
  const residualIntents = [...new Set(reconstructible.flatMap((d) => d.strandedIntents))].sort();

  // Per-capability basis size vs the tool budget.
  const basisPerCap = new Map<string, number>();
  for (const d of basis) {
    if (d.capabilityId) basisPerCap.set(d.capabilityId, (basisPerCap.get(d.capabilityId) ?? 0) + 1);
  }
  const overBudgetCapabilities = [...basisPerCap.entries()]
    .filter(([, n]) => n > TOOL_BUDGET)
    .map(([capabilityId, basisTools]) => ({ capabilityId, basisTools }))
    .sort((a, b) => b.basisTools - a.basisTools);

  return {
    total: ops.length,
    basisSize: basis.length,
    reduction: ops.length === 0 ? 0 : 1 - basis.length / ops.length,
    basis,
    reconstructible,
    review,
    clusters,
    residualIntents,
    overBudgetCapabilities,
  };
}

/** Human-readable distillation report — the Stage-2 loop reads this to decide. */
export function renderDistillation(r: DistillationReport): string {
  const pct = Math.round(r.reduction * 100);
  const lines: string[] = [
    `Distillation — ${r.total} operations → ${r.basisSize} basis (${pct}% reducible)`,
    "",
    `  basis           ${r.basis.length}   essential: canonical reads + every write`,
    `  reconstructible ${r.reconstructible.length}   read projections — leave review_required unless an intent is stranded`,
    `  review          ${r.review.length}   same-signature mutations — never auto-dropped`,
  ];
  if (r.clusters.length > 0) {
    lines.push("", "Redundant read clusters (canonical ⊇ projections):");
    for (const c of r.clusters.slice(0, 20)) {
      const proj = c.members.filter((m) => m !== c.canonical);
      lines.push(`  ${c.signature}  →  keep ${c.canonical}`);
      for (const m of proj) lines.push(`      drop ${m}`);
    }
  }
  if (r.residualIntents.length > 0) {
    lines.push(
      "",
      "⚠ Stranded intents — reachable ONLY via reconstructible ops (Stage-2 must decide):",
      ...r.residualIntents.slice(0, 20).map((i) => `  "${i}"`),
    );
  }
  if (r.overBudgetCapabilities.length > 0) {
    lines.push(
      "",
      "⚠ Capabilities whose BASIS still exceeds the tool budget (regroup — it's a screen, not a basis):",
      ...r.overBudgetCapabilities.map((c) => `  ${c.capabilityId}  ${c.basisTools} basis tools`),
    );
  }
  lines.push(
    "",
    r.reconstructible.length === 0 && r.overBudgetCapabilities.length === 0
      ? "Surface is at its eigenbasis — no reducible flab."
      : "Next: approve the basis, leave reconstructible review_required, adjudicate stranded intents.",
  );
  return lines.join("\n");
}
