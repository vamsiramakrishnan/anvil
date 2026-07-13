---
title: "Import a gateway estate"
description: "What anvil estate actually reads: an export you produce from Apigee, Kong, WSO2, MuleSoft, or IBM API Connect — an offline file, never a live connection — plus the exact document shape each adapter expects and how to produce it."
sidebar:
  order: 3
---

**What you'll have at the end:** a clear picture of what `anvil estate` reads, the
exact document each of the five adapters expects, and a working import you can
run right now with no gateway account.

## First, the question everyone asks: is Anvil talking to my gateway?

**No.** Anvil never connects to your gateway. There is no URL, no admin-API
token, no live discovery, no process sitting next to Apigee polling it. `anvil
estate` reads a **file on disk** — a config document you exported, or a ZIP/JAR
containing one — parses it offline, and compiles it. The adapters are pure
parsers; they hold no credentials and open no sockets.

So the flow is always two steps, both under your control:

1. **Export** your APIs from the gateway, using the gateway's own tooling, to a file.
2. **Point `anvil estate` at that file.**

That's the whole model. The rest of this page is what that file has to look
like, and how to produce it for each vendor.

## What the adapter reads

Every vendor adapter reads a **YAML or JSON document** describing the estate's
APIs — their routes, auth, quota, and policies. (JSON works everywhere; YAML is
just the friendlier way to write the same thing.) It is a *description* of the
estate, not the vendor's raw binary artifact: Anvil does not run a MuleSoft JAR,
interpret Apigee's proxy XML, or unpack a WSO2 CAR's Java internals.

Two vendors' native exports are already in a shape Anvil reads directly; for the
other three you produce a small normalized document from the vendor's export.

| Vendor (`--vendor`) | Native export | Read directly? | What you feed Anvil |
| --- | --- | --- | --- |
| `kong` | `deck` declarative config (`kong.yaml`) | **Yes** | the `deck` dump itself |
| `wso2` | `apictl` `api.yaml` (`data:` envelope) | **Yes** | the `api.yaml` (or its zip, via `--entry`) |
| `apigee` | API proxy bundle (XML) + products | No | a normalized `proxies:` / `products:` document |
| `mulesoft` | Exchange asset / app JAR | No | a normalized `apis:` document |
| `api_connect` | product / API archive (XML assembly) | No | a normalized `apis:` / `products:` document |

Anything Anvil can't *prove* it understands — a Kong transformer, an Apigee
`JavaScript` policy, a MuleSoft DataWeave step — is preserved as an **opaque**
policy and blocks certification, so a mapping gap is never a silent one.

## Try it now — no gateway required

This is the whole thing end to end: write a tiny Kong estate, list it, and
import one API into a real, approval-gated bundle. No account, no network.

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
        paths: ["/refunds"]
        methods: ["GET", "POST"]
    plugins:
      - name: openid-connect
        config: { scopes: ["refunds:write"] }
      - name: rate-limiting
        config: { minute: 100 }
YAML
# List the estate — this reads the file, nothing else:
node packages/cli/dist/bin-anvil.js estate inventory "$WORK/kong.yaml" --vendor kong
# Import the one API into a normal Anvil bundle (its POST lands review_required):
node packages/cli/dist/bin-anvil.js estate import "$WORK/kong.yaml" \
  --vendor kong --api refunds --out "$WORK/refunds"
test -f "$WORK/refunds/catalog.json"
rm -rf "$WORK"
```

The commands below swap in your real export. Every `import` produces an ordinary
bundle whose risky operations land `review_required` until you approve them —
the same gate every spec goes through.

## Kong

Kong is the direct case: its native declarative config **is** the format the
adapter reads. Export it with [decK](https://developer.konghq.com/deck/) and
point Anvil straight at the file.

```bash
deck gateway dump -o kong.yaml            # run by you, against your Kong Gateway
anvil estate inventory kong.yaml --vendor kong
anvil estate import kong.yaml --vendor kong --api refunds --out generated/refunds
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
      - { name: openid-connect, config: { scopes: ["refunds:write"] } }
      - { name: rate-limiting, config: { minute: 100 } }
```

**What maps:** `key-auth` / `jwt` / `openid-connect` → an auth summary; OIDC
`scopes` → per-operation `auth.scopes`; `rate-limiting` → a quota note;
request/response **transformers and any unrecognized plugin → opaque**.

**Official docs:** [decK overview & `deck gateway dump`](https://developer.konghq.com/deck/) ·
[decK file format](https://developer.konghq.com/deck/file/)

## WSO2

WSO2 is the other near-native case. The WSO2 [API Controller](https://apim.docs.wso2.com/en/latest/install-and-setup/setup/api-controller/getting-started-with-wso2-api-controller/)
(`apictl`) exports an API as a `.zip` containing an `api.yaml`, and that file's
`data:` envelope is a shape the adapter understands.

```bash
# Export from your API-M environment (note: `export api`, not the deprecated `export-api`)
apictl export api --name OrderService --version 1.0.0 --provider platform-team --environment prod
# Feed the api.yaml, or the whole zip and name the entry:
anvil estate import OrderService.zip --vendor wso2 --entry api.yaml --api OrderService
```

Anvil reads these fields (either as a top-level `apis:` array or the single-API
`data:` envelope that `apictl` writes):

```yaml
apis:                      # or:  data:  { ...one API... }
  - name: OrderService
    context: /orders
    version: 1.0.0
    lifeCycleStatus: PUBLISHED
    securityScheme: [oauth2]
    apiThrottlingPolicy: Gold
    operations:
      - { target: /orders, verb: POST, scopes: ["orders:write"] }
    mediationPolicies:
      - { name: custom-header-sequence }
