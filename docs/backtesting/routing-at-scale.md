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

With that fixed, the same 10-tool slice, routed by a real model:

| Router | Curated | Bare | Uplift | Pass rate |
| --- | ---: | ---: | ---: | ---: |
| Lexical (deterministic floor) | 18/20 | 16/20 | +10.0 pts | 90.0% |
| Model | 20/20 | 19/20 | +5.0 pts | **100.0%** |

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

## Reproducing

```bash
pnpm build
WORK=/tmp/zendesk docs/backtesting/reproduce/reproduce.sh zendesk   # fetch
# the trimmed bundle is the curated backtest; for the full estate compile
# $WORK/zendesk.spec.json.tmp (the untrimmed conversion) instead:
anvil source add  $WORK/zendesk.spec.json.tmp --root $WORK
anvil compile     --source <src-id> --root $WORK --service zendesk --out $WORK/bundle
anvil refine run  $WORK/bundle --skill author-intent-examples --out $WORK/pack
anvil refine apply $WORK/bundle
anvil approve     $WORK/bundle <the read operation ids>
anvil benchmark   $WORK/bundle                    # deterministic floor
anvil benchmark   $WORK/bundle --agent ./router.sh  # a real model
```

`router.sh` is any command that reads the routing prompt on stdin and prints
`{"tool": "<name>"}`; the benchmark refuses any name the served catalog does not
contain, so a hallucinated tool scores as a failed route rather than a pass.

Vendor specs are not committed. The numbers above were produced against the
Zendesk document as published; a later revision will shift them, which is the
point of keeping the recipe rather than the bytes.
