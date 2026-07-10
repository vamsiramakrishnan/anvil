# ADR-0007 — Canonical case document

**Status:** Accepted

## Context
A materialised case is defined by a set of inputs — its version and identity, the
task/question, the semantic target, the workspace layout, the skill, the evidence
policy, the phased procedure, the target-scoped context, and the expected-output
schema. The first cut stored these as several independent files written
side-by-side (`task.json`, `target.json`, `evidence-policy.json`,
`allowed-tools.json`, `expected-output.schema.json`, plus the `CASE.md` brief).

Independently-stored inputs drift. The `writableFields` in the policy and the
`propertyNames` enum in the expected schema are the same fact written twice; the
question in the task and the question rendered into the brief are the same
sentence written twice. Nothing reconciled them, so a hand-edit or a partial
regeneration could leave the agent reading a brief that disagreed with the
schema it is held to — the exact "two sources of truth desync" failure ADR-0001
names at the AIR level, reappearing one layer down.

## Decision
One `case.json` is the **single source of truth** for a case's inputs. It carries
`version`, `identity`, `task`, `target`, `workspace`, `skill`, `policy`,
`procedure`, `context`, and `expectedOutput` in one document.

The human/agent views — the `CASE.md` brief and `expected-output.schema.json` —
are **generated projections** of `case.json` and never independent inputs. The
brief's "you may write only …" line and the schema's `propertyNames` enum are
both derived from `policy.writableFields`; the brief's question is
`task.question`. Generation is **one-way**: `case.json` → views. Editing a view is
meaningless — it is overwritten on the next materialisation and read by nothing.

This is the case-level application of the projection rule in ADR-0001: the
document owns semantics; surfaces are derived views, not co-equal stores.

## Consequences
- A case has exactly one file to diff, checksum (see ADR-0009's `caseHash`), and
  reason about. The brief and schema cannot contradict it because they are
  functions of it.
- Tooling and tests assert view↔document coherence in one place rather than
  cross-checking N files pairwise.
- Editing `CASE.md` or the schema by hand is a no-op with respect to the
  investigation; the only meaningful edit target is `case.json`.
- Migration cost: the current `openCase` still emits the older multi-file layout
  (`materialize.ts`); consolidating onto `case.json` is the in-flight change this
  ADR records. See `docs/INVESTIGATION_ARCHITECTURE.md` for the full case anatomy.

## Alternatives considered
- **Several independently-stored input files (the prior design).** Rejected: no
  owner reconciles them, so they drift by construction, and the agent can end up
  briefed against a stale schema.
- **A brief (`CASE.md`) as the source of truth, schema derived from prose.**
  Rejected: prose is not a reliable machine input; the deterministic core needs a
  typed document, and free text re-introduces the parsing ambiguity Anvil exists
  to remove.
