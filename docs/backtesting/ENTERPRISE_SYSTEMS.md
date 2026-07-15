# Enterprise systems corpus — protocol-diverse validation

Anvil's backtest corpus (`systems.tsv`) began as developer-facing SaaS —
Jira, GitHub, Stripe, Slack, Notion. Those are all **REST/OpenAPI**. But the
back-office systems agents most need to touch — ERP, procurement, contract
lifecycle, financial close, HCM — overwhelmingly publish **OData**, **SOAP/WSDL**,
and **gRPC**, not OpenAPI. A compiler that claims to lower "any API surface" is
only as validated as the *formats* and *shapes* it has actually seen.

This catalog is the map of that territory: the enterprise systems worth
compiling, the wire format each one actually publishes, and — crucially —
whether its specification is **publicly fetchable** or **credential-gated behind
a customer tenant**. The reproducibility rule for the whole corpus applies here
(`reproduce.sh`): we commit the *recipe* (URL, curated ops, manifest), never the
vendor's bytes.

## What is wired into the corpus now

These are real specifications, publicly fetchable, and compile green through
every corpus oracle (compile · determinism · round-trip · lint · naming
differential · self-test). They were added to close the two biggest format gaps
— **zero OData and zero SOAP/WSDL** — and to broaden gRPC beyond a single
system.

