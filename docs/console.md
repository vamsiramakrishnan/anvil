# Review console

Use `anvil console` to inspect compiled bundles, review pending decisions,
and examine the evidence associated with them. The console presents the same
workspace state used by the CLI.

Review the affected operation or capability before approving it. A successful
UI action does not establish that the deployed upstream integration works.

## A projection, not a second truth

The console owns no state and no rules. It reads what is already on disk —
`air.yaml`, the generated projections, the benchmark report, refinement packs
and their `receipts/` — and it writes only by calling the library functions the
CLI commands themselves call:

| Console action | CLI command it equals |
| --- | --- |
| approve operations | `anvil approve` |
| approve or reject a capability | `anvil capability approve` / `reject` |
| record a pack decision | `anvil refine approve` / `reject` |
| apply a reviewed pack | `anvil refine apply-pack` |
| export a cluster task | `anvil refine export-task … group:<id>` |
| import a submission | `anvil refine import-proposal` |

An approval made in the console is staged, byte-verified, surface-checked, and
swapped into place exactly as `anvil approve` does it. A receipt written in the
console is the receipt `anvil refine apply-pack` verifies — the end-to-end
proof below hands one to the CLI to show it. A group proposal imported in the
console is benchmark-scored and refused on a negative delta exactly as the CLI
refuses it. The safety gates cannot diverge because there is one implementation
of each. Nothing the console shows is computed by the console: counts,
budgets, planner verdicts, drift, and clusters come from the same library
functions the CLI prints.

## Security posture, in plain words

The console runs on your machine with your filesystem authority, and its write
routes change approval state. A page open in another browser tab must not be
able to drive them, so:

- It binds `127.0.0.1` only and refuses to start on any other address.
- Every process mints a random token, puts it only in the page it serves, and
  requires it on every write. Nothing else carries it — not the URL the
  command prints, not a log line, not a JSON response.
- Every write must come from the console's own origin. Requests from any other
  page are refused, and the server never emits CORS headers, so another origin
  can read nothing either.
- Bodies are JSON only, capped in size, and validated against the API contract
  before any library function runs.
- Reads never write. No report is regenerated, no cache file lands in a
  bundle, and the console's scratch directory (`<root>/.anvil/console`) is
  created only by a write that needs it.
- Every path a request names must resolve inside the workspace root.

The full contract is the comment block at the top of
`packages/console/src/contract.ts`. Tests assert every line of it over a real
socket, and the mutation gate deletes the token, origin, and path checks to
prove those tests notice.

## The three views

**Decision queue** — every grey decision in one list, six kinds: an operation
not yet approved, a capability born `proposed`, a workflow the planner refuses,
a deficiency the deterministic plan reports, a review-tier refinement in a pack
awaiting a receipt, and a benchmark cluster of confusable tools. Each item
carries its reasons, its AIR claims (source, confidence, note), the suggested
action, and exactly what its decision needs: the operation's effect,
idempotency, retry, and confirmation posture; the capability's budget verdict;
the pack hash, refinement id, tier, and measured routing delta; the cluster's
members and mis-routed intents.

Bulk approval is by policy only — "reads, naturally idempotent,
evidence-backed", "capabilities within budget", "positive measured delta" — and
a policy can never reach a row the barrier bars: a non-idempotent mutation, a
destructive or irreversible one, an operation that requires confirmation, a
blocked operation, a capability outside its budget, or a pack refinement with a
non-positive delta. Barred rows say why in the list. The keyboard drives the
whole queue: `j`/`k` move, `x` selects, `a` approves, `r` rejects, `/`
filters, `?` shows the map.

**Estate inspector** — the bundle as AIR sees it: service, source and path
grammar, diagnostics, every operation with its effect, state, idempotency mode
and confirmation requirement, capabilities with their budget verdicts,
workflows with the planner's verdict, the served MCP surface before and after
supersession, and drift against another bundle in the workspace.

