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

## The production import journey

A gateway route table is not an API contract. For an agent-ready import, give
Anvil both sources of truth:

- the **gateway export**, which supplies the selected API's routes and deployed
  policy; and
- the original **OpenAPI or Swagger specification**, which supplies the request,
  response, and authentication contract.
- an optional **Anvil manifest**, which supplies reviewed idempotency,
  confirmation, retry, naming, workflow, and approval evidence that neither
  source can express.

```bash
# 1. Find the one API to adopt.
anvil estate inventory gateway-export.zip --vendor kong --json

# 2. Import it with its real contract and the public runtime URL that must remain
#    in the request path. Keep source and receipt state under one explicit root.
mkdir -p generated
anvil estate import gateway-export.zip \
  --vendor kong \
  --api payments \
  --spec specs/payments.swagger.yaml \
  --manifest specs/payments.anvil.yaml \
  --gateway-url https://api.example.com/payments \
  --root "$PWD" \
  --out generated/payments \
  --json > generated/payments.import.json

# 3. Use the content-derived id printed in the JSON report to verify every input
#    and the receipt-scoped output from any working directory.
IMPORT_ID="$(
  node -e 'const r=require("./generated/payments.import.json"); process.stdout.write(r.receipt.importId)'
)"
anvil estate verify "$IMPORT_ID" \
  --root "$PWD" \
  --bundle generated/payments

# 4. Only then inspect the operation-level safety posture.
anvil inspect generated/payments
anvil lint generated/payments
```

`--gateway-url` is not a management connection. It is an operator attestation of
the credential-free public HTTPS base URL through which generated calls must
travel. It is mandatory with `--spec`, rejects embedded credentials, query
strings, and fragments, and replaces the contract's server list so tools cannot
silently bypass the gateway.

Before compilation, Anvil compares the full normalized method/path multiset in
the selected gateway API with the supplied contract. Missing, extra, duplicate,
or ambiguous routes block every supplied operation. Gateway policies are then
retargeted by that method/path identity, not by coincidentally matching
`operationId` text.

`--manifest` is applied in that same compile, after the source is locked and
alongside the gateway policy overlay. This avoids modifying the bundle after
import—and immediately making its receipt lineage stale—just to add reviewed
operation semantics.

Capability review can be receipt-bound in the same way. Use the exact id printed
by `anvil capability list <bundle>` (not a display name or suffix):

```yaml
capabilities:
  payments.refunds:
    state: approved
    note: Reviewed against the locked contract and gateway evidence.
```

Anvil applies these decisions only after deterministic capability discovery and
authored workflow attachment. The budget therefore counts the real disclosed
surface: direct members plus every workflow dependency, whether or not that
dependency is approved yet. More than 20 tools requires both `allow_large: true`
and a non-empty `note`; the waiver is retained as a warning in AIR and bound,
together with the canonical parsed-manifest digest, into the immutable import
receipt. Unknown ids and unwaived budgets fail before any output or receipt is
created.

### Where the Swagger, export, and proof live

With `--root <workspace>`, the durable evidence layout is:

| Artifact | Location | Purpose |
| --- | --- | --- |
| Locked OpenAPI/Swagger | `<workspace>/.anvil/sources/<snapshot-id>/raw/<entrypoint>` | Exact content-addressed compiler source; the import report prints the snapshot id, entrypoint, hash, and directory. |
| Private import receipt | `<workspace>/.anvil/imports/<import-id>/import.receipt.json` | Immutable binding of export digest, inventory, contract provenance, overlays, blockers, and output manifest. |
| Original gateway export | `<workspace>/.anvil/imports/<import-id>/raw/export.bin` | Exact original bytes, including the outer ZIP when one was supplied. |
| Bundle receipt view | `<bundle>/import.receipt.json` | Redacted pointer to the private receipt plus output-lineage status; never the authoritative receipt. |
| Runtime coordinate | `<bundle>/air.yaml` and `air.json` | The operator-attested gateway URL pinned as the service server. |

Treat `.anvil/imports` as private evidence storage: the receipt is secret-free,
but `raw/export.bin` deliberately preserves the exact export and can therefore
contain customer configuration. The bundle view uses `$WORKSPACE` coordinates
and does not publish the operator's absolute paths.

`anvil estate verify <id> --root <workspace>` checks the immutable receipt,
stored export, and locked source. Add `--bundle <dir>` to check every
receipt-scoped output byte, the exact file set, and the redacted receipt view.
Re-running the same import is content-idempotent: it reuses the same receipt
without rewriting it.

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
Anvil can't fully read. Each opaque policy is cited by its exact location and
the immutable import receipt carries it as a blocker. Certification fails the
`contract.gateway-blockers-resolved` check rather than quietly dropping it.

The reasoning is simple: a gateway that rewrites requests in flight has a
contract the spec alone can't state. Anvil won't pretend otherwise.

There is deliberately no generic “reviewed, continue anyway” flag. Resolve the
blocker by replacing or removing the opaque policy and re-exporting, or by
adding deterministic support for that policy to the vendor adapter and
re-importing. An operation approval cannot clear an estate-level policy blocker.

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

## How you feed it: an offline export, not a live management connection

