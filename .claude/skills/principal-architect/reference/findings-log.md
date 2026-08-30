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
- **`source` vs `sources` CLI naming collision: resolved.** `anvil sources`
  became `anvil enrich-sources`; the old spelling stays as a hidden, working
  alias that prints where to go, so nothing broke. Executed once the operator
  gave a broad close-the-debt go-ahead.
- **`packages/cli/src/commands/estate.ts` is 3,327 lines.** The
  `commands/estate/` and `commands/capability/` subdirectory split
  (bug-bash retro fix) intentionally did not touch this — splitting
  `estate.ts`'s internals is a separate, larger piece of work, not covered
  by a directory reorganization.
- **Pagination: closed.** This entry previously claimed "detector exists, no
  skill closes it" — that had gone stale: `classifyPagination` infers the
  contract in normalize, the `document-pagination` refinement skill proposes
  it, `apply.ts` writes it, and the MCP description + skill card teach it.
  The last genuinely missing piece was the operator path — a manifest could
  not declare pagination — closed with the `pagination` manifest field
  (validated against real input params; declines on mutations and phantom
  carriers). Lesson repeated: verify this log against the code before citing
  it.

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

## Industry-estate round (TM Forum, Coda, Zendesk, Zuora, Temenos, Coupa, Workday REST, Freshworks, ServiceNow, Notion, Veeva, Zoho, Amadeus — 315 operations)

13 more estates compiled clean (api-evangelist mirrors keep specs as
`openapi/*.yml`, not `.yaml` — the batch-find predicate had to learn that).
Findings:

- **Whole-projection bodies produced blank catalog signatures**: tmforum's
  39 TMF `create` operations have zero params and rich nested bodies, so
  `projection: "whole"` left `operationInputSignature` with nothing to say —
  42/81 coverage on an estate whose bodies were fully typed. Fixed in
  `packages/generators/src/input-signature.ts`: a whole body now lists its
  top-level schema property names (required-first), lifting the corpus to
  300/315 — and all 15 remaining are genuinely input-less ops (whoami,
  keep-alive). The projection governs how a body is passed, not whether the
  agent gets to see what goes in it.
- **Zendesk pagination 2/13 is spec truth, not an inference miss**: 11 of 13
  list operations in the mirror specs declare no pagination params at all.
  Name-based inference can't conjure params the spec omits — a docs-tier
  enrichment target, not a compiler gap.
- **query_passthrough caught TMF hub filters**: the two hits are TMF event
  `hub.create` registrations whose body `query` field is a free filter
  expression ("status=active") routed to the notifier — a real passthrough
  surface on a mutation, correctly blocked.
- **Auth blocking split cleanly by class**: Coupa = the Stripe-class OR'd
  alternatives (`auth/alternatives_unmodeled`, 2 requirements); Workday REST
  and Zoho CRM = the Slack-class end-user OAuth
  (`auth/end_user_flow_unexecutable`, per-caller OBO needed). Both diagnostics
  say exactly what to model — the estates aren't mysteriously broken, they're
  waiting on the two known auth work items.

## Full-pipeline estate runs (spec → compile → refine → approve → selftest → conformance → simulate → certify → review)

Five estates driven through every stage, with real approvals and every gate
green at the end: Coda (124 ops; 66 reads + confirmation-gated rows.create
approved), Coupa (OR'd auth auto-selected), Workday REST and Zoho CRM (both
via the one-line `auth: { type: oauth2_on_behalf_of }` service remodel),
TMF621 Trouble Ticket (hub.create correctly blocked as query passthrough),
and Stripe (589 ops; 40 core reads + refunds.create.direct approved;
selftest 44 passed, simulate 298/298 cells). Three real defects found and
fixed by the loop itself:

- **Spec-declared examples that lie about their type** — Coda puts the wire
  serialization on array params (`example: "fetcher,custom"`) and a boolean
  example on a string enum; `exampleInput` used them verbatim, failing 8/72
  selftest fidelity checks at the zod boundary. `surfaceExample()` in
  `packages/generators/src/mock.ts` now repairs the comma-join and drops
  type/enum-mismatched examples so synthesis wins.
