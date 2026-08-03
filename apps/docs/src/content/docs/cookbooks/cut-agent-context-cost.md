---
title: "Cut your agent's context cost"
description: "Find out where an agent's context budget goes on your surface — ranked per operation, attributed to the exact field — then gate it in CI and let the disclosure ladder handle the rest."
sidebar:
  order: 8
---

**What you'll have at the end:** a ranked, attributed answer to *why does my
agent run out of context before it does anything useful* — the operations that
cost the most, the specific field inside each one that spends the budget, a
`--check` gate you can put in CI, and a clear view of what the disclosure ladder
already saved you.

Your API compiles to a lot of tools. An agent reading that tool list pays for
every one of them before it knows which single call it needs, and then one fat
response finishes off whatever context was left. Both halves are measurable, and
Anvil measures them: the tool surface exactly, from the bytes the MCP server
actually publishes, tokenized with `o200k_base`; the response half by driving
the simulator.

## 1. Ask where the budget goes

`anvil disclosure <dir>` is read-only and reports on a compiled bundle. Start
with the repo's payments example, which is small enough to read in full:

```bash
# [docs-tested]
WORK=$(mktemp -d)
node packages/cli/dist/bin-anvil.js compile examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml --service payments \
  --out "$WORK/payments" --root "$WORK" > /dev/null
node packages/cli/dist/bin-anvil.js disclosure "$WORK/payments" > "$WORK/bom.txt"
cat "$WORK/bom.txt"
# Four tools, 968 tokens: the surface already fits, so no lanes are built.
grep -q "flat (fits_budget)" "$WORK/bom.txt"
grep -q "No findings" "$WORK/bom.txt"
# The report itself never gates; --check does, and passes here.
node packages/cli/dist/bin-anvil.js disclosure "$WORK/payments" --check > /dev/null
rm -rf "$WORK"
```

```text
Disclosure BOM — payments 2026-07-09-prod  (tokens: o200k_base)

  Tool surface   968 tokens across 4 operation(s)
  Served         968 tokens across 4 approved operation(s)
  Budgets        1,200/tool · 8,000/response · 20,000/surface
  Ladder         flat (fits_budget) — 968 tokens at rest, within the 20,000-token surface budget

  Most expensive operations (measured tool surface):
    1.      360  payments.refunds.create  ✓
             68   19%  meta:_meta
             62   17%  input.idempotency_key
             51   14%  schema:inputSchema
    2.      226  payments.capture.create  ✓
             67   30%  meta:_meta
             42   19%  schema:inputSchema
             34   15%  annotations
```

Read it top down. **Tool surface** is every operation in the bundle; **Served**
is only the approved ones, because an operation nobody approved costs a live
agent nothing — a single total would make an unapproved surface look shipped.
Under each operation are its three biggest contributors: `input.` is a property
of the published input schema, `schema:` is the schema's own scaffolding,
`meta:` is Anvil's safety posture block, and a bare label is a top-level field
like `description` or `annotations`. Only three are printed on purpose — a big
surface is nearly always one or two pathological fields, and the long tail would
bury them.

## 2. On a big surface, see what the ladder already did

Now a service with a hundred operations. This one is synthetic so the page is
reproducible: ten tags of ten list endpoints, plus one search whose
`status_code` filter carries a 400-value enum — the shape you meet in real
specs.

```bash
# [docs-tested]
WORK=$(mktemp -d)
# A synthetic commerce API: 100 list operations across 10 tags, plus one search
# whose 'status_code' filter carries a 400-value enum.
node -e '
const tags = ["orders","invoices","customers","shipments","catalog","payouts","returns","tickets","webhooks","reports"];
const page = [{name:"per_page",in:"query",schema:{type:"integer",maximum:200}},
              {name:"cursor",in:"query",schema:{type:"string"}}];
const ok = {"200":{description:"ok",content:{"application/json":{schema:{type:"object",properties:{
  items:{type:"array",items:{type:"object",properties:{id:{type:"string"}}}},next_cursor:{type:"string"}}}}}}};
const paths = {};
for (const t of tags) for (let i = 0; i < 10; i++)
  paths["/"+t+"/list"+i] = {get:{operationId:"list_"+t+"_"+i,tags:[t],summary:"List "+t+" "+i,parameters:page,responses:ok}};
paths["/orders/search"] = {get:{operationId:"searchOrders",tags:["orders"],summary:"Search orders",responses:ok,
  parameters:[{name:"status_code",in:"query",schema:{type:"string",
    enum:Array.from({length:400},(_,i)=>"ORDER_STATUS_"+String(i).padStart(3,"0"))}}, ...page]}};
require("fs").writeFileSync(process.argv[1], JSON.stringify({openapi:"3.0.3",
  info:{title:"Commerce",version:"1.0.0"},servers:[{url:"https://api.example.com"}],paths}));
' "$WORK/commerce.json"
node packages/cli/dist/bin-anvil.js compile "$WORK/commerce.json" --service commerce \
  --out "$WORK/commerce" --root "$WORK" > /dev/null
# All reads. Approving them is what makes a served surface — and so a ladder — real.
IDS=$(node -e 'console.log(require(process.argv[1]).operations.map(o => o.id).join(" "))' "$WORK/commerce/air.json")
node packages/cli/dist/bin-anvil.js approve "$WORK/commerce" $IDS > /dev/null
node packages/cli/dist/bin-anvil.js disclosure "$WORK/commerce" --top 1 > "$WORK/bom.txt"
cat "$WORK/bom.txt"
grep -q "laddered (over_budget)" "$WORK/bom.txt"      # 10 lanes instead of 101 tools
grep -q "input.status_code" "$WORK/bom.txt"           # the field to put in the ticket
# The report exits 0 whatever it finds; --check is the gate, and it fails here.
set +e
node packages/cli/dist/bin-anvil.js disclosure "$WORK/commerce" --check > /dev/null
CHECK=$?
node packages/cli/dist/bin-anvil.js simulate "$WORK/commerce" > "$WORK/sim.out"
SIM=$?
set -e
test "$CHECK" -eq 1
test "$SIM" -eq 1
cat "$WORK/sim.out"
grep -q "disclosure/tool-surface: expected within-budget, got over-budget" "$WORK/sim.out"
rm -rf "$WORK"
```

