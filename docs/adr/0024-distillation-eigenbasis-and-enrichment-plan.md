# ADR-0024 — Distillation to an eigenbasis, and the plan that enriches its residue

**Status:** Accepted

## Context
A faithfully compiled surface can still be *bloated*: a REST API designed for a UI
exposes a dozen read projections of the same resource, RPC facades repeat one
mutation under many names, and generic operation names (`get_object`,
`do_transition`) tell an agent nothing to route on. More tools is not more
capability — past a platform's action-selection budget it is *less*, because the
agent spends its attention discriminating near-duplicates. Trimming by hand is
unprincipled and unsafe: drop the wrong read and you strand an intent; drop a
write and you lose a capability.

We want a **deterministic, mechanical** way to name the minimal spanning set of a
surface, and a principled way to spend enrichment effort only on what remains
genuinely uncertain.

## Decision
Three cooperating mechanisms, all pure and no-LLM.

**1. Distillation to an eigenbasis** (`packages/refinement/src/distill.ts`).
`distill(air)` treats each operation's `(resource, action, arity)` as an
eigen-coordinate and reduces the surface:
- **Reads collapse** by that coordinate to one canonical, most-general read per
  cluster (generality measured by required inputs); the others are
  `reconstructible` projections.
- **Writes never collapse** — every mutation is its own basis vector.
- **Same-signature mutation clusters** are flagged `review`, never auto-dropped.
- The report names the `basis`, the `reconstructible` projections, the redundant
  clusters, the **intents reachable only through a reconstructible op** (which a
  naive strip would lose), and any capability whose basis still exceeds the tool
  budget. It **proposes only** — reduction happens later by *not approving*, never
  by mutation. `anvil distill` exposes it (`--json`, `--check`, `--write`).

**2. The enrichment-plan bridge** (`packages/refinement/src/enrich-plan.ts`).
A distilled surface's *open questions* are exactly what enrichment should ask
about. `distillToEnrichmentPlan(report, deficiencies)` — a pure peer of `distill`,
detection passed in — turns them into a source-routed probe plan: writes kept as
basis without proven idempotency (`unproven_safety`), same-signature clusters
(`review_cluster`), reconstructible reads with stranded intents
(`stranded_intent`), and weak names (`weak_name`), each with a `sourceClass` (code
proves idempotency; docs describe intent) and an **advisory** `safetyDirection`.
`anvil distill --as-enrich-plan` emits it; `anvil enrich --plan` consumes it,
probing only the uncertain operations at the tier that can answer them (ADR
follow-on in the harness). The plan is routing only — **`reconcile` remains the
sole authority** on what may loosen safety.

**3. One weakness predicate** (`packages/air/src/naming.ts`).
`nameWeaknesses({canonicalName, resource, action, hasResource})` returns typed
reasons — `bare_noun | vague_verb | generic_resource | no_resource` — and is the
*single* definition of a weak name. The compiler's naming pass scores confidence
through it (`deriveNames`, via a `WEAKNESS_DELTA` table) and the refinement
detector raises `weak_operation_name` through it
(`packages/refinement/src/detect.ts`). One predicate, so the two can never
disagree — the failure that let `do_transition` be penalized by confidence yet
never flagged, and `get_object` escape both. The paired remediation is the
manifest `name: { resource, verb }` axis, which re-projects every routing surface
via `projectRoutingNames`.

## Consequences
- The bloat question has a mechanical answer: the basis is *derived*, the
  reconstructible ops are *named*, and nothing is silently thrown away — a human
  approves the reduction.
- Enrichment stops sweeping the whole surface and targets its residue, asking the
  sharp question at the admissible tier.
- Naming confidence and the naming deficiency are one judgement, and a flagged
  name has a first-class fix.
- **Deferred / honest limits:**
  - The tool budget is a module-private literal (`TOOL_BUDGET = 20` in
    `distill.ts`), not yet configurable per target profile.
  - The detector deliberately passes `hasResource: true`, so `no_resource` is
    reachable only from the compiler's derive-time scoring, never the detector —
    the predicate is shared but the two callers exercise different subsets.
  - The Stage-2 "coding-harness loop" that iterates on `distill --json` /
    `enrich --plan` is an external skill (`skills/anvil-distill/`), not code in
    these modules; the commands themselves only propose.
