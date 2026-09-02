# @anvil/console

The local review console: a browser page over a workspace of compiled bundles,
for the human who is Anvil's approval gate. On a real estate that gate is
hundreds of review-tier decisions — operations sitting in `review_required`,
capabilities born `proposed`, workflows the planner refuses, refinement packs
awaiting a receipt — made today by reading CLI text and typing ids into YAML.
The console puts the evidence next to the decision and the decision one click
from the receipt.

## Pure projection, no new truth

The console owns no state and no rules. It **reads** what is already on disk —
`air.yaml`, `generation.json`, the certification and benchmark reports,
refinement packs and their `receipts/` — and it **writes** only by calling the
`@anvil/*` library functions the CLI commands themselves call:

| Console action | Library function | CLI command it equals |
| --- | --- | --- |
| approve operations | `approveOperationsInBundle` (`@anvil/generators`) | `anvil approve` |
| approve / reject a capability | `approveCapabilityInBundle` / `rejectCapabilityInBundle` (`@anvil/generators`) | `anvil capability approve\|reject` |
| record a pack decision | `recordPackDecision` (`@anvil/refinement`) | `anvil refine approve\|reject` |
| apply a reviewed pack | `applyPackToBundle` (`@anvil/refinement`) | `anvil refine apply-pack` |
| export a cluster task | `selectTaskDeficiency` + `exportRefinementTask` (`@anvil/refinement`) | `anvil refine export-task … group:<id>` |
| import a submission | `importRefinementSubmission` (`@anvil/refinement`) | `anvil refine import-proposal` |

So an approval made here is staged, byte-verified, surface-checked, and swapped
into place exactly as `anvil approve` does it; a receipt written here is the
receipt `anvil refine apply-pack` verifies; a group proposal imported here is
benchmark-scored and refused on a negative delta exactly as the CLI refuses it.
The safety gates cannot diverge because there is one implementation of each.
Nothing the console shows is computed by the console: counts, budgets,
planner verdicts, drift, and clusters come from `planWorkflowSurface`,
`capabilityDisclosureBudget`, `diffContracts`, `readBenchmarkReport`, and the
deterministic refinement plan.

## Dependency direction

`@anvil/cli` → `@anvil/console` → `air`, `compiler`, `generators`,
`refinement` (the allow-list also admits `harness` and `system-pack`). The
console never imports the CLI; `anvil console` is a thin launcher. The
boundaries ratchet (`packages/cli/src/boundaries.test.ts`) enforces this, and
the console is listed as a build-time package so it can never reach the
serving path.

## Security posture

The server binds `127.0.0.1` only. Each process mints a random token, injects
it into the served page, and requires it as `X-Anvil-Console-Token` on every
non-GET request; non-GET requests whose `Origin` is not the server's own are
rejected; no CORS headers are ever emitted; bodies are JSON only and validated
against the contract before any library function runs. The full contract is
the comment block at the top of `src/contract.ts` — it is the specification
the server lane implements and the review reads against.

## Three views

- **Decision queue** — `GET /api/bundles/:id/queue`: every grey decision in one
  list, six kinds: an **operation** not yet approved, a **capability** born
  `proposed`, a **workflow** the planner refuses (or that is not approved), a
  **refinement** the deterministic plan reports as a deficiency, a **pack**
  refinement at the review tier awaiting a receipt, and a benchmark
  **cluster** of confusable tools. Each item carries its reasons, its AIR
  claims (source, confidence, note), the suggested action, whether it blocks,
  and a `subject` with exactly what its decision needs — the operation's
  effect, idempotency, retry, and confirmation posture; the capability's
  budget verdict; the workflow's planner verdict; the deficiency's target key
  and skill; the pack hash, refinement id, tier, and measured delta; the
  cluster's members and mis-routes. The queue is projected from the same
  files the other views read, so the UI consumes items directly and joins
  against nothing; the bulk barrier reads the subject alone. Deciding an item
  calls the matching mutation route.
- **Inspector** — `GET /api/bundles/:id`: the bundle as AIR sees it — service,
  source and path grammar, diagnostics, every operation with its effect,
  state, idempotency mode and confirmation requirement, capabilities with
  their budget verdicts, workflows with the planner's verdict, and the served
  surface before/after supersession.
- **Confusion explorer** — `GET /api/bundles/:id/benchmark`: the benchmark's
  confusable-tool clusters and routing hubs, with the mis-routed intents
  verbatim; a cluster exports a harness task and a submission imports back
  through the scored admission gate.

The pack list (`GET /api/bundles/:id/packs`) names, per refinement, the
receipt files under the pack's `receipts/` that bind a decision to it, and
carries every receipt the pack holds — what `anvil refine apply-pack` loads.
Applying a reviewed pack writes AIR only, exactly as the CLI does; the console
then tells the reviewer to recompile, because it has no reproject-after-apply
route by design.

## Layout

```
src/contract.ts      the HTTP API as zod schemas + inferred types (this lane)
src/contract.test.ts every schema parses fixtures built from a REAL compiled
                     bundle through the lifted library functions
src/server/          lane 2: the HTTP server (127.0.0.1, token, origin, JSON)
src/ui/              lane 3: the React UI (vite)
```

## Running

`anvil console [path]` serves the console on `127.0.0.1`. `path` is a workspace
root (bundles are discovered beneath it) or a single bundle directory;
`--json` prints `{ url, port, root }` and keeps serving, `--port` pins the
port, `--open` opens a browser. The end-to-end proof lives in `e2e/`
(`pnpm test:e2e`): Playwright drives the built page against a real
`anvil console` process over the real payments bundle and asserts every
decision on disk. See `docs/console.md`.
