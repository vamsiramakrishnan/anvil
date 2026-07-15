# Developer-experience review — fresh-clone setup

A record of setting Anvil up from a cold clone with **no prior knowledge**,
noting every point of friction. The goal is honest: what worked, what tripped a
newcomer, and what is still open. Fixes landed in the same change that added this
file are marked ✅; open items are recommendations, not regressions.

## What worked (worth keeping)

- **`pnpm install && pnpm build` is fast and clean** — ~4s install, ~23s build,
  no native-module surprises. `pnpm test` and `pnpm typecheck` pass green from a
  cold clone.
- **The no-drift claim holds.** `anvil skill /tmp/x` regenerates the operating
  skill byte-for-byte identical to the committed `skills/anvil/`. For a project
  whose thesis is "the CLI, MCP, and skill agree," having verified that on day
  one is reassuring.
- **The safety posture is legible.** `anvil agentify … && anvil inspect` on every
  example format (OpenAPI, OData, SOAP, gRPC, GraphQL) prints effect / risk /
  idempotency per operation without guesswork. The full pipeline
  (agentify → capability approve → build → certify) runs end-to-end on a
  non-payments example.

## Nits found and fixed ✅

- **A committed 404 artifact.** `tp51.wsdl` sat in the repo root containing the
  literal bytes `404: Not Found` — a failed `curl -o` that got committed. It is
  referenced nowhere. Removed. (The corpus's own reproducibility rule — *a 404
  body committed as a spec is the failure this exists to prevent* — was being
  violated at the repo root.)
- **Lint nagged on every run.** `biome.json` pinned `$schema` to 2.3.5 while the
  installed Biome resolved to 2.5.x, and used the deprecated `rules.recommended`
  field, so `pnpm lint` printed two deprecation infos every time. Ran
  `biome migrate`; lint is now silent (0 infos).
- **Examples README under-sold the corpus.** `examples/sap/` (OData v2) and
  `examples/salesforce/` (OpenAPI) existed on disk but were absent from the
  `examples/README.md` table and its "four protocols" title — a newcomer
  browsing examples would never discover the OData example. Table and title
  reconciled.
- **No `pnpm` entry point for the CLI.** Every doc says `alias anvil=node
  packages/cli/dist/bin-anvil.js`. Added a root `anvil` script so
  `pnpm anvil --help` and `pnpm anvil -- <cmd> <args>` work without the manual
  alias — discoverable via `pnpm run`.

## Corpus / validation gaps found and fixed ✅

These are the substantive ones — see `docs/backtesting/ENTERPRISE_SYSTEMS.md`.

