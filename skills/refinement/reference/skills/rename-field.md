---
name: refinement-skill-rename-field
description: Contract and investigation method for the rename-field skill — writes agent_name, aliases on a field target from single evidence. Read this before working a weak_field_name or unit_ambiguous_field deficiency.
---

# Skill: rename-field (v1)

**Triggers:** `weak_field_name`, `unit_ambiguous_field`
**Target:** `field`

## Evidence policy
- Admissible sources: `source_impl`, `test_fixture`, `spec`, `doc_example`, `postman`
- Minimum aggregate strength: **single**
  (`single` = one source · `corroborated` = two independent sources · `authoritative`
  = one implementation/recorded-traffic source).
- Minimum verification: **allow_unverified**
  (`verified` = a source Anvil re-hashed itself · `allow_unverified` = a caller-supplied
  excerpt is acceptable). Enforced per patched value by `evidence_meets_verification`.
- Per-field verification overrides: none.

## Output boundary
- May assert claim predicates: `field.agent_name`, `field.aliases`
- May write ONLY these target-relative fields: `agent_name`, `aliases`
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
- `agent_field_name_valid`

## Context assembled for you
- parent_operation
- field_schema
- sibling_fields
- source_evidence

## Executor's job
Find the domain term and unit the implementation, tests, or docs use. Set `agent_name` to that clear term while preserving the exact wire `name`; add only evidence-backed `aliases`. Check sibling inputs for normalized collisions. This is a reviewed binding, not a wire-schema rename.

## Investigation method
A repeatable procedure — the *how*, not just the constraints. Open a case
(`anvil case open <dir> <target-key>`) and work it in phases:

1. _(Researcher)_ Gather evidence from admissible sources: source_impl, test_fixture, spec, doc_example, postman.
2. _(Claim extractor)_ Turn the evidence into atomic, sourced claims.
3. _(Synthesizer)_ Draft a patch that writes only: agent_name, aliases.
4. _(Critic)_ Falsify each asserted value; keep only what the evidence supports.
5. _(Test writer)_ Record the checks that would prove the refinement.

If you cannot satisfy the evidence policy and stay inside the output boundary,
return **no proposal** — that is the correct, honest outcome.
