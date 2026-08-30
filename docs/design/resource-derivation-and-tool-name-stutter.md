# Resource derivation and tool-name stutter

Status: **implemented** (approved by the repo owner as an id-breaking change;
measured 2026-08-30 against `a9cfd63`, implemented on top of the same commit).
What landed, and what deliberately did not:

- **Implemented**: the `singularize` over-strip fix (§5, both mirrored copies);
  rules **A** (bulk-qualified verb segments) and **C** (bare CRUD-verb terminal
  segments, resource-only, with the estate-wide non-terminal guard) in
  `deriveNames`; the disambiguation-suffix stutter skip in
  `resolveNameCollisions`; and a `service_prefix_stutter` compile **warning**
  when an operator-chosen service id duplicates the operationIds' leading word
  (the toolName join itself is untouched).
- **One gate this document missed, found by the corpus**: rules A and C run
  only for source kinds whose paths follow resource grammar (OpenAPI/Swagger,
  Discovery, Postman, OData). The six measured estates never exercised an
  adapter-lowered RPC kind; NetSuite's WSDL — lowered to
  `/NetSuitePortType/<methodName>` — has operations literally named `get`,
  `add`, `getAll`, and unguarded rule C (and rule A, via `getAll`) collapsed
  them onto the synthetic port-type wrapper as their resource, the exact
  failure mode §6 documents for GraphQL's single-word guard. `normalize` now
  passes the estate path context only for resource-grammar kinds, and
  `deriveNames` re-homes nothing without it.
- **Still rejected / not implemented**: rule B as a compiler rule (§6 stands);
  rewriting `spec_authored` stutters; using `ACTION_VERB_WORDS` to disqualify
  segments; the "last NOUN-ish segment" idea; everything in §"What A+C do not
  fix". No default-off flag was used — the owner approved the id break
  directly, so the rules are unconditional.
- **Measured after implementation** (same harness, same six estates): id churn
  matched the §7 prediction exactly — plaid **252**, zendesk **70**, github
  **13**, stripe **3**, bigquery **2**, slack **0** re-homed resources, with
  `effect.action` unchanged on every single operation. Disambiguation-suffix
  stutters: zendesk 44 → **0**, stripe 2 → **0**, github 61 → **2**
  (`/user/issues` and `/user/repos`, where the ONLY distinguishing path word is
  the word the vendor's own operationId ends with — every alternative is a
  numbered blank, which is worse). `spec_authored` unchanged (github 13,
  stripe 2); bigquery's 42 `service_prefix_join` unchanged and now warned
  about. Rule C's new collisions handed plaid **26** stutters the resolver
  cannot avoid (`plaid_asset_report_get_get`): when `/asset_report/get`,
  `/asset_report/refresh` and `/asset_report/remove` all land on
  `asset_report.create`, the only distinguishing path word each op has IS its
  own trailing verb, which the vendor's operationId already ends with. This is
  the structural floor of resource-only re-homing on an RPC estate — the
  alternative was extending `OperationAction`, which §6 rejects. The stutter
  skip does hand the group's first member the elided `direct` token
  (`plaid_asset_report_create_direct`), so only the later siblings pay. One
  correction to §5's arithmetic: the fix moved **29** github resources, not
  26 — the hand-verified table missed `dispatche`(2) and
  `marketplace_purchas`(1).

Every figure below is reproducible with the read-only harness added alongside
this document:

```bash
pnpm install && pnpm build
node tools/naming-audit/run.mjs --fetch zendesk --service zendeskfull
node tools/naming-audit/run.mjs --fetch github  --service github
node tools/naming-audit/run.mjs --fetch plaid   --service plaid
```

`--fetch` pulls the **untrimmed** vendor spec named in
`docs/backtesting/reproduce/systems.tsv`. It deliberately does not go through
`docs/backtesting/reproduce/reproduce.sh <system>`: that script applies the
curated operation list, which cuts Zendesk to 9 operations —

```
$ docs/backtesting/reproduce/reproduce.sh zendesk
→ zendesk: fetching https://developer.zendesk.com/zendesk/oas.yaml
Wrote …/zendesk.spec.json: 5 paths, 9 operations, 53 components.
   Compiled 9 operations from src-f8ff72c23b8128c5 (openapi) → …/generated/zendesk (135 files).
```

