# Gateway estates: Apigee, Kong, WSO2, MuleSoft, IBM API Connect

Most enterprise APIs don't live in a git repo. They live behind a gateway, and
the gateway knows things the spec doesn't: which auth plugin actually fronts an
operation, which scopes a product grants, where rate limits bite, and which
requests get rewritten in flight. Anvil assesses the **estate** described by an
accepted offline input, then adopts selected APIs through the same compiler
pipeline every other source uses. The accepted bytes are tiered: native WSO2
estate, one native Kong declarative state, or normalized interchange for
Apigee, MuleSoft, and IBM API Connect. The archive reader is not a native
translator.

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
# 0. Pin the versioned accepted-input and proof contract.
anvil estate support --json > gateway-support.json

# 0.5. Optional adapter preflight: confirm the export is readable before a full estate audit.
anvil estate connect gateway-export.yaml --vendor kong --gateway-id kong-prod --json

# 1. Inventory and audit the complete accepted input, then create a review queue.
anvil estate inventory gateway-export.yaml --vendor kong \
  --gateway-id kong-prod --summary
anvil estate audit gateway-export.yaml --vendor kong \
  --gateway-id kong-prod --json > estate-audit.json
anvil estate plan gateway-export.yaml --vendor kong \
  --gateway-id kong-prod \
  --init-selection estate-selection.yaml \
  --out estate-adoption-plan.json

# 2. After review, import one exact coordinate with its real contract and the
#    public runtime URL that must remain in the request path.
mkdir -p generated
anvil estate import gateway-export.yaml \
  --vendor kong \
  --api payments \
  --gateway-id kong-prod \
  --strict-identity \
  --revision unversioned \
  --environment unscoped \
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
| Gateway export evidence | `<workspace>/.anvil/imports/<import-id>/raw/export.bin` | Exact file/ZIP bytes; for a WSO2 directory, a deterministic envelope containing every accepted relative path and byte. |
| Bundle receipt view | `<bundle>/import.receipt.json` | Redacted pointer to the private receipt plus output-lineage status; never the authoritative receipt. |
| Runtime coordinate | `<bundle>/air.yaml` and `air.json` | The operator-attested gateway URL pinned as the service server. |

Treat `.anvil/imports` as private evidence storage: the receipt is secret-free,
but `raw/export.bin` deliberately preserves content-complete export evidence and
can therefore contain customer configuration. The bundle view uses
`$WORKSPACE` coordinates and does not publish the operator's absolute paths.

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

Vendor exports (Kong `deck` dumps, Apigee bundles, WSO2 per-API ZIPs, MuleSoft
JARs, API Connect archives) are untrusted input. `gateway/archive` (ADR-0020) is
the one ZIP/JAR decode layer every adapter shares, and it refuses anything
dangerous:

- absolute paths, `..` traversal, backslashes, NUL bytes, and symlinks are
  rejected;
- per-file, depth, count, and cumulative-expansion limits stop decompression
  bombs;
- conflicting duplicate paths are rejected;
- UTF-8 decodes with `fatal: true`, so mangled text is a typed refusal.

Every rejection is reported. Silent truncation would read as "we imported
everything" when Anvil did not.

A WSO2 apictl bulk directory is walked with the same posture: lexical,
path-bounded traversal, no symlinks or special filesystem nodes, and aggregate
file/byte/depth limits. Each nested per-API ZIP then passes the archive battery.
The resulting evidence snapshot is independent of host paths, mtimes, ownership,
and directory enumeration order.

## What each adapter maps

The five implemented adapters share the same projection interface—parse as data,
synthesize the source spec, and turn supported gateway evidence into overlay
facts. Passing `gatewayAdapterConformance` proves those projection invariants;
it does not prove native-format acceptance, fixture provenance, or estate-scale
coverage. `anvil estate support --json` is the separate release-truth registry.

| Vendor | Input tier | Contract source | Auth → contract | Quota signals | Marked opaque |
| --- | --- | --- | --- | --- | --- |
| **Kong** | native single artifact | routes × methods per service | `key-auth`, `jwt`, `openid-connect` → auth summary; OIDC → per-operation `auth.scopes` | `rate-limiting` → quota diagnostic + `hasQuota` | request/response transformers; **any unrecognized plugin** |
| **Apigee** | normalized interchange | normalized proxies / revisions / environments | product scopes → `auth.scopes` | `Quota`, `SpikeArrest` | `AssignMessage`, `JavaScript`, native XML |
| **WSO2** | native estate | `api.yaml` operations from native per-API projects | scopes + security scheme | throttling tiers | mediation/operation policies, sequences, CAR internals |
| **MuleSoft** | normalized interchange | normalized asset resources | scopes; auth/SLA policies | SLA tiers | DataWeave, flow logic, native JAR/XML |
| **IBM API Connect** | normalized interchange | normalized products / plans | OAuth providers | plan rate limits | `map`, `gatewayscript`, `xslt`, native `x-ibm-configuration` |

