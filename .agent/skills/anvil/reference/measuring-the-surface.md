---
name: anvil-measuring-the-surface
description: Price and route a compiled bundle's served tool surface before shipping it: what anvil disclosure and anvil benchmark measure, and which answer a large surface needs versus a confusable one.
---

A surface nobody measured is a surface nobody can claim is good. Both
commands below are read-only, cheap, and answer different questions — run them
after `approve` and before you ship, so the shape an agent actually sees is a
measurement rather than a hope.

## `anvil disclosure <dir>` — what the catalog COSTS

Prices every operation by the exact tokens its MCP tool surface costs an agent
in `tools/list`, and attributes that cost to the contributor that produced it
— the description, each input schema property, the safety metadata — so the
output names the field to fix rather than the service to blame. Rolls up per
capability and per service, reports the disclosure ladder's verdict (what
laddering already saved, what remains over budget), and reports tokens-to-reach:
what an agent must read, starting cold, before it holds one operation's input
schema, and the round trips that cost buys.

```
anvil disclosure <dir>
anvil disclosure <dir> --json --reach
```

Tool-surface and reach figures are exact measurements of the bytes the runtime
publishes, counted under o200k_base. Response figures are projections read from
`simulation.report.json` under a recorded seed, and are labelled as such — do
not quote them as measurements.

## `anvil benchmark <dir>` — whether the catalog ROUTES

Routes the catalog's own intent examples over the served surface and reports
what an agent would actually pick, including `confusion.clusters`: families of
tools whose tasks land on each other, with the mis-routed intents verbatim and
the vocabulary that explains the collision.

## Which answer the numbers call for

Size and distinctness are different problems, and the fix for one does not fix
the other. On a real estate, routing accuracy fell from 90.0% at 10 served tools
to 58.6% at 329 — catalog size dominates — yet only a small fraction of the
failures were bad-name failures, so dropping operations will not repair a
cluster that collides on vocabulary.

- **Too big** → `anvil distill <dir>`. Reads collapse to a canonical basis;
  writes never collapse. You reduce by NOT approving, never by deleting, so the
  choice stays reversible. See `skills/anvil-distill/SKILL.md`.
- **Too alike** → the group rail. `anvil refine export-task <dir>
  group:<cluster-id>` hands one measured cluster to a harness;
  `anvil refine import-proposal` re-routes every task over the proposal's
  hypothetical surface and refuses a negative delta with the numbers, before a
  reviewer sees it. Its three honest answers are a composed workflow, an
  authored capability, or a disambiguation that rewrites what the members say.
- **Nothing calls it** → `anvil observe <dir> --from-records <spool>` folds a
  real serving-path record spool against the compiled contract. An operation
  whose calls all answered `not_found` is evidence-backed deprecation rather
  than a guess.

One trap, because the scoring makes it tempting: **never edit an operation's
intent examples to improve a routing number.** They are the task set those
numbers are measured against — moving them moves the target instead of the
tool, and every measurement downstream becomes circular.
