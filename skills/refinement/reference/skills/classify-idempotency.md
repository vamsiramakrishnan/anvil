---
name: refinement-skill-classify-idempotency
description: Contract and investigation method for the classify-idempotency skill — writes idempotency_mode, idempotency_mechanism, idempotency_key, idempotency_key_derivation, retry_basis on a operation target from authoritative evidence. Read this before working a mutation_effect_unproven or retry_basis_unproven or contested_safety_semantic deficiency.
---

# Skill: classify-idempotency (v1)

**Triggers:** `mutation_effect_unproven`, `retry_basis_unproven`, `contested_safety_semantic`
**Target:** `operation`

## Evidence policy
- Admissible sources: `source_impl`, `test_fixture`, `spec`, `doc_example`, `recorded_traffic`, `incident`
- Minimum aggregate strength: **authoritative**
  (`single` = one source · `corroborated` = two independent sources · `authoritative`
  = one implementation/recorded-traffic source).
- Minimum verification: **verified**
  (`verified` = a source Anvil re-hashed itself · `allow_unverified` = a caller-supplied
  excerpt is acceptable). Enforced per patched value by `evidence_meets_verification`.
- Per-field verification overrides: none.

## Output boundary
- May assert claim predicates: `operation.idempotency_mode`, `operation.retry_basis`
- May write ONLY these target-relative fields: `idempotency_mode`, `idempotency_mechanism`, `idempotency_key`, `idempotency_key_derivation`, `retry_basis`
- Structural keys (`type`, `required`, `schema`, `enum`, …) are never writable.

## Constraints
- do_not_loosen_safety
- do_not_invent_business_rules

## Validation (all must pass)
- `patch_within_boundary`
- `no_semantic_schema_change`
- `claims_from_allowed_sources`
- `evidence_meets_minimum_strength`
- `evidence_supports_value`
- `evidence_meets_verification`
- `idempotency_carrier_resolves`

## Context assembled for you
- parent_operation
- source_evidence
- capability

## Executor's job
Ground every asserted value in admissible evidence.

## Investigation method
A repeatable procedure — the *how*, not just the constraints. Open a case
(`anvil case open <dir> <target-key>`) and work it in phases:

1. _(Researcher)_ Gather evidence from admissible sources: source_impl, test_fixture, spec, doc_example, recorded_traffic, incident.
2. _(Claim extractor)_ Turn the evidence into atomic, sourced claims.
3. _(Synthesizer)_ Draft a patch that writes only: idempotency_mode, idempotency_mechanism, idempotency_key, idempotency_key_derivation, retry_basis.
4. _(Critic)_ Falsify each asserted value; keep only what the evidence supports.
5. _(Test writer)_ Record the checks that would prove the refinement.

If you cannot satisfy the evidence policy and stay inside the output boundary,
return **no proposal** — that is the correct, honest outcome.
