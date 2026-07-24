---
name: anvil-gateway-estates
description: Audit and adopt APIs from Kong, WSO2, Apigee, MuleSoft, or IBM API Connect exports without mistaking gateway routes or view-shaped APIs for proven agent semantics.
---

# Audit and adopt a gateway estate

A gateway route table proves deployment coordinates and policy placement. It
does not prove request/response schemas, business intent, write safety, or a
useful agent-tool boundary. Use this estate-first sequence for triage, then
adopt APIs one revision/environment coordinate at a time:

```bash
GATEWAY_ID=<stable-control-plane-or-org-id>
anvil estate support --json > gateway-support.json
anvil estate connect <export> --vendor <vendor> --gateway-id "$GATEWAY_ID"
anvil estate inventory <export> --vendor <vendor> --gateway-id "$GATEWAY_ID" --summary
anvil estate audit <export> --vendor <vendor> --gateway-id "$GATEWAY_ID" --check
anvil estate plan <export> --vendor <vendor> --gateway-id "$GATEWAY_ID" \
  --init-selection estate-selection.yaml \
  --out estate-adoption-plan.json
```

Run `anvil estate connect` when introducing a new export to separate adapter
readability and schema support checks from estate-wide audit. Connect returns a stable
report (`reachability`, `capabilities`, `diagnostics`, `protocolVersion`) and
does not require strict coordinate selection.

For a large human view, filter `inventory` with `--query`, `--owner`, or
`--lifecycle`, and bound it with `--limit`; use `--all` only when you
actually want every matching row. `--summary` keeps counts and diagnostics
without printing API rows. These are view filters, not import selection and not
audit suppression: `audit` and `plan` still evaluate the complete loaded
estate, while `import` resolves one exact
API/version/revision/environment coordinate where those axes exist.

The audit is deterministic over the content-addressed inventory. It reports
adapter limitations, contract fidelity, ambiguous routes, authentication gaps,
opaque policies, accountable owners, per-API adoption disposition, and exact
next actions. A completed audit exits zero by default; `--check` fails on
blocking findings, and `--fail-on review-required` makes every unresolved
warning a CI failure. Keep the JSON report as evidence and the complete
adoption-plan JSON as the reviewed baseline; do not scrape either bounded human
view.

## Plan and baseline a large estate

`estate plan` is the adoption control document, not a batch importer. It keeps
the exact API/version/revision/environment coordinate where those axes exist,
selected/deferred/triage decision, accountable owner, disposition, semantic
lane, next gate, and concrete next action for every API.
Ready rows contain an import command template with all reviewed coordinates
filled; replace only `<export>` with the local export file or WSO2 collection
directory. It also fingerprints the export, adapter result, APIs, findings,
gateway identity, and selection, then groups selected coordinates into owner
workstreams. The human view is intentionally bounded; check the complete JSON
plan into version control.

`--init-selection` writes a new schema-versioned YAML queue containing every
current coordinate. Every row starts `decision: triage` and
`semanticLane: deterministic_only`; no name, traffic signal, or coding agent
auto-selects it. The command refuses an existing destination. Edit the file
deliberately:

```yaml
schemaVersion: 1
apis:
  - id: orders
    revision: "12"
    environment: prod
    decision: selected
    semanticLane: agent_assisted
    intent: create and inspect customer orders
    owner: orders-team
    service: orders-prod
    contract: contracts/orders.openapi.yaml
    gatewayUrl: https://gateway.example.com/orders
    manifest: manifests/orders.anvil.yaml
  - id: applications-view
    revision: unversioned
    environment: prod
    decision: deferred
    semanticLane: deterministic_only
```

`service` is an optional reviewed agent-facing namespace. When omitted, Anvil
derives a collision-resistant id from gateway, API, optional semantic API
version, gateway revision, and environment and spells it explicitly in the
import template. Distinct selected coordinates may not claim the same explicit
service id, because their CLI, MCP, skill, and package names would collide when
composed.

