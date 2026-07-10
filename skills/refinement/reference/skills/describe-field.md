# Skill: describe-field (v1)

**Triggers:** `missing_field_description`
**Target:** `field`

## Evidence policy
- Admissible sources: `source_impl`, `test_fixture`, `spec`, `doc_example`, `postman`
- Minimum aggregate strength: **corroborated**
  (`single` = one source · `corroborated` = two independent sources · `authoritative`
  = one implementation/recorded-traffic source).
- Minimum verification: **allow_unverified**
  (`verified` = a source Anvil re-hashed itself · `allow_unverified` = a caller-supplied
  excerpt is acceptable). Enforced per patched value by `evidence_meets_verification`.
- Per-field verification overrides: none.

## Output boundary
- May assert claim predicates: `field.description`
- May write ONLY these target-relative fields: `description`
- Structural keys (`type`, `required`, `schema`, `enum`, …) are never writable.

## Constraints
- do_not_invent_business_rules
- do_not_change_field_type
- do_not_change_requiredness
- preserve_domain_terms

## Validation (all must pass)
- `patch_within_boundary`
- `no_semantic_schema_change`
- `claims_from_allowed_sources`
- `evidence_meets_minimum_strength`
- `evidence_supports_value`
- `evidence_meets_verification`
- `description_nonempty`
- `description_not_tautological`

## Context assembled for you
- parent_operation
- field_schema
- sibling_fields
- source_evidence

## Executor's job
Read the field's parent operation and its sibling fields, then find where the field's meaning is actually stated: a source-code comment or type, a contract-test fixture, the spec's own description, a doc example, or a Postman description. Emit one `field.description` claim per source you found and set `description` to the wording they corroborate. Preserve the domain's own terms; never invent a business rule, never merely restate the field's name, never touch its type or requiredness. If two independent sources do not agree, propose nothing.

## Investigation method
A repeatable procedure — the *how*, not just the constraints. Open a case
(`anvil case open <dir> <target-key>`) and work it in phases:

1. _(Researcher)_ Locate the field's declaration in the source implementation.
2. _(Researcher)_ Trace every read and write of the field through the code.
3. _(Researcher)_ Inspect its validation and serialization — where it is checked and where it leaves the system.
4. _(Researcher)_ Inspect the tests that exercise the field, and any user-facing output that contains it.
5. _(Claim extractor)_ Identify contradictions between sources before drawing conclusions.
6. _(Claim extractor)_ Produce atomic claims, each with an exact source span and predicate.
7. _(Synthesizer)_ Draft a description that contains ONLY clauses supported by an accepted claim.
8. _(Critic)_ Try to falsify each clause; drop any the evidence does not support.
9. _(Test writer)_ Run the generated deterministic validation and record the checks that prove the change.

If you cannot satisfy the evidence policy and stay inside the output boundary,
return **no proposal** — that is the correct, honest outcome.
