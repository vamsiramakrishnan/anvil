import {
  type Claim,
  claimReliability,
  confidenceFor,
  evidenceConfidence,
  SOURCE_RELIABILITY,
} from "@anvil/air";

/**
 * Reliability of each evidence source kind is defined once, in `@anvil/air`
 * (`SOURCE_RELIABILITY`), so the reconciler's asymmetric-trust gate and the
 * confidence aggregate weigh sources the same way. Re-exported here for the
 * harness's callers.
 */
export const RELIABILITY = SOURCE_RELIABILITY;

/** Reliability of the source behind a claim: explicit, else the per-kind default. */
export const reliabilityOf = claimReliability;

/**
 * Accumulates claims per subject (operation id). Confidence is *derived* by the
 * one canonical, predicate-scoped resolver in `@anvil/air` — the harness carries
 * no second combination rule. Reliability (source trust) stays a distinct axis
 * because it gates the reconciler, which is a different question from confidence
 * in a value.
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

  /** Confidence in one semantic, derived from this subject's harness-gathered claims. */
  confidenceFor(subject: string, predicate: string): number {
    return confidenceFor({ claims: this.claimsFor(subject) }, predicate);
  }

  /** Display-only coverage summary across this subject's harness claims. */
  coverage(subject: string): number {
    return evidenceConfidence({ claims: this.claimsFor(subject) });
  }
}