Native WSO2 selection rows keep `apiVersion: "1.0.0"` separate from
`revision: revision-7` (or `working-copy`). Preserve both values emitted by
`--init-selection`; neither is a display-only label.

The lanes mix per coordinate:

- `deterministic_only` (the default) runs inventory, audit, receipt-bound
  import, inspect, lint, and verification. It reports missing semantics without
  inventing them.
- `agent_assisted` adds CASE/distill investigation after import. Its output is
  a proposal for human review, never approval or gate evidence by itself.
- `manual_review` requests a human semantic review without launching an agent.

After an API passes receipt-bound import and verification, there are two
different governed loops. Do not conflate them.

Within one bundle, capability grouping can produce a smaller child bundle after
the normal human approval gate:

```bash
anvil capability propose <bundle>
anvil capability show <bundle> <capability-id> --operations --auth --evidence
anvil capability approve <bundle> <capability-id> --note <review-note>
anvil build <bundle> <approved-capability-id>
```

The coding agent may propose a capability around a user job and investigate
view-shaped APIs; deterministic Anvil checks exact operation membership,
workflow dependencies, identity groups, and the disclosure budget. A human
accepts or rejects the boundary. Only an approved capability builds, and its
child bundle must retain the gateway receipt and deployment namespace.

Across two or more bundles, `capability compose` is an audit and review
workflow only:

```bash
anvil capability compose <bundle-a> <bundle-b> [bundle-c...] \
  --out composition.audit.json \
  --init-review composition.review.yaml

# Edit a copy of the scaffold and cite local, digest-bound evidence.
anvil capability compose <bundle-a> <bundle-b> [bundle-c...] \
  --out composition.reviewed.audit.json \
  --review composition.reviewed.yaml
```

It accepts verified generated bundle directories and never modifies them. Every
audit/review destination must be new and outside the inputs. It reports:

- explicitly declared data-point duplicates;
- exact full-output-schema duplicates;
- structural leaf overlap as an investigation lead, never semantic equality;
- exact output-signature subset projections, bounded to the disclosed fields;
- contradictions and the conservative intersection of member auth and safety.

All candidates begin `unresolved`. Similarity never chooses a system of record.
Edit only decision, evidence, acknowledgement, and note fields. Preserve every
scaffold binding exactly: top-level `inputDigest`/`candidateDigest`, plus
each entry's `candidateId`, `candidateDigest`, `eligibleSources`, and
`eligibleMembers`. To review `same_fact` or `projection`, add a note and
cite relation evidence naming all exact eligible member ids with effective
confidence at least 0.5. Effective confidence is declared confidence times
AIR's canonical `sourceKind` reliability; generated mocks and inferred claims
cannot qualify even at declared confidence 1. Each `sourceRef` is a
normalized relative file path below the review manifest directory;
`artifactDigest` is mandatory and must match that non-empty, non-symlink,
regular local file (maximum 1 MiB). This verifies frozen bytes, not whether the
claim is true.

```yaml
semanticRelation: projection
relationEvidence:
  - memberIds: [member-..., member-...]
    sourceKind: source_impl
    sourceRef: evidence/customer-projection.json
    artifactDigest: sha256:<64-lowercase-hex>
    confidence: 0.8
```

A scoped read-authority selection separately names one exact eligible member.
That same member needs verified `system_of_record=true`, `lineage`, and
`freshness=current` evidence, each with effective confidence at least 0.5.
The reported
aggregate authority score is display-only and never selects or qualifies a
source; `write_authority` does not increase it. Blocked findings and missing
data-minimization or tenant evidence cannot be acknowledged away.
Review-required finding ids must be acknowledged explicitly. Use
`readAuthority.decision: unproven` or
`semanticRelation: not_equivalent` with a note when evidence does not support
a selection.

