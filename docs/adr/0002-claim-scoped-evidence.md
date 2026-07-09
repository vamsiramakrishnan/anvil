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
(`supports`/`contradicts`/`supersedes` → claim id), and a `review` status.

- **Aggregate confidence is derived**, not stored: `evidenceConfidence(evidence)`
  is a pure noisy-OR over *active* (non-rejected, non-superseded) claims. It can
  never drift from its inputs, and rejected/superseded claims cannot inflate it.
- The harness `EvidenceGraph` now **delegates** confidence to that one function —
  the duplicate combination rule is gone. `reliability` (source trust) stays a
  separate axis because it gates the asymmetric-trust reconciler, which is a
  different question from confidence in a value.

## Consequences
- Confidence is explainable per claim; conflict resolves deterministically
  (tested: order-independence + supersession exclusion).
- Old bundles carrying `{ items, confidence }` load lossily (unknown keys
  stripped, `claims` defaults to `[]`); generated-output compatibility is not
  sacred at this stage.
