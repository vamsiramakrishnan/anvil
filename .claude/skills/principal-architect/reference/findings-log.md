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
