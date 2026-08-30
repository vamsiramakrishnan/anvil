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
- **Fixed since.** `packages/cli/src/capability-composition.ts` now carries the
  envelope commonality pre-filter (`ENVELOPE_SOURCE_FRACTION` /
  `ENVELOPE_MIN_SOURCES`): a coordinate present in that fraction of all sources
  is classified as transport envelope and skipped unless explicitly declared.
  This entry said "not yet fixed" long after it was — third time this log has
  been caught stale. Verify against the code before citing it.

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
