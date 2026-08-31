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
- **Fixed — this entry had gone stale.** It read "not yet fixed" long after the
  filter landed. `packages/cli/src/capability-composition.ts:18-22` declares
  `ENVELOPE_SOURCE_FRACTION = 0.8` / `ENVELOPE_MIN_SOURCES = 3`, and lines
  1258-1331 exclude a coordinate meeting both from `structural_leaf_overlap`
  candidate generation, recording it in `suppressedEnvelopeCoordinates` so the
  suppression is reviewable rather than invisible. An explicitly declared
  `x-anvil-data-point` id is exempt: a declaration is not noise. The lesson the
  rest of this file already states applies to this file too — verify against the
  code before citing it.

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
- **`packages/cli/src/commands/estate.ts` is 2,373 lines** (was 3,327; it now
  lives in `commands/estate/` alongside its bug-bash split-outs). The
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
  (Confirmed exactly, on the Zendesk estate run below: 640 operations compiled
  with zero intent examples, and `refine run --skill author-intent-examples`
  is a mandatory step before the benchmark has anything to measure.)

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

## Routing at estate scale (Zendesk, full untrimmed spec — the first real benchmark run)

Full write-up: `docs/backtesting/routing-at-scale.md`. The short version, because
this is the first demand-side measurement Anvil has ever taken:

- **640 operations compiled; 329 reads approved; 657 routing tasks.** Nothing is
  approved on compile and nothing has intent examples on compile — both steps
  are load-bearing prerequisites to measuring anything.
- **Accuracy is dominated by catalog SIZE, not catalog quality.** Same estate,
  same router, slices of the catalog: 90.0% at 10 tools → 58.6% at 329. A
  31-point fall. Cite this whenever someone proposes exposing a whole estate;
  it is the quantitative case for capabilities and the disclosure budget, and
  it replaces an argument that used to be made from intuition.
- **Compilation's routing uplift was +2.0 pts at 329 tools** (+10.0 at 10).
  Zendesk publishes good operationIds, so the bare baseline is strong. This is
  an honest, unflattering number: on a well-named estate, compiling does not buy
  discovery — it buys the safety gate, the parameter contracts, and cross-surface
  agreement. Do not let anyone quote the benchmark as a naming-quality claim.
- **The `--agent` arm had never worked.** It demanded that the router command's
  whole stdout parse as JSON; real model CLIs fence their answers, so the first
  real run scored 0/20 on tasks the model had routed correctly. Fixed (tolerant
  extraction, unchanged catalog gate) → 20/20 with a real model on the same
  slice. Lesson, again: a feature that has only ever run against its own test
  double has not run.
- **A real model does NOT route the curated catalog better than the bare one.**
  At 50 tools: model 88/100 curated vs 89/100 bare (83 both, 5 curated-only, 6
  bare-only) — noise, i.e. no measurable uplift, where the lexical floor showed
  +8.0. The model degrades on the same size curve (100.0% at 10 tools → 88.0% at
  50), so the size finding is not an artifact of a dumb router, but the *naming*
  half of the uplift story does not survive contact with a capable one. Never
  cite this benchmark as evidence that compiling improves discovery. What it
  cannot see is what compiling actually buys: the approval gate, idempotency and
  confirmation semantics, parameter contracts, and cross-surface agreement.
- **Open: 44 of 640 generated tool names repeat a word** —
  `count_activities_activities`, `list_active_automations_automations`. The
  disambiguation suffix is appended without checking whether the name already
  ends in it. Deliberately not fixed in the benchmarking PR: changing name
  disambiguation changes operation ids in every compiled bundle, which is a
  contract change.
- **12 of 1277 authored intent phrases named a different operation than their
  own tool name** ("list the mes" for `show_current_user`). Two Anvil surfaces
  disagreeing about an operation's name is the exact failure the product exists
  to prevent, and no gate caught it. `author-intent-examples` now requires the
  operation's own names to corroborate a phrasing, and proposes nothing when
  none survives.

## Observed capability groupings (real Zendesk estate, 640 operations)