```text
Disclosure BOM — commerce 1.0.0  (tokens: o200k_base)

  Tool surface   24,984 tokens across 101 operation(s)
  Served         24,984 tokens across 101 approved operation(s)
  Budgets        1,200/tool · 8,000/response · 20,000/surface
  Ladder         laddered (over_budget) — 10 lane(s) cut 24,984 to 379 at rest (saved 24,605), within the 20,000-token surface budget

  Most expensive operations (measured tool surface):
    1.    2,224  commerce.orders.search  ✗ 1,024 over budget
          2,011   90%  input.status_code  enum with 400 values
             65    3%  meta:_meta
             37    2%  schema:inputSchema
    … 100 more (--top 0 for all, --json for everything).

  By capability:
       4,474   18%  Orders (11 op(s), 1 over budget)
       2,310    9%  Payouts (10 op(s))
       2,310    9%  Webhooks (10 op(s))
       …
```

The ladder line is the headline. A flat registration of these 101 tools costs an
agent 24,984 tokens on `tools/list`, every session, before it knows what it
wants. Anvil serves ten capability entry cards instead — 379 tokens at rest —
and discloses a lane's operations only when the agent opens it. Boot the bundle
with `anvil serve mcp generated/commerce` and a client's first `tools/list`
returns exactly ten tools:

```text
open_commerce_catalog     open_commerce_payouts
open_commerce_customers   open_commerce_reports
open_commerce_invoices    open_commerce_returns
open_commerce_orders      open_commerce_shipments
open_commerce_tickets     open_commerce_webhooks
```

Each card carries what it costs to enter, so the choice is informed rather than
a leap:

```json
{
  "name": "open_commerce_orders",
  "title": "Open Orders",
  "description": "Orders capability for commerce. Opens 11 tool(s) for Orders. Use for requests like: work with orders; manage orders.",
  "_meta": { "anvil/lane": true, "anvil/capability_id": "commerce.orders",
             "anvil/lane_tools": 11, "anvil/lane_tokens": 4474 }
}
```

Calling `open_commerce_orders` answers *"Orders: 11 tool(s) are now listed.
Refetch tools/list to read their input schemas; this lane stays open for the rest
of the session"* — and the next `tools/list` returns 21 tools, the ten cards plus
the eleven Orders operations. So reaching an Orders operation from cold costs
379 + 4,474 tokens instead of 24,984, and the median lane here is cheaper still.
The price is one extra round trip, and it is a real price: the ladder trades
latency for context, it does not make context free.

Two things the ladder deliberately does not do. It never changes *what* is
exposed — laddering decides when an approved operation's schema is disclosed,
never whether it may be called, and every approval, confirmation, and
idempotency gate is untouched. And it declines whenever it would not help: the
payments bundle above reports `flat (fits_budget)` because a ladder over four
tools buys an extra round trip and saves nothing. The other refusals are
`unmeasured` (nothing to reason from), `no_capabilities` (nothing to make lanes
out of), `no_grouping_benefit` (every lane would hold one operation), and
`no_token_benefit` (the cards cost as much as the tools they replace).

## 3. The finding is the ticket

Laddering moves cost around; it does not fix a tool that is too expensive on its
own. That is what the findings section is for, and it is the part worth taking
to whoever owns the spec:

```text
  Findings (1):
    ✗ [measured]  Operation 'commerce.orders.search' publishes a 2,224-token tool surface, 1,024 over
    the 1,200-token per-tool budget — paid by every agent that lists tools, before it knows it wants
    this one. 2,011 of it (90%) is the input property 'status_code' — enum with 400 values.

  Report only — exits 0. Use --check to gate a pipeline on measured over-budget tool surfaces.
```