— far too small a sample to measure a defect *rate* on. The curated recipe is
right for safety backtesting; it is wrong for this measurement.

## 1. Where the code is

| Thing | Location |
|---|---|
| `effect.resource` assignment | `packages/compiler/src/normalize.ts:755` — `effect.resource = singularize(names.resource)` |
| resource choice | `packages/compiler/src/naming.ts:318-323` |
| the existing trailing-verb rule | `packages/compiler/src/naming.ts:291-317` |
| action choice | `packages/compiler/src/naming.ts:339-351` |
| `canonicalName` | `packages/compiler/src/naming.ts:354-356` — `operationId` wins outright |
| `displayName` | `packages/compiler/src/naming.ts:357-358` — the spec `summary` wins outright |
| MCP tool name | `packages/compiler/src/naming.ts:411` — `` `${serviceId}_${canonicalName}` `` |
| disambiguation suffix append | `packages/compiler/src/naming.ts:534-539` |
| the action vocabulary the trailing-verb rule reuses | `packages/compiler/src/classify.ts:140-151` (`ACTION_VERB_WORDS`), `classify.ts:175-177` (`actionVerbFor`) |
| `singularize` | `packages/compiler/src/naming.ts:28-36` (mirrored at `packages/refinement/src/skills/executor.ts:69`) |

The one structural fact that explains the whole defect class:
`naming.ts:318-323` derives the resource from **one path segment**, while
`naming.ts:354-358` takes `canonicalName` and `displayName` from **the spec's
own operationId and summary**. Those two sources are never reconciled. When they
disagree, nothing notices.

## 2. The reported facts, verified

All five reported Zendesk cases reproduce exactly (untrimmed
`https://developer.zendesk.com/zendesk/oas.yaml`, `--service zendeskfull`,
640 operations — the reported count is exact):

```
GET /api/v2/views/count_many
  id=zendeskfull.count_many.list
  resource="count_many" action="list" kind=read
  canonicalName=get_view_counts
  displayName="Count Tickets in Views"
  cli="zendeskfull count_many list"

GET /api/v2/users/show_many    resource="show_many"  canonicalName=show_many_users_users
GET /api/v2/views/active       resource="active"     canonicalName=list_active_views_views
GET /api/v2/users/me           resource="me"         canonicalName=show_current_user
GET /api/v2/accounts/available resource="available"  canonicalName=verify_subdomain_availability
```

Tool-name stutter is exactly 44 of 640, as reported.

**One correction to the brief.** The `available` case is
`GET /api/v2/accounts/available`, not `/subdomains/available` — there is no
`/subdomains` path in the spec. The word "subdomain" comes from the *displayName*
("Verify Subdomain Availability"), which is precisely the point: the spec's own
name text knows what the operation is about and the derived resource does not.

**Two additions the brief did not name**, both found while measuring:

- The 44 stutters are **not one defect**. Across six estates they split into
  three causes with three different owners (§4).
- `singularize` over-strips a whole class of English plurals (§5), which
  corrupts `effect.resource` independently of any path reasoning and — worse —
  poisons the "corroborate against the name" repair, because an over-stripped
  stem can never match a real word.

## 3. Defect 1 — the resource is a path segment, and often that segment is a method

`tools/naming-audit/run.mjs`, six untrimmed estates chosen for style contrast.
Never blend these: the defect rate ranges from 0% to 72%.

| Estate | Style | Ops | Reads | resource contradicted by its own name text | resource is a bulk-RPC segment (`count_many`) | resource is a bare CRUD verb segment (`/x/get`) |
|---|---|---:|---:|---:|---:|---:|
| zendesk (untrimmed) | tag-rich REST with RPC verbs in paths | 640 | 336 | 50 | 44 | 26 |
| github | tag-rich REST | 1222 | 638 | 154 | 0 | 13 |
| stripe | REST, path-encoded operationIds | 594 | 265 | 0 | 0 | 3 |
| slack | RPC-over-HTTP, dotted segments | 174 | 80 | 0 | 0 | 0 |
| bigquery | Google Discovery | 42 | 18 | 0 | 1 | 1 |
| plaid | RPC-over-HTTP, plain segments | 351 | 8 | 1 | 0 | **252** |

