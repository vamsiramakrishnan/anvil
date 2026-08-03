---
name: refinement-skill-author-routing-phrases
description: Contract and investigation method for the author-routing-phrases skill — writes intent_examples on a capability target from single evidence. Read this before working a capability_missing_routing_phrases deficiency.
---

# Skill: author-routing-phrases (v1)

**Triggers:** `capability_missing_routing_phrases`
**Target:** `capability`

## Evidence policy
- Admissible sources: `spec`, `doc_example`, `postman`
- Minimum aggregate strength: **single**
  (`single` = one source · `corroborated` = two independent sources · `authoritative`
  = one implementation/recorded-traffic source).
- Minimum verification: **allow_unverified**
  (`verified` = a source Anvil re-hashed itself · `allow_unverified` = a caller-supplied
  excerpt is acceptable). Enforced per patched value by `evidence_meets_verification`.
- Per-field verification overrides: none.

## Output boundary
- May assert claim predicates: `capability.intent_examples`
- May write ONLY these target-relative fields: `intent_examples`
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

## Context assembled for you
- capability
- source_evidence

## Executor's job
Ground every asserted value in admissible evidence.

## Investigation method
A repeatable procedure — the *how*, not just the constraints. Open a case
(`anvil case open <dir> <target-key>`) and work it in phases:

1. _(Researcher)_ Gather evidence from admissible sources: spec, doc_example, postman.
2. _(Claim extractor)_ Turn the evidence into atomic, sourced claims.
3. _(Synthesizer)_ Draft a patch that writes only: intent_examples.
4. _(Critic)_ Falsify each asserted value; keep only what the evidence supports.
5. _(Test writer)_ Record the checks that would prove the refinement.

If you cannot satisfy the evidence policy and stay inside the output boundary,
return **no proposal** — that is the correct, honest outcome.
