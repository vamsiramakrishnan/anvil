# Skill: enrich-errors (v1)

**Triggers:** `undocumented_error`, `error_retryability_unclear`
**Target:** `error`

## Evidence policy
- Admissible sources: `source_impl`, `test_fixture`, `spec`, `incident`, `doc_example`
- Minimum aggregate strength: **single**
  (`single` = one source · `corroborated` = two independent sources · `authoritative`
  = one implementation/recorded-traffic source).

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

## Context assembled for you
- parent_operation
- declared_error
- source_evidence

## Executor's job
Map the declared error to its real meaning from the implementation or tests: the human-facing `message`, and whether it is `retryable`. Emit `error.message` / `error.retryable` claims. Note the asymmetry: marking an error `retryable=true` LOOSENS safety and needs authoritative (implementation or recorded-traffic) evidence; tightening (`retryable=false`) is always safe.

If you cannot satisfy the evidence policy and stay inside the output boundary,
return **no proposal** — that is the correct, honest outcome.