| System | Protocol | Why it matters | Spec |
| --- | --- | --- | --- |
| **NetSuite SuiteTalk** | SOAP / WSDL 1.1 | Oracle NetSuite ERP — the canonical enterprise SOAP surface (`add`/`update`/`delete`/`search` over every record type) | [public WSDL](https://webservices.netsuite.com/wsdl/v2024_2_0/netsuite.wsdl) |
| **OData v4 (TripPin)** | OData v4 `$metadata` | The OASIS reference service — exercises the same v4 EDMX path SAP S/4HANA, Dynamics 365 and Business Central publish | [public $metadata](https://services.odata.org/V4/TripPinServiceRW/$metadata) |
| **OData v2 (Northwind)** | OData v2 `$metadata` | The classic v2 EDM dialect — the dialect SAP Gateway / SuccessFactors serve most | [public $metadata](https://services.odata.org/V2/Northwind/Northwind.svc/$metadata) |
| **etcd** | gRPC / proto3 | Distributed KV powering Kubernetes — real multi-message proto with streaming RPCs | [public rpc.proto](https://raw.githubusercontent.com/etcd-io/etcd/main/api/etcdserverpb/rpc.proto) |
| **Okta** | OpenAPI 3 | Enterprise identity / IGA — 732 operations, heavy collision-resolution surface | [public spec](https://raw.githubusercontent.com/okta/okta-management-openapi-spec/master/dist/current/management-minimal.yaml) |
| **DocuSign CLM (Agreement Manager)** | OpenAPI 3 | The closest **public, machine-readable CLM contract** — agreements, agreement types, tasks | [public swagger](https://raw.githubusercontent.com/docusign/OpenAPI-Specifications/master/agreementmanager.rest.swagger-1.0.0.json) |
| **BigQuery** | Google Discovery | Enterprise data warehouse — jobs, datasets, row-access-policy deletes | [public $discovery](https://bigquery.googleapis.com/$discovery/rest?version=v2) |
| **Datadog** | OpenAPI 3 | Observability — 1409 ops; drove the naming-collision mechanism fix (see below) | [public spec](https://raw.githubusercontent.com/DataDog/datadog-api-client-go/master/.generator/schemas/v2/openapi.yaml) |

The last four were sourced from the **`ge-agent-factory`** simulator catalog
(`apps/factory/simulator-systems/openapi-sources.json`). DocuSign CLM stands in
for the credential-gated CLM systems (Icertis, Fenergo, SAP) — it is the same
agreement/clause/template domain, publicly published.

### Accounting for all 89 systems in the catalog

The `ge-agent-factory` catalog has **89 system directories**; each is a
synthesized simulator pack (schema/tools/seed JSON), *not* an API spec, so there
is nothing for Anvil to compile in the directory itself. The compilable input is
the spec URL recorded in `openapi-sources.json`, which covers 54 of the 89 and
tags each by fetchability. Every system is therefore accounted for as follows:

| Status | Count | Anvil can ingest? | Action taken |
| --- | ---: | --- | --- |
| `downloadable` (real URL) | 9 | **Yes** | Fetched + compiled all 9; **7 wired into the corpus**, 2 deliberately omitted (see table below) |
| `auth_required` | 9 | Only with a tenant export | Cataloged with reproduce recipe (SAP S/4HANA FI/MM, SAP Ariba/Fieldglass, Workday, ServiceNow, Salesforce CRM/Marketing, Icertis) |
| `docs_only` | 26 | No public machine-readable spec | Cataloged (Coupa, BlackLine, Concur, Avalara, JAGGAER, Kyriba, …) |
| `manual_required` | 10 | No | Cataloged (HighRadius, Benefitfocus, C2FO, …) |
| no source hint | 35 | No | Synthesized-only; no public API contract exists to fetch |

So the honest answer to "have you run them all?" is: **all 9 with a real,
fetchable spec have been fetched and compiled** (the ceiling this catalog
allows); the other 80 have no public machine-readable contract and are
customer-reproducible only, via the recipes below. Chasing them without
credentials would mean inventing specs — exactly what `openapi-sources.json`
exists to prevent.

The two OData reference services are deliberate **stand-ins** for the
credential-gated enterprise OData endpoints below: they publish the identical
`$metadata`/EDMX shape (entity types, composite keys, navigation properties,
`FunctionImport`s, SAP/annotation vocabularies), so the adapter path they
exercise is the same one a real SAP or Dynamics tenant hits. When you have a
tenant, swap the URL — the recipe is unchanged.

### A classification nuance this corpus surfaced

etcd's `Range` RPC is a **read** (it reads a key range), but `Range` is not a
read-verb, so the compiler classifies it conservatively as a `mutation`. That is
the safety contract working as designed — *effect is proven from the source,
never guessed* — and it is exactly the case a manifest exists to enrich
(`x-anvil-effect: read`). The behavior is pinned in
`tools/corpus/expected/etcd.json` so a future "helpful" heuristic that silently
promotes `Range` to a read trips the differential.

### A compiler finding this corpus surfaced — then fixed at the mechanism level

Datadog's public v2 OpenAPI (`downloadable`, Apache-2.0, ~7 MB, 1409 ops)
originally failed with four `duplicate_operation_id` errors on
`datadog.retention_filters.{list,get,delete,search}`. Root cause: Datadog ships
two retention-filter families — `apm/config/retention-filters` (hyphen) and
`rum/applications/{id}/retention_filters` (underscore) — whose resource segments
differ **only by a separator that `snake_case` folds**. The operation id
snake-cases the resource, so both fold to `retention_filters` and the ids
collide; but the CLI command keeps the raw token and the tool name derives from
the distinct operationIds, so neither of those surfaces sees the clash.

The fix was **mechanism-level, not a per-spec patch**: the naming pass
(`resolveNameCollisions`) was deduping only two of the three surfaces that
`validate.ts` enforces unique (CLI command + tool name), leaving the operation
id — a third, independently-normalized surface — unrepaired. Adding the
operation id as a resolver surface closes the *entire class* of id-only
collisions (any two resources that differ only by a snake-case-folded separator,
on any spec), not just Datadog's four. The two colliding families now
disambiguate by their real namespace token (`.apm` / `.rum`). This is the same
class as the historical `linear` #23 (`duplicate_tool_name`), which the tool-name
surface already closed. Datadog is now wired into the corpus and green; the
resolution is pinned in `tools/corpus/expected/datadog.json` and asserted as a
unit test (`compiler.test.ts`). See `tools/corpus/README.md` →
"Resolved naming-collision class".

## The broader enterprise landscape (reproduce with customer credentials)

Most enterprise APIs are **not** publicly fetchable — the specification lives
behind a customer tenant, a partner developer portal, or a per-instance
`$metadata`/WSDL endpoint that requires auth. That does not make them
un-compilable; it makes them **customer-reproducible**. For each, the recipe is
the same three steps:

```bash
#   1. Export the spec from your tenant (endpoints noted per system below).
#   2. anvil source add <spec>            # locks an immutable snapshot
#   3. anvil compile --source <id> --manifest <your-manifest> --service <name>
```

| System | Category | Protocol(s) published | Where the spec lives |
| --- | --- | --- | --- |
| **Icertis (ICI)** | Contract lifecycle (CLM) | REST (OpenAPI) | ICI tenant → API catalog; partner portal. Gated. |
| **BlackLine** | Financial close | REST (OpenAPI/Swagger) | BlackLine developer portal (per-customer key). Gated. |
| **Coupa** | Procure-to-pay | REST + bulk XML/CSV | `/api` on your Coupa instance; OpenAPI via portal. Gated. |
| **SAP Ariba** | Sourcing / procurement | REST (OpenAPI) + SOAP | Ariba Developer Portal (`api.sap.com`), app-key gated. |
| **SAP S/4HANA** | ERP | **OData v2 & v4** + SOAP | `/sap/opu/odata/.../$metadata` on the tenant; SAP Business Accelerator Hub. |
| **SAP SuccessFactors** | HCM | **OData v2 & v4** | `/odata/v2/$metadata` per tenant. Gated. |
| **SAP Concur** | Travel & expense | REST (OpenAPI) | Concur Developer Center. Gated. |
| **Workday** | HCM / Financials | **SOAP/WSDL** + REST (RaaS) | Public versioned WSDLs (`community.workday.com/.../productionapi`); REST per tenant. |
| **ServiceNow** | ITSM / workflow | REST (Table/Scripted) + SOAP | Per-instance (`/api/now/...`, direct web-service WSDL per table). Gated. |
| **Oracle Fusion / EBS** | ERP | SOAP/WSDL + REST | Per-pod WSDL/OpenAPI catalog. Gated. |
| **Microsoft Dynamics 365 / Business Central** | ERP / CRM | **OData v4** `$metadata` | `/data/$metadata` per environment. Gated. |
| **Salesforce** | CRM | REST + SOAP (Enterprise/Partner WSDL) + GraphQL | Per-org WSDL export; `examples/salesforce` ships a shape. |
| **Xero** | Accounting (SMB/mid-market) | REST (OpenAPI) | **Public** — `XeroAPI/Xero-OpenAPI` on GitHub (large; curate first). |

Legend: **bold protocol** = a format now exercised by the wired-in corpus
above, so the adapter path is validated even while the specific vendor spec
stays gated.

Coverage of all nine `ge-agent-factory` **`downloadable`** specs (the only ones
with a real, fetchable URL — the other 80 systems are `auth_required`,
`docs_only`, `manual_required`, or have no source hint at all, so they are
customer-reproducible only):

| Spec | Fetched | Compiles | In corpus | Note |
| --- | --- | --- | --- | --- |
| github, jira, pagerduty | ✓ | clean | ✓ (pre-existing) | already validated |
| okta, docusign_clm, bigquery | ✓ | clean | ✓ | added this round |
| **datadog** | ✓ | clean **after the naming fix** | ✓ | was 4 errors; drove the mechanism fix |
| kubernetes | ✓ | clean | — | enormous `swagger.json`; one row away if wanted |
| apigee (admin API) | ✓ | clean | — | Google Discovery admin API collides *conceptually* with Anvil's existing Apigee **gateway-estate** import (`anvil estate import --vendor apigee`); wiring it as a plain compiled system would confuse the two |

So of the nine downloadable specs, **seven are now in the corpus** and the two
omissions are deliberate (size / naming clarity), not failures.

## Why this is the right kind of validation

The value is not "more systems." It is **format and shape diversity under the
same oracles**. Every system above — public or gated — lowers through one of
four adapters (`packages/compiler/src/protocols/{odata,wsdl,grpc,graphql}.ts`)
into the same AIR, and is then held to the same invariants as an OpenAPI spec:
deterministic compile, round-trip-stable contract hash, conservative effect
classification, no silent operation drops. When a real SAP `$metadata` or a real
NetSuite WSDL compiles green, the claim "the agent stopped guessing" has been
tested against the surfaces enterprises actually run — not just the ones with a
nice OpenAPI file on GitHub.

## Adding a system

1. Confirm the spec URL is **publicly fetchable and stable** (`curl -fsSL`). A
   404 body committed as a "spec" is the failure this corpus exists to prevent.
2. Add a row to `systems.tsv`: `name<TAB>format<TAB>url<TAB>curated<TAB>trimmer`.
   OData/WSDL/gRPC/GraphQL compile whole — use `(whole)` / `none`.
3. `node tools/corpus/run.mjs quick --systems <name>` — must be green.
4. `--update-baseline` to pin metrics; add `expected/<name>.json` to pin the
   naming/effect differential for a few stable operations.
5. Commit the recipe. Never commit the vendor's spec bytes.