- **Spec-authored markdown headings fracture skill sections** — Coda's
  rows.list description embeds `### Value results`, which terminated the
  operation's section in `operations.md`. Headings inside descriptions are
  demoted to bold (`demoteHeadings`, `packages/generators/src/skill.ts`).
- **Fixed-window Semantics parsing in conformance** — the skill-claim check
  scanned only 7 lines past a section header; a long real description pushed
  `- Semantics:` out of the window, reading every posture flag as false and
  reporting tri-surface drift where there was none. The parser
  (`packages/harness/src/conformance.ts`) now scans to the next header.

Also exercised for real: `certify`'s sibling-descriptions gate refused
Coda's and Stripe's genuinely duplicated/missing descriptions until a
manifest distinguished them (the intended human-authored fix); `refine run`
proposed 17 example patches on Coda and correctly rejected the one whose
value didn't validate; the Zoho mirror's flattened specs carry dangling
`./Common.json` refs — the original self-contained specs under
`openapi/zoho-crm/v8.0/` are the right compile input. The `anvil review`
model pass on the finished Coda bundle returned zero grounded findings
(its "operations.md truncated" note is the reviewer's own context cap —
the file is complete on disk).

## Auth unblock work items — built (both classes closed)

- **Carrier-equivalent OR alternatives now compile** (`resolveAlternatives`
  in `packages/compiler/src/normalize.ts`): when every credentialed
  alternative resolves cleanly to the SAME principal class, the first is
  selected with a non-blocking `auth/alternative_selected` issue → the
  operation lands `review_required` with a note naming what was picked and
  what was bypassed. Any principal disagreement, unresolvable alternative,
  or embedded AND-composite keeps the conservative block. Validated:
  Stripe 589/589 blocked → 589/589 review_required (basic selected);
  Coupa 8/8 → review_required (client-credentials selected over api-key).
- **End-user OAuth has a paved OBO road**: the
  `auth/end_user_flow_unexecutable` diagnostic now prescribes the exact
  manifest recipe (`auth: { type: oauth2_on_behalf_of }`), and a narrow
  service-level carve-out in `applyServiceAuthDefaults`
  (`packages/compiler/src/compile.ts`) applies the one sanctioned
  service-wide type remodel authorization_code → on_behalf_of: same
  end-user authority story, executed per caller via RFC 8693 token
  exchange (runtime support already existed in
  `packages/runtime/src/credentials.ts` / `inbound-identity.ts`), imported
  token endpoint preserved, operation lifted blocked → review_required
  with an `auth/end_user_flow_remodeled` note. Authority swaps
  (service↔end_user) remain refused. Validated: Workday REST 2/2 blocked →
  review_required with a one-line manifest. (Zoho's mirror spec has an
  unresolvable external `Common.json` ref — a corpus artifact, same auth
  shape as Workday.)

## 2026-08-30 — Resource derivation and MCP tool-name stutter (six untrimmed estates, 3,023 operations)

Measured against `a9cfd63`. **Analysis only — no naming, classification or
disambiguation behaviour was changed.** Full write-up:
`docs/design/resource-derivation-and-tool-name-stutter.md`.

**Verify these numbers yourself** (this is the point of the entry — the log has
gone stale three times, so it ships with its own harness):

```bash
pnpm install && pnpm build
node tools/naming-audit/run.mjs --fetch zendesk --service zendeskfull
node tools/naming-audit/run.mjs --fetch plaid   --service plaid
NAMING_AUDIT_RULES=AC node tools/naming-audit/run.mjs --fetch github --service github
```

`--fetch` compiles the UNTRIMMED vendor spec from `systems.tsv`. Do **not** use
`reproduce.sh <system>` for this: its curated list cuts Zendesk to 9 operations
(verified — "Wrote …: 5 paths, 9 operations"), which cannot measure a rate.

### Per estate — never blend these; the defect rate ranges 0%–72%

