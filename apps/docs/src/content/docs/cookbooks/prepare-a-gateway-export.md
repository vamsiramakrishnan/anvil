---
title: Prepare a gateway export
description: Check the exact offline evidence Anvil accepts from Kong, WSO2, Apigee, MuleSoft, and IBM API Connect before importing an API.
sidebar:
  order: 3
---

Anvil reads offline evidence. It does not connect to a gateway management
plane.

Run the support command before preparing an export:

```bash
anvil estate support <vendor>
```

The result defines the accepted bytes, modeled semantics, opaque boundaries,
and release tier for that vendor. After preparing the export, return to
[Import a gateway estate](/anvil/cookbooks/import-a-gateway-estate/).

## What Anvil reads

Start with `anvil estate support [vendor]` (or `--json` in CI). It is the
versioned contract for accepted bytes, modeled semantics, authority evidence,
opaque boundaries, fixture provenance, and scale proof.

Each vendor adapter accepts one documented offline shape. The shape records
routes, auth, quotas, and policies. Kong uses declarative YAML or JSON. WSO2
accepts a native `apictl` directory, per-API ZIP, extracted project, or
standalone `api.yaml`. The other adapters use normalized YAML or JSON.
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

## Archive inputs

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
