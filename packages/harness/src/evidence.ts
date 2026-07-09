import type { EvidenceItem, EvidenceKind } from "@anvil/air";

/**
 * Reliability of each evidence source (spec: "mock source priority" / evidence
 * graph). This is the backbone of the asymmetric-trust rule: enrichment that
 * *reduces* safety must be backed by high-reliability evidence.
 */
export const RELIABILITY: Record<EvidenceKind, number> = {
  recorded_traffic: 0.95,
  source_impl: 0.9,
  test_fixture: 0.85,
  spec: 0.7,
  postman: 0.6,
  incident: 0.6,
  doc_example: 0.5,
  inferred: 0.4,
  generated_mock: 0.3,
};

export function reliabilityOf(item: EvidenceItem): number {
  return item.confidence ?? RELIABILITY[item.kind];
}

/** Accumulates evidence per operation and rolls it up into a confidence score. */
export class EvidenceGraph {
  private readonly byOp = new Map<string, EvidenceItem[]>();

  add(operationId: string, item: EvidenceItem): void {
    const list = this.byOp.get(operationId) ?? [];
    list.push(item);
    this.byOp.set(operationId, list);
  }

  itemsFor(operationId: string): EvidenceItem[] {
    return this.byOp.get(operationId) ?? [];
  }

  operations(): string[] {
    return [...this.byOp.keys()];
  }

  /** The single most reliable piece of evidence for an operation (0 if none). */
  maxReliability(operationId: string): number {
    const items = this.itemsFor(operationId);
    return items.reduce((m, i) => Math.max(m, reliabilityOf(i)), 0);
  }

  /**
   * Combined confidence via noisy-OR: corroborating sources raise confidence,
   * but no single weak source can dominate. Bounded to [0, 0.99].
   */
  confidenceFor(operationId: string): number {
    const items = this.itemsFor(operationId);
    if (items.length === 0) return 0;
    const product = items.reduce((acc, i) => acc * (1 - reliabilityOf(i)), 1);
    return Math.min(0.99, 1 - product);
  }
}