Compiled the real published Zendesk OAS (`https://developer.zendesk.com/zendesk/oas.yaml`,
1.8 MB) end to end: **640 operations**, 741 bundle files, 122 review_required.

**The tag taxonomy, measured.** `anvil capability propose` returned **90
groupings, 100% of them `source: "tag"` at confidence 0.90** — median 6 tools,
max 35. That is the vendor's REFERENCE taxonomy (organised by resource:
"Attachments", "Brands", "Custom Object Fields"), so narrowing the served
catalog by capability moves the routing problem up a level rather than solving
it: pick 1 of 90 servers instead of 1 of 329 tools.

**The behavioural lane.** `packages/harness/src/trace-capabilities.ts` +
`anvil capability propose --from-records <spool>` group operations by
co-occurrence within one `traceId`. Driven against a synthesized-but-realistic
spool written through the runtime's own `JsonlRecordSpool` (2,550 records, 347
interleaved traces, 8 distinct shapes, retries and rate-limit errors mixed in),
over the real 640-operation AIR:

- 4 groupings proposed, all four **cutting across 3-4 of Zendesk's own tag
  capabilities** — e.g. the 140-trace triage task spans `zendesk.tickets`,
  `zendesk.ticket_comments`, `zendesk.users`, `zendesk.macros`. This is the
  disagreement between the reference taxonomy and real usage, measured rather
  than argued.
- 4 one-off shapes (3 traces each) proposed nothing: below the 5-trace floor,
  which is `MIN_SAMPLES_FOR_CLAIM`'s number and judgement.
- Two ubiquitous operations (`zendesk.current.list.oauth`,
  `zendesk.current.list.locales` — the session bootstrap) were filtered out
  statistically before any grouping formed: present in 8 of 8 trace shapes.

**The pre-filter, quantified — the behavioural form of the FLEXCUBE finding.**
Same spool, filter disabled: 25 grouping members of which **8 (32%) were pure
session-bootstrap noise**, and the co-occurrence pair table more than doubles
(31 → 68). With the filter: 17 members, 0% noise. The filter is a pre-filter,
not a smarter evidence bar afterwards, for the reason `design-patterns.md`
gives.

**One design note worth carrying forward**: ubiquity is measured over distinct
trace *shapes*, not trace instances — the structural analogue of the envelope
filter counting *sources*, not occurrences. Counting instances breaks twice:
one very hot task repeated ten thousand times makes its own members look
ubiquitous, and a spool that only ever saw one task suppresses every operation
in it and proposes nothing.

