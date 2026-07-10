# Skill: describe-operation (v1)

**Triggers:** `missing_operation_description`
**Target:** `operation`

## Evidence policy
- Admissible sources: `source_impl`, `test_fixture`, `spec`, `doc_example`, `postman`
- Minimum aggregate strength: **corroborated**
  (`single` = one source · `corroborated` = two independent sources · `authoritative`
  = one implementation/recorded-traffic source).

## Output boundary
- May assert claim predicates: `operation.description`
- May write ONLY these target-relative fields: `description`
- Structural keys (`type`, `required`, `schema`, `enum`, …) are never writable.

## Constraints
- do_not_invent_business_rules
- preserve_domain_terms

## Validation (all must pass)
- `patch_within_boundary`
- `no_semantic_schema_change`
- `claims_from_allowed_sources`
- `evidence_meets_minimum_strength`
- `evidence_supports_value`
- `description_nonempty`
- `description_not_tautological`

## Context assembled for you
- parent_operation
- source_evidence
- capability

## Executor's job
Establish what the operation does from the implementation, tests, or docs — enough to distinguish it from its siblings (this description feeds operation routing). Emit `operation.description` claims and set `description`. Do not invent behaviour the sources do not show.

If you cannot satisfy the evidence policy and stay inside the output boundary,
return **no proposal** — that is the correct, honest outcome.
