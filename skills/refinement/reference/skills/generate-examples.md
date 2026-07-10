# Skill: generate-examples (v1)

**Triggers:** `required_field_no_example`
**Target:** `field`

## Evidence policy
- Admissible sources: `spec`, `source_impl`, `test_fixture`, `doc_example`, `postman`, `generated_mock`
- Minimum aggregate strength: **single**
  (`single` = one source · `corroborated` = two independent sources · `authoritative`
  = one implementation/recorded-traffic source).
- Minimum verification: **allow_unverified**
  (`verified` = a source Anvil re-hashed itself · `allow_unverified` = a caller-supplied
  excerpt is acceptable). Enforced per patched value by `evidence_meets_verification`.
- Per-field verification overrides: none.

## Output boundary
- May assert claim predicates: `field.example`
- May write ONLY these target-relative fields: `examples`
- Structural keys (`type`, `required`, `schema`, `enum`, …) are never writable.

## Constraints
- do_not_change_field_type
- do_not_change_requiredness

## Validation (all must pass)
- `patch_within_boundary`
- `no_semantic_schema_change`
- `claims_from_allowed_sources`
- `evidence_meets_minimum_strength`
- `evidence_supports_value`
- `evidence_meets_verification`
- `examples_validate_against_schema`

## Context assembled for you
- parent_operation
- field_schema
- source_evidence

## Executor's job
Find a realistic value for the field: a contract-test fixture, a doc or Postman example, or the field's own schema (enum / example / default). Emit a `field.example` claim and set `examples` to values that VALIDATE against the field schema. Prefer real, sourced values; a schema-derived value is acceptable and grounded. Never change the field's type or requiredness.

## Investigation method
A repeatable procedure — the *how*, not just the constraints. Open a case
(`anvil case open <dir> <target-key>`) and work it in phases:

1. _(Researcher)_ Look for a real value in fixtures, docs, or Postman; else use the field's own schema.
2. _(Claim extractor)_ Record the value as a claim tied to where it came from.
3. _(Synthesizer)_ Set `examples` to values that VALIDATE against the field schema.
4. _(Critic)_ Confirm each example satisfies the schema (type, enum, bounds).
5. _(Test writer)_ Record the argument-mapping check the example should improve.

If you cannot satisfy the evidence policy and stay inside the output boundary,
return **no proposal** — that is the correct, honest outcome.
