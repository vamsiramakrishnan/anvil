---
title: "Import a gateway estate"
description: "Import the APIs behind your gateway from an offline export you produce — Apigee, Kong, WSO2, MuleSoft, or IBM API Connect — never a live connection."
sidebar:
  order: 3
---

**What you'll have at the end:** a clear picture of what `anvil estate` reads
from a gateway estate, the exact document each adapter expects, and a verified
bundle that locks the original OpenAPI/Swagger contract together with the
gateway export and public runtime URL. For WSO2, that includes the real
`apictl export apis` directory of per-API ZIPs rather than a hand-built
aggregate file.

## First, the question everyone asks: is Anvil talking to my gateway?

**No management-plane connection.** Anvil needs no admin URL, admin-API token,
live discovery, or process sitting next to Apigee polling it. `anvil estate`
reads an **artifact on disk** — a config document, a supported ZIP/JAR, or a
native WSO2 apictl collection directory — and parses it offline. The adapters
are pure parsers; they hold no credentials and open no sockets.

The production flow has four required inputs and one optional enrichment input,
all under your control:

1. **Export** your APIs from the gateway, using the gateway's own tooling, to an
   offline artifact.
2. **Locate the original OpenAPI/Swagger** for the one API you want to adopt.
3. **Attest the public HTTPS gateway URL** that generated calls must traverse.
   This runtime URL is written into the bundle; Anvil does not call it during
   import.
4. Optionally provide an **Anvil manifest** with reviewed idempotency,
   confirmation, retry, naming, workflow, and approval evidence.
5. **Point `anvil estate` at those files.**

That's the whole model. The rest of this page is what that file has to look
like, and how to produce it for each vendor.

## What the adapter reads

Start with `anvil estate support [vendor]` (or `--json` in CI). It is the
versioned contract for accepted bytes, modeled semantics, authority evidence,
opaque boundaries, fixture provenance, and scale proof.

Each implemented vendor adapter reads an explicitly documented offline shape describing the
estate's APIs — their routes, auth, quota, and policies. Kong uses declarative
YAML/JSON. WSO2 accepts its native apictl directory, per-API ZIP, extracted API
project, or standalone `api.yaml`. The other adapters use normalized YAML/JSON.
Anvil does not run a MuleSoft JAR, interpret Apigee's proxy XML, or infer the
behavior of a WSO2 CAR or mediation sequence.

WSO2 has native estate ingestion. Kong directly accepts one native declarative
state document, but not a `deck --all-workspaces` directory as one estate. For
the other three implemented adapters you produce a normalized document from
vendor evidence.

| Vendor (`--vendor`) | Release tier | Native evidence | What you feed Anvil |
| --- | --- | --- | --- |
| `kong` | `native_single_artifact` | `deck` declarative state (`kong.yaml`) | one state document; multi-workspace directories are not collected |
| `wso2` | `native_estate` | `apictl export apis` directory of per-API ZIPs | the directory, one per-API ZIP, one extracted API project, or standalone `api.yaml` |
| `apigee` | `normalized_interchange` | proxy-revision ZIP plus product/deployment management responses | a normalized `proxies:` / `products:` document |
| `mulesoft` | `normalized_interchange` | Exchange contract plus API Manager instance/applied-policy responses | a normalized `apis:` document |
| `api_connect` | `normalized_interchange` | Product YAML plus referenced OpenAPI / `x-ibm-configuration` YAML | a normalized `apis:` / `products:` document |

Mashery is `research_only`: it has no `GatewayKind`, accepted input, adapter, or
scale claim. `anvil estate support mashery` records that boundary without
pretending a management-API capture is already implemented.

Anything Anvil can't *prove* it understands — a Kong transformer, an Apigee
`JavaScript` policy, a MuleSoft DataWeave step — is kept as an **opaque**
policy: one Anvil can't fully read, so it flags it for a human. An opaque policy
is recorded as an immutable receipt blocker, and certification fails
`contract.gateway-blockers-resolved`, so a mapping gap is never a silent one.

### Identity evidence has a narrower boundary

An auth plugin name is not an issuer. A token or discovery endpoint is not an
issuer either. Adapters preserve these as different evidence classes:

