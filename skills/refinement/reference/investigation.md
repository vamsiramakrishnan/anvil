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
case.json                  # THE canonical, IMMUTABLE case specification: identity, task,
                           #   target, workspace, policy, tools, procedure, expectedOutput —
                           #   fixed at open, never rewritten by the run it describes.
CASE.md                    # generated view of case.json: short, procedural brief
expected-output.schema.json# generated view of case.json: the contract proposal.json is held to
workspace/                 # your scratch space
output/                    # where each phase deposits its result
output/lifecycle.json      # the canonical MUTABLE run state — the one thing that DOES
                           #   change: the state machine, stage-freeze hashes, and the
                           #   recorded validate-proposal outcome. Written by the rails only.
```
CASE.md and expected-output.schema.json are GENERATED from case.json — never edit them.

## Phases (keep outputs separate — do not let one pass both invent and approve)
- **Researcher** → `output/evidence.json`
- **Claim extractor** → `output/claims.json`
- **Synthesizer** → `output/proposal.json`
- **Critic** → `output/critique.json`
- **Test writer** → `output/tests.json`

## Executable rails (prefer these over hand-written JSON)
- `anvil case inspect <case>`
- `anvil case add-evidence <case> --predicate p --source k --path file --lines a-b`
- `anvil case validate-claims <case>`
- `anvil case synthesize <case> field=value`
- `anvil case validate-proposal <case> <air>`
- `anvil case finalize <case> [--status ...]`

The CLI enforces the source policy, allowed predicates, patch boundaries, and the
output schema. You contribute intelligence; Anvil supplies the rails.

`add-evidence` takes either `--path` (a filesystem coordinate Anvil reads and verifies
itself) or `--uri`/`--ref` (an external pointer whose excerpt you supply and Anvil
cannot verify) — never both, never neither. External evidence stays unverified unless a
future provider actually resolves and confirms the pointer; a skill whose policy
requires verified evidence (e.g. marking an error retryable) rejects a proposal grounded
only in unverified claims.

## Plan your own retrieval
The deterministic layer decides *what* deficiency exists; you decide *how* to
investigate it. Do not wait to be handed context — start from the search hints in
CASE.md and navigate the repository yourself.

## How your investigation actually runs
Today every case runs natively — a plain subprocess, not sandboxed. The filesystem and
network guarantees the case describes are not mechanically enforced yet; they hold only
because you follow them. Bubblewrap and container backends that would enforce them are
designed for but not yet implemented, so running native execution today always requires
explicit opt-in (`allowDegradedNative`) rather than a silent default — the gap is
visible, not assumed away.

## Knowing when NOT to refine is the point
A proposal is not required. Finalize with an honest status — Anvil validates the status
you request against the actual artifacts before accepting it, so an unsupported claim
(e.g. `blocked_by_missing_source` with no recorded source) is refused, not silently
written:
- `proposal_generated` — evidence grounds an in-boundary patch that passed validate-proposal.
- `supported` — the current semantics are already correct; nothing to change.
- `conflicted` — sources disagree; record the contradiction, propose nothing.
- `insufficient_evidence` — not enough admissible evidence.
- `blocked_by_missing_source` — a source you need is unavailable (name it with `--blocked-sources`).

A harness that declines cleanly is worth more than one that always produces a patch.
