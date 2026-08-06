---
name: refinement-skill-document-pagination
description: Contract and investigation method for the document-pagination skill — writes pagination_style, pagination_cursor_param, pagination_next_field, pagination_items_field, pagination_page_size_param, pagination_max_page_size, pagination_default_page_size on a operation target from corroborated evidence. Read this before working a undocumented_pagination deficiency.
---

# Skill: document-pagination (v1)

**Triggers:** `undocumented_pagination`
**Target:** `operation`

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
- May assert claim predicates: `operation.pagination`
- May write ONLY these target-relative fields: `pagination_style`, `pagination_cursor_param`, `pagination_next_field`, `pagination_items_field`, `pagination_page_size_param`, `pagination_max_page_size`, `pagination_default_page_size`
- Structural keys (`type`, `required`, `schema`, `enum`, …) are never writable.

## Constraints
- do_not_invent_business_rules

## Validation (all must pass)
- `patch_within_boundary`
- `no_semantic_schema_change`
- `claims_from_allowed_sources`
- `evidence_meets_minimum_strength`
- `evidence_supports_value`
- `evidence_meets_verification`
- `pagination_binding_resolves`

## Context assembled for you
- parent_operation
- source_evidence
- capability

## Executor's job
Ground the continuation style and exact wire parameter, plus dotted response paths for items/next and any page-size parameter/default/maximum. Every request parameter must exist and every response path must resolve in the schema; never guess a size knob from a vague name.

## Investigation method
A repeatable procedure — the *how*, not just the constraints. Open a case
(`anvil case open <dir> <target-key>`) and work it in phases:

1. _(Researcher)_ Gather evidence from admissible sources: source_impl, test_fixture, spec, doc_example, postman.
2. _(Claim extractor)_ Turn the evidence into atomic, sourced claims.
3. _(Synthesizer)_ Draft a patch that writes only: pagination_style, pagination_cursor_param, pagination_next_field, pagination_items_field, pagination_page_size_param, pagination_max_page_size, pagination_default_page_size.
4. _(Critic)_ Falsify each asserted value; keep only what the evidence supports.
5. _(Test writer)_ Record the checks that would prove the refinement.

If you cannot satisfy the evidence policy and stay inside the output boundary,
return **no proposal** — that is the correct, honest outcome.
