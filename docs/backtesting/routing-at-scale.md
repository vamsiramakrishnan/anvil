# Routing at estate scale: the Zendesk run

`anvil benchmark` exists to answer the claim the whole product rests on — that a
compiled toolchain makes an agent stop guessing. Until this run it had only ever
been pointed at the 12-operation `examples/payments` bundle, where it reported
`+0.0` uplift and nobody learned anything. This is the first time it was run
against a real estate.

The estate is Zendesk's published OpenAPI document, untrimmed: the same
`developer.zendesk.com/zendesk/oas.yaml` the curated backtest fetches, compiled
whole instead of narrowed to the reference MCP server's tool list.

## Method

Every step is the public CLI; nothing here is a fixture.

1. `anvil compile` the full spec → **640 operations** (336 reads, 304 mutations).
   Nothing is approved on compile, which is the safety contract working: the
   generated surface starts empty.
2. `anvil refine run --skill author-intent-examples` then `anvil refine apply` →
   routing phrases for all 640. A freshly compiled bundle has **zero** intent
   examples, so this step is not optional: without it the benchmark has no tasks
   to run at all.
3. `anvil approve` the **329 read operations** that compiled clean. Reads only —
   the 304 mutations stay behind the gate, which is where an unproven
   non-idempotent mutation belongs. That leaves a 329-tool catalog and 657
   routing tasks.
4. `anvil benchmark` — each intent routed over the CURATED catalog (the tool
   names and descriptions the generated MCP server serves) and over the BARE
   catalog (the names the source document supplies on its own). The gap is what
   compilation bought.

## Result 1 — accuracy collapses as the catalog grows

Deterministic lexical router, same estate, slices spanning the whole catalog:

| Tools served | Tasks | Curated | Bare | Uplift | Pass rate |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 20 | 18 | 16 | +10.0 pts | **90.0%** |
| 25 | 50 | 41 | 39 | +4.0 pts | 82.0% |
| 50 | 100 | 81 | 73 | +8.0 pts | 81.0% |
| 100 | 200 | 143 | 130 | +6.5 pts | 71.5% |
| 200 | 400 | 246 | 233 | +3.2 pts | 61.5% |
| 329 | 657 | 385 | 372 | +2.0 pts | **58.6%** |

Routing accuracy falls **31 points** between a 10-tool and a 329-tool catalog,
and the uplift compilation provides shrinks with it. Both halves matter:

- **Catalog size dominates catalog quality.** At 329 tools the failures are
  overwhelmingly genuine ambiguity, not bad names — "list the views" is a fair
  description of `list_views`, `list_active_views`, `list_compact_views` and
  `execute_view` at once. Measured against the catalog entry the router actually
  reads (tool name *and* description), only **5 of 272 failures (1.8%)** were
  unroutable because the intent shared no vocabulary with its target.
- **Compilation's naming buys little when the vendor already names well.**
  Zendesk publishes real operationIds (`ListViews`, `ShowManyUsers`), so the bare
  catalog starts strong and `+2.0 pts` is an honest number, not a broken
  measurement. The value of compiling this estate is the safety gate, the
  parameter contracts and the aligned surfaces — not discovery.

The actionable reading is that **narrowing the served catalog is the highest-leverage
thing an operator can do for routing accuracy**, which is what capabilities and the
disclosure budget are for. That was previously an argument; it is now a curve.

## Result 2 — a real model, and two defects the run exposed

Running the benchmark for real immediately found two bugs in it.