Two estates are the interesting ends of the range.

**Slack is clean — zero defects on every measure.** `decomposeSegment`
(`naming.ts:192-215`) already splits a dotted RPC segment
(`chat.postMessage` → resource `chat`, action `post_message`). When a vendor
declares "this is RPC" in the URL shape, Anvil already reads it correctly. The
defect is not "Anvil can't do RPC"; it is "Anvil only recognises RPC when it is
punctuated".

**Plaid is the worst case, and it is not a tail.** 252 of 351 operations
(72%) take a bare CRUD verb as their resource:

```
POST /transactions/get       id=plaid.get.create.transactions_direct   cli="plaid get create transactions_direct"
POST /accounts/balance/get   id=plaid.get.create.accounts_balance      cli="plaid get create accounts_balance"
POST /item/get               id=plaid.get.create.item                  cli="plaid get create item"
```

The whole 351-operation estate collapses onto 71 "resources" whose top six are
`get(114) create(53) list(39) update(15) refresh(12) remove(12)`. An agent asked
to route on that catalogue has nothing to route on.

The existing trailing-verb rule (`naming.ts:291-317`) does not fire here for two
reasons, both deliberate and both documented in the code: it only accepts a
**single-word** segment (`!snakeCase(lastConcrete).includes("_")`, line 297) and
it only recognises the ten `ACTION_VERB_WORDS` families — which contain
`search`, `query`, `status`, `execute`, but not `get`, `list`, `create`,
`count`, `show`.

## 4. Defect 2 — tool-name stutter is three defects wearing one coat

Classified by *where* the adjacent repeat is introduced:

