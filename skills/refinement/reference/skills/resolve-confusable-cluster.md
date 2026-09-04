---
name: refinement-skill-resolve-confusable-cluster
description: Contract and investigation method for the resolve-confusable-cluster skill — writes workflow, capability, disambiguate on a group target from single evidence. Read this before working a confusable_tool_cluster deficiency.
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
- May assert claim predicates: `group.workflow`, `group.capability`, `group.disambiguate`
- May write ONLY these target-relative fields: `workflow`, `capability`, `disambiguate`
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
- `group_disambiguation_distinguishes`

## Context assembled for you
- group_members
- source_evidence

## Executor's job
Ground every asserted value in admissible evidence.

## Investigation method
A repeatable procedure — the *how*, not just the constraints. Open a case
(`anvil case open <dir> <target-key>`) and work it in phases:

1. _(Researcher)_ Read every member's name, description, params, and intent examples, and the mis-routed intents verbatim. Establish WHY the agent confuses them, because the answer decides the shape: steps of one task (workflow), one task-shaped family the catalog never names (capability), or — the common case — genuinely distinct operations whose descriptions do not state what distinguishes them (disambiguate).
2. _(Researcher)_ Default to `disambiguate` unless the evidence forces a shape. Removing or regrouping tools is a bigger claim than rewording them: a workflow asserts the members are steps of one outcome, a capability asserts they belong under one heading. If neither is true, the members are fine and their TEXT is the defect.
3. _(Researcher)_ For a disambiguation, name the discriminating axis first — what actually differs between these members (scope, lifecycle stage, input identity, returned shape, side effect) — then check each member's current description against it. The words the confusion is made of are in the task's `sharedTokens`; the words that resolve it are the ones only ONE member can truthfully say.
4. _(Researcher)_ If the members form a sequence (one's output feeds the next's required input), sketch the workflow: steps in order, each later step's required params bound as $.output.<field> of the previous step's real output schema.
5. _(Researcher)_ If the members are one task-shaped family rather than a sequence, sketch the capability: the member set (grant only), a name and intents in the members' own vocabulary.
6. _(Claim extractor)_ Record claims naming the chosen shape, each tied to a source. For a disambiguation the claim to ground is the DISTINCTION — the spec line, code path, or fixture showing this member does what the others do not; a reworded description asserting a difference no source states is inventing behavior.
7. _(Synthesizer)_ Propose EXACTLY ONE of `disambiguate`, `workflow`, or `capability`, with every operation reference inside the task's grant. A disambiguation rewrites at least two members' descriptions (rewording one distinguishes it from nothing) and every rewrite carries a rationale. A workflow's supersedes names only its own steps; every name and intent is grounded in the members' own vocabulary. When no shape is real, decline honestly (insufficient_evidence) and say why — a decline is a first-class answer.
8. _(Synthesizer)_ Write each disambiguated description so it would still be right with the siblings absent, and so a reader could pick between them with nothing else on screen. Keep the domain's own nouns (Anvil refuses invented vocabulary), state the distinction in the FIRST clause, and do not describe the other members inside a member's own description. Do NOT touch intent examples: they never reach the served surface — `mcpToolDescription` composes it from description/displayName plus compiled safety facts — and they are the task set your proposal is scored against, so editing them moves the target instead of the tool.
9. _(Critic)_ Try to falsify the proposal: a binding whose field the previous step does not output, a superseded tool the composite cannot stand in for, a name that only relabels the confusion — or, for a disambiguation, a rewrite whose new words its siblings could say just as truthfully. Anvil refuses that last one deterministically (`group_disambiguation_distinguishes`) and then re-runs the routing benchmark over your proposal, refusing a negative delta with the numbers.
10. _(Test writer)_ Record which mis-routed intents your shape should flip to passing, and name the ones you expect it to leave failing; the import's scored admission re-routes every task over the hypothetical surface and attaches the measured delta as evidence for the reviewer.

If you cannot satisfy the evidence policy and stay inside the output boundary,
return **no proposal** — that is the correct, honest outcome.