**The `--agent` arm had never worked.** It required the router command's entire
stdout to parse as JSON. Real model CLIs fence their answers in ```` ```json ````,
so every route was discarded and the first run scored **0/20** on a catalog the
model had in fact routed correctly every time. A benchmark that reports failure
for answers it was given is worse than no benchmark, because a benchmark is
believed. The parse is now tolerant of fences and surrounding prose; the gate
that refuses any tool name absent from the served catalog is unchanged — loose
about syntax, strict about which tools exist.

With that fixed, the same slices routed by a real model:

| Tools | Router | Curated | Bare | Uplift | Pass rate |
| ---: | --- | ---: | ---: | ---: | ---: |
| 10 | Lexical (deterministic floor) | 18/20 | 16/20 | +10.0 pts | 90.0% |
| 10 | Model | 20/20 | 19/20 | +5.0 pts | **100.0%** |
| 50 | Lexical (deterministic floor) | 81/100 | 73/100 | +8.0 pts | 81.0% |
| 50 | Model | 88/100 | 89/100 | **−1.0 pts** | **88.0%** |

Two things follow, and the second one is uncomfortable.

**Catalog size hurts a real model too.** 100.0% → 88.0% across the same range
where the floor goes 90.0% → 81.0%. The model is better everywhere, as a floor
implies it should be, but it degrades on the same curve. The headline finding is
not an artifact of a dumb router.

**Compilation's routing uplift is router-dependent, and for a capable model it
is not there.** At 50 tools the model routed the bare catalog *marginally better*
than the curated one: 83 tasks both catalogs got right, 5 only curated, 6 only
bare. That difference is noise, and the honest reading of it is that a model
reading Zendesk's own operationIds does not need Anvil's names. Anyone quoting
this benchmark as evidence that compiling improves discovery is quoting it
wrongly. What compilation buys on this estate is the approval gate, the
parameter contracts, the idempotency and confirmation semantics, and the fact
that the CLI, the MCP server, the skill and the SDKs cannot disagree — none of
which a routing score can see.

**12 authored intent phrases named something other than their own operation.**
`effect.resource` is a path segment, so `GET /subdomains/available` templated
"list the availables" for an operation named `verify_subdomain_availability`, and
`GET /users/me` templated "list the mes" for `show_current_user`. That is two
Anvil surfaces — the skill's routing phrases and the MCP tool name — disagreeing
about what an operation is called, which is the single failure this compiler
exists to prevent. `author-intent-examples` now emits only phrasings the
operation's own canonical and display names corroborate, and proposes nothing
when none survives: the deficiency staying open is more honest than closing it
with an intent nobody would say. Re-measured on the same estate, 12 of 1277
misaligned phrases became **0 of 1265**, with every operation still holding at
least one intent.

The filter is a floor, not a grammar check. `GET /views/count_many` still
templates "list the count manies", because `get_view_counts` really does say
"count" — naming that path segment correctly is a compiler-side fix, and this
rule only refuses phrases that are provably about something else.

## From failures to work items: mis-route clusters and routing hubs

The 272 failures above used to die in the report as 272 `failReason` strings.
`anvil benchmark` now clusters them deterministically (same report in, same
clusters out — no model, no network) and writes the result into
`benchmark.report.json` as a `confusion` section, rendering the top clusters in
the terminal. The report stays schemaVersion 2: the field is additive, and the
certify reader validates only the envelope it names.

**What a cluster is.** An edge connects the tool a task belonged to and the tool
the CURATED catalog actually routed it to; connected components of that graph
are families of mutually confusable tools — "these K tools, to an agent, blur
into one" — with the evidence attached: member operation ids, the mis-routed
intents verbatim, per-direction counts, and the shared vocabulary stems that
make them collide (`list_views` / `execute_view` collide on "view"). A family
below five mis-routed tasks is not reported: one crossed intent is an authored
phrasing being vague, and five is the same floor the harness uses before
recorded traffic may claim anything (`MIN_SAMPLES_FOR_CLAIM`).

**What a hub is, and why it is reported apart.** A tool confused with more than
a catalog-scale number of partners (5% of the catalog, and never fewer than 6)
is not a member of any family — it is a sink, the shape a search endpoint makes
when every stray intent falls into it. This is the routing-side twin of the
FLEXCUBE envelope finding: left in the graph, one hub welds every real family
into a single giant blob, so hubs are pulled out first and listed separately as
`routing hubs` with their own evidence. The isolation is armed as a mutation
mutant (`benchmark/hub-never-welds-clusters`).

**What to do with one.** A cluster is a candidate, never a decision — the
benchmark only proves the confusion exists, not what it should become. The
honest closings are the existing propose-only rails: compose a workflow that
`supersedes` the variants, collapse them behind a parameter of one tool via a
manifest, or narrow the served capability so the confusable siblings are not
exposed together. A hub usually wants the opposite reading: not composition but
a look at whether the hub tool's description is doing too much work.

## Open finding: 44 curated tool names stutter

Turned up while reading the model's mis-routes, not yet fixed:
**44 of 640 generated tool names repeat a word immediately** —
`zendeskfull_count_activities_activities`,
`zendeskfull_list_active_automations_automations`,
`zendeskfull_reorder_custom_object_fields_fields`. The disambiguation suffix is
appended without checking whether the name already ends in that word.

It is left alone here deliberately. Changing how names disambiguate changes
operation ids across every compiled bundle, which is a contract change and not
something to slip into a benchmarking PR. Filed as its own piece of work.

## Result 3 — the disclosure ladder, measured

The MCP server has served a two-stage disclosure ladder since before this
benchmark existed (`@anvil/air`'s `ladderPlan`, served by `@anvil/mcp-runtime`'s
`lane.ts`): stage 1 lists one entry card per capability instead of every tool,
and stage 2 discloses a lane's own tools once an agent opens it. Nobody had
ever routed a task over it — `anvil benchmark` only ever measured the flat
catalog. `ladderedCatalog`/`stagedRoute` (`@anvil/refinement`) and
`anvil benchmark --catalog flat|laddered|both` close that gap: stage 1 picks a
lane over `RoutableTool`s built from `laneEntryToolName`/`laneEntryDescription`,
stage 2 routes within *only* the lane the router said it opened, and a task
passes iff the tool it reaches is the intent's own operation — the exact
`TaskRouter` contract the flat benchmark already used, unmodified.

This estate compiled slightly differently on this run — the vendor spec moved
since the original measurement above, consistent with this document's own
note that a later revision would shift the numbers: **641 operations** (was
640) and **330 read operations** that compiled clean and approve without a
`review_required` block (was 329). Three independent bundles were built from
the same compiled-and-intent-authored AIR by approving the first 50, 100, and
all 330 of those read operations (sorted by operation id), then each was run
through `anvil benchmark <dir> --catalog both` with the deterministic lexical
router — the same floor Result 1 used.

### Laddered underperforms flat at every size — first pass

| Tools | Flat pass rate | Laddered pass rate | Gap |
| ---: | ---: | ---: | ---: |
| 50 | 65.3% (64/98) | 42.9% (42/98) | −22.4 pts |
| 100 | 63.3% (124/196) | 35.7% (70/196) | −27.6 pts |
| 330 | 58.9% (385/654) | 31.5% (206/654) | −27.4 pts |

A breakdown of the 50-tool run's 56 laddered failures against a diagnostic that
classifies each one by which stage lost it: **37 "no route" (stage 1 matched no
entry card at all)**, 12 "wrong lane" (stage 1 entered a different capability
than the target's own), and 7 "right lane, wrong tool" (the ordinary
same-family confusion Result 1 already describes, just relocated inside a
lane). Two-thirds of the laddered loss was stage 1 finding *nothing to route
to*, not routing to the wrong thing.

The cause was legible from the entry cards themselves. A discovered
capability's `description` and `intentExamples` are compiler-templated —
`"Views capability for zendesk."`, `"work with views"`, `"manage views"` — and
share no vocabulary with how the benchmark's own intents actually ask:
`"list the views"`, `"get a view by id"`, `"create a new view"`. The entry
card built from that capability carried none of the words a router could
match against.

### The lever: fold member verbs/resources into the card

`laneEntryDescription` (`packages/air/src/ladder.ts`) now carries a
`memberVocabulary` field: `${effect.action} ${effect.resource}` for up to 8
deduplicated member operations, in sorted-id order — "list view, get view,
create view, delete view, …" — appended to the card as `Covers: …`. Every
lane already carries this information regardless of how its capability was
authored or named, so it costs nothing to add and needs no new evidence
source; the ladder stays a pure projection (no embeddings, no runtime search).
The per-card token cost stays capped at the per-operation budget exactly as
before (`entryCardTokens`), so a large lane cannot inflate the surface by
listing every member — the cap simply now spends its allotment on real
routing vocabulary instead of an empty margin.

Re-measured on the same three bundles, nothing else changed:

| Tools | Flat pass rate | Laddered before | Laddered after | Recovered |
| ---: | ---: | ---: | ---: | ---: |
| 50 | 65.3% | 42.9% (42/98) | 57.1% (56/98) | +14.2 pts |
| 100 | 63.3% | 35.7% (70/196) | 48.0% (94/196) | +12.3 pts |
| 330 | 58.9% | 31.5% (206/654) | 47.7% (312/654) | +16.2 pts |

The same 50-tool failure breakdown after the change: **2** "no route" (was
37), **31** "wrong lane" (was 12), **9** "right lane, wrong tool" (was 7). The
fix did almost exactly what the vocabulary gap predicted — stage 1 now finds
*some* lane on all but 2 of 98 tasks — and moved the residual loss from "no
match at all" to "matched the wrong one of 25 small, similarly-generic lanes"
(Zendesk's discovered capabilities average two operations each at this
catalog size, so many entry cards now share a lot of the same verbs). That
residual is a real, different problem — closer to Result 1's catalog-size
finding one level up, now applied to lanes instead of tools — and is left
open rather than folded into this change, per the "at most one move" scope
here.

**The improvement is real and it is kept**, because it clears the only bar
that matters for this kind of change: the benchmark got better, on every
size measured, without touching what any operation means, what is approved,
or what the ladder projection is allowed to decide (`lane.ts:21-26` — the
ladder still only changes *when* a schema is disclosed, never *whether* an
operation may be called). Laddered routing still trails flat by 8–15 points
at every size after the fix — this is an honest number, not a claim that the
ladder now wins.

### The trade-off the numbers actually support

| Tools | Flat tokens at rest | Laddered tokens at rest | Laddered tokens/task (rest + avg opened lane) | Reduction |
| ---: | ---: | ---: | ---: | ---: |
| 50 | 26,632 | 1,390 | 2,764 (1,390 + 1,374) | 9.6× |
| 100 | 48,745 | 2,405 | 3,869 (2,405 + 1,464) | 12.6× |
| 330 | 164,152 | 5,363 | 7,738 (5,363 + 2,375) | 21.2× |

Read together, the two tables say the ladder is not free accuracy — it is a
real trade, and the trade gets more favorable as the catalog grows. At 330
tools an agent using the flat catalog reads **164,152** measured tool-surface
tokens before it can route anywhere; the same agent on the ladder reads about
**7,738** tokens for the task it actually runs, a **21×** reduction, while
landing 11 points lower on accuracy (58.9% → 47.7%) than the flat catalog it
replaced. Whether that trade is worth taking is an operator decision this
benchmark exists to inform, not one it makes — a latency- or cost-sensitive
deployment over a catalog this large may prefer it; one where every routing
point matters may not. What this run adds is that the trade is now a
measured, reproducible one instead of an assumption on either side.

### A second stage-1 lever: fold member intent examples into the card

`memberVocabulary` closes most of the vocabulary gap with two-word stems
(`list view`, `get view`); the phrase an agent actually types is longer than a
stem, and every approved operation already carries authored phrasing that a
lexical or model router matches more directly than a stem ever can —
`skill.intentExamples`, the exact field `author-intent-examples` populates and
this benchmark's own tasks are drawn from. `LadderLane.memberIntentExamples`
(`packages/air/src/ladder.ts`) folds up to 4 of a lane's member operations'
own intent examples into the card, deduplicated and walked in the same
sorted-`operationIds` order `memberVocabulary` already uses, rendered as an
`Examples: "…"; "…".` sentence. No new evidence source, no embeddings, no
runtime search — the ladder stays a pure projection, and the card's overall
cost stays capped at the per-operation budget exactly as before
(`entryCardTokens`).

Re-measured on the same three bundles, nothing else changed:

| Tools | Flat pass rate | Laddered (lever 1) | Laddered (lever 1 + 2) | Recovered |
| ---: | ---: | ---: | ---: | ---: |
| 50 | 65.3% | 57.1% (56/98) | **66.3%** (65/98) | +9.2 pts |
| 100 | 63.3% | 48.0% (94/196) | **60.7%** (119/196) | +12.7 pts |
| 330 | 58.9% | 47.7% (312/654) | **52.1%** (341/654) | +4.4 pts |

**The change is kept**, per the same bar the first lever cleared: laddered
accuracy improved at every measured size, with no other move. At 50 tools the
ladder now routes *better* than the flat catalog it replaces (66.3% vs.
65.3%) — the first size at which laddering has ever beaten flat in this whole
investigation. At 100 and 330 tools it still trails flat, by 2.6 and 6.8
points respectively — down from 15.3 and 11.2 points after lever 1 alone at
the same two sizes, and well inside the 8–15 point gap the first-pass ladder
carried at every size.

The updated trade-off, folding this lever's own token cost into the same
comparison:

| Tools | Flat tokens at rest | Laddered tokens at rest | Laddered tokens/task (rest + avg opened lane) | Reduction |
| ---: | ---: | ---: | ---: | ---: |
| 50 | 26,632 | 1,928 | 3,223 (1,928 + 1,295) | 8.3× |
| 100 | 48,745 | 3,411 | 4,832 (3,411 + 1,421) | 10.1× |
| 330 | 164,152 | 7,618 | 10,245 (7,618 + 2,627) | 16.0× |

The extra phrasing costs real card tokens — the at-rest surface grew roughly
40% at every size versus lever 1 alone (1,390 → 1,928 at 50 tools; 2,405 →
3,411 at 100; 5,363 → 7,618 at 330) — and the reduction shrank from
9.6×/12.6×/21.2× to 8.3×/10.1×/16.0×. That is the honest price of the accuracy
gained: still a double-digit-times reduction at 100 and 330 tools, and still a
real trade rather than a free win.

## Result 4 — `auto` weighs the trade-off instead of assuming it

Everything above answers "is laddering worth it here" with a report a human
reads. `decideLadder`'s `auto` mode (`packages/mcp-runtime/src/lane.ts`) is
the code that decides it for a live server, and until now it only ever
answered from the token side of the trade — it laddered whenever
`ladderPlan` said `over_budget`, with no notion that laddering might cost more
accuracy than it saves.

`auto` now consults a measured accuracy delta when one exists for the bundle.
The CLI/serve path (`anvil serve mcp`, and `anvil status`/`anvil inspect` for
reporting) reads `benchmark.report.json` via `readBenchmarkReport`
(`@anvil/refinement`), checks it against the bundle's current content hash the
same way `benchmarkEvidenceStatus` already does for the benchmark evidence
lane, and — only when both `catalogs.flat` and `catalogs.laddered` are fresh —
passes `{ ladderedMinusFlatPts }` in through `LadderServeOptions`. `@anvil/air`
never imports `@anvil/refinement`, and neither does `@anvil/mcp-runtime`: the
report is read and reduced to two numbers entirely inside the CLI package
(`packages/cli/src/commands/ladder-status.ts`), which is the only new
dependency this adds.

With a fresh delta in hand, `auto` ladders only when **both** hold:

- **Token savings clear `MIN_LADDER_TOKEN_SAVINGS_FRACTION` (0.5).** `ladderPlan`
  already refuses to ladder unless the at-rest surface is *strictly* cheaper
  (`no_token_benefit`), but "cheaper by a sliver" still costs an agent the
  extra round trip the ladder's own header comment warns about. Every
  measured reduction on this estate — 8.3×–16.0× after lever 2, 9.6×–21.2×
  after lever 1 — clears a 50% bar by an order of magnitude, so this only
  ever refuses a ladder whose saving is not obviously worth an accuracy risk;
  it never fires with no report present.
- **The accuracy delta is not worse than `MIN_LADDERED_ACCURACY_DELTA_PTS`
  (-8 points).** Drawn from the two regimes this document measured, not
  guessed: the lever-1 ladder trailed flat by 8.2–15.3 points at every size
  and is exactly the surface this floor should refuse; the lever-1-plus-2
  ladder trails by at most 6.8 points, and beats flat outright at 50 tools —
  exactly the surface this floor should allow. -8 sits on the line between
  those two measured regimes: tight enough to have rejected the ladder this
  document shipped first, loose enough to admit the one it shipped after
  measuring the fix.

Both constants live in `lane.ts` with their own one-paragraph justification;
change either only against new measurement, the same way these values came
from measurement rather than a guess. With no report present — every bundle
that has never been benchmarked, which is most of them — `auto` falls
straight through to `ladderPlan`'s own verdict, byte-identical to its
pre-measurement behavior; nothing about a never-benchmarked bundle's served
surface changes because this feature shipped.

`anvil status` and `anvil inspect` both print the live decision as one line —
mode, the plan's own reason, and (when a fresh report informed it) which floor
did the work or that both cleared:

```
Disclosure ladder: serving laddered — plan says over_budget (measured delta -2.6 pts clears the floors).
Disclosure ladder: serving flat — plan says laddered (over_budget), but measured laddered accuracy (-11.2 pts) falls below the -8 pt floor.
```

This is a read of the exact same evidence `anvil serve mcp` would consult
(`ladderStatusSummary` calls `decideLadder` with the same `measuredAccuracy`
the serve path derives), not a second implementation of the decision — what
the operator is told and what the deployed server does can never quietly
disagree.

## Reproducing

```bash
pnpm build
WORK=/tmp/zendesk docs/backtesting/reproduce/reproduce.sh zendesk   # fetch
# the trimmed bundle is the curated backtest; for the full estate compile
# $WORK/zendesk.spec.json.tmp (the untrimmed conversion) directly — no
# `anvil source add` snapshot needed for a one-off compile:
anvil compile     $WORK/zendesk.spec.json.tmp --service zendesk --out $WORK/bundle
anvil refine run  $WORK/bundle --skill author-intent-examples --out $WORK/pack
anvil refine apply $WORK/bundle --skill author-intent-examples
anvil approve     $WORK/bundle <the read operation ids>
anvil benchmark   $WORK/bundle                             # deterministic floor, flat catalog (today's default)
anvil benchmark   $WORK/bundle --agent ./router.sh          # a real model, flat catalog
anvil benchmark   $WORK/bundle --catalog both                # + the disclosure-ladder comparison above
```

`router.sh` is any command that reads the routing prompt on stdin and prints
`{"tool": "<name>"}`; the benchmark refuses any name the served catalog does not
contain, so a hallucinated tool scores as a failed route rather than a pass.

Vendor specs are not committed. The numbers above were produced against the
Zendesk document as published; a later revision will shift them, which is the
point of keeping the recipe rather than the bytes.
