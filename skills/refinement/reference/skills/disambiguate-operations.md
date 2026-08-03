---
name: refinement-skill-disambiguate-operations
description: Contract and investigation method for the disambiguate-operations skill — writes description on a operation target from single evidence. Read this before working a indistinct_operation_descriptions deficiency.
---

# Skill: disambiguate-operations (v1)

**Triggers:** `indistinct_operation_descriptions`
**Target:** `operation`

## Evidence policy
- Admissible sources: `spec`, `source_impl`, `test_fixture`, `doc_example`, `postman`
- Minimum aggregate strength: **single**
  (`single` = one source · `corroborated` = two independent sources · `authoritative`
  = one implementation/recorded-traffic source).
- Minimum verification: **allow_unverified**
  (`verified` = a source Anvil re-hashed itself · `allow_unverified` = a caller-supplied
  excerpt is acceptable). Enforced per patched value by `evidence_meets_verification`.
- Per-field verification overrides: none.

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
- `evidence_meets_verification`
- `description_nonempty`
- `description_not_tautological`

## Context assembled for you
- parent_operation
- capability
- source_evidence

## Executor's job
Ground every asserted value in admissible evidence.

## Investigation method
A repeatable procedure — the *how*, not just the constraints. Open a case
(`anvil case open <dir> <target-key>`) and work it in phases:

1. _(Researcher)_ Gather evidence from admissible sources: spec, source_impl, test_fixture, doc_example, postman.
2. _(Claim extractor)_ Turn the evidence into atomic, sourced claims.
3. _(Synthesizer)_ Draft a patch that writes only: description.
4. _(Critic)_ Falsify each asserted value; keep only what the evidence supports.
5. _(Test writer)_ Record the checks that would prove the refinement.

If you cannot satisfy the evidence policy and stay inside the output boundary,
return **no proposal** — that is the correct, honest outcome.
