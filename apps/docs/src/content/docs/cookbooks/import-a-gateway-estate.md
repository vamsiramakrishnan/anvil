---
title: "Import a gateway estate"
description: "Import the APIs behind your gateway from an offline export you produce — Apigee, Kong, WSO2, MuleSoft, or IBM API Connect — never a live connection."
sidebar:
  order: 3
---

This guide produces a verified bundle from an offline gateway export. The
bundle binds three facts: the API contract, the gateway evidence, and the
public runtime URL.

Use this sequence:

1. Check the vendor boundary with `anvil estate support`.
2. Inventory the export.
3. For an estate-scale rollout, audit the evidence and prepare an adoption
   plan.
4. Import one selected gateway coordinate.
5. Verify the receipt before approval or release.

Anvil never connects to the gateway management plane.

## Does Anvil connect to the gateway?

No. `anvil estate` reads an artifact on disk: a configuration document, a
supported ZIP or JAR, or a native WSO2 `apictl` collection directory. The
adapters hold no credentials and open no network connections.

The import requires three inputs. A reviewed Anvil manifest is optional.

1. **Export** your APIs from the gateway, using the gateway's own tooling, to an
   offline artifact.
2. **Locate the original OpenAPI/Swagger** for the one API you want to adopt.
3. **Attest the public HTTPS gateway URL** that generated calls must traverse.
   This runtime URL is written into the bundle; Anvil does not call it during
   import.
4. Optionally provide an **Anvil manifest** with reviewed idempotency,
   confirmation, retry, naming, workflow, and approval evidence.

Prepare the offline evidence with [the vendor input guide](/anvil/cookbooks/prepare-a-gateway-export/).
This page covers inventory, import, receipt verification, and release.

## Try it now — no gateway required

This example writes a small Kong export and its API contract, inventories the
export, imports one API, and verifies the receipt. The runtime URL is an
attestation only. No account or network connection is used.

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

For a real gateway, use the export shape and command in [the vendor input
guide](/anvil/cookbooks/prepare-a-gateway-export/). Every executable import
still requires `--spec`, `--gateway-url`, and `--root`. Add
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
