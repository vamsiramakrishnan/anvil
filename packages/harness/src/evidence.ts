import { type Claim, type EvidenceKind, evidenceConfidence } from "@anvil/air";

/**
 * Reliability of each evidence *source kind* (spec: "mock source priority" /
 * evidence graph). This is the backbone of the asymmetric-trust rule: enrichment
 * that *reduces* safety must be backed by a high-reliability source. It weights
 * the source, distinct from a claim's own `confidence` in its value.
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

/** Reliability of the source behind a claim: explicit, else the per-kind default. */
export function reliabilityOf(claim: Claim): number {
  return claim.reliability ?? RELIABILITY[claim.source];
}

/**
 * Accumulates claims per subject (operation id) and rolls them into a confidence
 * score. Confidence is *derived* by the one canonical function in `@anvil/air`
 * (`evidenceConfidence`) — the harness no longer carries a second, divergent
 * combination rule. Reliability (source trust) stays here because it gates the
 * reconciler, a separate concern from confidence in a value.
 */
export class EvidenceGraph {
  private readonly bySubject = new Map<string, Claim[]>();

  add(subject: string, claim: Claim): void {
    const list = this.bySubject.get(subject) ?? [];
    list.push(claim);
    this.bySubject.set(subject, list);
  }

  claimsFor(subject: string): Claim[] {
    return this.bySubject.get(subject) ?? [];
  }

  subjects(): string[] {
    return [...this.bySubject.keys()];
  }

  /** The single most reliable source for a subject (0 if none). */
  maxReliability(subject: string): number {
    return this.claimsFor(subject).reduce((m, c) => Math.max(m, reliabilityOf(c)), 0);
  }

  /** Confidence derived from this subject's harness-gathered claims alone. */
  confidenceFor(subject: string): number {
    return evidenceConfidence({ claims: this.claimsFor(subject) });
  }
}