**Confusion explorer** — the benchmark's confusable-tool clusters and routing
hubs with the mis-routed intents verbatim. A cluster exports a harness case
file; a submission imports back through the scored admission gate, and a
refusal shows the routing numbers, not only prose.

## Running it

```bash
anvil console                # the current directory as the workspace root
anvil console ./generated    # every bundle beneath a directory
anvil console ./generated/payments --open   # one bundle, opening a browser
anvil console . --port 4177 --json          # print { url, port, root }, keep serving
```

A workspace root is walked for every directory holding an `air.yaml` (or
`air.json`); each is a bundle addressed by its workspace-relative path. Any
`pack.json` beneath the root whose service matches a bundle is one of that
bundle's packs. Both are re-read on every request, so what you see is what is
on disk now — including changes the CLI made a moment ago.

### Deciding a refinement pack

Record decisions in the console or with `anvil refine approve|reject`; the
receipt is the same file either way, under the pack's `receipts/`. Applying
the pack writes AIR only, exactly as `anvil refine apply-pack` does, and the
console then says what the CLI says: recompile the bundle to regenerate its
projections. A pack is bound to the source contract it was measured against,
and approving an operation or deciding a capability changes that contract —
so decide and apply a pack before approving, or run `anvil refine run` again
afterwards; a stale pack is refused, never silently applied.

### The refinement loop's packs

`tools/corpus/refine-loop.mjs` (see `tools/corpus/README.md`) runs the same
`anvil refine run --out`/`anvil benchmark`/`anvil refine export-task` sequence
a human would type, once nightly, over every gateway-estate fixture — so its
output is not a special case for the console, it is the ordinary case: a
workspace directory holding `air.yaml` files with `pack.json`s sitting beside
them. Point the console at that workspace and the loop's packs appear in the
decision queue exactly like a pack a person ran by hand:

```bash
node tools/corpus/refine-loop.mjs --work ./refine-loop-workspace
anvil console ./refine-loop-workspace --open
```

Nothing routes the loop's findings anywhere else, and nothing new had to be
built to show them: the "Prefer documenting how the console shows the loop's
packs over adding a console route" call in the loop's own design is this
section — the console already walks a workspace for `air.yaml` + `pack.json`
pairs (above), and `refine-loop.mjs` writes exactly that shape. The loop's own
`refine-loop.report.json`/`refine-loop-summary.md` (and the "Refinement
inbox" issue a nightly workflow keeps rolling from it — see
`.github/workflows/corpus.yml`) are the fast, textual view of the SAME
backlog; the console is where a human actually decides it, cluster exports
included.

## The end-to-end proof

`pnpm test:e2e` (a turbo task deliberately outside `pnpm test`, so the unit
suite and the mutation runner never depend on a browser) runs
`packages/console/e2e` under Playwright: Chromium drives the real built page
served by a real `anvil console` process over a workspace the built CLI
compiles from the payments example. Every scenario asserts on disk — the
operation's `state` in `air.yaml` and in the regenerated MCP projection, the
bundle digest before and after, the capability's lifecycle, the receipt file,
and `anvil refine apply-pack` accepting that receipt — because the disk is the
truth the console projects. The security scenario runs in the browser: a write
without the token is refused, and a page at another origin can read nothing.

## What it deliberately does not do

- **No reproject-after-apply route.** `anvil refine apply-pack` writes AIR and
  tells you to recompile; so does the console. One implementation, one
  message.
- **No reviewer identity on capability decisions.** The library records none
  for `anvil capability approve|reject`, so the console does not invent a
  field it would have no home for. Pack decisions carry a reviewer because
  their receipts do.
- **No workflow approval.** A workflow the planner refuses is fixed at its
  source and recompiled; the queue explains which step is refused and why.
- **No report regeneration.** The benchmark and certification records are the
  CLI's to produce; the console shows them and says when they are stale.
