# Backtest batch 2 — the eight BACKTESTABLE-tier systems

The triage in `README.md` marked eleven systems BACKTESTABLE (public spec +
mature reference MCP). Three were covered in the first two rounds (Slack,
Twilio, Google Workspace); this round runs the remaining eight: **Notion,
Asana, PagerDuty, Zendesk, Intercom, Zoom, HubSpot, and DocuSign**.

Each was compiled from its real, published spec (verbatim bytes), then
compared against its reference MCP server's actual tool surface. Two new
systemic compiler bugs were found and fixed — both invisible until a spec of
this shape/scale hit them.

## What each system stressed, and the result

| System | Spec (real) | Ops | Format axis | Compile | Result |
| --- | --- | --- | --- | --- | --- |
| Notion | makenotion/notion-mcp-server's own `notion-openapi.json` | 24 | operationId→tool, the cleanest case | 0.8s | clean |
| Asana | Asana/openapi `asana_oas.yaml` | 249 (full) | large OpenAPI 3 | 3.2s | clean |
| PagerDuty | PagerDuty/api-schema `openapiv3.json` | 465 (full) | **YAML alias round-trip** | 2.6s | **bug #19** |
| Zendesk | developer.zendesk.com `oas.yaml` | 617 (full) | scale (most ops of any) | 3.5s | clean |
| Intercom | intercom/Intercom-OpenAPI 2.11 | 108 (full) | standard OpenAPI 3 | 2.2s | clean |
| Zoom | zoom/api `openapi.v2.json` | 155 (full) | Swagger 2.0 (meetings) | 1.2s | clean |
| HubSpot | HubSpot-public-api-spec-collection (Deals) | 12 | opaque object-type paths | 0.7s | clean (naming note) |
| DocuSign | docusign/OpenAPI-Specifications eSignature v2.1 | 414 (full) | **broad-schema blowup** | 56s→19s | **bug #18** |

Full specs were compiled as-is (no pre-trimming) as the scale check; the
`reproduce/` recipe carries a curated subset per system that overlaps each
reference MCP for an apples-to-apples naming comparison (`reproduce.sh
<system>` regenerates it). DocuSign is the one exception — its
`envelopeDefinition` is so large that even a 10-path trimmed spec is 1.8MB, so
it is documented here and pinned by a synthetic regression test rather than
shipped as a fixture.

## The two systemic bugs (full writeups in `deficiencies.md`)

### #18 — DocuSign: per-operation schema materialization had no size bound
DocuSign's eSignature spec (Swagger 2.0, 619 definitions) took **56 seconds**
to compile and produced a **400MB** in-memory AIR that took `airToYaml` 30s+
to serialize. The existing ref-*depth* bound caps a deep schema chain, but
DocuSign's request bodies (`tabs`, `accountSettingsInformation`) are
pathologically *broad* — hundreds of properties, each a large object — so a
single depth-1 hop still materialized ~2.5MB per operation. Fixed with a
node-count budget (`DEFAULT_MAX_SCHEMA_NODES`) that bounds breadth the way the
depth bound bounds depth. DocuSign dropped to 19s; every other spec is
byte-identical (their largest operation is ~1000 nodes, 4× under budget).

### #19 — PagerDuty: Anvil couldn't re-parse its own generated `air.yaml`
`anvil lint`/`certify` re-read the generated `air.yaml`. PagerDuty's real
465-operation bundle serialized to 110 YAML aliases (repeated retry-condition
lists, error shapes, etc.), and the `yaml` parser's default anti-"billion
laughs" cap of 100 aliases threw *"Excessive alias count indicates a resource
exhaustion attack"* — so Anvil rejected its own output. Fixed by not emitting
aliases in the canonical YAML at all (`aliasDuplicateObjects: false` — also
more human-diffable) and raising the cap on the trusted AIR re-parse;
untrusted specs/manifests keep the default protection.

## Naming comparison vs. the reference MCPs

- **Notion** is the sharpest datapoint: makenotion's server mints tool names
  *directly from the OpenAPI operationId* (`API-post-search`,
  `API-retrieve-a-page`) — the exact thing Anvil does. Anvil produces
  `notion_post_search`, `notion_retrieve_a_page`: same derivation, and Notion's
  `POST /search` is correctly classified a **read** (Anvil's read-intent rule),
  matching the reference server treating it as read-only.
- **PagerDuty / Asana / Zendesk / Intercom** reference servers hand-curate
  `verb_object` names (`list_incidents`, `asana_create_task`) and gate writes
  behind a server-level flag (`--enable-write-tools`, `READ_ONLY_MODE`). Anvil
  derives comparable names from operationIds and reaches the same read/write
  posture per-operation (confirmation + approval) rather than all-or-nothing.
- **Zoom** (Swagger 2.0) converts cleanly: `zoom meetings create` /
  `zoom_meeting_create`, `zoom meetings delete` (destructive). The community
  Zoom MCP exposes the same `create_meeting`/`delete_meeting` CRUD.
- **HubSpot** is the honest naming wart: its Deals path is `/crm/v3/objects/0-3`
  (`0-3` is HubSpot's real internal object-type id for deals) and its
  operationId literally embeds the path (`get-/crm/v3/objects/0-3_getPage`).
  Anvil faithfully renders `hubspot_get_crm_v3_objects_0_3_get_page` — verbose,
  but a true reflection of a genuinely opaque vendor spec (same category as
  Stripe's `PostChargesChargeCapture`, finding #13). The official HubSpot MCP
  sidesteps this entirely with object-agnostic meta-tools
  (`hubspot-list-objects` + an objectType param) — a design choice, not
  something a faithful per-endpoint compiler can or should invent.

## Safety comparison

Across all eight reference servers, **none** implements a per-call
confirmation gate or dry-run; safety is server-level (read-only flags, OAuth
scopes) or, in DocuSign's case, delegated to the client via MCP tool
annotations. Anvil's per-operation `--confirm`-on-non-idempotent-mutation plus
the approval workflow is stricter than any of them — a genuine differentiator,
independently noted by the tool-surface research for DocuSign's `Send Envelope`
(a single, irreversible, legally-significant call gated only by a client-side
hint). The example manifests here mark every non-idempotent create
confirmation-required and non-retried, consistent with Jira/Twilio/Slack.

## Certification note (Notion)
`anvil certify generated/notion` FAILs one gate —
`semantic.descriptions-present` — because Notion's spec operations carry no
descriptions. That is certify doing its job on a real spec-quality gap, not an
Anvil defect; the other six certify clean.
