# Backtesting Anvil against real APIs and mature MCP servers

## Method

For each SaaS product below:

1. Pull the vendor's real, published OpenAPI/Swagger spec (never hand-written) —
   verbatim bytes, verified by direct fetch.
2. Trim to a curated, representative subset of operations that overlaps what
   the product's mature reference MCP server exposes (so the comparison is
   apples-to-apples), keeping every schema/parameter/response component those
   operations transitively reference, verbatim, from the real spec. The vendor
   specs are **not committed** — they are large and fully reproducible; the
   spec URL, curated operation list, trimmers, and authored safety manifest for
   every system live in `reproduce/`, and `reproduce/reproduce.sh <system>`
   regenerates any bundle from scratch (fetch → trim → compile).
3. Run the real `anvil` CLI end to end: `source add` → `compile` → `inspect` →
   enrich with a manifest (only where the compiler's own classification is
   wrong or the spec cannot express real-world safety semantics, e.g.
   idempotency) → `lint` → approve → `package skill`.
4. Compare the generated CLI/MCP/skill surface against the mature reference
   MCP server's real tool list, naming convention, and safety behavior
   (research-sourced, cited).
5. Log every deficiency found as a concrete failure scenario. Fix the ones
   that are systemic (compiler/generator bugs, not one-off manifest tweaks),
   with tests, before moving to the next product.

## Feasibility triage (25 systems)

A system is only actually backtestable if it has BOTH (a) a real spec
fetchable without a tenant login and (b) a mature reference MCP server to
compare against. Researched via web search, every URL verified by a live
fetch before being marked fetchable.