- **The backtest corpus could not ingest OData or SOAP at all.** `reproduce.sh`
  routed everything that was not `graphql`/`protobuf` through a JSON-conversion
  path (`to_json`) that corrupts XML. So the two formats most associated with
  enterprise systems were unreachable by the very harness meant to validate the
  compiler — even though the compiler's adapters handle them. Widened the
  non-REST branch (and `run.mjs`'s `preparedPath`) to compile `odata`/`wsdl`
  as-is.
- **Zero enterprise / OData / SOAP systems in the corpus.** The 19 systems
  skewed entirely to developer SaaS over REST. Added seven real, publicly-
  fetchable enterprise specs across the gap formats — NetSuite SuiteTalk (SOAP),
  OData v4 (TripPin), OData v2 (Northwind), etcd (gRPC), plus Okta (identity),
  DocuSign CLM / Agreement Manager (contract lifecycle), and BigQuery (Google
  Discovery, data warehouse) — each green on every oracle, with pinned baselines
  and naming/effect differentials. The last three were sourced from the
  `ge-agent-factory` simulator catalog's `openapi-sources.json`, using only its
  `downloadable` entries with real URLs.
- **A compiler finding fell out of the expansion — and was fixed at the
  mechanism level.** Datadog's real v2 OpenAPI failed with four
  `duplicate_operation_id` errors: its `apm/…/retention-filters` and
  `rum/…/retention_filters` families differ only by a separator that
  `snake_case` folds, so their operation ids collided. Root cause was general:
  the naming pass deduped only two of the three surfaces `validate.ts` enforces
  unique. The fix adds the operation id as a resolver surface (one line in
  `SURFACES`), closing the whole id-collision class — and, as a bonus, revealed
  that the corpus's long-documented "known red: linear #23" was already stale
  (the tool-name surface had fixed it). Both are now wired green with pinned
  differentials and a unit test. See `ENTERPRISE_SYSTEMS.md` and
  `tools/corpus/README.md` → "Resolved naming-collision class".

## Are the CLI and skill validated end-to-end — not just the MCP/compile path?

Honest answer after digging in: **the artifacts are complete and there ARE
end-to-end validators, but the corpus was only running half of them — and the
half it skipped caught a real bug.**

What a built bundle actually contains (verified on a real Oracle ORDS build):
three aligned surfaces plus a progressively-disclosed skill —
`cli/<svc>.mjs`, `mcp/server.js`, and `skill/` with `SKILL.md`, six
`reference/*.md` files (capabilities, operations, idempotency, errors,
workflows, setup), `examples/` (worked inputs), `schemas/`, and `evals/`. Plus a
generated `tests/conformance.test.ts`. So the CLI and skill are genuinely
generated, not stubs.

Two validators exist: `anvil selftest` (boots the mock + MCP + CLI and checks
fidelity/retry) and `anvil conformance` (proves the **CLI == MCP == skill** wire
surfaces agree, operation by operation). The gap: **the corpus quick oracles ran
`selftest` on every system but never `conformance`**, and the only
conformance-tested bundle in the repo is `payments` — which has no parameter
whose name collides with a CLI flag. So the tri-surface agreement was unvalidated
for every real spec added in this branch.

Running `conformance` on a real bundle immediately found a bug:

- **Reserved-flag / parameter collision (fixed, mechanism-level).** Oracle ORDS
  addresses a table by `/{schema}/{table}` — a required path parameter literally
  named `schema`, the same word as the CLI's `--schema` disclosure view. The
  flag parser force-booleaned `schema`, so `--schema hr` triggered the schema
  view and **dropped the value**: the CLI sent zero wire requests where the MCP
  tool sent one. `conformance` failed (`wire-agreement … CLI produced 0 wire
  requests`); `selftest` passed, because it drives inputs as objects, not CLI
  flags. Fix: the disclosure views (`--schema/--examples/--errors/--policy/
  --explain`) are no longer force-boolean — a **bare** flag is the view, a
  **valued** flag sets the operation parameter (exactly what `--schema=hr`
  already did; the space-form was silently inconsistent). This restores CLI↔MCP
  agreement for *any* spec whose parameter names a reserved flag, not just ORDS.
  Guarded by a new unit test (`tool-cli-gates.test.ts`) and verified by
  `conformance` going red→green on the real ORDS bundle; a second real spec
  (DocuSign CLM) passes conformance 7/7 unchanged.

On "examples, good and bad": skills ship **good** worked examples
(`examples/*.json`, synthesized from the same `exampleInput` used by `--examples`
and the MCP surface, so they can't drift) and **behavioral bad-path** coverage
(`evals/error_recovery.yaml`: `must_not: retry` on `not_found`, backoff on
`rate_limited`). What they do NOT ship is an **invalid-input** example — a
malformed request demonstrating the `validation_error` refusal. The runtime does
reject it (there's a test), but the skill never shows an agent the rejection. A
worthwhile future addition.

Remaining gap (recommendation): **wire `conformance` into the corpus.** It needs
a built capability bundle (approve → build), which is heavier than the
compile-only quick oracles, so it belongs as its own corpus mode (like
`estates`) that builds one capability per pinned system and asserts tri-surface
agreement. Until then the unit test guards the specific class found here, but a
*new* CLI/skill divergence on a real spec would still slip through the nightly
run.

## Open recommendations (not changed here)

- **No `.nvmrc`** despite `engines.node >= 22.17`. A newcomer on an older Node
  gets a mid-build failure rather than an upfront nudge. A one-line `.nvmrc`
  (or `mise`/`asdf` file) would fail fast.
- **`baseline.json` timings are machine-specific.** Already documented in
  `tools/corpus/README.md`, but the 4 new entries were recorded on a dev box; if
  CI time-budget flaps, refresh from a CI run per the existing note.
- **Enterprise coverage is still format-validated, not vendor-validated.** The
  wired-in OData services are reference stand-ins; the real SAP / Dynamics /
  SuccessFactors / Icertis / BlackLine specs are credential-gated. The recipes
  in `ENTERPRISE_SYSTEMS.md` let a customer reproduce a real backtest, but the
  public corpus can only prove the *adapter path*, not a specific vendor's
  quirks. Worth a partner spec drop when one becomes shareable.