| Estate | Style | Ops | Reads | resource contradicted by its own name text | bulk-RPC segment resource (`count_many`) | bare CRUD segment resource (`/x/get`) | tool-name stutter (spec-authored / service-prefix / disambiguation) |
|---|---|---:|---:|---:|---:|---:|---|
| zendesk untrimmed | tag-rich REST, RPC verbs in paths | 640 | 336 | 50 | 44 | 26 | 44 (0 / 0 / **44**) |
| github | tag-rich REST | 1222 | 638 | 154 | 0 | 13 | 74 (13 / 0 / **61**) |
| stripe | REST, path-encoded operationIds | 594 | 265 | 0 | 0 | 3 | 4 (2 / 0 / 2) |
| slack | RPC-over-HTTP, dotted segments | 174 | 80 | 0 | 0 | 0 | **0** |
| bigquery | Google Discovery | 42 | 18 | 0 | 1 | 1 | 42 (0 / **42** / 0) |
| plaid | RPC-over-HTTP, plain segments | 351 | 8 | 1 | 0 | **252** | **0** |

The brief's facts all reproduce exactly (640 operations; `count_many`/`show_many`/
`active`/`me` resources; 44 stutters). **One correction**: the `available` case is
`GET /api/v2/accounts/available`, not `/subdomains/available` — "subdomain" comes
from the displayName, which is itself the point.

### Read-variant collapse headroom — the naive number is 65–70% contamination

