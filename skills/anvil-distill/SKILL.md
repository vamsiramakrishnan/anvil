---
name: anvil-distill
description: Strip a bloated agent surface down to its eigenbasis — the minimal spanning set of operations — in two stages. Stage 1 is the mechanistic `anvil distill` pass (deterministic, proposes). Stage 2 is this loop: a coding harness reviews the proposal, applies it through approval, re-measures, and iterates to convergence. Use when a compiled service exposes far more tools/content than an agent needs (view-shaped APIs, CRUD×N, screen composites).
---

# Distilling a surface to its eigenvalues

A view-shaped or enterprise API is usually **rank-deficient**: most operations are
projections of a small basis (a "detail view" is `get(entity)` with fixed fields;
a "by-status list" is `list(entity)` with a filter). Exposing them all is tool and
content bloat. The goal is the **eigenbasis** — the smallest set of operations such
that every real task decomposes into it, and the residual (tasks needing a dropped
op) is noise.

This runs in **two stages**, and you (the coding harness) drive the loop.

## Stage 1 — mechanistic (deterministic, it proposes)

```
anvil distill <dir>            # human report
anvil distill <dir> --json     # the artifact you iterate on
```

`distill` computes the basis with a hard asymmetry you must preserve:

- **Reads collapse.** Grouped by `(resource, action, arity)` — where arity is a
  keyed *item* read vs a *collection* read — one canonical (most general, fewest
  required inputs) spans the cluster; the rest are `reconstructible`.
- **Writes never collapse.** Every mutation is its own basis vector. Same-signature
  mutations are put in `review`, never auto-dropped.

Key fields in the `--json`: `basis`, `reconstructible`, `review`, `clusters`,
`residualIntents`, `overBudgetCapabilities`, and `reduction` (the reducible
fraction). The pass is deliberately **conservative and mechanical** — it does not
know business meaning. That is your job in Stage 2.

## Stage 2 — the loop (you add judgment, then measure)

Repeat until convergence:

1. **Distill.** `anvil distill <dir> --json`. If `reduction` is ~0 and there are no
   `overBudgetCapabilities`, you are at the eigenbasis — stop.
2. **Adjudicate the `reconstructible` set.** For each, decide:
   - *Truly a projection* → leave it unapproved (`review_required`). It's flab.
   - *Carries distinct intent/semantics* the canonical does not (check its
     `strandedIntents`) → **keep it**, or re-home the intent onto the canonical
     (add the routing phrase to the canonical via the manifest) then drop it.
   - **Never** silently drop an op whose `strandedIntents` are non-empty without
     re-homing them — that is coverage you are deleting.
3. **Fix `overBudgetCapabilities`.** A capability whose *basis* still exceeds the
   tool budget is a screen, not a basis: split the grouping (manifest
   `capability:` / tags) by real intent, don't `--allow-large` your way past it.
4. **Apply through approval** (the only mutating step):
   - `anvil approve <dir> <basis-op-ids...>` — expose the basis.
   - Leave `reconstructible` unapproved. Enrich the manifest where you re-homed an
     intent or renamed a canonical, then `anvil compile … --manifest …` to reproject.
5. **Measure.** `anvil assess <dir>` (readiness held or improved) and re-`distill`.
   Confirm: basis shrank or held, no new `residualIntents`, capabilities within
   budget. If a metric regressed, revert the last decision.
6. **Certify the reduction is safe.** `anvil build <dir> <cap> --out b && anvil
   certify b && anvil conformance b` — the smaller surface must still pass every
   gate and keep CLI == MCP == skill agreement.

## Convergence

You are done when, in one pass: `reduction ≈ 0`, `reconstructible` is empty or every
member is a *deliberate* keep, `residualIntents` is empty, and no capability is over
budget. That is the eigenbasis: minimal spanning set, no stranded coverage, each
capability a basis rather than a screen.

## Rules (do not violate)

- **Never drop a write.** Mutations are basis vectors; the pass will only ever put
  them in `basis` or `review`.
- **Never strand an intent.** A dropped read's `strandedIntents` must be empty or
  re-homed first.
- **Reduce by *not approving*, not by deleting.** The source snapshot and AIR are
  unchanged; distillation is a choice of which operations to expose. Reversible.
- **Prove it safe.** Every reduction ends at `certify` + `conformance`, or it didn't
  happen.