That sentence is a ticket someone can close. Not "make your API
agent-friendly" — *this one query parameter's enum is 90% of the cost of this
tool, and every agent pays it whether or not it ever calls the operation.* The
`✗ [measured]` tag is load-bearing: it says the number is a fact about the
contract, not an estimate, and only measured findings are allowed to gate.

The report always exits 0, so running it to learn something never reddens a
build. `--check` is the gate, and it fails on measured over-budget tool surfaces
only. `anvil simulate` fails on the same fact from the coverage side, which is
how it shows up in a pipeline that already runs the safety matrix:

```text
  Coverage by dimension:
    ✓ fault         101 op(s), 404/404 cells
    ✓ pagination    101 op(s), 202/202 cells
    ✗ disclosure    101 op(s), 201/202 cells  (projected from simulated data)
    Projected figures are estimates under seed 1, not measurements of live traffic.
      ✗ commerce.orders.search disclosure/tool-surface: expected within-budget, got over-budget
```

`anvil refine plan` names the same deficiency
(`schema_too_large_for_disclosure`) and routes it to a `reduce-schema-disclosure`
skill, which is listed as not yet implemented — so today the fix is yours: trim
the enum in the spec, or state a shorter `description` in the manifest and
recompile. Either way all three surfaces move together.

Use `--top 0` to rank every operation instead of the first ten, and `--json` for
the full bill of materials — every contributor, not just the top three, plus the
per-capability rollup and the ladder verdict as data.

## 4. The other half: what a response costs

A tool surface is a fact about your contract. A *response* size is a fact about
somebody's data, so Anvil will not derive one — it drives the deterministic
simulator under a recorded seed and labels the result a projection everywhere it
appears. `anvil simulate` reports it as the `response-page` cells of the
disclosure dimension, written to `simulation.report.json`:

```json
{
  "operationId": "commerce.list0.list.orders",
  "dimension": "disclosure", "variant": "response-page",
  "expected": "within-budget", "actual": "within-budget", "ok": true,
  "basis": "simulated-data",
  "figure": { "tokens": 2800, "budgetTokens": 8000, "estimator": "o200k_base", "seed": 1 }
}
```

`basis: "simulated-data"` next to the contract-derived `tool-surface` cells is
the whole discipline: on a terminal both render as digits, and a report that
mixes them launders an estimate into a guarantee. For the same reason
`anvil disclosure` reports its response section only from figures recorded on the
bundle's operations — a freshly compiled bundle prints
`Response cost: NOT MEASURED` and points you at `anvil simulate` rather than
printing a zero, which on a cost report would read as *free*.

What Anvil does with that number is solve for a page instead of truncating one.
It reads the page-size parameter off the spec — `per_page`, `page_size`,
`pagelen`, `limit`, `max_results`/`maxResults`, `$top`, along with whatever
`maximum` and `default` the parameter declares — and sizes the outgoing request
against the 8,000-token response budget, so the upstream never sends what nobody
will read. It stays out of the way in the three cases where a number would be a
guess: the caller supplied a size (an explicit ask is never quietly shrunk), the
parameter has no wire location in the input schema, or nothing measured what a
row costs. Names it will *not* claim include `count` and `size`, which mean
something else too often to rewrite safely. Truncation still exists, but only as
the failsafe, and it says so:

```text
[truncated: ~8000 of ~33687 estimated tokens — served 31856 of 134138 chars (~3.98 chars/token
measured for this operation; the serving path carries no tokenizer, so token figures are
estimates). Narrow the request with 'anvil_projection' to select fewer fields, or page with 'cursor']
```

`anvil_projection` is a reserved JMESPath input on every generated tool, next to
`anvil_dry_run` — it is how an agent asks for fewer fields rather than
discovering after the fact that it got too many:

```json
"anvil_projection": {
  "type": "string",
  "description": "JMESPath expression (as in `aws --query`) applied to a successful response before it is measured against the context budget, e.g. `items[].{id: id, name: name}`. Selecting fewer fields lowers the cost per item, which raises the number of items that fit in one page. It may only narrow the response, never expand it; an invalid expression fails the call rather than returning the unprojected payload."
}
```

The ordering is the point: the projection is applied *before* the response is
measured against the budget, so a narrower view genuinely buys a bigger page
instead of paying full context cost for a trimmed one. The expression is also
compiled before the upstream call, so a malformed one costs nothing upstream —
it fails the call rather than quietly returning the whole payload.

## Where this fits

Run `anvil disclosure` after a compile and again after the spec changes — a
surface gets expensive the same way a repository gets slow, one reasonable
addition at a time. Wire `anvil disclosure --check` next to
[`anvil sync`](/anvil/cookbooks/respond-to-drift/) in the same pipeline stage:
one catches the contract meaning something new, the other catches it costing
more. Neither mutates anything.