| # | System | Public spec (no login) | Mature reference MCP | Verdict |
| - | --- | --- | --- | --- |
| 1 | Jira Cloud | ✅ developer.atlassian.com swagger.v3.json | ✅ sooperset/mcp-atlassian + official Atlassian remote MCP | **BACKTESTED** |
| 2 | Confluence Cloud v2 | ✅ dac-static.atlassian.com openapi-v2.v3.json | ✅ sooperset/mcp-atlassian | **BACKTESTED** |
| 3 | GitHub | ✅ github/rest-api-description (790 paths) | ✅ github/github-mcp-server (official, 60+ tools) | **BACKTESTED** |
| 4 | Stripe | ✅ stripe/openapi spec3.json (414 paths) | ✅ stripe/agent-toolkit, mcp.stripe.com (official) | **BACKTESTED** |
| 5 | Slack | ⚠️ slackapi/slack-api-specs (archived/stale since Mar 2024) | ✅ korotovsky/slack-mcp-server (community, 18 tools) | **BACKTESTED** (Swagger 2.0 + RPC-over-HTTP) |
| 6 | Zoom | ✅ zoom/api openapi.v2.json (103 paths) | ✅ official Zoom MCP + community | **BACKTESTED** (Swagger 2.0) |
| 7 | DocuSign | ✅ docusign/OpenAPI-Specifications (213 paths, eSignature) | ✅ official mcp-d.docusign.com (beta) + community | **BACKTESTED** (found perf bug #18) |
| 8 | Twilio | ✅ twilio/twilio-oai (80+ files, ~1800 endpoints) | ✅ twilio-labs/mcp (official, hosted) | **BACKTESTED** (scale + POST-reuse) |
| 9 | PagerDuty | ✅ PagerDuty/api-schema openapiv3.json (273 paths) | ✅ PagerDuty/pagerduty-mcp-server (official, 71 tools) | **BACKTESTED** (found alias bug #19) |
| 10 | Intercom | ✅ intercom/Intercom-OpenAPI (2.11) | ✅ intercom/intercom-mcp-server (official, read-only) | **BACKTESTED** |
| 11 | Google Workspace | ✅ Discovery-doc format, not native OpenAPI (Gmail/Calendar/Drive) | ✅ taylorwilsdon/google_workspace_mcp (community) | **BACKTESTED** (built a Discovery→OpenAPI adapter) |
| 12 | Zendesk | ✅ developer.zendesk.com/zendesk/oas.yaml (429 paths) | ⚠️ reminia/zendesk-mcp-server (community, 6 tools) | **BACKTESTED** (617 ops, most of any) |
| 13 | HubSpot | ⚠️ HubSpot-public-api-spec-collection (fragmented, many files) | ✅ mcp.hubspot.com / @hubspot/mcp-server (official) | **BACKTESTED** (Deals slice; naming note) |
| 14 | Notion | ✅ makenotion/notion-mcp-server's own openapi json (~20 paths) | ✅ makenotion/notion-mcp-server (official, 4.5k★, 22 tools) | **BACKTESTED** (cleanest operationId→tool) |
| 15 | Asana | ✅ Asana/openapi asana_oas.yaml (249 ops) | ⚠️ roychri/mcp-server-asana (community, 41 tools) | **BACKTESTED** |
| 16 | Microsoft Graph / SharePoint | ✅ microsoftgraph/msgraph-metadata (huge, ~1377 paths) | ⚠️ fragmented, no dominant reference server | SPEC-ONLY |
| 17 | Linear | ✅ GraphQL SDL in linear/linear (no OpenAPI) | ✅ mcp.linear.app (official) | **BACKTESTED** (via the GraphQL adapter; found collision bug #23) |
| 18 | Salesforce | ❌ spec generator requires an authenticated org (tenant-specific output) | ✅ salesforcecli/mcp (official, requires org auth to run) | GATED |
| 19 | ServiceNow | ❌ spec only exportable from a live logged-in instance | ⚠️ echelon-ai-labs/servicenow-mcp (community, 75+ tools) | GATED |
| 20 | SAP (S/4HANA etc.) | ⚠️ catalog browsable; spec download requires free-account login | ⚠️ dev-tooling MCPs only, no business-API reference server | SPEC-ONLY / GATED |
| 21 | Shopify | ❌ REST deprecated, no vendor OpenAPI spec (GraphQL-first) | ✅ Shopify/dev-mcp (official, but docs/storefront-scoped) | GATED |
| 22 | Coupa | ⚠️ Open Buy/CSO specs plausibly public, no single canonical spec | ❌ no mature MCP | SPEC-ONLY |
| 23 | Workday | ❌ Community docs gated behind tenant login | ❌ only a demo repo (`Workday/ai-conversation-bridge`) + generic DB connector | **GATED** — see `workday.md` |
| 24 | Icertis | ❌ APIs Knowledge Center gated behind ICI license | ❌ none found | **GATED** |
| 25 | BlackLine | ⚠️ developer portal HTTP-reachable but real content OAuth-gated | ❌ none found | **GATED** |
| 26 | Oracle FLEXCUBE | ⚠️ docs.oracle.com ships a 49MB ServiceXML zip (10,216 XSDs) but no WSDL/OpenAPI; REST swagger is generated per installed instance | ❌ none | **GATED** — see `banking.md` |
| 27 | Temenos Transact | ❌ api.temenos.com catalog behind community login | ❌ none | **GATED** — see `banking.md` |
| 28 | Nucleus FinnOne | ❌ no public developer portal or spec at all | ❌ none | **GATED** — see `banking.md` |
| 29 | Murex MX.3 | ❌ client-only documentation (mxplus API under NDA) | ❌ none | **GATED** — see `banking.md` |
| 30 | Amadeus Self-Service | ✅ amadeus4dev/amadeus-open-api-specification (Swagger 2.0 per product) | ⚠️ community (donghyun-chae/mcp-amadeus etc.) | **BACKTESTED** — see `gds.md` |
| 31 | Travelport uAPI | ✅ official Travelport GitHub, 158 WSDLs (SOAP, v26–v51) | ❌ none found | SPEC-ONLY (drove the multi-file WSDL mechanism) — see `gds.md` |
| 32 | Sabre | ✅ SabreDevStudio WSDLs (30 real SOAP services) | ⚠️ official Sabre MCP exists but partner-gated | SPEC-ONLY — see `gds.md` |

Full per-system research detail (URLs, tool counts, caveats) is in the task
transcript; this table is the actionable summary.

## Status

**Seventeen products fully backtested** — real spec, real compile → inspect →
lint → approve → package loop, compared against each product's actual mature
reference MCP: the fifteen REST/RPC-over-HTTP systems (Jira, Confluence,
GitHub, Stripe, Slack, Twilio, Google Workspace, Notion, Asana, PagerDuty,
Zendesk, Intercom, Zoom, HubSpot, DocuSign) plus two **real non-REST schemas** —
**GitHub's 1,752-type GraphQL** (vs `github-mcp-server`) and **Temporal's
121-rpc gRPC proto** (vs `temporal-mcp`), with **Linear** GraphQL and **etcd**
multi-file proto alongside. They span OpenAPI 3.x, Swagger 2.0, Google
Discovery, RPC-over-HTTP, GraphQL SDL, and gRPC/proto3. **27 real, systemic
compiler bugs found and fixed**, each with a regression test:

1. Compiler crash on any self-referential schema (Jira's `LinkGroup`)
2. `POST /search` misclassified as an unsafe mutation (Jira's JQL search)
3. CLI command and MCP tool name disagreeing about the same operation
4. Two independent, drifting "what is a verb" keyword lists → unified into one
5. Naming-confidence threshold too weak to flag a genuinely bad operationId
6. Compiler hangs indefinitely on a richly cross-referential schema graph (Stripe)
7. Fixing the hang's speed didn't fix the still-too-large output
8. Root-caused #7 to Stripe's own `x-expansionResources` marker; collapsed it correctly instead of just truncating
9. A depth-bound fix regression: array-typed fields silently turned into objects
10. The depth bound itself was a patch, not the fix — redesigned to bundle named schemas once and `$ref` everywhere else (the same representation Stripe's own spec and real SDK generators use), instead of truncating a naively inlined tree
11. The redesign's first version silently did nothing: `@scalar/openapi-parser`'s `dereference()` doesn't share object references across repeated `$ref`s, so identity-based matching never fired — fixed via structural (`title`-based) matching
12. Per-operation `$ref` re-inlining reintroduced the same blowup one level down (50MB for a single operation) — fixed by measuring the real cost per hop and bounding it correctly
13. Auto-generated, semantically-empty operationIds (Stripe's `PostChargesChargeCapture`) correctly scored low-confidence by the same fix that started with Jira's `doTransition` — validation, not a new bug
14. `.json` REST format suffix leaked into the resource/CLI/tool name, rendering the *same* Twilio resource two ways (`Messages.json` vs `Messages`)
15. POST reused for update (Twilio's `UpdateMessage`) collided create+update onto one name — fixed by honoring the operationId verb for the one case HTTP method can't express, without regressing Stripe's `Get`-that-is-a-list
16. RPC-over-HTTP dotted paths (Slack's `/chat.postMessage`) produced a broken CLI command (`chat.postMessage send`) and, once split naively, a spurious `admin.*` collision
17. Google Discovery Document format was entirely unsupported — built a new protocol adapter (`discovery.ts`) that lowers it to OpenAPI 3.0, unlocking *all* Google APIs
18. Per-operation schema materialization had no *size* bound — DocuSign's pathologically broad request bodies made a 400MB AIR and a 56s compile; a node-count budget bounds breadth the way the depth bound bounds depth (→19s), every other spec byte-identical
19. Anvil couldn't re-parse its own generated `air.yaml` — PagerDuty's 465-op bundle emitted 110 YAML aliases and tripped the parser's billion-laughs cap of 100; fixed by not emitting aliases and raising the cap on the trusted AIR re-parse
20. Real GraphQL schemas hung the compile (gigabytes on serialize) — the protocol adapters emitted named schemas with no `title`, so `bundleDocument` couldn't re-collapse a deeply recursive dereferenced GraphQL graph; fixed by stamping `title` on every adapter schema (GitHub's 1,752 types: hung → 54ms)
21. Synthetic-namespace paths (`/graphql/Mutation/<field>`) doubled the tool names — the trailing-verb rule fired on any field *containing* a verb; scoped to bare single-word verb segments only, so GraphQL tool names land exactly on `github-mcp-server`'s
22. gRPC message types imported from another `.proto` file didn't resolve (opaque body stub) — added multi-file proto import resolution from the snapshot, parity with OpenAPI multi-file `$ref`s; proven on etcd's real 4-file proto
23. Same-named GraphQL Query + Mutation fields (Linear's `initiativeUpdate`) produced identical MCP tool names the command-keyed collision resolver couldn't see — repair now enforces uniqueness across both projected surfaces to a fixpoint (found by the corpus harness's first run)
24. `airToYaml` corrupted strings containing whitespace-only lines (lgtm.com) — the round-trip law is now self-verifying with a fully-quoted lossless fallback
25. Every PUT/POST whose path ended in `status`/`progress`/`state` was silently flipped to a read — the write-method read exception is now search-on-POST only (external review, PR #13)
26. Discovery server URL dropped `servicePath` — Drive-shaped documents would call `/files` instead of `/drive/v3/files` (external review)
27. Discovery per-method OAuth scopes were parsed but never emitted, so every Google operation lost its real scopes in the AIR (external review)

See `deficiencies.md` for the full writeup of each (symptom → root cause →
fix → test), and the per-product / per-batch detail in `jira.md`,
`confluence.md`, `github.md`, `stripe.md`, `gws.md`, `twilio.md`, `slack.md`,
`batch2.md` (Notion, Asana, PagerDuty, Zendesk, Intercom, Zoom, HubSpot,
DocuSign), and `protocols-real.md` (GitHub GraphQL, Linear, Temporal, etcd).
`workday.md` explains why the fully gated enterprise systems (Workday, Icertis,
BlackLine) can't be backtested the same way.

The bug-discovery curve is the real story: findings #1–#13 came from the first
four OpenAPI/Swagger products; #14–#17 needed the deliberately-different third
batch (a new format, RPC naming, raw scale); #18–#19 needed a genuinely huge
(DocuSign) and a genuinely repetitive (PagerDuty) real spec. Each *kind* of
diversity — format, convention, scale, breadth — surfaced bugs the others
could not. All fifteen now compile clean end-to-end; every remaining
BACKTESTABLE and GATED system is documented in the triage table above.
