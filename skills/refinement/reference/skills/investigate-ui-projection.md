---
name: refinement-skill-investigate-ui-projection
description: Contract and investigation method for the investigate-ui-projection skill — writes description on a operation target from authoritative evidence. Read this before working a ui_projection_contract deficiency.
---

# Skill: investigate-ui-projection (v1)

**Triggers:** `ui_projection_contract`
**Target:** `operation`

## Evidence policy
- Admissible sources: `source_impl`, `test_fixture`, `spec`, `doc_example`, `postman`, `recorded_traffic`, `incident`
- Minimum aggregate strength: **authoritative**
  (`single` = one source · `corroborated` = two independent sources · `authoritative`
  = one implementation/recorded-traffic source).
- Minimum verification: **verified**
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

1. _(Researcher)_ Trace every supplied frontend caller to the handler and record the user intent separately from the screen layout.
2. _(Researcher)_ Trace the handler through serializers, downstream calls, persistence writes, authorization checks, and idempotency handling.
3. _(Researcher)_ Inspect contract/integration tests, ownership, versioning, and sibling domain APIs to learn whether behavior is stable outside this view.
4. _(Claim extractor)_ Record separate claims for business intent, UI-only composition, hidden writes, authority, ownership, and lifecycle; preserve contradictions.
5. _(Synthesizer)_ Only when verified evidence proves a stable capability, propose a precise description grounded by that evidence. Otherwise emit no proposal and state what evidence or owner decision is missing.
6. _(Critic)_ Try to falsify stability: look for screen-specific fields, per-view branching, duplicate domain APIs, undocumented persistence, and frontend-only version coupling.
7. _(Test writer)_ Record contract, authorization, write-safety, and routing checks that would prove the retained capability; never invent a replacement facade.

If you cannot satisfy the evidence policy and stay inside the output boundary,
return **no proposal** — that is the correct, honest outcome.