| Estate | Total | `spec_authored` (already in the vendor's operationId) | `service_prefix_join` (`${serviceId}_${canonicalName}`) | `disambiguation_suffix` (`naming.ts:534-539`) |
|---|---:|---:|---:|---:|
| zendesk | 44 | 0 | 0 | **44** |
| github | 74 | 13 | 0 | **61** |
| stripe | 4 | 2 | 0 | 2 |
| slack | 0 | 0 | 0 | 0 |
| bigquery | 42 | 0 | **42** | 0 |
| plaid | 0 | 0 | 0 | 0 |

- **`disambiguation_suffix`** is the reported defect and the only one that is
  unambiguously Anvil's to fix. `resolveSurfaceCollisions` picks the shortest
  distinguishing path token and appends it unconditionally
  (`naming.ts:534-539`), without asking whether `canonicalName` already ends in
  that word: `zendeskfull_count_activities_activities` from
  `GET /api/v2/activities/count`, `github_apps_get_webhook_config_for_app_app`
  from `GET /app/hook/config`.
- **`spec_authored`** must **not** be "fixed". GitHub's 13 are
  `copilot/copilot-enterprise-one-day-usage-metrics` — GitHub wrote that
  operationId. Rewriting a vendor's declared name is exactly the guessing Anvil
  exists to stop.
- **`service_prefix_join`** is real but operator-dependent. BigQuery's 42/42
  only stutter because the reproduce recipe passes `--service bigquery` while
  the Discovery operationIds are `bigquery.models.get`. With Anvil's own derived
  service id the same spec produces zero stutters:

  ```
  $ node -e '…compile({spec})'   # no serviceId override
  derived serviceId: big_query_api
  big_query_api_bigquery_models_get
  ```

  A fix here belongs at the `toolName` join (`naming.ts:411`) or as a compile
  warning when the operator's `--service` duplicates the operationId's leading
  token — not in the collision resolver.

## 5. Defect 3 (new) — `singularize` over-strips

`packages/compiler/src/naming.ts:28-36`. The `-ses → -s` branch exists to keep
`statuses → status` and `buses → bus`, but it fires on every `-ses` plural:

```
$ node -e '(async()=>{const C=await import("./packages/compiler/dist/index.js");
  for (const w of ["releases","databases","searches","branches","boxes","cases","licenses","statuses","buses","addresses"])
    console.log(w.padEnd(12),"->",C.singularize(w));})()'
releases     -> releas
databases    -> databas
searches     -> searche
branches     -> branche
boxes        -> boxe
cases        -> cas
licenses     -> licens
statuses     -> status
buses        -> bus
addresses    -> address
```

Hand-verified operation counts (the audit's `defect3.candidateResources` is a
candidate list — it over-reports legitimate singulars a spec only ever writes in
the plural, e.g. Slack's `user`/`view`/`file`, so these were checked by eye):

| Estate | Operations with an over-stripped resource | Values |
|---|---:|---|
| github | 26 | `releas`(5) `immutable-releas`(5) `analys`(3) `automated-security-fixe`(3) `branche`(3) `databas`(3) `licens`(2) `variant-analys`(2) |
| zendesk | 4 | `saved_searche`(4) |

This is not cosmetic. `releas` and `release` cluster separately, and no
name-corroboration rule can ever rescue an operation whose resource is not a
word. The mirrored copy at `packages/refinement/src/skills/executor.ts:69` has
the same behaviour by design ("character-for-character identical"), so a fix has
to move both.

## 6. What the fix should be

Three candidate rules were simulated **anchored to real output** — the baseline
segment index is the segment that actually produced today's `effect.resource`,
so each rule is measured as a delta on real behaviour, never as an independent
re-derivation that could differ for unrelated reasons.

| Rule | zendesk | github | stripe | slack | bigquery | plaid |
|---|---:|---:|---:|---:|---:|---:|
| **A** bulk-RPC segment (`<verb>_many\|_all\|_bulk`) | 44 | 0 | 0 | 0 | 1 | 0 |
| **B** name corroboration (fall back to the parent when the candidate is absent from `canonicalName`/`displayName`) | 32 | 137 | 0 | 0 | 0 | 1 |
| **C** bare CRUD-verb segment (`/x/get`, `/x/count`) | 26 | 13 | 3 | 0 | 1 | 252 |
| **A+C combined** (recommended) | 70 (10.9%) | 13 (1.1%) | 3 (0.5%) | 0 | 2 (4.8%) | 252 (71.8%) |
| **A+B+C combined** | 83 (13.0%) | 149 (12.2%) | 3 (0.5%) | 0 | 2 (4.8%) | 253 (72.1%) |

### Accept: rule A — a bulk-qualified verb segment is a method

`count_many`, `show_many`, `destroy_many`, `create_many`, `update_many`,
`restore_many`, `recover_many`. Detection is closed and unambiguous: a
multi-token segment whose head is a verb and whose *every* remaining token is a
quantity qualifier. Across all 3,023 operations measured it changed 45
operations and lost corroboration on **zero**. It is a strict generalisation of
the rule already at `naming.ts:293-299`, relaxing only the `includes("_")`
guard, and only for this shape — so the reason that guard exists (GraphQL/gRPC
lower every operation to `/graphql/Mutation/<field>`, and a field named
`acceptEnterpriseAdminInvitation` must stay the resource) is untouched: no
GraphQL field ends in `_many`.

### Accept: rule C — a bare CRUD-verb segment is a method, resource-only

`/transactions/get` → resource `transaction`. Two design choices matter:

1. **Resource-only re-homing.** Leave `effect.action` exactly as the HTTP method
   produced it and let the existing collision resolver supply the variant token.
   `GET /api/v2/activities` and `GET /api/v2/activities/count` both become
   `zendeskfull.activities.list`; the resolver's own distinguishing-token logic
   then names the second `…list.count`. This is the cheaper option *and* the
   more truthful one, because `OperationAction`
   (`packages/air/src/enums.ts:24-42`) has no `count`, `show`, `insert`,
   `destroy`, `sync` or `refresh` member. Setting the action from the segment
   would require either extending that enum — a contract change to
   `effect.action`, which the CLI command, the skill card and the surface
   signature's `effectDigest` all project — or a lossy segment→enum map. Neither
   is worth it for a resource fix.
2. **A non-terminal guard.** The verb word must never appear as a *non-terminal*
   concrete segment anywhere in the same estate. If a spec has
   `/reports/{id}/lines`, then `reports` is a real collection there and
   `/x/reports` must keep it. This is the cheap statistical pre-filter
   `design-patterns.md` prescribes, applied before the rule rather than as a
   smarter bar afterwards. It fired zero times on all six estates — it is
   insurance, not load-bearing.

Rule C also fixes Zendesk's single largest contaminated cluster:
`count|list(21)`, whose 21 members span **13 different OpenAPI tags**.

### Reject: using Anvil's own `ACTION_VERB_WORDS` to disqualify a segment

This is the most attractive-looking option in the brief and it is wrong. An
earlier simulation that treated any segment whose head token is in
`ACTION_VERB_WORDS` as an action changed 88 Zendesk operations, gained
corroboration on 15 and **lost it on 16** — a net negative. The cause is
structural: `trigger`, `status`, `filter`, `query`, `report`, `message`, `hold`,
`lock`, `check` are all in the vocabulary *and* all real REST collections.
Zendesk alone has `GET /api/v2/custom_objects/{key}/triggers` (13 operations on
`trigger`) and `GET /api/v2/channels/twitter/tickets/{id}/statuses`. The
vocabulary exists to name what an operation *does*; it is not, and must not
become, a list of words that cannot name a thing. `naming.ts:293-299`'s existing
narrow use — a *bare, single-word* trailing segment only — is as far as that
table can safely be pushed.

### Reject as a compiler rule: rule B — name corroboration

Corroboration scores beautifully (`corroborationGained` 137, `corroborationLost`
0 on GitHub) and is nonetheless unsafe, because **corroboration measures
agreement with the operation's own name text, not truth**. A hand audit of a
28-item systematic sample (every 5th of the 137 GitHub changes) found roughly 15
semantically **wrong**, 10 right, 3 arguable:

```
wrong:  /orgs/{org}/hooks/{hook_id}          hook            -> org     (canonical says "webhook")
wrong:  /repos/{owner}/{repo}/contents/{path} content        -> repo    (canonical says "file")
wrong:  /user/subscriptions                   subscription   -> user    (canonical says "watched_repos")
wrong:  /repos/{o}/{r}/releases/{id}          releas         -> repo    (defect 3 victim: "releas" is not a word)
wrong:  /orgs/{org}/blocks/{username}         block          -> org
right:  /gists/{id}/star                      star           -> gist
right:  /branches/{b}/protection/enforce_admins enforce_admin -> protection
right:  /repos/{t_owner}/{t_repo}/generate    generate       -> repo
```

GitHub's operationIds use *synonyms* of the path (`hook`/`webhook`,
`content`/`file`), so absence from the name text proves nothing. Three of the
wrong ones are caused by defect 3 — an over-stripped stem can never corroborate,
so the rule re-homes a perfectly good resource.

The right home for rule B is the shape this repo already converges on
(`design-patterns.md` §1): a **deterministic detector in
`packages/refinement/src/detect.ts`** that raises
`resource_uncontradicted_by_name` as a reviewable deficiency, closed by a
manifest `name: { resource: … }` override — which
`packages/compiler/src/manifest.ts:770` and `projectRoutingNames`
(`naming.ts:50-62`) already implement end to end. Detect, propose, let a human
decide. Do not let it rewrite ids on its own.

### Rejected: "use the last NOUN-ish segment"

There is no deterministic noun test available to the compiler, and the cases
that need one are exactly the ones no closed verb list reaches. Rules A and C
*are* the decidable subset of this idea.

### What A+C do not fix — named, not glossed

- **Adjectival state selectors.** `/views/active` → `active`,
  `/views/compact` → `compact`, `/groups/assignable` → `assignable`,
  `/accounts/available` → `available`, `/macros/new` → `new` (rule C catches
  `new` only because it is in the CRUD list; the others survive). Zendesk's
  `active|list(5)` cluster is still keyed on `active` after every rule
  above — A, B and C alike. These are
  precisely the read *variants* the collapse feature wants, which says the
  honest answer is a variant signal of its own (shared parent segment + shared
  response schema), not a resource rule.
- **Pronoun and one-off RPC segments.** `/users/me` → `me`,
  `/users/me/logout` → `logout`, `/macros/{id}/apply` → `apply`,
  `/tickets/{id}/display` → `display`, `/queues/order` → `order`.
- **Over-clustering on a generic sub-resource.** Zendesk's `definition(10)`:
  `/views/definitions`, `/triggers/definitions`, `/automations/definitions` all
  key on `definition`. `definitions` *is* a plausible sub-resource, so no rule
  above should touch it — the fix would be qualifying the resource with its
  parent (`view_definition`), which is a separate and larger proposal.
- **Synonym mismatch** (GitHub `hook`/`webhook`) — correctly untouched.
- **Over-singularization** (§5) — a separate defect with a separate fix.

### The tool-name stutter fix

In `resolveSurfaceCollisions` (`naming.ts:522-546`), skip a candidate token that
`op.canonicalName` already ends with (comparing singularized) and take the next
token from `distinguishingToken`'s ordered candidate list. This is **not**
id-neutral: it changes `mcp.toolName`, `cli.command` and `op.id` together, by
construction (`naming.ts:536-539` moves all four in lockstep, which is the
invariant that must not be broken). Zendesk 44, GitHub 61, Stripe 2.

## 7. Blast radius

### The measured id churn

| Estate | changed under A+C (recommended) | changed under A+B+C |
|---|---:|---:|
| plaid | 252 (71.8%) | 253 (72.1%) |
| zendesk (untrimmed) | 70 (10.9%) | 83 (13.0%) |
| github | 13 (1.1%) | 149 (12.2%) |
| bigquery | 2 (4.8%) | 2 (4.8%) |
| stripe | 3 (0.5%) | 3 (0.5%) |
| slack | 0 | 0 |

Rejecting rule B is what keeps GitHub's churn at 13 operations instead of 149,
for zero loss of measured headroom (§8).

### What is bound to the id, precisely

- **`contractHash` covers the entire AIR document**
  (`packages/air/src/hash.ts:38` — `hashCanonical({...AirDocument.parse(air), diagnostics: undefined})`).
  So *any* `effect.resource` change moves it, including one that leaves the id
  alone. There is no "resource is metadata" escape hatch.
- **`contractDigest`** (`packages/compiler/src/contract/digest.ts:70`) folds
  `contractHash`, so every `ContractSnapshot` identity changes.
- **`bundle.json`'s `contractHash`/`capabilityHash`**
  (`packages/generators/src/capability-view.ts:359-360`) both change.
- **The system pack's content address** — `packShape`
  (`packages/system-pack/src/digest.ts`) covers `contractRef`, `capabilities`
  and `surfaceSignature`; `packDigest` therefore changes for every affected
  estate.
- **Surface signatures** — `operationSignature`
  (`packages/compiler/src/capability/signature.ts:33-42`) keys on `op.id` and
  carries `publicName: op.mcp.toolName`. `diffSurfaceSignature`
  (`signature.ts:161`) has **no rename lane**: a re-homed operation appears as
  `removed` (breaking) plus `added` (additive), so the overall classification is
  `breaking`.
- **Contract drift** — `diffContracts`
  (`packages/compiler/src/drift.ts:461-499`) matches "by their stable AIR id".
  A re-homed approved operation emits `operation_removed` at **blocking**
  severity ("was removed from the spec while approved and exposed") plus
  `operation_added`. Every affected estate's next `anvil` drift check would go
  blocking-red for a rename it cannot see.
- **Refinement assessments and tasks** carry the `contractHash` they judged
  (`packages/refinement/src/assess.ts:299`,
  `packages/refinement/src/protocol/task.ts:87`) and become bound to a contract
  that no longer exists.
- **Approval** — `approveOperations`
  (`packages/compiler/src/compile.ts:494-509`) matches `op.id` exactly, and
  `anvil approve <path> <operation-ids...>`
  (`packages/cli/src/commands/approve.ts:66`) takes literal ids. Approval
  *state* lives in the bundle's own `air.yaml` (`op.state`), not in a separate
  keyed store, so a recompile regenerates it rather than orphaning it — but any
  runbook, script or CI job that passes literal ids to `anvil approve` breaks
  silently (the id simply matches nothing).

### What is **not** at risk — measured, not assumed

**User manifests are largely safe by construction.** `operationMatchesKey`
(`packages/compiler/src/manifest.ts:646-648`) accepts three keys:

```ts
return op.id === key || op.canonicalName === key || op.sourceRef.operationId === key;
```

Across all 18 checked-in backtest manifests (`docs/backtesting/reproduce/manifests/`,
231 operation entries) **zero** are keyed on an AIR id. Gmail's 11 dotted keys
(`gmail.users.messages.send`) look like AIR ids but are Google Discovery
operationIds, matched through the third branch. A manifest keyed the documented
way survives untouched. Only a manifest a user wrote against literal AIR ids
breaks — and that failure is loud (the entry matches nothing) rather than silent.

### Checked-in fixtures

- `packages/compiler/src/gateway/golden/expected/*.json` — 5 files, ~15
  operations, all literal AIR ids (`refunds.refunds.create`) on `/refunds`
  paths. Unaffected by A or C.
- `tools/corpus/expected/*.json` — 21 files, keyed on `sourceRef.operationId`
  and asserting `toolName`. Safe under A/C except where a collision group
  changes membership. `plaid.json`'s `assetReportRemove` is one such case.
- Unit tests asserting literal ids / commands / tool names —
  `packages/compiler/src/compiler.test.ts` (~30 assertions),
  `naming-collisions.test.ts`, `drift.test.ts` (5),
  `packages/air/src/resolve.test.ts` (2),
  `packages/generators/src/mock-server.test.ts` (2). All are hand-written
  fixtures on simple paths. The only one in this rule's blast zone is
  `compiler.test.ts:598-599` (`GET /field/search` → resource `field`, command
  `jira field search`), which rules A and C both leave alone.

**A live finding while checking this**: the naming drift guard is **already red**
for plaid on `a9cfd63`, before any change proposed here:

```
$ node tools/corpus/run.mjs quick --systems plaid
=== quick: plaid ===
REGRESSION … FAIL naming-differential …
  FAIL naming-differential: assetReportRemove: toolName
    plaid_asset_report_remove_asset_report_direct != plaid_asset_report_remove_post
```

The checked-in expectation says `plaid_asset_report_remove_post`; the compiler
produces `plaid_asset_report_remove_asset_report_direct`. Quick mode needs
network so it is not wired into `pnpm test`
(`tools/corpus/README.md`), which is how it went stale unnoticed. This is left
**unfixed on purpose**: refreshing the fixture would bury the question of
whether `plaid_asset_report_remove_asset_report_direct` is a name anyone wants,
which is the same question this document is about.

### Is there a safe automatic migration?

**No.** Stated plainly:

- There is no id-alias or rename concept anywhere in AIR, the contract layer, or
  the pack — every id-keyed comparison in the system
  (`diffContracts`, `diffSurfaceSignature`, `approveOperations`,
  `surfaceSignatureForContract`) does exact-match lookup and treats a miss as
  removal.
- A mechanical `old id → new id` map *is* derivable at compile time (the rules
  are deterministic functions of the path, so the compiler knows both answers),
  and could be emitted as a one-shot artifact for an operator to diff. But
  consuming it would mean teaching every id-keyed surface a second lookup path,
  and a rename lane in `diffSurfaceSignature` is a compatibility-semantics
  change in its own right — "this operation was renamed" is not obviously
  `compatible`, and calling it so would let a real removal hide behind a rename.
- Sequencing recommendation: land this behind a compile-time flag defaulted
  **off**, use it to publish a per-estate id-churn report from
  `tools/naming-audit/run.mjs`, and flip the default only in a release the owner
  declares id-breaking. Do not migrate silently.

## 8. Why this matters to the read-variant collapse feature

The planned feature collapses read variants of one resource into a single tool
with a filter argument, as a lever on served tool count (routing accuracy falls
from 90.0% at 10 tools to 58.6% at 329). Its input is `effect.resource`.

Measured headroom, keyed on `(resource, action)` over read operations, where
"tools saved" is `members − clusters`. Reported twice: naively, and gated on
**OpenAPI-tag coherence** — a cluster only counts if all its members carry the
same tag, which is the spec's own answer to "are these variants of one thing".

"Corrected" is the recommended pair, rules A+C
(`NAMING_AUDIT_RULES=AC node tools/naming-audit/run.mjs …`).

| Estate | naive today | tag-coherent today | naive corrected (A+C) | tag-coherent corrected (A+C) |
|---|---:|---:|---:|---:|
| zendesk | 104 | **31** | 109 | **58** |
| github | 282 | **100** | 284 | **102** |
| slack | 27 | **27** | 27 | **27** |
| stripe | 48 | n/a (0 tagged) | 48 | n/a |
| bigquery | 1 | n/a (0 tagged) | 1 | n/a |
| plaid | 0 | 0 | 0 | 0 |

Read this per estate; a blended number would be meaningless.

- **Zendesk's real headroom today is 31 tools, not 104.** 70% of the naive
  figure is contamination, and the single largest apparent cluster —
  `count|list(21)` — is 21 counts of 21 *different* resources spanning 13 tags.
  Collapsing it would be a semantic error, not a saving. After A+C the
  trustworthy figure is **58**, an 87% increase in real headroom.
- **Rule B makes Zendesk's headroom slightly worse**, which is an independent
  reason to reject it: `NAMING_AUDIT_RULES=ABC` gives 57 tag-coherent, against
  58 for `AC`. Adding 32 re-homings buys −1.
- **GitHub's number barely moves** (100 → 102), and rule B contributes **none**
  of that: A+C alone reaches 102, and adding B's 137 re-homings leaves it at
  102. GitHub's resources were mostly already right; its problems are 154
  uncorroborated resources and 61 stuttering names, not clustering. Fixing
  resource derivation is not a lever on GitHub's tool count.
- **Slack's 27 is already fully coherent.** The dotted-RPC path already does the
  right thing; there is nothing to win.
- **Plaid has zero read-variant headroom** for an entirely different reason:
  only 8 of 351 operations classify as reads at all, because every Plaid
  endpoint is a POST. `POST /transactions/get` lands `kind=mutation` with
  confirmation semantics. That is a separate and more consequential finding than
  anything in this document, and it is not addressed here.

The worked example, all 13 Zendesk reads under `/api/v2/views/`:

```
GET /api/v2/views                    id=zendeskfull.views.list             resource=view
GET /api/v2/views/{view_id}          id=zendeskfull.views.get              resource=view
GET /api/v2/views/{view_id}/count    id=zendeskfull.count.list.by_view_id  resource=count
GET /api/v2/views/{view_id}/execute  id=zendeskfull.views.execute          resource=view
GET /api/v2/views/{view_id}/export   id=zendeskfull.views.export           resource=view
GET /api/v2/views/{view_id}/tickets  id=zendeskfull.tickets.list.views     resource=ticket
GET /api/v2/views/active             id=zendeskfull.active.list.views      resource=active
GET /api/v2/views/compact            id=zendeskfull.compact.list           resource=compact
GET /api/v2/views/count              id=zendeskfull.count.list.views_direct resource=count
GET /api/v2/views/count_many         id=zendeskfull.count_many.list        resource=count_many
GET /api/v2/views/definitions        id=zendeskfull.definitions.list.views resource=definition
GET /api/v2/views/search             id=zendeskfull.views.search           resource=view
GET /api/v2/views/show_many          id=zendeskfull.show_many.list.views   resource=show_many
```

Thirteen reads of one resource, split across seven `effect.resource` values.
Today's derivation both **over-clusters** (`count` gathers 22 unrelated
operations from 13 tags) and **under-clusters** (`list_views`,
`list_active_views`, `list_compact_views`, `list_views_by_id` — the exact four
variants the feature exists to collapse — land in four different clusters).
Until that is fixed the headroom number is not a measurement, and this document
recommends it be treated as unmeasurable rather than reported.

## 9. Recommendation, in order

1. **Fix `singularize` (§5) first.** It is independent, it corrupts
   `effect.resource` on its own, and it silently sabotages any
   corroboration-based repair. Its id impact is narrower than the path rules —
   `id` uses `snakeCase(names.resource)` unsingularized (`naming.ts:407`), so
   only `effect.resource` and the *synthesized* `canonicalName` for operations
   without an operationId move. Still not id-neutral; still needs approval.
2. **Then rules A and C**, together, behind a default-off flag, with the
   per-estate churn report from `tools/naming-audit/run.mjs` attached.
3. **Then the disambiguation-suffix stutter fix**, once, in the same
   id-breaking release — doing it separately spends the id-break budget twice.
4. **Rule B as a refinement detector only**, never as a compiler rule.
5. **Leave `spec_authored` stutter alone**, and treat `service_prefix_join` as a
   compile-time warning about the operator's `--service` choice.
6. **Do not** extend `ACTION_VERB_WORDS`' role beyond
   `naming.ts:293-299`'s bare-single-word case.