Even a fully reviewed candidate yields only a review-, evidence-, and
contract-bound
`reviewed_plan_only` record with `buildReady:false` and
`generatedMcp:false`. Anvil has no safe multi-source AIR/MCP materializer yet;
the audit report itself is never build, approval, or deploy input.

Release configuration is downstream only of the separately approved
single-bundle build, never a `capability compose` report. Review the
environment, Gemini Enterprise surface and location, connector IdP, upstream
credentials, and Firestore ledger separately:

```bash
anvil target gemini-enterprise <capability-bundle> \
  --surface <custom-mcp|agent-gateway> --server-auth oauth \
  --endpoint https://mcp.example.com/mcp \
  --project <project-id> --location <app-location> --engine <engine-id> \
  --idp <google|entra|okta|other> --oauth-scope <mcp-api-scope> \
  --inbound-issuer <issuer-url> --inbound-audience <mcp-api-audience>
anvil deploy credentials <capability-bundle> --env <environment> --project <project-id>
anvil deploy ledger <capability-bundle> --project <project-id> --database <database-id>
anvil certify <capability-bundle>
anvil selftest <capability-bundle>
anvil conformance <capability-bundle>
anvil simulate <capability-bundle>
anvil publish <capability-bundle> --target cloud-run --env <environment>
```

`publish` prepares a plan; it does not deploy. After the reviewed plan is
applied, require exact-runtime live conformance, safe-read proof for every
distinct delegated/OBO identity group, and HTTP 200 from `/readyz` before
writes are enabled. Never invoke a real mutation merely to manufacture proof.
Gemini sign-in, connector OAuth, and upstream API identity are separate trust
planes and must not be collapsed into one “IdP configured” checkbox.
The Gemini app/engine `--location` is not interchangeable with Agent Gateway
or Agent Registry regions; when using `agent-gateway`, review the separate
`--gateway-location` and `--registry-location` compatibility inputs.

On every re-export, inherit the reviewed selection and gateway identity from the
prior plan and write a separate candidate:

```bash
anvil estate plan <new-export> --vendor <vendor> \
  --baseline estate-adoption-plan.json \
  --out estate-adoption-plan.candidate.json \
  --check
```

`--check` fails on source, API-coordinate, finding, adapter, gateway, or
selection drift. It never promotes the candidate, and `--out` cannot overwrite
the reviewed baseline. Review the diff, update the versioned selection when
needed, then promote through the normal repository review. Use the same explicit
`--gateway-id` for inventory, audit, plan, and strict imports.
`planHash` content-addresses the stable adoption plan; `reportHash` binds the
complete change and lineage envelope. Validate both whenever a plan becomes a
baseline.

## Know the import boundary

The adapters consume an offline, UTF-8 configuration document, optionally held
in a hardened ZIP/JAR container. WSO2 additionally accepts a native apictl bulk
directory made of independently selectable per-API archives or extracted API
projects. The container reader does not turn arbitrary vendor binaries or
multi-file graphs into semantics.

The versioned release claim is `anvil estate support [vendor] [--json]`.
It separates accepted bytes, modeled semantics, authority evidence, opaque
boundaries, fixture provenance, and scale proof. The table below is generated
from that same registry:

| Vendor | Release tier | Directly understood input today |
| --- | --- | --- |
| Kong | `native single artifact` | One declarative workspace/state file, either bare or selected from an archive. |
| WSO2 API Manager | `native estate` | A standalone api.yaml, one per-API ZIP/project, or a bulk directory of independent projects. |
| Apigee | `normalized interchange` | Anvil normalized proxy/revision/environment/product interchange document. |
| MuleSoft | `normalized interchange` | Anvil normalized asset/resource/policy interchange document. |
| IBM API Connect | `normalized interchange` | Anvil normalized API/resource/product/plan/assembly interchange document. |
| Mashery (Boomi Cloud API Management) | `research only` | No accepted input; research contract only. |

