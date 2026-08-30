---
name: refinement-skill-rehome-resource
description: Contract and investigation method for the rehome-resource skill — writes resource on a operation target from single evidence. Read this before working a resource_contradicted_by_own_name deficiency.
---

# Skill: rehome-resource (v1)

**Triggers:** `resource_contradicted_by_own_name`
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
- May assert claim predicates: `operation.resource`
- May write ONLY these target-relative fields: `resource`
- Structural keys (`type`, `required`, `schema`, `enum`, …) are never writable.

## Constraints
- do_not_loosen_safety
- do_not_invent_business_rules
- preserve_domain_terms

## Validation (all must pass)
- `patch_within_boundary`
- `no_semantic_schema_change`
- `claims_from_allowed_sources`
- `evidence_meets_minimum_strength`
- `evidence_supports_value`
- `evidence_meets_verification`
- `resource_grounded_in_contract`

## Context assembled for you
- parent_operation
- capability
- source_evidence

## Executor's job
Ground every asserted value in admissible evidence.

## Investigation method
A repeatable procedure — the *how*, not just the constraints. Open a case
(`anvil case open <dir> <target-key>`) and work it in phases:

1. _(Researcher)_ Read the path, the name text, and the sibling operations. Establish what entity this operation actually acts on — not which segment happens to precede it.
2. _(Researcher)_ Check for a synonym pair (hook/webhook, content/file): when the name and the path spell the SAME entity differently, the path's word is usually still the right resource and no change is needed.
3. _(Claim extractor)_ Record claims naming the entity, each tied to a source span; keep contradictions visible.
4. _(Synthesizer)_ Propose ONLY `resource`, and only a word the operation's own path or name text states — the deterministic grounding check refuses anything else. When the evidence does not decide, decline honestly.
5. _(Critic)_ Try to falsify the choice: a scope segment (org, repo, user) that merely corroborates the name is the audited failure mode, not a resource.
6. _(Test writer)_ Record the routing checks the re-home should improve; the closure a reviewer applies is the manifest `name: { resource }` override.

If you cannot satisfy the evidence policy and stay inside the output boundary,
return **no proposal** — that is the correct, honest outcome.