```

**What maps:** operation `scopes` → `auth.scopes`; `securityScheme` → auth
summary; `apiThrottlingPolicy` → a quota note; **`mediationPolicies` → opaque**.

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
anvil estate import apigee-estate.yaml --vendor apigee --api payments-proxy --out generated/payments
```

**What maps:** the product's `scopes` → `auth.scopes` on the proxy's operations;
`Quota` / `SpikeArrest` → quota notes; **`AssignMessage` / `JavaScript` / `XSL` /
`JSONToXML` / `XMLToJSON` → opaque**.

**Official docs:** [Download an API proxy bundle](https://docs.cloud.google.com/apigee/docs/api-platform/fundamentals/download-api-proxies) ·
[`apigeecli`](https://github.com/apigee/apigeecli) ·
[API proxy configuration reference](https://docs.cloud.google.com/apigee/docs/api-platform/reference/api-proxy-configuration-reference)

## MuleSoft

**Export:** MuleSoft splits the information across two places, so you assemble
the document from two sources — the asset itself from
[Anypoint Exchange](https://docs.mulesoft.com/exchange/), and the **applied
policies** from API Manager (list them with the
[Anypoint CLI](https://docs.mulesoft.com/anypoint-cli/latest/anypoint-platform-cli-commands):
`api-mgr:api:list`, then `api-mgr:policy:describe`). Anvil reads a normalized
asset document keyed by `assetId`:

```yaml
apis:
  - assetId: customer-api
    productVersion: v1
    instanceLabel: prod
    resources:
      - { method: GET,  path: /customers }
      - { method: POST, path: /customers, scopes: ["customers:write"] }
    policies:
      - { policyId: openidconnect }
      - { policyId: rate-limiting-sla }
      - { policyId: custom-dataweave-transform }
```

```bash
anvil estate import mulesoft-estate.yaml --vendor mulesoft --api customer-api --out generated/customer
```

**What maps:** auth policies (`openidconnect`, `jwt-validation`,
`client-id-enforcement`, `oauth2-provider`) → auth summary; `rate-limiting` /
`rate-limiting-sla` / `spike-control` → quota notes; **DataWeave and any other
custom policy → opaque**.

**Official docs:** [Anypoint Exchange](https://docs.mulesoft.com/exchange/) ·
[Anypoint CLI for API Manager](https://docs.mulesoft.com/anypoint-cli/latest/anypoint-platform-cli-commands) ·
[Exchange platform APIs](https://docs.mulesoft.com/exchange/about-platform-apis)

## IBM API Connect

**Export:** the [`apic`](https://www.ibm.com/docs/en/api-connect/software/10.0.x_cd?topic=tool-api-development-management-commands)
developer toolkit gets products and their APIs as OpenAPI YAML with an
`x-ibm-configuration` assembly — `apic apis:get` / `apic draft-apis:clone` pull
the definitions locally. Anvil reads a normalized product/API document — note
the vendor flag is `api_connect` (with an underscore):

```yaml
apis:
  - name: claims-api
    version: 2.1.0
    basePath: /claims
    oauthProviders: [corporate-oauth]
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
anvil estate import apiconnect-estate.yaml --vendor api_connect --api claims-api --out generated/claims
```

**What maps:** `oauthProviders` → OAuth2 auth; resource `scopes` →
`auth.scopes`; a plan's `rateLimit` → a quota note; **assembly actions `map` /
`gatewayscript` / `xslt` → opaque**.

**Official docs:** [API development & management commands](https://www.ibm.com/docs/en/api-connect/software/10.0.x_cd?topic=tool-api-development-management-commands) ·
[Managing API products](https://www.ibm.com/docs/en/api-connect/software/10.0.x_cd?topic=tool-managing-api-products) ·
[Developer toolkit CLI](https://github.com/ibm-apiconnect/cli)

## Feeding a ZIP or JAR

If your export is an archive, hand it to `anvil estate` directly — the hardened
[archive harness](/anvil/reference/adr/0020-offline-gateway-archive-harness/)
unpacks it, refusing path traversal, symlinks, and decompression bombs, and
reporting every rejection instead of dropping it silently. It auto-selects a
`.json` / `.yaml` / `.yml` / `.xml` entry; if the archive holds several, name
the one with the config:

```bash
anvil estate inventory export.zip --vendor wso2 --entry Definitions/api.yaml
```

The **config entry inside** the archive still has to be a shape the adapter
reads (the shapes above) — the harness makes opening the container safe, it does
not translate a native proxy-XML or JAR into a description. (`.tar`/`.gz` aren't
decoded yet; extract them, or pass the config file directly.)

## After import

An import is a normal bundle, so the normal loop applies:

```bash
anvil inspect generated/refunds     # every operation's effect, risk, idempotency
anvil approve generated/refunds <operation-id>   # expose one, after reading its risk
```

Risky operations stay `review_required` until you approve them, and opaque
policies block certification until reviewed. For a large estate, see
[operating at estate scale](/anvil/concepts/gateway-estates/#operating-at-scale) —
you inventory the whole estate cheaply, then import and approve the few APIs that
belong in an agent's hands.

## What Anvil does not do (so nothing surprises you)

- **It does not connect to your gateway** or store credentials. Exports are
  offline files you produce.
- **It does not yet parse native proxy XML, CAR, or JAR internals.** Feed a
  YAML/JSON description; Kong's `deck` dump and WSO2's `api.yaml` already qualify.
- **It does not import a whole estate at once** — one API per `import`; loop the
  command for several.
- **It does not trust an export's own "public" flag.** Every operation still
  passes the approval gate before any surface exposes it.
