# ADR-0002 — Claim-scoped evidence

**Status:** Accepted

## Context
Evidence was modeled twice and neither was claim-scoped:
- `air.Evidence = { items: EvidenceItem[]; confidence: number }` — a flat list
  plus a **stored aggregate** confidence no consumer could explain from its
  inputs (`0.6`, bumped to `0.95` by hand).
- The harness rolled items into confidence via **noisy-OR**, while the reconciler
  combined the *same* findings by a **max-reliability threshold** — two rules over
  two representations of one thing.

This is the "confidence number not attached to a specific claim" and "evidence
graph as an unstructured list" the architecture brief calls out.

## Decision
Evidence is a set of **claims**. A `Claim` carries `subject`, `predicate`,
`value`, `source`, `sourceRef`, `sourceRevision`, `method`, `confidence`,
`reliability`, `timestamp`, an optional `relation`
(`supports`/`contradicts`/`supersedes` → claim id, with `id` required when a
relation is present), and a `review` status.

Confidence is **resolved per semantic, never node-wide**:

- **`confidenceFor(evidence, predicate)`** is the safety-relevant resolver.
  Claims about *different* predicates never corroborate each other, so a strong
  `exists` can never inflate a weak `idempotency.mode`. Within a predicate,
  contradictions resolve deterministically: claims are grouped by asserted value,
  each group is a noisy-OR of its members' **effective weights**, and the
  best-supported value wins.
- **`effectiveWeight = confidence × reliability`**, so ten confident claims from a
  generated mock (reliability 0.3) cannot drive a semantic to certainty.
  `SOURCE_RELIABILITY` lives in `@anvil/air` and the harness re-exports it — one
  table, used by both the aggregate and the asymmetric-trust reconciler.
- **Relations are enforced.** `resolveActiveClaims` drops reviewed-out claims and
  any claim targeted by an active `supersedes` relation; dangling targets are
  ignored, not trusted.
- **`evidenceConfidence(evidence)`** remains, but only as a node-level **coverage
  summary for display/triage** — the *weakest* per-predicate confidence. It
  explicitly does **not** gate safety or approval.

The harness `EvidenceGraph` delegates to these functions — the old duplicate
noisy-OR/threshold rule is gone.

## Consequences
- Confidence is explainable per semantic; conflict, supersession, and unreliable
  sources resolve deterministically (all tested).
- Safety questions ask `confidenceFor(predicate)`; the node number is display-only.
- Old bundles carrying `{ items, confidence }` load lossily (unknown keys
  stripped, `claims` defaults to `[]`); generated-output compatibility is not
  sacred at this stage.
