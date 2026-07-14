# Gateway estates: Apigee, Kong, WSO2, MuleSoft, IBM API Connect

Most enterprise APIs don't live in a git repo. They live behind a gateway, and
the gateway knows things the spec doesn't: which auth plugin actually fronts an
operation, which scopes a product grants, where rate limits bite, and which
requests get rewritten in flight. So Anvil imports the whole **estate** — a
gateway's catalog of APIs, plus the gateway settings around them — not just the
spec. Five vendor adapters convert gateway exports into the same compiler
pipeline every other source uses.

> **What "estate" means here:** everything one gateway export describes — the
> APIs, their auth, their quotas, and the policies wrapped around them.

## One rule: no vendor detail escapes

Each adapter emits exactly one thing — `GatewayApiImport { source, overlay }`
(ADR-0013) — and the pipeline (`compileContract`) consumes it like any other
spec plus extra facts. Two parts:

- **`source`** — a synthesized OpenAPI document. Gateways declare routes, not
  formal contracts, so a shared `synth.ts` builds the minimal spec with stable
  operation ids.
- **`overlay`** — a layer of extra facts added on top of that spec: auth schemes
  resolved to `auth.scopes` restrictions, quotas, and — most importantly —
  **opaque policies**.

### Opaque policies: the honesty mechanism

A request-transformer, a DataWeave script, a `gatewayscript` assembly step —
anything the adapter can't *prove* it understands is marked **opaque**: a policy
Anvil can't fully read, so it flags it for a human. Each opaque policy is cited
by its exact location and **blocks automatic certification** — a signed check
that the bundle is safe to ship — rather than being quietly dropped.

The reasoning is simple: a gateway that rewrites requests in flight has a
contract the spec alone can't state. Anvil won't pretend otherwise.

## Before any adapter reads a byte: the archive harness

Vendor exports (Kong `deck` dumps, Apigee bundles, WSO2 CAR/ZIPs, MuleSoft JARs,
API Connect archives) are untrusted archives. `gateway/archive` (ADR-0020) is the
one decode layer every adapter shares, and it refuses anything dangerous:

- absolute paths, `..` traversal, backslashes, NUL bytes, and symlinks are
  rejected;
- per-file, depth, count, and cumulative-expansion limits stop decompression
  bombs;
- conflicting duplicate paths are rejected;
- UTF-8 decodes with `fatal: true`, so mangled text is a typed refusal.

Every rejection is reported. Silent truncation would read as "we imported
everything" when Anvil did not.

## What each adapter maps

All five adapters share the same shape — parse as data (never throw), synthesize
the source spec, and turn gateway policy into overlay facts — and all five pass
the same `gatewayAdapterConformance` battery.

| Vendor | Contract source | Auth → contract | Quota signals | Marked opaque |
| --- | --- | --- | --- | --- |
| **Kong** | routes × methods per service | `key-auth`, `jwt`, `openid-connect` → auth summary; OIDC → per-operation `auth.scopes` | `rate-limiting` → quota diagnostic + `hasQuota` | request/response transformers; **any unrecognized plugin** |
| **Apigee** | proxies / revisions / environments | product scopes → `auth.scopes` | `Quota`, `SpikeArrest` | `AssignMessage`, `JavaScript` policies |
| **WSO2** | API definition operations | scopes + security scheme | throttling tiers | mediation sequences |
| **MuleSoft** | asset resources | scopes; auth/SLA policies | SLA tiers | DataWeave and flow logic |
| **IBM API Connect** | products / plans | OAuth providers | plan rate limits | `map`, `gatewayscript`, `xslt` assembly actions |

Each adapter also declares a **capability matrix** (`capabilityMatrix` /
`capabilityGaps`): what it supports fully, partially, or not at all, rendered as
rows so partial support is never invisible.

## How you feed it: an offline export, not a live connection

Anvil never connects to your gateway — no URL, no management-API token, no live
discovery. `anvil estate` reads a **file** you export (a config document, or a
ZIP/JAR the archive harness unpacks) and parses it offline.

What the adapter reads is a YAML/JSON *description* of the estate, not the
vendor's raw binary:

- Kong's `deck` dump and WSO2's `apictl` `api.yaml` are already in the shape the
  adapter expects.
- For Apigee, MuleSoft, and IBM API Connect, you flatten the vendor's export into
  that shape first.

The archive harness makes *opening* a container safe. It does not translate proxy
XML, a CAR, or a JAR into a description — that's on you.