Reads keyed on `(resource, action)`; "tools saved" = members − clusters; gated on
same-OpenAPI-tag coherence (the spec's own answer to "are these one thing").

| Estate | naive today | tag-coherent today | naive after A+C | tag-coherent after A+C |
|---|---:|---:|---:|---:|
| zendesk | 104 | **31** | 109 | **58** |
| github | 282 | **100** | 284 | **102** |
| slack | 27 | **27** | 27 | **27** |
| stripe / bigquery | 48 / 1 | n/a (0 tagged) | 48 / 1 | n/a |
| plaid | 0 | 0 | 0 | 0 |

Zendesk's largest apparent cluster, `count|list(21)`, is 21 counts of 21
*different* resources spanning **13 different tags**. The 13 reads under
`/api/v2/views/` split across seven `effect.resource` values — today's derivation
over-clusters (`count` gathers 22 unrelated ops) *and* under-clusters (the four
`views` list variants the feature exists to collapse land in four clusters).

### Three things that were not in the brief

1. **The 44 stutters are three defects.** Only `disambiguation_suffix`
   (`naming.ts:534-539`) is Anvil's. GitHub's 13 are the vendor's own
   operationId (`copilot/copilot-enterprise-…`) and must NOT be "fixed".
   BigQuery's 42 are `${serviceId}_${canonicalName}` where the operator passed
   `--service bigquery` against Discovery operationIds `bigquery.models.get` —
   with Anvil's derived id (`big_query_api`) the same spec stutters zero times.
2. **`singularize` (`naming.ts:28-36`) over-strips.** `releases→releas`,
   `databases→databas`, `searches→searche`, `branches→branche`, `cases→cas`,
   `licenses→licens`. Hand-verified: github 26 ops, zendesk 4. It corrupts
   `effect.resource` on its own AND sabotages any name-corroboration repair,
   because a non-word can never corroborate. Mirrored verbatim at
   `packages/refinement/src/skills/executor.ts:69`.
3. **`tools/corpus/expected/plaid.json` is ALREADY stale on `a9cfd63`** —
   `node tools/corpus/run.mjs quick --systems plaid` fails
   `naming-differential`: expects `plaid_asset_report_remove_post`, gets
   `plaid_asset_report_remove_asset_report_direct`. Quick mode needs network so
   it is not in `pnpm test`. Left unfixed on purpose (see the design doc §7).

### Rules: what to accept, what to reject, and why — measured

| Rule | zendesk | github | stripe | slack | bigquery | plaid |
|---|---:|---:|---:|---:|---:|---:|
| A bulk-RPC segment (`<verb>_many`) | 44 | 0 | 0 | 0 | 1 | 0 |
| B name corroboration | 32 | 137 | 0 | 0 | 0 | 1 |
| C bare CRUD segment, resource-only | 26 | 13 | 3 | 0 | 1 | 252 |
| **A+C (recommended)** | **70** | **13** | **3** | **0** | **2** | **252** |

- **Accept A and C.** 45 A-changes across 3,023 ops with zero corroboration
  lost; C needs no `OperationAction` enum change because it re-homes the
  resource only and lets the existing collision resolver name the variant.
- **Reject "a segment matching `ACTION_VERB_WORDS` is an action".** Simulated:
  88 Zendesk changes, 15 corroboration gained, **16 lost**. `trigger`, `status`,
  `filter`, `query`, `report`, `message`, `lock` are vocabulary words *and* real
  REST collections (Zendesk has 13 ops on `trigger` alone). The existing narrow
  bare-single-word use at `naming.ts:293-299` is as far as that table can go.
- **Reject B as a compiler rule.** It scores 137/137 "corroboration gained" on
  GitHub and a hand audit of every 5th change (28 sampled) found ~15 outright
  **wrong** (`hook→org`, `content→repo`, `subscription→user`, `releas→repo`).
  Corroboration measures agreement with the operation's own name text, not
  truth; GitHub's operationIds use synonyms of the path. It also buys nothing:
  A+C alone reaches GitHub's 102 tag-coherent headroom, and on Zendesk B makes
  it *worse* (58 → 57). Its right home is a `detect.ts` deficiency closed by a
  manifest `name: { resource: … }` override — machinery
  `manifest.ts:770` + `projectRoutingNames` already provide end to end.
- **A+C do not fix**: adjectival selectors (`active`, `compact`, `assignable`,
  `available`), pronoun/one-off RPC segments (`me`, `logout`, `apply`,
  `display`, `order`), generic sub-resource over-clustering (`definition`, 10
  ops across three parents), or synonym mismatch. Said out loud rather than
  glossed.

### Blast radius (all id-bound surfaces read, not assumed)

- `contractHash` hashes the WHOLE AIR document (`packages/air/src/hash.ts:38`),
  so *any* `effect.resource` change moves it — there is no "resource is
  metadata" escape. It cascades to `contractDigest`
  (`compiler/src/contract/digest.ts:70`), `bundle.json`'s
  `contractHash`/`capabilityHash` (`generators/src/capability-view.ts:359-360`),
  `packDigest` (`system-pack/src/digest.ts`), and every stored refinement
  assessment (`refinement/src/assess.ts:299`).
- `diffSurfaceSignature` (`compiler/src/capability/signature.ts:161`) and
  `diffContracts` (`compiler/src/drift.ts:461-499`) have **no rename lane**: a
  re-homed approved operation emits `operation_removed` at *blocking* severity
  plus `operation_added`. Every affected estate's drift check goes red.
- `approveOperations` (`compiler/src/compile.ts:494`) and `anvil approve`
  (`cli/src/commands/approve.ts:66` (`<operation-ids...>`)) match `op.id` exactly. State lives in the
  bundle's `air.yaml`, so a recompile regenerates it — but literal-id runbooks
  break.
- **Manifests are largely safe, measured**: `operationMatchesKey`
  (`compiler/src/manifest.ts:646-648`) accepts id OR canonicalName OR
  `sourceRef.operationId`, and **0 of 231** operation entries across all 18
  `docs/backtesting/reproduce/manifests/*.yaml` are AIR-id-keyed (gmail's 11
  dotted keys are Discovery operationIds).
- Fixtures: `compiler/src/gateway/golden/expected/*.json` (5 files, literal AIR
  ids, all `/refunds` paths — unaffected); `tools/corpus/expected/*.json` (21
  files, operationId-keyed, `toolName`-asserting — `plaid.json` affected, and
  already stale); `compiler.test.ts:598-599` is the only unit assertion in the
  rules' blast zone and A/C leave it alone.
- **There is no safe automatic migration.** No id-alias or rename concept exists
  anywhere in AIR, the contract layer, or the pack; every id-keyed comparison is
  exact-match and treats a miss as removal. A mechanical old→new map is
  derivable at compile time, but consuming it means teaching every id-keyed
  surface a second lookup and inventing a rename compatibility class. Land
  behind a default-off flag; flip only in a release declared id-breaking.
