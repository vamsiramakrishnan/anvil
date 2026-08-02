# Findings log — real evidence, not speculation

This file exists so architectural opinions can cite dogfooding results
instead of intuition. Add to it when you validate something against a real
system or find a genuine gap; keep entries factual and dated in spirit (what
was run, what came back, what it implies) rather than editorializing.

## FLEXCUBE validation (Oracle FLEXCUBE Universal Banking REST API, 30 services)

Compiled 29 of 30 real bank-service swagger specs end-to-end through
`anvil source add` → `anvil compile` (the 30th, `CardTxnLimitService`, had an
empty swagger file in the source zip — a gap in the source docs, not Anvil).
This is the largest real-world estate Anvil has been run against in this
codebase's history: 144 operations, 283 output data points.

**`anvil capability compose` across all 29 bundles found 7 candidate
overlap groups:**
- 3 genuine candidates (shared `SummaryQuery`-style shapes and CRUD-lifecycle
  shapes across related services — `CardAccountMapping`, `AssetProduct`, and
  siblings) — real signal, worth a human's time.
- 4 `structural_leaf_overlap` candidates, one of which — `/fcubsWarningResp`,
  the shared REST response envelope field — appeared identically across
  **all 29 sources**, producing a single 139-member candidate. That one
  candidate alone was **64% of all ~217 candidate members in the entire
  report**. This is concrete evidence, not a hypothetical, that pure
  structural-shape matching without any envelope/transport-noise filter
  drowns real signal at real scale. See `design-patterns.md`'s note on this
  — the fix is a cheap statistical pre-filter, not a smarter evidence bar.
- **Not yet fixed**: `packages/cli/src/capability-composition.ts` has no such
  pre-filter today. This is a known, evidenced, open item — a good candidate
  for "worth doing" the next time someone asks what to prioritize in
  composition.

## OBDX validation

The Oracle Banking Digital Experience (OBDX) RPM/YAML estate was the first
"real complete system" used to pressure-test composition and the
nouns/verbs/packaging critique that led to several of the fixes below. It
surfaced the `estate connect` staleness bug described in the gap below.

## Gaps found and closed this session (worked examples, not just claims)

- **`classify-idempotency`** — the refinement skill described in
  `safety-invariants.md` and `design-patterns.md`. Root cause of it never
  having existed wasn't a missing registry entry; it was that
  `applyPatches`'s `"operation"` case had no write path for
  `idempotency_mode`/`mechanism`/`key`/`keyDerivation`/`retry_basis` at all —
  even a perfectly valid proposal could never have been applied once
  approved. Fixing the write path was the actual unblock.
- **Workflow-candidate enrichment** — `packages/harness/src/workflow-candidates.ts`
  + `workflow-probe.ts`, wired into `runEnrichment`. Closes the
  "`Workflow` schema says enriched, never guessed; `enrich.ts` never
  populated it" gap described in `design-patterns.md`.
- **Stale generated skill docs** — `skills/anvil/reference/gateway-estates.md`
  (from the OBDX work) recommended a CLI step (`estate connect`) the actual
  generator template no longer produced, because nothing in CI enforced
  regenerating checked-in docs after their generator changed. This is what
  motivated the drift-guard test additions described in
  `design-patterns.md`.

## Known, deferred, evidenced technical debt (flagged, not yet executed)

Cite these rather than rediscovering them from scratch:
- **`source` vs `sources` CLI naming collision** — flagged as the
  highest-leverage *but* highest-risk UX fix in the CLI surface (two
  near-identical top-level commands with different meanings). Deliberately
  not executed without explicit go-ahead, because renaming a top-level
  command is a breaking-change-shaped decision, not a pure quality fix.
- **`packages/cli/src/commands/estate.ts` is 3,327 lines.** The
  `commands/estate/` and `commands/capability/` subdirectory split
  (bug-bash retro fix) intentionally did not touch this — splitting
  `estate.ts`'s internals is a separate, larger piece of work, not covered
  by a directory reorganization.
- **`undocumented_pagination` has a detector, no skill.** Same "detector
  exists, no skill closes it" shape as `classify-idempotency` was before
  this session — `Operation.pagination` is a fully-typed AIR field
  (cursor/page/offset/link styles), the detector fires on list/search
  operations missing it, but nothing proposes it and nothing wires a
  classified `pagination` through to generated `--limit`/`--cursor`
  CLI/MCP params. A real, concrete next slice if pagination/token-economy
  work becomes a priority.

## Public-corpus gauntlet (Slack, Jira, Twilio, Stripe, GitHub, NOAA WSDL)

2,804 operations compiled across six public specs (Swagger 2.0, OpenAPI 3,
WSDL) with zero crashes. Findings, in leverage order:

- **query_language_passthrough fired correctly on first contact**: six Jira
  operations blocked, including delete-by-JQL and archive-by-JQL — the most
  dangerous operations in that spec. GitHub's search `q` query param was NOT
  blocked (free-text search data), vindicating the position-aware two-tier
  rule; the originally-specced single regex would have blocked every search
  endpoint on GitHub.
- **Pagination inference was the missing compile step** (now fixed): the
  corpus initially compiled with pagination on 0 of 938 search operations
  despite trivially name-inferable params. Conservative name-based inference
  (classifyPagination in the compiler) lifted this to 572/938 (60%) with
  per-API styles matching reality — Stripe starting_after→cursor 89%,
  Twilio PageToken→cursor 96%, Jira startAt→offset, GitHub page→page.
- **Whole-service blocking is the top adoption cliff, by design**: Slack
  174/174 blocked (end-user OAuth needs per-caller OBO modeling — correct),
  Stripe 589/589 blocked because the spec declares basic-OR-bearer
  alternative security for the same key and AIR refuses to pick implicitly.
  Recommendation (not yet implemented): when ALL alternatives share one
  principal class and differ only in carrier, select the first with a
  warning instead of blocking — the distinction carries no safety weight.
- **SOAP adapter emits no read hints**: NOAA's 12 forecast operations (pure
  reads) all classify as mutation/none/review_required — safe but useless.
  x-anvil-effect exists for adapters to declare reads; the WSDL adapter
  never emits it.
- **Compile produces empty intentExamples**, so `anvil benchmark` has no
  tasks to derive on a raw compile — intent generation is enrichment work,
  but the benchmark's usefulness depends on it; sequence accordingly.