**CLOSED — a manifest can now author a capability.** The gap this entry named
("`CapabilitySource` includes `\"manifest\"` and nothing in the workspace ever
sets it; `CapabilityReviewManifest` can only approve/reject what discovery
produced") is closed end to end. The write path is
`authorCapabilities` (`packages/compiler/src/capability-authoring.ts:35`),
which sets `source: "manifest"` at
`packages/compiler/src/capability-authoring.ts:83` and — the load-bearing line,
armed as mutation mutant `capability-authoring/never-born-approved` — births
every authored capability at `lifecycle: "proposed"`
(`capability-authoring.ts:99`), wired into compile between discovery and
workflow attachment (`packages/compiler/src/compile.ts:419`). The manifest
schema gained the authoring fields on the same `capabilities:` entry the
review path always used (`CapabilityReviewManifest`,
`packages/compiler/src/manifest.ts:487`): `operations` (the authoring marker;
empty refused), `display_name`, `description`, `intent_examples`. Validation
is hard and structured: `capability_author_member_unresolved`,
`capability_author_id_collision` (never a silent merge). Approval flows
through the SAME `approveCapability` disclosure budget as a discovered
grouping — a 21-member authored capability is refused without
`allow_large` + note, verified at compile level. `anvil build` of an approved
authored capability works unchanged, and an authored capability whose members
are all unapproved still builds nothing (`capability_empty`) — authoring
grants no approval to members. `anvil capability diff` reports an authored
capability truthfully ("manifest-authored; not expected in discovery",
members checked against the document) instead of phantom drift
(`diffCapability`, `packages/compiler/src/capability-review.ts:543`). The
traffic loop is closed propose-only: each observed grouping now carries a
ready-to-review `manifestSnippet` (`packages/harness/src/trace-capabilities.ts`),
and `anvil capability propose --from-records --snippet <grouping-id>` prints
it verbatim for the operator to paste, review, and compile — Anvil never
writes the manifest file.

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

## Resource derivation + tool-name stutter fix landed (2026-08-30, six untrimmed estates)

`docs/design/resource-derivation-and-tool-name-stutter.md` implemented against
`a9cfd63` after owner approval of the id break: singularize over-strip fix
(both mirrored copies, drift-guarded by `packages/compiler/src/naming.test.ts`),
rules A (bulk-qualified verb segments) + C (bare CRUD-verb terminal segments,
resource-only, estate-wide non-terminal guard), the disambiguation-suffix
stutter skip, and a `service_prefix_stutter` compile warning. Rule B stays
rejected as a compiler rule. Measured with `tools/naming-audit/run.mjs` before
and after, per estate (re-homed resources = predicted exactly):

| estate | ops | re-homed (predicted → measured) | disamb. stutters before → after | spec-authored (untouched) |
|---|---:|---|---|---|
| plaid | 351 | 252 → **252** | 0 → 26 (rule-C collisions where the only distinguishing word is the op's own trailing verb — the structural floor of resource-only re-homing on an RPC estate) | 0 |
| zendesk (untrimmed) | 640 | 70 → **70** | 44 → **0** | 0 |
| github | 1222 | 13 → **13** | 61 → **2** (`/user/issues`, `/user/repos`: the only distinguishing word is the operationId's own tail) | 13 |
| stripe | 594 | 3 → **3** | 2 → **0** | 2 |
| bigquery | 42 | 2 → **2** | 0 → 0 (42 `service_prefix_join` untouched, now warned) | 0 |
| slack | 174 | 0 → **0** | 0 → 0 | 0 |

`effect.action` changed on **zero** operations (resource-only re-homing held).
Plaid's resource catalogue went from 71 values topped by
`get(114) create(53) list(39)` to 146 values topped by `transaction(14)`,
with no CRUD verb left as any operation's resource. Singularize moved 29
github resources (the doc's hand table said 26 — it missed `dispatche`(2),
`marketplace_purchas`(1)) and 4 zendesk ones, all to real words; the brief's
literal sibilant class `(ch|sh|x|z|ss)es` had to be narrowed (`z` → `zz`, plus
a small `-che` stem list) because it minted new non-words on GitHub's real
estate (`caches → cach`, `machine-sizes → machine-siz`).

The corpus caught what the six measured estates could not: NetSuite's WSDL
lowers to `/NetSuitePortType/get|add|getAll`, and unguarded rules A/C
collapsed those bare-CRUD method names onto the synthetic wrapper as their
resource — the same failure mode the trailing-verb rule's single-word guard
documents for GraphQL. Fix: `normalize` hands `deriveNames` the estate path
context only for resource-grammar source kinds (openapi/swagger/discovery/
postman/odata); without it the rules stay off. Also found stale-at-base:
`tools/corpus/expected/{box,adyen,adobe_aem}.json` pinned pre-subsetFallback
collision tokens (verified identical under the base compiler) — refreshed
alongside plaid's deliberately-left-stale pin.

The one-line lesson: a rule measured against real estates before it ships
lands exactly on its prediction — and every place it drifted (three missed
singulars, the sibilant class, the WSDL wrapper) was a place where a hand
count, a spelled-out regex, or an unmeasured source kind had NOT been
machine-checked against real estates first.

## 2026-08-30 — Naming conformance becomes an always-on ratchet (corpus lanes)

The naming audit that found the six defects above is a hand-run,
network-needing tool — which is why the defects sat unnoticed for months. The
corpus now gates the audit's counters continuously
(`tools/corpus/naming-conformance.mjs`, semantics copied from
`tools/naming-audit/run.mjs`, which stays the source of truth): per estate,
(a) `effect.resource` values sharing zero content tokens with their own
canonicalName/displayName, (b) tool-name stutter split spec_authored /
service_prefix_join / disambiguation_suffix, (c) singularize-over-strip
candidate resources. The ratchet FAILS on any counter growth (no recorded-plan
escape — unlike the module-size ratchet, there is never a good reason for more
semantic contradictions); shrinkage passes loudly and must be banked with
`--update-naming-baseline`. Offline estates lane gates every PR via ci.yml;
the network systems gate nightly via corpus.yml. Growth-trip is pinned by
`tools/corpus/naming-conformance.test.ts` and armed as mutation
`corpus/naming-ratchet-fails-on-growth`.

Recorded baselines (produced by running the oracle, 2026-08-30). Offline
estates (also now covered by expected/<estate>.json naming pins, generated
from a green run): kong-refunds 0/0-0-0/1, kong-reporting 0/0-0-0/1,
apigee-payments 0/0-0-0/1, wso2-orders 0/3-0-0/0, mulesoft-customer 0/0-0-0/0,
apiconnect-claims 0/2-0-0/1 (zeroOverlap / stutters spec-join-disamb /
overStripped). The wso2/apiconnect `spec_authored` stutters
(`order_service_get_orders_orders`) are the gateway adapters' own synthesized
operationIds — real signal the estates lane had never measured.

Network systems (20 of 34 recorded): plaid 1/0-0-26/15 (the 26 is the
post-A+C structural floor the design doc predicted, now pinned so it cannot
grow), bigquery 0/0-42-0/0 and gmail 0/0-11-0/0 (the `--service`-choice
prefix join, pinned), box 0/24-0-0/9, adobe_aem 20/0-0-0/0, etcd 6/0-0-0/0,
hubspot 0/6-0-0/0, temporal 0/0-0-0/6; the rest small or zero.

**Live confirmation of the invisibility hole while recording**: 13 of 34
quick-mode systems (github, stripe, twilio, zendesk, intercom, docusign,
github_gql, linear, odata_trippin, okta, datadog, xero, shopware) currently
fail AT COMPILE — `anvil compile` exits 1 on error-level diagnostics
(`auth/service_oauth2_ambiguous`, `duplicate_agent_input_name`,
`query_language_passthrough`), all of which predate the merge base — and
oracle_ords's vendor spec URL now 404s. The scheduled quick lane is red today
and nobody had noticed, which is the exact failure mode this work exists to
end: corpus.yml's gate job now opens/updates a `corpus-regression` issue on
failure and closes it when green, so a scheduled red lands in the tracker
instead of a run list nobody reads. Those 13+1 systems have no naming
baseline yet; once their compile reds are fixed, the oracle fails with the
exact record command until one is recorded (reviewed).

## 2026-08-30 — Path grammar becomes a compiled, evidenced decision (zero id churn)

Successor to the resource-derivation fix above. The kind-gate that fix ended
with (estate path context only for openapi/swagger/discovery/postman/odata)
made the REST-vs-RPC grammar call implicitly, by source kind. Now
`classifyPathGrammar` (`packages/compiler/src/path-grammar.ts`) makes it
explicitly, from one deterministic pass over the estate (three paired signals
with abstention bands: CRUD-verb terminal fraction, GET/HEAD share, `{param}`
path fraction; plus a dotted-terminal short-circuit and a verb-repetition
count carried as evidence). The verdict + counts land in AIR at
`service.source.pathGrammar` (additive, optional — an older air.yaml
round-trips byte-identically), drive the estate-context gate in `normalize`,
print from `anvil inspect`, and are overridable by a top-level manifest
`path_grammar:` key (a contradicting override applies but records a
`path_grammar_override_contradicts_evidence` warning). A genuinely split
estate declines: `ambiguous` classification, `path_grammar_ambiguous` warning
naming both candidates with counts, fallback to the pre-classifier source-kind
gate — armed as mutation mutant
`path-grammar/ambiguous-never-silently-selects`.

**Verdicts on the measured estates** (all basis `estate_evidence` unless
noted; counts are `verb-terminal / GET-HEAD / parameterized / dotted` over
ops):

| estate | ops | verdict | winning counts |
|---|---:|---|---|
| plaid | 351 | **rpc_plain** | 252 verb-terminal, 5 GET/HEAD, 4 parameterized |
| zendesk (untrimmed) | 640 | resource_grammar | 70 verb-terminal, 333 GET/HEAD, 363 parameterized |
| github | 1222 | resource_grammar | 13 / 638 / 1135 |
| stripe | 594 | resource_grammar | 3 / 265 / 393 |
| bigquery (discovery) | 42 | resource_grammar | 2 / 16 / 41 |
| slack | 174 | **rpc_dotted** | 174/174 dotted terminals |
| odata trippin / northwind | 25 / 130 | resource_grammar | trippin's 3 bound-op dotted terminals stay under the 0.5 gate |
| examples/{payments,sap} | 4 / 11 | resource_grammar | — |
| examples/{soap,graphql} | 4 / 9 | adapter_lowered (source_kind) | by construction; counts still recorded |

**Zero-churn proof held exactly**: all 12 before/after dumps byte-identical on
id/resource/action/canonicalName/cli/toolName (3,206 operations), plus
`node tools/corpus/run.mjs estates` green. The classifier NAMES what the code
already did; the one place its verdict differs from the old kind-gate — Slack
(openapi kind, but context now off as `rpc_dotted`) — is an estate where rules
A+C fired zero times, measured, so the names cannot move.

**Deliberately not done** (recorded as future work in the design doc): driving
`effect.action` from the terminal verb on `rpc_plain` estates (would erase
Plaid's 26 residual `…get_get` stutters but changes ids and `OperationAction`),
and weighing an `rpc_plain` verdict in read classification (safety loosening —
needs the asymmetric evidence bar, not a grammar verdict).

## Rule B lands as a detector, not a compiler rule (2026-08-30)

`resource_contradicted_by_own_name` (packages/refinement/src/detectors/
resource-name.ts) is the measured-safe home of rule B from
docs/design/resource-derivation-and-tool-name-stutter.md §6: a deterministic
detector that fires when `effect.resource` shares no content-token stem
(camel/snake split, stopwords, plural-insensitive — `routingTokens` in
src/vocabulary.ts, one tokenizer shared by detector, heuristic, and
validation) with the operation's own `canonicalName`/`displayName`. It is
closed through the existing detect → export-task → harness →
import-proposal → review → apply-pack rails by the `rehome-resource` skill,
whose output boundary is the one axis the manifest `name: { resource }`
override already projects end to end (compiler manifest.ts →
projectRoutingNames).

Measured on the test suite's fixture estates (deterministic, from
`runDetectors` over the checked-in fixtures): the GitHub-shaped
hook/webhook estate in
packages/refinement/src/protocol/rehome-resource.test.ts — **3 of 4
operations fire** (`github.hooks.get` and `github.hooks.list`, both the
audited `hook`-path/"webhook"-name synonym case, plus `github.releas.get`,
the singularize over-strip victim); the corroborated control
(`github.repos.list`, resource `repo` vs name `list_org_repos`) does not
fire. **No pre-existing fixture in the refinement or CLI suites started
firing**: every suite that asserts exact deficiency sets, plan counts, or
pack summaries for its fixture estates passed unchanged (the only test
edits were the two skill-roster lists that enumerate implemented skills by
name) — pre-existing fixtures whose resources are derived from the same
words their names use are untouched, which is the detector precision the
design doc's audit demanded.

Two boundaries make an unreliable harness safe here, both deterministic:
`resource_grounded_in_contract` (validate.ts) refuses any proposed resource
that is not a word the operation's own path or name text states (mutation
gate: `refinement/ungrounded-resource-refused`), and approval.ts routes
every `resource` patch to review on the FIELD, like the idempotency guard —
a valid proposal from verified authoritative evidence still lands at review.
The heuristic executor proposes ONLY the singularize over-strip repair
(`releas` → `release`, the vendor's own word read off the vendor's own
name); every synonym case honestly proposes nothing and flows to the
harness seam.