Anvil never connects to the gateway management plane — no admin URL, no
management-API token, and no live discovery. `anvil estate` reads a **file** you
export (a config document, or a ZIP/JAR the archive harness unpacks) and parses
it offline. The `--gateway-url` used in a production import is only the
operator-attested runtime coordinate written into generated tools; Anvil does
not call it during import.

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
  triage with jq → pick the handful that matter and locate their real specs
        │
        ▼  anvil estate import --api <id> --spec <contract> --gateway-url <url>
  each import → a normal bundle, contract + gateway evidence locked together
        │
        ▼  anvil inspect / lint / verify
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
faithful mirror of an 800-API estate. Each production import also needs that
API's native contract and public gateway URL:

```bash
anvil estate import prod-estate.zip \
  --vendor wso2 \
  --api payments \
  --spec contracts/payments.openapi.yaml \
  --gateway-url https://api.example.com/payments \
  --root "$PWD" \
  --out generated/payments
```

Without `--spec`, Anvil can still synthesize an OpenAPI-shaped route inventory
for assessment, but every operation is `blocked`: a path and method do not prove
request bodies, responses, authentication, or runtime routing. The CLI prints
the recovery command. To keep native-contract review tractable, Anvil groups
operations into **capabilities** by tag or resource and enforces a
tool-disclosure budget: a capability of 5–15 tools is the sweet spot, and one
that floods past 20 is blocked until you split it (`--allow-large` to override).
So you never face 800 undifferentiated operations.

> **The net shape:** inventory scales to the whole estate; compilation, review,
> and approval stay granular. Of 800 APIs, the 795 you never import aren't
> half-exposed or best-effort — they're simply not there. That absence *is* the
> safety property.

What does *not* yet exist, and shouldn't be assumed: batch or `--all` import,
CLI-side filtering of the inventory (use `--json` + `jq`), and a live pull from a
management API (the adapters read offline exports). See
[ADR-0013](/anvil/reference/adr/0013-gateway-adapters-emit-snapshot-plus-overlay/)
for why inventory and per-API compilation are separated by design.

## Receipt lineage after import

The receipt proves the exact import boundary; it does not pretend that later
intentional mutations are the same output.

- A bound re-import verifies the old receipt before replacement and preserves
  recognized lifecycle records (`certification.json`, `publication.json`, and
  top-level `*.report.json`). A Gemini Enterprise target is preserved only when
  it regenerates exactly from its persisted setup and the candidate AIR.
  Unknown files and missing, extra, or changed target files stop replacement.
- `anvil approve` changes compiler projections, so it marks the bundled receipt
  view `stale` and records the complete derived-state manifest. `estate verify
  --bundle`, `status`, and `certify` then fail visibly. Editing the view back to
  `bound` does not work because the recorded hashes still disagree.
- Re-import without a flag refuses a stale derived state. `--replace-derived` is
  an explicit reset, not a merge: it first verifies every recorded derived byte,
  then discards the old derived state and later recognized lifecycle artifacts.
  Put the reviewed operation and capability decisions in `--manifest` on that
  re-import to mint a new immutable receipt whose initial output is already
  approved and bound.

That last operation does **not** infer or copy approvals from the stale bundle:
only declarations in the supplied manifest survive the reset. A failed staged
install leaves the prior bundle and its old private receipt intact; a successful
reviewed re-import creates a new content-derived receipt rather than rewriting
the old one. If only old-backup cleanup fails after a successful swap, the
command reports success and tells you where the retained backup is.

## Using it today, honestly

- **Library** — every adapter is exported from `@anvil/compiler`'s gateway module
  (`KongGatewayAdapter`, `ApigeeGatewayAdapter`, `Wso2GatewayAdapter`,
  `MulesoftGatewayAdapter`, `ApiConnectGatewayAdapter`) alongside the archive
  harness, conformance battery, and capability matrix. `GatewayApiImport` feeds
  `compileContract` directly, and the result is a normal bundle — CLI, MCP, skill,
  hooks, simulator, and certification all apply.
- **CLI** — `anvil estate inventory <export> --vendor <v>` lists an estate's APIs
  without compiling anything, and `anvil estate import <export> --vendor <v>
  [--api <id>] --spec <contract> --gateway-url <url> --root <workspace>` locks a
  native contract and gateway evidence into one normal bundle. `anvil estate
  verify <import-id> --root <workspace> [--bundle <dir>]` verifies that chain.
  The export may be a bare config document or a ZIP/JAR archive, which is decoded
  through the hardened harness (rejections printed, never silent) with the real
  fflate backend. Opaque policies and contract-fidelity blockers are surfaced in
  the import summary. tar/gzip containers are refused by name until their thin
  decoders land.
- **Deferred per-vendor depth** (recorded in ADR-0021) — Kong
  consumers/credentials/workspaces, WSO2 mediation-sequence semantics, MuleSoft
  Exchange metadata and client apps, and API Connect subscription analytics.

Once imported, a gateway estate is backtestable like any other capability — see
[Simulation & backtesting](/anvil/concepts/simulation-and-backtesting/).

Related ADRs: 0013 (snapshot + overlay), 0020 (archive harness), 0021 (vendor
adapters).
