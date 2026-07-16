import { type AirDocument, confidenceFor, type Operation } from "@anvil/air";
import type { AnvilManifest, OperationManifest } from "@anvil/compiler";
import type { EnrichmentPlan } from "@anvil/refinement";
import {
  type HarnessAgent,
  type HarnessFinding,
  HeuristicHarnessAgent,
  type ProbePlanQuestion,
} from "./agent.js";
import { EvidenceGraph } from "./evidence.js";
import { connectSource, type TransportFactory } from "./mcp-source.js";
import { sourceClassOf } from "./profiles.js";
import { type ReconcileDecision, reconcile } from "./reconcile.js";
import type { SourceConfig } from "./sources.js";

export interface EnrichOptions {
  agent?: HarnessAgent;
  transportFactory?: TransportFactory;
  /**
   * When given, enrichment is PLAN-DRIVEN: instead of sweeping every operation
   * against every source, it probes only the plan's targeted operations and
   * routes each question to the sources whose evidence pole matches its
   * `sourceClass` (code proves idempotency; docs describe intent). This is the
   * consume side of `anvil distill --as-enrich-plan` — the surface's UNCERTAIN
   * operations, asked the sharp question, at the tier that can answer it.
   */
  plan?: EnrichmentPlan;
}

/** One (operation, question) probe to run against a source, after plan routing. */
interface RoutedProbe {
  op: Operation;
  question?: ProbePlanQuestion;
}

/**
 * The probes to run against ONE source. Plan-driven: each target's questions,
 * routed to this source only when its `sourceClass` matches the source's pole
 * (`any` matches every source). Un-planned: every operation, generic query.
 */
function probesForSource(
  air: AirDocument,
  config: SourceConfig,
  plan: EnrichmentPlan | undefined,
): RoutedProbe[] {
  if (!plan) return air.operations.map((op) => ({ op }));
  const cls = sourceClassOf(config.system);
  const byId = new Map(air.operations.map((o) => [o.id, o]));
  const out: RoutedProbe[] = [];
  for (const target of plan.targets) {
    const op = byId.get(target.operationId);
    if (!op) continue;
    for (const q of target.questions) {
      if (q.sourceClass === "any" || q.sourceClass === cls) {
        out.push({ op, question: { queries: q.queries, predicate: q.predicate } });
      }
    }
  }
  return out;
}

export interface OperationEnrichment {
  operationId: string;
  canonicalName: string;
  priorConfidence: number;
  newConfidence: number;
  decisions: ReconcileDecision[];
}

export interface EnrichmentReport {
  sources: string[];
  operations: OperationEnrichment[];
  /** A proposed manifest patch — NOT applied. Review, then `anvil compile --manifest`. */
  proposedManifest: AnvilManifest;
  graph: EvidenceGraph;
  /** Plan-driven only: the operations the plan targeted (the rest were never probed). */
  targetedOperationIds?: string[];
}

/**
 * Connect to the configured published MCP servers, gather evidence for each
 * operation, and produce a *proposed* manifest patch. This never mutates AIR:
 * enrichment is propose-only and approval-gated (spec §17). Errors from any one
 * source are isolated so a flaky connector doesn't sink the run.
 */
export async function runEnrichment(
  air: AirDocument,
  sources: SourceConfig[],
  options: EnrichOptions = {},
): Promise<EnrichmentReport> {
  const agent = options.agent ?? new HeuristicHarnessAgent();
  const plan = options.plan;
  const graph = new EvidenceGraph();
  const connected: string[] = [];
  // operationId -> all findings across every source.
  const findingsByOp = new Map<string, HarnessFinding[]>();

  for (const config of sources) {
    let source: Awaited<ReturnType<typeof connectSource>> | undefined;
    try {
      source = await connectSource(config, options.transportFactory);
      const tools = await source.listTools();
      connected.push(config.id);
      for (const { op, question } of probesForSource(air, config, plan)) {
        const findings = await agent.probe({ op, source, config, tools, question });
        for (const f of findings) graph.add(op.id, f.evidence);
        const list = findingsByOp.get(op.id) ?? [];
        list.push(...findings);
        findingsByOp.set(op.id, list);
      }
    } catch {
      // Isolate connector failures; the enrichment continues with other sources.
    } finally {
      await source?.close().catch(() => {});
    }
  }

  const proposed: Record<string, OperationManifest> = {};
  const operations: OperationEnrichment[] = [];

  // In plan mode only the targeted operations were probed — report exactly those,
  // in the plan's priority order, so the output mirrors what was investigated.
  const byId = new Map(air.operations.map((o) => [o.id, o]));
  const targetedIds = plan
    ? [...new Set(plan.targets.map((t) => t.operationId))].filter((id) => byId.has(id))
    : undefined;
  const reported = targetedIds
    ? (targetedIds.map((id) => byId.get(id) as Operation) as Operation[])
    : air.operations;

  for (const op of reported) {
    const findings = findingsByOp.get(op.id) ?? [];
    const { patch, decisions } = reconcile(op, findings);
    if (Object.keys(patch).length > 0) proposed[op.canonicalName] = patch;
    // Confidence is resolved *per semantic*, not as one node-wide number: for each
    // predicate the harness actually investigated, compare the confidence before
    // and after adding its claims. The report surfaces the strongest such lift, so
    // "confidence rose" means we learned more about a specific semantic — never
    // that an "exists" claim inflated an unrelated "idempotency.mode".
    const touched = new Set(graph.claimsFor(op.id).map((c) => c.predicate));
    const after = { claims: [...op.evidence.claims, ...graph.claimsFor(op.id)] };
    let priorConfidence = 0;
    let newConfidence = 0;
    for (const predicate of touched) {
      const before = confidenceFor(op.evidence, predicate);
      const now = confidenceFor(after, predicate);
      if (now - before >= newConfidence - priorConfidence) {
        priorConfidence = before;
        newConfidence = now;
      }
    }
    operations.push({
      operationId: op.id,
      canonicalName: op.canonicalName,
      priorConfidence,
      newConfidence,
      decisions,
    });
  }

  return {
    sources: connected,
    operations,
    proposedManifest: { operations: proposed, workflows: {} },
    graph,
    targetedOperationIds: targetedIds,
  };
}
