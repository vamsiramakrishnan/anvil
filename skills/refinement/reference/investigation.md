# Investigating as a case

A *case* turns "run a skill" into a bounded research job with a body. Anvil
materializes an isolated directory for one deficiency; you investigate inside it and
deposit machine-readable outputs. You never edit AIR — the deterministic core
validates, measures, and reconciles what you emit.

## Open and drive a case
```
anvil case list <dir>                 # deficiencies you can open a case for
anvil case open <dir> <target-key>    # materialize .refinement/cases/<id>/
anvil case investigate <case>         # drive the live agent (or work it by hand)
anvil case close <case> <dir>         # re-enter Anvil's rails: validate + reconcile
```

## The case directory
```
CASE.md                    # short, procedural brief (question, may/may-not, method)
task.json                  # the brief in machine form
target.json                # the semantic coordinate + AIR facts + prior evidence
evidence-policy.json       # admissible sources, minimum strength, output boundary
allowed-tools.json         # what you may inspect, the helpers, hard prohibitions
expected-output.schema.json# the contract output/proposal.json is held to
workspace/                 # your scratch space
output/                    # where each phase deposits its result
```

## Phases (keep outputs separate — do not let one pass both invent and approve)
- **Researcher** → `output/evidence.json`
- **Claim extractor** → `output/claims.json`
- **Synthesizer** → `output/proposal.json`
- **Critic** → `output/validation-report.json`
- **Test writer** → `output/tests.json`

## Executable rails (prefer these over hand-written JSON)
- `anvil case inspect-target <case>`
- `anvil case show-schema <case>`
- `anvil case search-symbol <case> <symbol>`
- `anvil case list-callers <case> <symbol>`
- `anvil case add-evidence <case> --predicate p --value v --source k --ref path:lines`
- `anvil case validate-claims <case>`
- `anvil case test-proposal <case>`
- `anvil case finalize <case> [--status ...]`

The CLI enforces the source policy, allowed predicates, patch boundaries, and the
output schema. You contribute intelligence; Anvil supplies the rails.

## Plan your own retrieval
The deterministic layer decides *what* deficiency exists; you decide *how* to
investigate it. Do not wait to be handed context — start from the search hints in
CASE.md and navigate the repository yourself.

## Knowing when NOT to refine is the point
A proposal is not required. Finalize with an honest status:
- `proposal_generated` — evidence grounds an in-boundary patch.
- `supported` — the current semantics are already correct; nothing to change.
- `conflicted` — sources disagree; record the contradiction, propose nothing.
- `insufficient_evidence` — not enough admissible evidence.
- `blocked_by_missing_source` — a source you need is unavailable.

A harness that declines cleanly is worth more than one that always produces a patch.