Each adapter also declares a **capability matrix** (`capabilityMatrix` /
`capabilityGaps`): what it supports fully, partially, or not at all, rendered as
rows so partial support is never invisible.

## How you feed it: an offline export, not a live management connection

Anvil never connects to the gateway management plane — no admin URL, no
management-API token, and no live discovery. `anvil estate` reads an offline
artifact you export: a supported document, ZIP/JAR, or native WSO2 apictl bulk
directory. The `--gateway-url` used in a production import is only the
operator-attested runtime coordinate written into generated tools; Anvil does
not call it during import.

The exact boundaries are:

- Kong's `deck` declarative config is direct input.
- WSO2's native `apictl export apis` directory, one per-API ZIP, one extracted
  per-API project, and standalone `api.yaml` are direct input.
- Apigee, MuleSoft, and IBM API Connect currently require the normalized
  documents in the import cookbook. Native proxy XML, Mule application
  XML/DataWeave, and IBM assembly packages are not decoded.

The archive harness makes *opening* a container safe. It does not translate
proxy XML, a CAR, mediation code, or a JAR into proven semantics.

For the exact document each adapter reads, plus step-by-step export instructions
per vendor (with links to each gateway's own export docs), see the
[Import a gateway estate](/anvil/cookbooks/import-a-gateway-estate/) tutorial.

### Native WSO2 collection boundary

The WSO2 bulk command is:

```bash
apictl export apis --environment production --all --force
WSO2_APIS="$HOME/.wso2apictl/exported/migration/production/tenant-default/apis"
anvil estate inventory "$WSO2_APIS" --vendor wso2 \
  --gateway-id wso2-production --summary
anvil estate audit "$WSO2_APIS" --vendor wso2 \
  --gateway-id wso2-production --json > wso2-estate-audit.json
```

That directory contains working-copy archives named
`<APIName>_<APIVersion>.zip` and revision archives named
`<APIName>_<APIVersion>_Revision-<N>.zip`. Each archive is one
`<APIName>-<APIVersion>/` project with `api.yaml`, `api_meta.yaml`, optional
`deployment_environments.yaml`, `Definitions/swagger.yaml` (or another formal
definition), and supporting members such as `Sequences/`.

Anvil never flattens those projects into an invented `apis:` document. It
normalizes each project independently and records content-addressed evidence
for the collection, the per-API container, and every accepted member. Pass the
directory to `inventory`, `audit`, `plan`, and `import`; do not use `--entry` on
the directory. Select an import with exact `--api`, `--api-version`,
`--revision`, and `--environment` axes. For WSO2, `--api-version 1.0.0`
selects the semantic `api.yaml data.version`; `--revision working-copy` selects
a project whose `data.isRevision` is not true; and `--revision revision-7`
selects a project with `data.isRevision: true` and `data.revisionId: 7`.
Contradictory or missing revision identity is a scoped blocker. A single native
per-API ZIP is also accepted directly without `--entry api.yaml`. When gateway
revision is distinct, literal semantic API version `0.0.0` remains a real
version rather than an absence sentinel.

Validated OpenAPI/Swagger candidates under `Definitions/` are located and
hashed, but none is silently chosen as compiler source. Supply the selected
candidate's exact bytes through `--spec`. Binding succeeds only when there is
one validated embedded candidate and the digest matches. Zero candidates,
multiple candidates, or a mismatch fail closed unless a legitimate external
contract is explicitly attested with
`--attest-spec-override "<reviewed reason>"`. The decision is receipt-bound and
the public receipt view redacts the reason to a digest; matching routes alone
are not byte lineage.

The collection semantic digest is computed from validated member content.
Repacking identical members changes packaging lineage, not semantic plan drift.

Native collection traversal is bounded at 100,000 filesystem and expanded
member records, 25 MiB per filesystem file, 200 MiB combined raw and expanded
bytes, and path depth 32. Each nested ZIP separately passes the normal
10,000-member, 25 MiB/member, 200 MiB-expanded, depth-32 archive battery. Anvil
rejects an over-limit collection rather than presenting a partial estate.

CAR files, sequences, and mediation implementations remain opaque. Their bytes
and locations stay in lineage, but Anvil does not claim to understand their
runtime behavior and does not let a reviewer clear them with ordinary operation
approval.

### Diagnostic ownership prevents cross-API poisoning

Gateway diagnostics carry structured ownership when the source establishes it:
an API/version/revision/environment, a content-addressed source artifact, and,
where known, a route. Audit turns those into stable API, artifact, or route
findings and folds them into only the matching API disposition and owner
workstream.

Import first rejects truly global errors, then resolves one exact coordinate
and considers only findings whose API subject and artifact lineage match that
selection. A duplicate or opaque API B therefore does not block unrelated API
A. Even if malformed WSO2 `api.yaml` prevents reading B's API id, its per-project
origin and digest retain artifact ownership so A remains importable. A failure
that occurs before any safe project boundary exists—an unsafe collection root,
rejected outer container, or unreadable aggregate document—has no narrower
owner and intentionally fails the whole load.

`estate inventory` still exits 1 when any artifact-scoped error is present,
while preserving valid rows in its output. That status says the collection
needs triage; it does not say every API failed. `estate audit` exits zero by
default while reporting its whole-estate gate; `--check` makes the gate a CI
failure.

The top-level audit gate remains a conservative summary of the entire estate:
it is `blocked` while any project has a blocker. Per-API disposition and
selection-aware import are the adoption authority, so the same plan can
correctly show a red estate summary and an unrelated clean coordinate ready for
import.

## Proof the abstraction isn't vendor-shaped

Two differential tests keep the adapters honest:

- **Kong differential** — the same logical API expressed differently (YAML vs.
  JSON, reordered plugins) yields the same effective auth scope on the same
  operation.
- **Cross-vendor differential** — the same logical API (`POST /refunds`
  requiring `refunds:write`) expressed in native Kong/WSO2 input and the
  documented normalized Apigee/MuleSoft/API Connect shapes yields the **same
  effective contract** through `compileContract`, on all five.

## Operating at scale

A production WSO2 estate can hold 1,000 APIs and multiple revisions or deployed
environments for each. Anvil does not answer that with 1,000 automatic
compilations. It separates cheap estate-wide mechanism from governed,
API-by-API adoption.

```text
1,000 APIs in one offline export
        │
        ├─ inventory → bounded/filterable operator view
        ├─ audit     → complete findings and per-coordinate disposition
        └─ plan      → versioned triage queue, owners, workstreams, drift
                              │
                              ▼ reviewed selection
                    one receipt-bound import
                              │
                              ▼
             inspect → semantic investigation → re-import
                              │
                              ▼ human capability review
             build → target/identity/ledger → proof → deploy plan
```

### Inventory is filterable; audit remains complete

`anvil estate inventory` enumerates APIs without compiling them. Its human and
JSON views can be bounded by `--query`, `--owner`, `--lifecycle`, and `--limit`;
`--all` returns every matching row and `--summary` keeps just counts and
diagnostics. These are presentation filters, not evidence suppression.

```bash
anvil estate inventory "$WSO2_APIS" --vendor wso2 \
  --lifecycle PUBLISHED --owner platform-team --limit 50
anvil estate inventory "$WSO2_APIS" --vendor wso2 \
  --query payments --json > payments-inventory-view.json
anvil estate audit "$WSO2_APIS" --vendor wso2 \
  --gateway-id wso2-production --json > complete-estate-audit.json
```

The snapshot and audit are content-addressed and order-independent. The audit
keeps every scoped finding even when the operator view is small.

### Plan the queue; do not script selection from names

`estate plan --init-selection` materializes every
API/version/revision/environment coordinate with `decision: triage` and
`semanticLane: deterministic_only`. It does not recommend APIs and refuses to
overwrite an existing selection file. Reviewers add intent, owner, contract,
gateway URL, and one of
`deterministic_only`, `agent_assisted`, or `manual_review`.

```bash
anvil estate plan "$WSO2_APIS" --vendor wso2 \
  --gateway-id wso2-production \
  --init-selection estate-selection.yaml \
  --out estate-adoption-plan.json
```

The resulting plan groups work by accountable owner and prints a complete
import template only for a selected coordinate with the required evidence. On
re-export, compare against the reviewed baseline:

```bash
anvil estate plan "$WSO2_APIS" --vendor wso2 \
  --gateway-id wso2-production \
  --baseline estate-adoption-plan.json \
  --out estate-adoption-plan.candidate.json \
  --check
```

That check detects source, API-coordinate, adapter, finding, gateway-identity,
and selection drift. It never promotes the candidate.

### Adoption and composition stay human-gated

Import one reviewed coordinate with its native contract and public gateway URL.
The default service and deployment namespace are derived from gateway, API,
optional semantic API version, gateway revision, and environment so concurrent
workstreams cannot overwrite each other.

```bash
anvil estate import "$WSO2_APIS" \
  --vendor wso2 \
  --api payments \
  --api-version 3.0.0 \
  --revision revision-4 \
  --environment Default \
  --gateway-id wso2-production \
  --strict-identity \
  --spec contracts/payments.openapi.yaml \
  --gateway-url https://api.example.com/payments \
  --root "$PWD"
```

Without `--spec`, route-derived operations remain assessment-only and blocked:
a path and method do not prove request bodies, responses, authentication, or
business intent. If the API is view/BFF-shaped, the optional coding-agent lane
can trace callers, handlers, persistence, authorization, and tests, but it can
only propose evidence. A reviewer records accepted semantics in the manifest
and re-runs the receipt-bound import.

Single-bundle capability grouping is a second loop and can build only after
human approval:

```bash
anvil capability propose <bundle>
anvil capability show <bundle> <capability-id> --operations --auth --evidence
anvil capability approve <bundle> <capability-id> --note <review-note>
anvil build <bundle> <capability-id>
```

The coding agent proposes the useful user-job boundary; Anvil deterministically
checks operation membership, workflow dependencies, identity groups, and the
tool-disclosure budget; a human approves it.

Cross-bundle `capability compose` is deliberately different:

```bash
anvil capability compose <bundle-a> <bundle-b> [bundle-c...] \
  --out composition.audit.json \
  --init-review composition.review.yaml
```

It compares verified generated bundle directories without modifying them and
writes new, exclusive audit/review artifacts. It never infers source authority
from shape, never weakens auth or safety, and never generates AIR, CLI, MCP, or
skill. A reviewed candidate remains `reviewed_plan_only`,
`generatedMcp:false`, and `buildReady:false`; the audit is not approval or build
input. Exact local evidence and review requirements are documented in
`skills/anvil/reference/composing-capabilities.md`.

For recurring estate-quality overlap sweeps across many bundles, use the harness
guide: `skills/anvil-composition-audit/SKILL.md`.

Release configuration follows only the separately approved single-bundle
build, never the `capability compose` report. It binds the environment, Gemini
Enterprise location/surface and connector IdP, upstream credentials, and
durable idempotency store before static, simulated, and live proof. The Gemini
app/engine location, Agent Gateway region, and Agent Registry region remain
distinct reviewed inputs; Gemini sign-in, connector OAuth, and upstream API
identity remain distinct trust planes.

There is no estate-wide `import --all`, no live management-plane pull, and no
agent self-approval. The APIs you never select are not half-exposed or
best-effort—they are absent from the generated agent surface. See
[ADR-0013](/anvil/reference/adr/0013-gateway-adapters-emit-snapshot-plus-overlay/)
for why inventory and per-API compilation remain separate.

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
- **CLI** — `anvil estate inventory`, `estate audit`, and `estate plan` cover the
  complete offline estate without compiling it; inventory alone has bounded
  view filters. `anvil estate import <export> --vendor <v> --api <id>
  --revision <r> --environment <e> --spec <contract> --gateway-url <url>
  --root <workspace>` locks one exact coordinate's contract and gateway
  evidence into a normal bundle. `anvil estate verify <import-id> --root
  <workspace> [--bundle <dir>]` verifies that chain. The export may be a bare
  supported document, a ZIP/JAR decoded by the hardened harness, or a native
  WSO2 apictl directory of per-API projects. Opaque policies and
  contract-fidelity blockers stay scoped and visible. tar/gzip containers are
  refused by name until their thin decoders land.
- **Deferred per-vendor depth** (recorded in ADR-0021) — Kong
  consumers/credentials/workspaces, WSO2 CAR/mediation/sequence semantics,
  native Apigee proxy bundle decoding, native MuleSoft application
  XML/DataWeave decoding, native IBM assembly decoding, and API Connect
  subscription analytics.

Once imported, a gateway estate is backtestable like any other capability — see
[Simulation & backtesting](/anvil/concepts/simulation-and-backtesting/).

Related ADRs: 0013 (snapshot + overlay), 0020 (archive harness), 0021 (vendor
adapters).