- A configured `key-auth`, `jwt`, `VerifyAPIKey`, or similar family can identify
  an auth **type** only where the mapping is unambiguous. That record cannot also
  claim issuer, audience, carrier, principal, or scopes.
- Exact `issuer`, `audience`, `carrier`, `principal`, and `scopes` values become
  field-level, operation-scoped evidence with a pointer to the source field.
- Kong OIDC `config.issuer`, `config.audience`, and `config.scopes` are read
  directly. A Kong key carrier is exact only when one `key_names` entry is
  present and `key_in_header`, `key_in_query`, and `key_in_body` explicitly
  select exactly one supported location.
- WSO2 operation `scopes` are direct evidence. A compound `securityScheme` or
  generic `oauth2` label does not reveal a client grant or user authority.
- The three normalized adapters accept this exact block at API and
  operation/resource level:

```yaml
identity:
  issuer: https://identity.example.com/
  audience: api://payments
  principal: delegated
  carrier: { in: header, name: Authorization, scheme: Bearer }
  scopes: [payments.read]
```

Apigee accepts it on a proxy, flow, or auth policy; MuleSoft on an API or
resource (and the same fields directly in an auth policy's `config`); API
Connect on an API or resource. The WSO2 normalized envelope also accepts it on
an API or operation. A malformed declared identity field is a blocking adapter
error, not silently missing evidence. Fields such as `token_endpoint`,
`tokenUrl`, and discovery URLs are deliberately ignored for issuer
reconciliation.

## Try it now — no gateway required

This is the whole thing end to end: write a tiny Kong estate and its real API
contract, list the estate, import one API, find its locked source and private
receipt, and verify the chain. The example runtime URL is an attestation only:
no account or network is used.

```bash
# [docs-tested]
WORK=$(mktemp -d)
cat > "$WORK/kong.yaml" <<'YAML'
_format_version: "3.0"
services:
  - name: refunds
    url: https://backend.internal/refunds
    routes:
      - name: refunds-route
        paths: ["/refunds/{id}"]
        methods: ["GET"]
    plugins:
      - name: openid-connect
        config: { scopes: ["refunds:read"] }
      - name: rate-limiting
        config: { minute: 100 }
YAML
cat > "$WORK/openapi.yaml" <<'YAML'
openapi: 3.0.3
info: { title: Refunds, version: 1.0.0 }
components:
  securitySchemes:
    enterprise_oidc:
      type: oauth2
      flows:
        clientCredentials:
          tokenUrl: https://idp.example.test/oauth/token
          scopes:
            refunds:read: Read refunds
security:
  - enterprise_oidc: [refunds:read]
paths:
  /refunds/{id}:
    get:
      operationId: fetchRefund
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses: { "200": { description: ok } }
YAML
# List the estate — this reads the file, nothing else:
node packages/cli/dist/bin-anvil.js estate inventory "$WORK/kong.yaml" --vendor kong
# Import the API with its full contract and an attested gateway runtime:
node packages/cli/dist/bin-anvil.js estate import "$WORK/kong.yaml" \
  --vendor kong --api refunds \
  --spec "$WORK/openapi.yaml" \
  --gateway-url https://gateway.example.test \
  --root "$WORK" \
  --out "$WORK/refunds" \
  --json > "$WORK/import.json"

# The report tells you exactly where the locked spec and private receipt live.
IMPORT_ID="$(node -e 'const r=require(process.argv[1]); process.stdout.write(r.receipt.importId)' "$WORK/import.json")"
LOCKED_DIR="$(node -e 'const r=require(process.argv[1]); process.stdout.write(r.source.lock.directory)' "$WORK/import.json")"
ENTRYPOINT="$(node -e 'const r=require(process.argv[1]); process.stdout.write(r.source.lock.entrypoint)' "$WORK/import.json")"
RECEIPT_DIR="$(node -e 'const r=require(process.argv[1]); process.stdout.write(r.receipt.directory)' "$WORK/import.json")"
test -f "$LOCKED_DIR/raw/$ENTRYPOINT"
test -f "$RECEIPT_DIR/import.receipt.json"
test -f "$RECEIPT_DIR/raw/export.bin"

# Verify the receipt, exact export, locked contract, and receipt-scoped bundle.
node packages/cli/dist/bin-anvil.js estate verify "$IMPORT_ID" \
  --root "$WORK" \
  --bundle "$WORK/refunds"
test -f "$WORK/refunds/catalog.json"
rm -rf "$WORK"
```

The commands below swap in your real export. For production onboarding, add the
same `--spec`, `--gateway-url`, and `--root` flags to every vendor example. Add
`--manifest <anvil.yaml>` when the source pair cannot prove operation-level
safety; Anvil applies it in the same receipt-bound compile.
Without `--spec`, Anvil emits an assessment-only route contract and blocks every
operation because routes alone do not prove request, response, or authentication
semantics.

## Where Anvil puts the evidence

For the command above:

| Evidence | Location |
| --- | --- |
| Locked OpenAPI/Swagger | `$WORK/.anvil/sources/<snapshot-id>/raw/<entrypoint>` |
| Immutable private receipt | `$WORK/.anvil/imports/<import-id>/import.receipt.json` |
| Content-complete export evidence | `$WORK/.anvil/imports/<import-id>/raw/export.bin` |
| Redacted receipt pointer | `$WORK/refunds/import.receipt.json` |

The JSON import report prints the concrete ids, hashes, and directories. Keep
using the same `--root` when you verify from another working directory. For a
file or ZIP, `raw/export.bin` is the exact supplied bytes. For an extracted WSO2
collection directory, it is a deterministic path-and-byte envelope: every
accepted relative path and byte is retained without host paths, mtimes, or
ownership metadata. The private receipt is secret-free, but either representation
can contain customer configuration; protect the `.anvil/imports` tree
accordingly.

## Triage the whole estate; adopt one coordinate at a time

`inventory`, `audit`, and `plan` answer different questions:

- `inventory` is the bounded operator view. Filter it with `--query`, `--owner`,
  or `--lifecycle`; cap rows with `--limit`, request all matching rows with
  `--all`, or print counts plus diagnostics with `--summary`.
- `audit` evaluates the complete loaded estate and emits the full finding and
  per-API disposition report. `--check` turns its selected threshold into a CI
  failure; it does not hide findings.
- `plan` creates a coordinate-aware triage queue and owner workstreams.
  `--init-selection` starts every
  API/version/revision/environment coordinate at `decision: triage` and never
  overwrites an existing selection file.
- `import` accepts one exact selected coordinate. It is deliberately not a
  whole-estate conversion switch.

```bash
anvil estate inventory <export> --vendor <vendor> \
  --query payments --lifecycle PUBLISHED --limit 25
anvil estate audit <export> --vendor <vendor> \
  --gateway-id <stable-control-plane-id> --json > estate-audit.json
anvil estate plan <export> --vendor <vendor> \
  --gateway-id <stable-control-plane-id> \
  --init-selection estate-selection.yaml \
  --out estate-adoption-plan.json
```

Diagnostics are scoped rather than treated as one undifferentiated document
failure. An adapter attaches an API subject, a content-addressed artifact
subject, and, where known, a route subject. The audit assigns those findings to
the matching API or artifact and folds them into only the affected disposition
and owner workstream. Import applies true estate-global findings plus findings
whose API coordinate and artifact evidence match the selected API.

That distinction is what makes a large collection usable: an invalid or
duplicate coordinate in API B remains visible and blocks B, but does not poison
an unrelated API A. A malformed WSO2 project whose API id cannot be read can
still be isolated by its per-project artifact origin and digest. A failure that
prevents Anvil from establishing any safe project boundary—such as an unsafe
outer container or an unreadable whole aggregate document—remains global and
fails closed.

`estate inventory` still exits 1 when any artifact-scoped error is present,
while preserving valid rows in its output. Treat that exit as “this collection
needs triage,” not “every API failed.” `estate audit` exits zero by default
while reporting its whole-estate gate; add `--check` when that gate should fail
CI.

The audit's top-level gate is deliberately a whole-estate health summary, so it
remains `blocked` while any scoped blocker is open. That does not mean every API
is blocked: adoption uses the selected API row's disposition and matching import
diagnostics. The plan can therefore show a red estate summary and a clean,
unrelated coordinate ready for import at the same time.

## Kong

Kong is the direct case: its native declarative config **is** the format the
adapter reads. Export it with [decK](https://developer.konghq.com/deck/) and
point Anvil straight at the file.

```bash
deck gateway dump -o kong.yaml            # run by you, against your Kong Gateway
anvil estate inventory kong.yaml --vendor kong
anvil estate import kong.yaml --vendor kong --api refunds \
  --spec refunds.openapi.yaml --manifest refunds.anvil.yaml \
  --gateway-url https://api.example.com/refunds \
  --root "$PWD" --out generated/refunds
```

The shape (top-level `services[]`, each with `routes[]` and `plugins[]`):

```yaml
_format_version: "3.0"
services:
  - name: refunds
    url: https://backend.internal/refunds
    routes:
      - { name: refunds-route, paths: ["/refunds"], methods: ["GET", "POST"] }
    plugins:
      - name: openid-connect
        config:
          issuer: https://identity.example.com/
          audience: api://refunds
          scopes: ["refunds:write"]
      - { name: rate-limiting, config: { minute: 100 } }
```

**What maps:** `key-auth` / `jwt` / `openid-connect` → an auth summary; exact
OIDC `issuer`, `audience`, and `scopes` → cited operation identity evidence;
OIDC `scopes` also constrain per-operation `auth.scopes`; `rate-limiting` → a
quota note; request/response **transformers and any unrecognized plugin →
opaque**. A `token_endpoint` in plugin configuration remains token-acquisition
metadata and is never promoted to issuer evidence.

**Official docs:** [decK overview & `deck gateway dump`](https://developer.konghq.com/deck/) ·
[decK file format](https://developer.konghq.com/deck/file/)

## WSO2

WSO2 is the other native case. The WSO2 [API
Controller](https://apim.docs.wso2.com/en/latest/install-and-setup/setup/api-controller/getting-started-with-wso2-api-controller/)
(`apictl`) bulk command writes a directory of independently selectable per-API
ZIPs. Anvil reads that directory directly; you do not have to merge 1,000
`api.yaml` files into one invented document.

```bash
# Export all deployed revisions. Add --all when working copies and undeployed
# revisions must be included; --force first clears the prior export for this
# environment and tenant.
apictl export apis --environment production --all --force

WSO2_APIS="$HOME/.wso2apictl/exported/migration/production/tenant-default/apis"
anvil estate inventory "$WSO2_APIS" --vendor wso2 \
  --gateway-id <stable-wso2-control-plane-id> --summary
anvil estate audit "$WSO2_APIS" --vendor wso2 \
  --gateway-id <stable-wso2-control-plane-id> --json > wso2-estate-audit.json
anvil estate plan "$WSO2_APIS" --vendor wso2 \
  --gateway-id <stable-wso2-control-plane-id> \
  --init-selection estate-selection.yaml \
  --out estate-adoption-plan.json
```

WSO2 names a working-copy archive `<APIName>_<APIVersion>.zip` and a revision
archive `<APIName>_<APIVersion>_Revision-<N>.zip`. Inside is one
`<APIName>-<APIVersion>/` project:

```text
<APIName>-<APIVersion>/
├── api.yaml
├── api_meta.yaml
├── deployment_environments.yaml
├── Definitions/
│   ├── swagger.yaml
│   └── schema.graphql
└── Sequences/
    ├── in-sequence/
    ├── out-sequence/
    └── fault-sequence/
```

Anvil uses `api.yaml` for gateway inventory, routes, scopes, throttling, and
policy evidence. It reads deployed gateway names from
`deployment_environments.yaml`. It records `api_meta.yaml`,
`Definitions/*`, sequences, and all other accepted members with content
digests and parent-archive lineage. It does not silently promote
a definition into the compiler source. Materialize the selected API's validated
OpenAPI/Swagger candidate and pass those exact bytes with `--spec`. Anvil
accepts the binding only when there is exactly one validated embedded
`Definitions` candidate and its digest matches. Zero candidates, multiple
candidates, and digest mismatch fail closed. For a legitimate external source
of truth, add `--attest-spec-override "<reviewed reason>"`; the decision is
receipt-bound and the public receipt view keeps only a redacted reason digest.
Matching routes do not substitute for byte lineage.

```bash
anvil estate import "$WSO2_APIS" \
  --vendor wso2 \
  --api OrderService \
  --api-version 1.0.0 \
  --revision revision-2 \
  --environment Default \
  --gateway-id <stable-wso2-control-plane-id> \
  --strict-identity \
  --spec extracted/OrderService-1.0.0/Definitions/swagger.yaml \
  --manifest manifests/orders.anvil.yaml \
  --gateway-url https://api.example.com/orders \
  --root "$PWD"
```

Do not use `--entry` on a collection directory; it selects neither an API nor a
revision. Use `--api`, `--api-version`, `--revision`, and `--environment`.
These are separate WSO2 axes: `--api-version 1.0.0` selects
`api.yaml data.version`; `--revision revision-2` selects WSO2 revision 2;
`--revision working-copy` selects a project whose `api.yaml data.isRevision` is
not true. A `data.isRevision: true` project must carry a usable
`data.revisionId`; Anvil renders it as `revision-N` and blocks contradictory or
missing revision identity rather than folding it into the working copy. A
single native per-API ZIP also works directly, without `--entry api.yaml`; an
extracted per-API project and a standalone `api.yaml` remain supported.
The selection file represents the same axes as `apiVersion: "1.0.0"` and
`revision: revision-2`; preserve both values emitted by `--init-selection`.
When gateway revision is distinct, literal semantic API version `0.0.0` remains
a real version and is not collapsed into `unversioned`.

The collection semantic digest is computed from validated project members.
Repacking the same members can change outer packaging identity, but that is
packaging lineage—not semantic adoption-plan drift.

The collection reader is deliberately bounded: 100,000 filesystem and expanded
member records, 25 MiB per filesystem file, 200 MiB combined raw and expanded
bytes, and path depth 32. Each per-API ZIP also passes the standard archive
battery independently (10,000 members, 25 MiB/member, 200 MiB expanded, depth
32). A collection over a boundary is rejected with a diagnostic; it is never
silently truncated.

For a standalone or normalized document, Anvil reads these fields (either as a
top-level `apis:` array or the single-API `data:` envelope that `apictl`
writes):

```yaml
apis:                      # or:  data:  { ...one API... }
  - name: OrderService
    context: /orders
    version: 1.0.0
    lifeCycleStatus: PUBLISHED
    securityScheme: [oauth2]
    identity:                 # optional normalized exact evidence, not inferred
      issuer: https://identity.example.com/
      audience: api://orders
      carrier: { in: header, name: Authorization, scheme: Bearer }
      principal: service
    apiThrottlingPolicy: Gold
    operations:
      - { target: /orders, verb: POST, scopes: ["orders:write"] }
    mediationPolicies:
      - { name: custom-header-sequence }
```

**What maps:** operation `scopes` → both `auth.scopes` and cited
operation-specific identity evidence; `securityScheme` → auth summary (and a
type-only record for an unambiguous `api_key`, `basic`, `jwt`, or `mtls`
value); an explicit `identity` block → exact identity evidence;
`apiThrottlingPolicy` → a quota note; **`mediationPolicies`, operation policy
implementations, CAR files, and sequence files → opaque**. Opaque bytes remain
in lineage, but Anvil does not execute or infer their behavior.

**Official docs:** [Getting started with apictl](https://apim.docs.wso2.com/en/latest/install-and-setup/setup/api-controller/getting-started-with-wso2-api-controller/) ·
[Export/import & migrate APIs](https://apim.docs.wso2.com/en/latest/install-and-setup/setup/api-controller/managing-apis-api-products/migrating-apis-to-different-environments/) ·
[apictl command reference](https://apim.docs.wso2.com/en/latest/reference/apictl/wso2-api-controller/)

## Apigee

**Export:** Apigee's native artifact is an API-proxy **bundle** — the `apiproxy/`
tree of XML — [downloaded](https://docs.cloud.google.com/apigee/docs/api-platform/fundamentals/download-api-proxies)
via the management API or [`apigeecli`](https://github.com/apigee/apigeecli)
(`apigeecli apis export …`), alongside your API products
(`apigeecli products export …`). Anvil does **not** read the raw XML bundle —
flatten each proxy and the product that fronts it into this document:

```yaml
proxies:
  - name: payments-proxy
    basePath: /payments
    revision: "12"
    environments: [prod]
    identity:
      issuer: https://identity.example.com/
      audience: api://payments
      principal: service
      carrier: { in: header, name: Authorization, scheme: Bearer }
    flows:                                  # one per operation
      - { method: GET,  path: /refunds, name: listRefunds }
      - { method: POST, path: /refunds, name: createRefund }
    policies:                               # by type; names are yours
      - { type: OAuthV2,       name: VerifyAccessToken }
      - { type: Quota,         name: QuotaPerApp }
      - { type: AssignMessage, name: AM-AddTenantHeader }
products:
  - name: payments-product
    scopes: ["refunds:write"]
    quota: "1000/minute"
    proxies: [payments-proxy]               # links product → proxy
```

```bash
anvil estate inventory apigee-estate.yaml --vendor apigee
anvil estate import apigee-estate.yaml --vendor apigee --api payments-proxy \
  --spec payments.openapi.yaml --gateway-url https://api.example.com/payments \
  --root "$PWD" --out generated/payments
```

**What maps:** the product's `scopes` → `auth.scopes` on the proxy's operations;
`Quota` / `SpikeArrest` → quota notes; **`AssignMessage` / `JavaScript` / `XSL` /
`JSONToXML` / `XMLToJSON` → opaque**.

**Official format docs:** [Download an API proxy bundle](https://docs.cloud.google.com/apigee/docs/api-platform/fundamentals/download-api-proxies) ·
[API proxy configuration reference](https://docs.cloud.google.com/apigee/docs/api-platform/reference/api-proxy-configuration-reference).
The community [`apigeecli`](https://github.com/apigee/apigeecli) can help with
capture automation, but its own README says it is not an officially supported
Google product; the Apigee REST API remains the normative source.

## MuleSoft

**Export:** MuleSoft splits the information across two places, so you assemble
the document from two sources — the asset itself from
[Anypoint Exchange](https://docs.mulesoft.com/exchange/), and the **applied
policies** from API Manager (list them with the
[Anypoint CLI](https://docs.mulesoft.com/anypoint-cli/latest/anypoint-platform-cli-commands):
`api-mgr:api:list` / `api-mgr:api:describe`, then
`api-mgr:policy:list <apiInstanceId>`). `policy:describe` describes a policy
template; it is not proof that the policy is applied to an API instance. Anvil
reads a normalized
asset document keyed by `assetId`:

```yaml
apis:
  - assetId: customer-api
    productVersion: v1
    instanceLabel: prod
    identity:
      issuer: https://identity.example.com/
      audience: api://customers
      principal: service
      carrier: { in: header, name: Authorization, scheme: Bearer }
    resources:
      - { method: GET,  path: /customers }
      - { method: POST, path: /customers, scopes: ["customers:write"] }
    policies:
      - { policyId: openidconnect }
      - { policyId: rate-limiting-sla }
      - { policyId: custom-dataweave-transform }
```

```bash
anvil estate import mulesoft-estate.yaml --vendor mulesoft --api customer-api \
  --spec customer.openapi.yaml --gateway-url https://api.example.com/customers \
  --root "$PWD" --out generated/customer
```

**What maps:** auth policies (`openidconnect`, `jwt-validation`,
`client-id-enforcement`, `oauth2-provider`) → auth summary; `rate-limiting` /
`rate-limiting-sla` / `spike-control` → quota notes; **DataWeave and any other
custom policy → opaque**.

**Official docs:** [Anypoint Exchange](https://docs.mulesoft.com/exchange/) ·
[Anypoint CLI for API Manager](https://docs.mulesoft.com/anypoint-cli/latest/anypoint-platform-cli-commands) ·
[Exchange platform APIs](https://docs.mulesoft.com/exchange/about-platform-apis)

## IBM API Connect

**Export:** the [`apic`](https://www.ibm.com/docs/en/api-connect/cloud/10.0.x_saas?topic=tool-managing-api-products)
developer toolkit clones published Product YAML and referenced OpenAPI YAML
with `x-ibm-configuration` assemblies. Use `apic products:clone` or
`apic apis:clone` for the catalog scope being assessed; draft commands address
a different lifecycle. Anvil reads a normalized product/API document — note
the vendor flag is `api_connect` (with an underscore):

```yaml
apis:
  - name: claims-api
    version: 2.1.0
    basePath: /claims
    oauthProviders: [corporate-oauth]
    identity:
      issuer: https://identity.example.com/
      audience: api://claims
      principal: service
      carrier: { in: header, name: Authorization, scheme: Bearer }
    resources:
      - { method: POST, path: /claims, scopes: ["claims:write"] }
    assembly:
      execute:
        - { type: map }
        - { type: gatewayscript }
products:
  - name: insurance-product
    plans:
      - { name: gold, rateLimit: 100/hour, apis: [claims-api] }
```

```bash
anvil estate import apiconnect-estate.yaml --vendor api_connect --api claims-api \
  --spec claims.openapi.yaml --gateway-url https://api.example.com/claims \
  --root "$PWD" --out generated/claims
```

**What maps:** `oauthProviders` → OAuth2 auth; resource `scopes` →
`auth.scopes`; a plan's `rateLimit` → a quota note; **assembly actions `map` /
`gatewayscript` / `xslt` → opaque**.

**Official docs:** [API development & management commands](https://www.ibm.com/docs/en/api-connect/software/10.0.x_cd?topic=tool-api-development-management-commands) ·
[Managing API products](https://www.ibm.com/docs/en/api-connect/software/10.0.x_cd?topic=tool-managing-api-products) ·
[Developer toolkit CLI](https://github.com/ibm-apiconnect/cli)

## Feeding a ZIP or JAR

If your export is an archive, hand it to `anvil estate` directly — the
[archive harness](/anvil/reference/adr/0020-offline-gateway-archive-harness/)
safely unpacks it, refusing path traversal, symlinks, and decompression bombs,
and reporting every rejection instead of dropping it silently.

```bash
# One native apictl API project: api.yaml is found without --entry.
anvil estate inventory OrderService_1.0.0_2.zip --vendor wso2

# A generic archive containing one normalized adapter document:
anvil estate inventory normalized-export.zip --vendor apigee \
  --entry normalized/apigee-estate.yaml
```

A native WSO2 per-API ZIP is a special, documented project shape and does not
need `--entry`. For other ZIP/JAR inputs, Anvil auto-selects only when exactly
one config-like entry exists; use `--entry` to disambiguate several. The config
inside still has to be a shape the selected adapter reads—the harness makes
opening the container safe, it does not translate native proxy XML or a
MuleSoft JAR into a normalized description. `.tar`/`.gz` are not decoded;
extract them or pass the supported config directly.
Obvious Apigee `apiproxy/` bundles, Mule application JAR layouts, and IBM
OpenAPI documents with root `x-ibm-configuration` fail with
`gateway/unsupported_native_artifact` and point to
`anvil estate support <vendor>` instead of suggesting that `--entry` makes
them semantic.

## After import

Verify the import before entering the normal bundle loop:

```bash
anvil estate verify <import-id> --root "$PWD" --bundle generated/refunds
anvil inspect generated/refunds     # every operation's effect, risk, idempotency
anvil lint generated/refunds
# Put reviewed operation semantics and `state: approved` in anvil.yaml, then
# re-run the same `anvil estate import ... --manifest anvil.yaml` command.
```

Risky operations from a full native contract stay `review_required` until you
approve them. For a gateway import, supply reviewed semantics and operation
states through `--manifest` during import so the immutable receipt binds the
intended surface. Do not use a later `anvil approve` as the normal gateway
workflow: `anvil approve` refuses a receipt-backed bundle before changing any
file. Use the exact re-import command it prints, add the reviewed operation
states to the manifest, and mint a new receipt whose compiler inputs and output
hashes bind those decisions. A receipt can still become stale after manual
tampering; `estate verify --bundle`, `status`, and `certify` report that as a
failure rather than offering a post-import approval transition.

The manifest can bind capability review too. Copy the exact id from
`anvil capability list generated/refunds`:

```yaml
capabilities:
  refunds.refund:
    state: approved
    note: Reviewed against the locked contract and gateway evidence.
```

The id is exact—Anvil does not guess from a short or display name. Review is
applied after workflow attachment, so the budget includes direct tools and every
authored workflow dependency. A capability above 20 disclosed tools needs
`allow_large: true` and a non-empty note; that waiver and the canonical parsed
manifest digest are recorded in the immutable receipt.

## Group one bundle, audit across bundles, then configure release

Importing a valid API does not mean every operation should become one giant
agent surface. Within one receipt-bound bundle that passes `inspect`, `lint`,
and `estate verify`, use the buildable capability-grouping loop:

```bash
anvil capability propose <bundle>
anvil capability show <bundle> <capability-id> --operations --auth --evidence
anvil capability approve <bundle> <capability-id> --note <review-note>
anvil build <bundle> <approved-capability-id>
```

This is where the coding harness and Anvil have different jobs. A coding agent
may investigate view-shaped endpoints and propose a capability around a
concrete user job. Anvil deterministically checks exact operation membership,
workflow dependencies, identity groups, and the disclosure budget. A human
accepts or rejects that boundary. Only an approved capability builds, and the
child bundle retains its parent gateway receipt and deployment namespace.

Cross-bundle comparison is a different, audit-only workflow:

```bash
anvil capability compose <bundle-a> <bundle-b> [bundle-c...] \
  --out composition.audit.json \
  --init-review composition.review.yaml
```

After a reviewer edits only the scaffold's decision, evidence,
acknowledgement, and note fields and cites digest-matched local evidence, rerun
to a new output with `--review`.
Similarity never assigns authority; exact member selection requires separately
reviewed semantic relation and read-authority evidence. Auth, safety,
environment/revision, stale-receipt, and data-minimization blockers remain
non-waivable. Even a completed review emits only `reviewed_plan_only` with
`generatedMcp:false` and `buildReady:false`. It generates no AIR, CLI, MCP, or
skill, and its report is never input to `approve`, `build`, `publish`, or
`deploy`. See the generated Anvil skill's
`reference/composing-capabilities.md` for the exact review contract.

Release configuration happens only after the separately approved single-bundle
build, never after or from the `capability compose` report:

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

`publish` prepares a deployment plan; it does not deploy anything. After an
operator applies the reviewed plan, require live conformance against the exact
runtime artifact, a successful opted-in read for every distinct delegated/OBO
identity group, and HTTP 200 from `/readyz` before writes are enabled. Gemini
Enterprise sign-in, connector OAuth, and upstream API identity are separate
trust planes—not one generic “IdP configured” checkbox.
The Gemini app/engine location is also separate from Agent Gateway and Agent
Registry regions; the `agent-gateway` path requires those reviewed compatibility
inputs as well.

Opaque policies are different from operation approval: they are estate-level
contract blockers. There is no generic “reviewed, continue anyway” switch.
Use the diagnostic's exact export coordinate to inspect the policy, then either
replace or remove it and re-export, or add deterministic support for that
policy to the vendor adapter and re-import. Certification names every unresolved
blocker under `contract.gateway-blockers-resolved`.

Re-running an unchanged bound import preserves recognized certification,
publication, report, and exactly regenerable Gemini target artifacts. It refuses
unknown or tampered files. If you deliberately need to reset a stale approved
bundle to the clean import baseline, rerun the same import with
`--replace-derived`. Anvil first verifies the recorded derived bytes, then
discards the old derived state and later lifecycle artifacts; this is a reset,
not a merge. Re-declare the reviewed operation and capability decisions in the
manifest on that command to mint a new bound receipt without copying decisions
implicitly from the stale bundle. The old private receipt remains immutable.

For a large estate, see
[operating at estate scale](/anvil/concepts/gateway-estates/#operating-at-scale) —
you inventory the whole estate cheaply, then import and approve the few APIs that
belong in an agent's hands.

## What Anvil does not do (so nothing surprises you)

- **It does not connect to your gateway management plane** or request admin
  credentials. Exports are offline files you produce. It stores their exact
  bytes (or a content-complete deterministic envelope for a WSO2 directory)
  under the private receipt root, so do not put live credentials in an export
  and protect `.anvil/imports` as evidence.
- **It does not parse native Apigee proxy XML, MuleSoft JAR/DataWeave, IBM
  assembly bundles, WSO2 CAR internals, or mediation implementations.** Kong's
  `deck` dump and WSO2's native apictl project/collection qualify directly;
  Apigee, MuleSoft, and IBM API Connect require the normalized shapes above.
- **It does not import a whole estate at once** — one API per `import`; loop the
  reviewed, plan-generated command for several.
- **It does not trust an export's own "public" flag.** Every operation still
  passes the approval gate before any tool an agent sees exposes it.