For the exact document each adapter reads, plus step-by-step export instructions
per vendor (with links to each gateway's own export docs), see the
[Import a gateway estate](/anvil/cookbooks/import-a-gateway-estate/) tutorial.

## Proof the abstraction isn't vendor-shaped

Two differential tests keep the adapters honest:

- **Kong differential** — the same logical API expressed differently (YAML vs.
  JSON, reordered plugins) yields the same effective auth scope on the same
  operation.
- **Cross-vendor differential** — the same logical API (`POST /refunds` requiring
  `refunds:write`) expressed in *each* vendor's native format yields the **same
  effective contract** through `compileContract`, on all five.

## Operating at scale

A production Apigee or WSO2 estate can hold 800 APIs. Anvil's answer is not to
compile all 800. It's to make the estate **cheap to assess** and **deliberate to
adopt** — two different problems, scaled differently.

```
  800 APIs in the export
        │
        ▼  anvil estate inventory   (whole estate, no compiling)
  triage with jq → pick the handful that matter
        │
        ▼  anvil estate import --api <id>   (one at a time)
  each import → a normal bundle, operations held for review
        │
        ▼  anvil approve   (after reading each operation's risk)
  the agent sees a few coherent capabilities
```

### Assessment is whole-estate and cheap

`anvil estate inventory` enumerates every API in the export — id, name, route
count, auth summary, lifecycle, owner, quota — *without compiling any of them*.
The snapshot is content-addressed and order-independent: re-inventorying an
unchanged estate yields the same digest, so it drops cleanly into CI as a
baseline. Look before you compile.

```bash
# The whole estate, as structured data — then triage with the tools you have
anvil estate inventory prod-estate.zip --vendor wso2 --json \
  | jq -r '.apis[] | select(.lifecycle=="PUBLISHED" and .hasQuota) | .id'
```

### Adoption is per-API and human-gated

You import the APIs you chose, one at a time; `--api` names a single id. There is
no `--all`, and that's the point: at scale the goal is *fewer* agent tools, not a
faithful mirror of an 800-API estate. To onboard the handful that matter, loop
the import over the ids you triaged:

```bash
for api in payments refunds payouts; do
  anvil estate import prod-estate.zip --vendor wso2 --api "$api" \
    --out "generated/$api"
done
```

Each import produces an ordinary bundle whose operations land `review_required`
(held for review) until a human approves them. To keep that review tractable,
Anvil groups operations into **capabilities** by tag or resource and enforces a
tool-disclosure budget: a capability of 5–15 tools is the sweet spot, and one
that floods past 20 is blocked until you split it (`--allow-large` to override).
So you never face 800 undifferentiated operations — you review coherent,
right-sized capabilities, and expose operations through `anvil approve` only
after reading their risk.

> **The net shape:** inventory scales to the whole estate; compilation, review,
> and approval stay granular. Of 800 APIs, the 795 you never import aren't
> half-exposed or best-effort — they're simply not there. That absence *is* the
> safety property.

What does *not* yet exist, and shouldn't be assumed: batch or `--all` import,
CLI-side filtering of the inventory (use `--json` + `jq`), and a live pull from a
management API (the adapters read offline exports). See
[ADR-0013](/anvil/reference/adr/0013-gateway-adapters-emit-snapshot-plus-overlay/)
for why inventory and per-API compilation are separated by design.

## Using it today, honestly

- **Library** — every adapter is exported from `@anvil/compiler`'s gateway module
  (`KongGatewayAdapter`, `ApigeeGatewayAdapter`, `Wso2GatewayAdapter`,
  `MulesoftGatewayAdapter`, `ApiConnectGatewayAdapter`) alongside the archive
  harness, conformance battery, and capability matrix. `GatewayApiImport` feeds
  `compileContract` directly, and the result is a normal bundle — CLI, MCP, skill,
  hooks, simulator, and certification all apply.
- **CLI** — `anvil estate inventory <export> --vendor <v>` lists an estate's APIs
  without compiling anything, and `anvil estate import <export> --vendor <v>
  [--api <id>]` compiles one API into a normal bundle. The export may be a bare
  config document or a ZIP/JAR archive, which is decoded through the hardened
  harness (rejections printed, never silent) with the real fflate backend. Opaque
  policies are surfaced in the import summary. Separately, `anvil source add
  --origin <vendor>` records gateway provenance on locked snapshots. tar/gzip
  containers are refused by name until their thin decoders land.
- **Deferred per-vendor depth** (recorded in ADR-0021) — Kong
  consumers/credentials/workspaces, WSO2 mediation-sequence semantics, MuleSoft
  Exchange metadata and client apps, and API Connect subscription analytics.

Once imported, a gateway estate is backtestable like any other capability — see
[Simulation & backtesting](/anvil/concepts/simulation-and-backtesting/).

Related ADRs: 0013 (snapshot + overlay), 0020 (archive harness), 0021 (vendor
adapters).