If the supplied artifact is outside that row, stop with an unsupported-format
finding. Do not rename or flatten it silently and call the result a native
import. Any route without an explicit path and method, and every unsupported
transform/mediation/assembly policy, stays opaque and blocks exposure.

### Drive a real WSO2 apictl bulk export

`apictl export apis` writes a directory of per-API archives named
`<APIName>_<APIVersion>.zip` for a working copy or
`<APIName>_<APIVersion>_Revision-<N>.zip` for a revision under
`<USER_HOME>/.wso2apictl/exported/migration/<environment>/tenant-default/apis`.
Each archive has one API project rooted at `<APIName>-<APIVersion>/`, including
`api.yaml`, `api_meta.yaml`, optional `deployment_environments.yaml`, and
the formal contract under `Definitions/` (normally
`Definitions/swagger.yaml` for REST APIs).

```bash
apictl export apis --environment production --all --force
WSO2_APIS="$HOME/.wso2apictl/exported/migration/production/tenant-default/apis"

anvil estate inventory "$WSO2_APIS" --vendor wso2 \
  --gateway-id <stable-wso2-control-plane-id> --summary
anvil estate audit "$WSO2_APIS" --vendor wso2 \
  --gateway-id <stable-wso2-control-plane-id> --check
anvil estate plan "$WSO2_APIS" --vendor wso2 \
  --gateway-id <stable-wso2-control-plane-id> \
  --init-selection estate-selection.yaml --out estate-adoption-plan.json
```

Pass the collection directory itself, not an invented aggregate YAML document.
Do not use `--entry` on a collection: select with `--api`, `--revision`,
and `--environment`, plus `--api-version` when inventory shows a separate
semantic version axis. For native WSO2, `--api-version 1.0.0` means
`api.yaml data.version`; `--revision working-copy` selects the working copy,
and `--revision revision-7` selects the project whose
`api.yaml data.isRevision` is true and `data.revisionId` is 7. A declared
revision without a usable id is a scoped blocker, never collapsed into the
working copy. When gateway revision is a separate axis, literal semantic
`apiVersion: "0.0.0"` remains a real version, not Anvil's absence sentinel. A
single native per-API ZIP is also accepted directly without `--entry api.yaml`.
For production adoption, extract or otherwise materialize the selected
archive's validated OpenAPI/Swagger candidate under `Definitions/` and pass
those exact bytes with `--spec`. Anvil binds the supplied digest only when
there is one validated embedded candidate and the bytes match. Zero candidates,
multiple candidates, or a digest mismatch fail closed. For a legitimate
external source of truth, repeat deliberately with
`--attest-spec-override "<reviewed reason>"`; the attestation is receipt-bound
and its reason is redacted to a digest in the public receipt view. Route
compatibility alone is not byte lineage. `api.yaml` supplies gateway inventory
and policy evidence, not a full request/response contract.

```bash
anvil estate import "$WSO2_APIS" --vendor wso2 \
  --api OrderService --api-version 1.0.0 --revision revision-7 \
  --environment Default --gateway-id <stable-wso2-control-plane-id> \
  --strict-identity \
  --spec extracted/OrderService-1.0.0/Definitions/swagger.yaml \
  --gateway-url https://gateway.example.com/orders
```

Anvil keeps each API project independent. The collection snapshot, each
per-API ZIP or extracted project, and every accepted member carry separate
content digests and parent lineage. Diagnostics carry API, artifact, and, where
known, route/revision/environment ownership. Import applies genuinely global
findings plus findings whose API constraints and artifact lineage match the
selected coordinate. A duplicate or opaque API B does not poison unrelated API
A; even a malformed project whose API id cannot be read stays isolated by its
per-project origin and digest. A failure that prevents Anvil from establishing
any safe project boundary remains subjectless, global, and fail-closed.
`semanticDigest` is computed from validated project members. Repacking the
same members can change outer packaging identity, but packaging metadata is
lineage evidence, not semantic adoption-plan drift.
`estate inventory` still exits 1 when any artifact-scoped error is present,
while preserving valid rows in its output; that exit means the collection needs
triage, not that every row is unusable. `estate audit` exits zero by default
while reporting its whole-estate gate, and `--check` turns that gate into a CI
failure.
The audit's top-level gate still summarizes whether any estate finding is open;
it may be `blocked` while an unrelated API row is ready. Adoption authority is
the selected row's scoped disposition plus import diagnostics, not an inference
that a red estate summary makes every API equivalent.

