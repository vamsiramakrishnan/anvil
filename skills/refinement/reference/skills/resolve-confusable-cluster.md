---
name: refinement-skill-resolve-confusable-cluster
description: Contract and investigation method for the resolve-confusable-cluster skill — writes workflow, capability on a group target from single evidence. Read this before working a confusable_tool_cluster deficiency.
---

# Skill: resolve-confusable-cluster (v1)

**Triggers:** `confusable_tool_cluster`
**Target:** `group`

## Evidence policy
- Admissible sources: `spec`, `source_impl`, `test_fixture`, `doc_example`, `postman`, `recorded_traffic`
- Minimum aggregate strength: **single**
  (`single` = one source · `corroborated` = two independent sources · `authoritative`
  = one implementation/recorded-traffic source).
- Minimum verification: **allow_unverified**
  (`verified` = a source Anvil re-hashed itself · `allow_unverified` = a caller-supplied
  excerpt is acceptable). Enforced per patched value by `evidence_meets_verification`.
- Per-field verification overrides: none.

## Output boundary
- May assert claim predicates: `group.workflow`, `group.capability`
- May write ONLY these target-relative fields: `workflow`, `capability`
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
- `group_proposal_shape`
- `group_grant_respected`
- `group_supersedes_within_steps`
- `group_workflow_composes`
- `group_names_grounded`

## Context assembled for you
- group_members
- source_evidence

## Executor's job
Ground every asserted value in admissible evidence.

## Investigation method
A repeatable procedure — the *how*, not just the constraints. Open a case
(`anvil case open <dir> <target-key>`) and work it in phases:

1. _(Researcher)_ Read every member's name, description, params, and intent examples, and the mis-routed intents verbatim. Establish WHY the agent confuses them: variants of one read, steps of one task, or genuinely distinct operations with colliding vocabulary.
2. _(Researcher)_ If the members form a sequence (one's output feeds the next's required input), sketch the workflow: steps in order, each later step's required params bound as $.output.<field> of the previous step's real output schema.
3. _(Researcher)_ If the members are one task-shaped family rather than a sequence, sketch the capability: the member set (grant only), a name and intents in the members' own vocabulary.
4. _(Claim extractor)_ Record claims naming the chosen shape, each tied to a source; keep the evidence for sequences (docs describing the flow, traffic groupings) separate from vocabulary facts.
5. _(Synthesizer)_ Propose EXACTLY ONE of `workflow` or `capability`, with every operation reference inside the task's grant, supersedes only naming the proposal's own steps, and every name/intent grounded in the members' own vocabulary. When neither shape is real, decline honestly (insufficient_evidence) and say why in the summary — a decline is a first-class answer.
6. _(Critic)_ Try to falsify the composition: a binding whose field the previous step does not output, a superseded tool the composite cannot stand in for, a name that only relabels the confusion. Anvil will re-run the routing benchmark over your proposal and refuse a negative delta with the numbers.
7. _(Test writer)_ Record which mis-routed intents your shape should flip to passing; the import's scored admission attaches the measured delta as evidence for the reviewer.

If you cannot satisfy the evidence policy and stay inside the output boundary,
return **no proposal** — that is the correct, honest outcome.
