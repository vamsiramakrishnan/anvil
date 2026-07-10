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

## Investigation method
A repeatable procedure — the *how*, not just the constraints. Open a case
(`anvil case open <dir> <target-key>`) and work it in phases:

1. _(Researcher)_ Find the operation's handler and read what it actually does.
2. _(Researcher)_ Read sibling operations so the description distinguishes this one (it feeds routing).
3. _(Researcher)_ Inspect tests and docs that describe the operation's effect.
4. _(Claim extractor)_ Extract atomic claims about the operation's behaviour, with source spans.
5. _(Synthesizer)_ Draft a description from supported claims only; do not invent behaviour.
6. _(Critic)_ Falsify each clause and confirm the description is distinct from siblings.
7. _(Test writer)_ Record the routing checks the new description should improve.

If you cannot satisfy the evidence policy and stay inside the output boundary,
return **no proposal** — that is the correct, honest outcome.
