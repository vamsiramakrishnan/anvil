# Skill: enrich-errors (v1)

**Triggers:** `undocumented_error`, `error_retryability_unclear`
**Target:** `error`

## Evidence policy
- Admissible sources: `source_impl`, `test_fixture`, `spec`, `incident`, `doc_example`
- Minimum aggregate strength: **single**
  (`single` = one source · `corroborated` = two independent sources · `authoritative`
  = one implementation/recorded-traffic source).
- Minimum verification: **allow_unverified**
  (`verified` = a source Anvil re-hashed itself · `allow_unverified` = a caller-supplied
  excerpt is acceptable). Enforced per patched value by `evidence_meets_verification`.
- Per-field verification overrides: `retryable` → **verified**.

## Output boundary
- May assert claim predicates: `error.message`, `error.retryable`
- May write ONLY these target-relative fields: `message`, `retryable`
- Structural keys (`type`, `required`, `schema`, `enum`, …) are never writable.

## Constraints
- do_not_loosen_safety

## Validation (all must pass)
- `patch_within_boundary`
- `no_semantic_schema_change`
- `claims_from_allowed_sources`
- `evidence_meets_minimum_strength`
- `evidence_supports_value`
- `evidence_meets_verification`

## Context assembled for you
- parent_operation
- declared_error
- source_evidence

## Executor's job
Map the declared error to its real meaning from the implementation or tests: the human-facing `message`, and whether it is `retryable`. Emit `error.message` / `error.retryable` claims. Note the asymmetry: marking an error `retryable=true` LOOSENS safety and needs authoritative (implementation or recorded-traffic) evidence; tightening (`retryable=false`) is always safe.

## Investigation method
A repeatable procedure — the *how*, not just the constraints. Open a case
(`anvil case open <dir> <target-key>`) and work it in phases:

1. _(Researcher)_ Find where the error is raised and under what condition.
2. _(Researcher)_ Inspect tests and incidents that show whether a retry succeeds or duplicates work.
3. _(Claim extractor)_ Extract claims for the human message and for retryability, with sources.
4. _(Synthesizer)_ Set `message` and, ONLY when tightening, `retryable`. Loosening (retryable=true) needs authoritative evidence and defers to review.
5. _(Critic)_ Check the retryability direction against the evidence class before proposing.
6. _(Test writer)_ Record the error-recovery check the enrichment should improve.

If you cannot satisfy the evidence policy and stay inside the output boundary,
return **no proposal** — that is the correct, honest outcome.