The collection boundary is finite: at most 100,000 filesystem and expanded
member records, 25 MiB per filesystem file, 200 MiB combined raw and expanded
bytes, and path depth 32. Each nested ZIP independently passes the standard
10,000-member, 25 MiB/member, 200 MiB-expanded, depth-32 archive battery. Anvil
rejects an over-limit estate rather than silently truncating it.

This boundary is intentionally narrow. Anvil preserves CAR files, sequences,
mediation implementations, and other uninterpreted members as evidence, but
does not execute or infer their behavior; relevant policy/mediation remains
opaque and blocks exposure. Apigee, MuleSoft, and IBM API Connect still require
the normalized documents in the table above.

### Keep identity evidence field-level

A configured auth plugin or security-scheme family is recorded separately from
exact identity configuration. It can identify an auth type only when that
mapping is unambiguous; it cannot also prove issuer, audience, credential
carrier, principal, or scopes. Exact fields are emitted as cited,
operation-scoped evidence and reconciled against the supplied contract.

Kong reads explicit OIDC `config.issuer`, `config.audience`, and
`config.scopes`. It records a key carrier only when one `key_names` entry and
all three `key_in_header`/`key_in_query`/`key_in_body` flags explicitly
select one supported location. WSO2 operation `scopes` are exact evidence;
generic `oauth2` and compound security labels do not reveal a grant or
principal. Normalized Apigee, MuleSoft, and API Connect documents accept an
`identity` block containing only `issuer`, `audience`, `carrier`,
`principal`, and `scopes` at their documented API and operation/resource
levels. Malformed declared identity is a blocking adapter error.

Never derive an issuer from `token_endpoint`, `tokenUrl`, discovery URLs, or
plugin names. Those are acquisition/configuration coordinates, not proof of the
identity that signed the credential accepted by the API.

## Select; do not mirror

Use inventory/audit to choose APIs that serve an agent intent. Do not batch
compile hundreds of UI endpoints into hundreds of tools. For each selected API,
locate its original OpenAPI/Swagger contract and attest the public gateway URL:

```bash
anvil estate import <export> \
  --vendor <vendor> \
  --api <inventory-id> \
  --gateway-id <stable-control-plane-or-org-id> \
  --strict-identity \
  --revision <inventory-revision> \
  --environment <inventory-environment> \
  --spec <contract.openapi.yaml> \
  --gateway-url https://gateway.example.com/<base> \
  --manifest anvil.yaml \
  --root "$PWD"
```

Then run `anvil inspect`, `anvil lint`, `anvil distill --as-enrich-plan`,
and `anvil estate verify <import-id> --bundle <reported-output>`. Omitting
`--out` is deliberate: the default directory contains the stable
vendor/gateway/API/service/environment/revision identity, so prod, test, and
successive revisions cannot overwrite one another. `--strict-identity` refuses
offline exports whose real control-plane identity has not been supplied.
Compatibility mode records such lineage explicitly as `gatewayId=unscoped`
and emits a warning; it never presents the fallback as proven. The literal
`--gateway-id unscoped` is reserved and rejected. Likewise, a native export
must omit an unknown revision/environment rather than declaring Anvil's
`unversioned`/`unscoped` absence sentinels; plan-generated flags remain valid
attestations for genuinely omitted coordinates. Without `--spec`, the bundle
is assessment-only and its route-derived operations stay blocked.

