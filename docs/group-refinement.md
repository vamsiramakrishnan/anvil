# Resolve a confusable-tool cluster (group refinement)

Routing accuracy falls with catalog size — measured on a real estate, 90.0% at
10 served tools to 58.6% at 329 (`docs/backtesting/routing-at-scale.md`). The
failures are not uniform: they cluster on confusable tool FAMILIES, and
`anvil benchmark` reports those families as candidates. This page is the loop
that turns one such candidate into a reviewed, measured change to the served
surface:

```
anvil benchmark            measure routing; mis-routes cluster into confusable families
anvil refine export-task   hand ONE cluster to a coding harness as a hash-bound case file
  <harness answers>        workflow | capability | honest decline
anvil refine import-proposal   deterministic validation + benchmark-scored admission
anvil refine review/approve    a person decides, with the measured delta in front of them
anvil refine apply-pack        the reviewed bytes land in AIR
anvil compile / serve          the served surface shrinks (tools/list before vs after)
```

Nothing in this loop auto-approves anything. The two proposal kinds are pinned
to the review tier on their patch keys (`workflow`, `capability`), and the
measured routing delta is evidence for the reviewer — never an approval.

## 1. Measure and pick a cluster

```bash
anvil benchmark generated/service
```

The report (`benchmark.report.json`) carries `confusion.clusters`: groups of
served tools whose intent tasks the router routed into each other, each with a
deterministic id (`cc_…`), the mis-routed intents verbatim, and the shared
vocabulary that explains the collisions. Clusters are candidates — worth asking
about, never a decision. Routing hubs (one tool confused with a catalog-scale
number of partners) are reported apart and never form clusters.

## 2. Export the cluster as a case file

```bash
anvil refine export-task generated/service group:cc_849bdc358216 \
  --repo-root . --out task.json \
  --traffic-report observed.json   # optional: anvil capability propose --from-records --out
```

The task is the same hash-bound JSON contract as every other `export-task`
job, with group-scope facts:

- every member operation in full routing detail (id, tool name, description,
  intent examples, input params with requiredness);
- the mis-routed intents verbatim, with counts, and the shared vocabulary
  tokens;
- the estate's traffic groupings, when an observed-capability report is
  supplied — and their members become the only operations OUTSIDE the cluster
  the proposal may reference (`relatedOperationIds`, the grant);
- the bounded proposal union the harness may answer with.

## 3. The harness answers — a bounded union

Exactly one of:

- **A workflow proposal** (`patch.set.workflow`): name, description, intent
  examples, ordered steps with `$.output.<field>` bindings, and `supersedes` —
  the member tools the composite REPLACES on the served surface. `supersedes`
  may only name the proposal's own steps.
- **A capability proposal** (`patch.set.capability`): id, display name,
  description, intent examples, and members (⊆ grant) — the same declaration a
  manifest `capabilities:` entry makes.
- **No change, with a reason**: the protocol's honest-decline statuses
  (`insufficient_evidence`, …) with the reason in `summary` and no patch. A
  decline is a first-class answer, not a failure.

## 4. Import: deterministic validation, then benchmark-scored admission

```bash
anvil refine import-proposal generated/service task.json submission.json --out pack/
```

Validation is deterministic and named — an unreliable harness is safe because
the machine only accepts demonstrated, grounded output:

- `group_proposal_shape` — exactly one arm of the union, strict schemas;
- `group_grant_respected` — every referenced operation is inside the task's
  hash-bound grant;
- `group_supersedes_within_steps` — a composite may only replace what it
  performs;
- `group_workflow_composes` — the workflow registers on the SHARED surface
  planner (`planWorkflowSurface` in `@anvil/air` — the same code
  `@anvil/mcp-runtime` serves and the disclosure budget charges), and every
  later step's required input is bound from a field the previous step's real
  output schema declares;
- `group_names_grounded` — every proposed name and intent is the member
  operations' own vocabulary (the shared `routingTokens` tokenizer), never an
  invention.

Then the admission gate: the deterministic lexical router re-routes the same
intent tasks over the current served catalog and over the hypothetical one the
proposal would produce — for a workflow, members superseded per the shared
planner and the composite registered under its real served name and
description; for a capability, the member tasks routed over the full catalog
vs the narrowed one.

- A **negative** delta is refused with the numbers ("this abstraction makes
  routing worse: 6→4 of 12"), per-intent, and no pack is written.
- A **non-negative** delta attaches as evidence (`routing-delta.json`, plus a
  `group.routing_delta` claim on the refinement) and the proposal lands at
  REVIEW tier. Zero is not refusal — routing is one dimension; a reviewer may
  still want the composition for safety or ergonomics — but the evidence says
  it bought nothing.

The delta report also says what was NOT done: the chain's data flow is
validated structurally against real output schemas; it is not executed against
a mock, and `simulated: false` records that honestly.

## 5. Review, apply, and watch the surface shrink

```bash
anvil refine review pack/
anvil refine approve pack/ "resolve-confusable-cluster:group:cc_…" \
  --reviewer you@example.com --reason "measured +41.7 pts; composes cleanly"
anvil refine apply-pack generated/service pack/
```

An approved **workflow** proposal lands in AIR as an approved workflow — the
receipt IS the human decision — so `planWorkflowSurface` registers the
composite and applies its supersessions: `tools/list` shrinks (K members − N
superseded + 1 composite). The superseded operations stay in AIR, in the CLI,
and in every client SDK under their unchanged safety contracts; suppression is
a disclosure decision, not an approval one.

An approved **capability** proposal lands born `proposed`, exactly like a
manifest-authored capability: the receipt approved DECLARING the grouping, and
the capability's own approval — with its disclosure budget — still goes
through `anvil capability approve`.

Recompile (`anvil compile`) to reproject the bundle, and re-run
`anvil benchmark` if you want the post-change measurement on the record.
