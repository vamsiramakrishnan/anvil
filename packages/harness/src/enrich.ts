import { type AirDocument, confidenceFor } from "@anvil/air";
import type { AnvilManifest, OperationManifest } from "@anvil/compiler";
import { type HarnessAgent, type HarnessFinding, HeuristicHarnessAgent } from "./agent.js";
import { EvidenceGraph } from "./evidence.js";
import { connectSource, type TransportFactory } from "./mcp-source.js";
import { type ReconcileDecision, reconcile } from "./reconcile.js";
import type { SourceConfig } from "./sources.js";

export interface EnrichOptions {
  agent?: HarnessAgent;
  transportFactory?: TransportFactory;
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
      for (const op of air.operations) {
        const findings = await agent.probe({ op, source, config, tools });
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

  for (const op of air.operations) {
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
  };
}