For a receipt-backed gateway import, put reviewed operation states and semantic
fixes in the supplemental manifest and re-run the same import. `anvil approve`
and capability reprojection refuse to mutate receipt-bound output and print a
re-import command using the preserved private export. This makes approval a
compiler input covered by the new receipt rather than a stale annotation.

Every new receipt exposes two identities:

- `selection.identity.digest` owns the output coordinate and hashes only
  vendor, gateway, API, optional semantic API version, service, environment,
  and gateway revision.
- `selection.identity.lineageDigest` binds that coordinate to the exact export,
  normalized inventory, and gateway-id evidence source. The receipt digest also
  binds the manifest, source, policies, diagnostics, and generated bytes.

An unrelated API changing in a large export therefore does not move this API's
default output path. It does change evidence lineage. Review the estate diff,
then use `--replace-derived` to accept that verified same-coordinate transition.
A different stable coordinate is always refused, even with
`--replace-derived`; choose the collision-safe default or another `--out`.
Preserve the import command, manifest, both identity digests, import id, and
verification report in the pipeline.

## Investigate view-shaped APIs

Valid OpenAPI can still encode a poor agent surface. A route such as
`POST /applications/filter` may persist a saved filter even though “filter”
looks read-like; a dashboard aggregator may be useful to a screen but expose no
stable business intent; row-action endpoints may hide high-risk state changes.
The coding harness should investigate, not perform a mechanistic conversion:

1. Read operationId, summary, description, schemas, response codes, security,
   and idempotency carriers together.
2. When source access is supplied, trace frontend callers to the server handler,
   persistence writes, downstream calls, tests, and authorization checks.
3. When approved evidence is supplied, compare observed traffic and gateway
   policy without copying secrets or payload data into the bundle.
4. Record contradictions as findings. Never let a read-like path token override
   explicit persistence evidence.
5. Enrich the one AIR model with `name`, `side_effect`, risk, reversibility,
   idempotency, confirmation, and retry policy. Leave uncertainty
   `review_required`.
6. Distill redundant view endpoints into capability-level intents, but keep
   every write as its own reviewed basis vector.

For a coordinate explicitly marked `semanticLane: agent_assisted`, use the
implemented CASE rail only after its receipt-bound import:

```bash
anvil distill <bundle-from-import-report> --as-enrich-plan \
  --write <bundle-from-import-report>/enrich-plan.json
anvil case list <bundle-from-import-report>
anvil case open <bundle-from-import-report> <target-key> --out <case-root>
anvil case investigate <materialized-case-dir>
anvil case close <case-dir> <bundle-from-import-report> --json
```

CASE records evidence, claims, critique, tests, and a proposed patch. A reviewer
accepts justified semantics into the supplemental manifest and re-runs the
original receipt-bound import. The agent cannot edit AIR, approve an operation,
close a deterministic finding, or bypass inspect, lint, verification, and
approval policy. Do not launch it for `deterministic_only` or
`manual_review` coordinates.

Example correction:

```yaml
operations:
  createSavedFilter:
    name: { resource: saved_filter, verb: create }
    side_effect: mutation
    risk: medium
    reversible: true
    idempotency:
      strategy: required_request_key
      key_location: header
      header: Idempotency-Key
    confirmation: { required: true, risk: medium }
    state: approved
```

Approval in that manifest is justified only after the evidence above has been
reviewed. A required idempotency header is evidence of a carrier, not proof that
the upstream implements the same-key/same-request replay contract.

## Findings and ownership

- `anvil_adapter`: parser/normalizer support gaps or fabricated semantics.
- `gateway_owner`: opaque policies, routes, products, and export completeness.
- `api_owner`: request/response contract and business behavior.
- `identity_owner`: issuer, audience, credential carrier, scopes, and principal.

A pipeline may baseline informational adapter limitations, but never waive
blocking route fabrication, a missing contract for exposure, unresolved opaque
policy, identity contradiction, or unproven write safety.
