---
title: "Prove durable idempotency for writes"
description: "Inspect every approved write, choose a shared or dedicated Firestore boundary, verify Anvil's generated contract, then use /readyz for live proof."
sidebar:
  order: 7
---

**What you'll have at the end:** an offline, machine-readable answer to “which
writes need shared state and exactly what will Terraform wire?”, plus the one
post-deployment check that proves the runtime can actually reach that store.

Anvil keeps four different claims separate:

1. **Operation semantics:** whether repeating the upstream operation is safe and
   where its idempotency key travels.
2. **Runtime deduplication:** whether all Cloud Run instances share a durable
   reservation/replay ledger.
3. **Plan identity:** whether the reviewed bundle, project, store contract, and
   non-secret ledger inputs reached the Terraform plan unchanged.
4. **Live readiness:** whether the deployed runtime identity can reach the
   provisioned database now.

A generated file can prove wiring, and a matching Terraform output can bind
that wiring to a plan. Neither proves the plan was applied. Only a live
data-plane probe can prove the reachable runtime identity can access the store.

## 1. Ask Anvil which writes need durable state

Compile the bundle, then inspect its generator-owned store contract:

```bash
anvil deploy ledger generated/payments \
  --project acme-prod-1 \
  --database bank-shared-ledger \
  --database-mode shared
```

The command is offline and read-only. It lists every approved mutation—not only
the Firestore-backed ones—and shows each operation's AIR idempotency mode, key
carrier, retry posture, and durable-store requirement. It then verifies
`deploy/idempotency-store.json` against canonical AIR and exact-compares every
compiler-owned bundle byte with a fresh deterministic projection using the
persisted generator inputs. A missing, malformed, stale, or tampered contract,
Terraform file, or runtime artifact fails instead of causing the CLI to guess
coordinates or claim fresh wiring.

Gateway-estate imports persist a coordinate-derived `deploymentNamespace`.
Cloud Run resources, Terraform state, the ledger URI namespace, and the hashed
collection group use that deployment identity while the AIR service id remains
unchanged for agents. Two environments or revisions with the same service id
therefore do not share deployment or ledger coordinates.

For the payments example, the important coordinates are:

```text
Managed store — REQUIRED
  backend: Google Cloud Firestore Native (no Firebase client SDK)
  database: bank-shared-ledger
  provisioning mode: shared
  collection group: anvil_idempotency_<deployment-namespace-hash>
  location: owned by the existing shared database
  ANVIL_LEDGER: firestore://acme-prod-1/bank-shared-ledger/payments
```

Firestore Native is Anvil's one generated production backend. “Firebase” is not
a second ledger choice here: Firebase client SDKs are not loaded by the Cloud
Run runtime. AlloyDB and Spanner can be implemented through Anvil's backend
registry, but the generated deployment does not provision or claim support for
them. They need an explicit plugin, transaction/readiness implementation, and
separately reviewed infrastructure.

:::caution
Shared mode is the estate-scale default. It uses an existing, platform-owned
database per reviewed trust/regulatory domain and consumes no additional
database quota per capability. Firestore IAM does not isolate collection
groups, so the database is the security boundary. Use `--database-mode
dedicated --location <immutable-location>` when a capability needs a separate
database IAM boundary. Google Cloud console access does not enforce database
IAM conditions; restrict console users separately.
:::

## 2. Produce external Terraform input

Write the non-secret inputs outside the compiler-owned bundle:

```bash
anvil deploy ledger generated/payments \
  --project acme-prod-1 \
  --database bank-shared-ledger \
  --database-mode shared \
  --ttl-seconds 604800 \
  --tfvars > /EXTERNAL_TF_WORK/ledger.auto.tfvars.json
```

Merge that JSON with the other reviewed operator inputs *before* creating
`tfplan`. Do not add or change variables at apply time.

The ledger tfvars contain `anvil_expected_project_id` rather than
`project_id`. Submit the build to that project explicitly:

```bash
gcloud builds submit --project acme-prod-1 \
  --config generated/payments/deploy/cloudbuild.yaml \
  --substitutions _TFVARS_URI=gs://PRIVATE_INPUT_BUCKET/operator.auto.tfvars.json
```

Cloud Build's `$PROJECT_ID` remains Terraform's one actual deployment project.
Terraform fails the plan if it differs from `anvil_expected_project_id`; a
command-line variable cannot silently move the ledger to another project.

The emitted `anvil_ledger_input_digest` binds the bundle hash, deployed-runtime
hash, store-contract hash, expected project, database, mode, location,
namespace, and retention. Terraform recomputes the digest and emits the same
identities and coordinates as the planned `idempotency_store` output. Archive
the tfvars, rendered plan, and that output together, then compare them with
`anvil deploy ledger --json`.

:::caution
A matching digest and `idempotency_store` output are **plan evidence, not an
apply receipt**. They do not prove any cloud resource changed.
:::

The generated Terraform:

- in shared mode, references the exact existing database without creating or
  importing that platform singleton; in dedicated mode, creates a named
  database with delete protection, `prevent_destroy`, and
  `deletion_policy = "ABANDON"`;
- configures TTL on completed records' `expires_at` field and disables the
  unused single-field index; both field-policy resources also use
  `deletion_policy = "ABANDON"`;
- grants the runtime service account `roles/datastore.user`, conditionally
  scoped to that database;
- sets `ANVIL_LEDGER` and the completed-result retention window on Cloud Run;
- makes Cloud Run depend on the ledger IAM and TTL resources;
- refuses any `var.env` or `credential_secret_refs` key that shadows a
  compiler-owned setting such as `ANVIL_ENV`, `ANVIL_LEDGER`, the host
  allowlist, or timeout/retention controls; and
- refuses the same environment name appearing in both external maps. These are
  hard plan failures, never filtering or last-write-wins behavior.

Completed results can contain application response data. Choose the shortest
retention that covers the real client retry/reconciliation window. Provider TTL
deletion is asynchronous, so the runtime also checks logical expiry before
replay. In-progress reservations deliberately have no TTL: elapsed time cannot
prove that an upstream mutation stopped. The generated contract also exposes an
819,200-byte serialized replay-result ceiling. A larger successful response
leaves the row in progress for the same deliberate reconciliation path instead
of discarding the reservation after the upstream may have committed.

### Removing and later reintroducing the ledger

When a later AIR revision removes the last approved operation that requires the
ledger, its reviewed Terraform plan detaches `ANVIL_LEDGER`, the runtime IAM
binding, and the resource dependencies. Applying that plan removes the
capability-owned resources from Terraform state but **abandons rather than
deletes** the TTL policy and index exemption. A dedicated database is also
abandoned; a shared database remains in the platform's state. Replay evidence
and its retention behavior therefore remain intact.

If a later revision requires the ledger again, do not apply a create plan over
those preserved resources. Import both field policies into initialized
capability state; in dedicated mode, also import the database:

```bash
# Dedicated mode only:
terraform -chdir="$TF_WORK" import 'google_firestore_database.ledger[0]' \
  "projects/$PROJECT_ID/databases/$DATABASE"
# Shared and dedicated modes:
terraform -chdir="$TF_WORK" import google_firestore_field.ledger_no_single_field_indexes \
  "projects/$PROJECT_ID/databases/$DATABASE/collectionGroups/$COLLECTION_GROUP/fields/*"
terraform -chdir="$TF_WORK" import google_firestore_field.ledger_result_expiry \
  "projects/$PROJECT_ID/databases/$DATABASE/collectionGroups/$COLLECTION_GROUP/fields/expires_at"
```

Use coordinates from `anvil deploy ledger`; never reconstruct the hashed
collection group by hand.

This hermetic example checks the complete offline path without contacting GCP:

```bash
# [docs-tested]
WORK=$(mktemp -d)
node packages/cli/dist/bin-anvil.js compile examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml --service payments \
  --out "$WORK/payments" --root "$WORK"
node packages/cli/dist/bin-anvil.js deploy ledger "$WORK/payments" \
  --project acme-prod-1 --database bank-shared-ledger \
  --database-mode shared --ttl-seconds 3600 --json \
  > "$WORK/ledger-report.json"
node -e '
  const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (report.contract.state !== "fresh") process.exit(1);
  if (report.store.runtimeUri !== "firestore://acme-prod-1/bank-shared-ledger/payments") process.exit(1);
  if (report.store.provisioningMode !== "shared") process.exit(1);
  if (report.deploymentInput.state !== "bound") process.exit(1);
  if (!/^[a-f0-9]{64}$/.test(report.deploymentInput.digest)) process.exit(1);
  if (report.liveReadiness.state !== "unverified") process.exit(1);
  if (report.cloudCallsMade !== false) process.exit(1);
' "$WORK/ledger-report.json"
node packages/cli/dist/bin-anvil.js deploy ledger "$WORK/payments" \
  --project acme-prod-1 --database bank-shared-ledger \
  --database-mode shared --ttl-seconds 3600 --tfvars \
  > "$WORK/ledger.auto.tfvars.json"
grep -q '"ledger_database_mode": "shared"' "$WORK/ledger.auto.tfvars.json"
grep -q '"ledger_database_id": "bank-shared-ledger"' "$WORK/ledger.auto.tfvars.json"
grep -q '"anvil_expected_project_id": "acme-prod-1"' "$WORK/ledger.auto.tfvars.json"
grep -Eq '"anvil_ledger_input_digest": "[a-f0-9]{64}"' "$WORK/ledger.auto.tfvars.json"
rm -rf "$WORK"
```

## 3. Require live readiness after apply

Static status is intentionally honest:

```text
Static wiring — FRESH
Live readiness — UNVERIFIED
```

“Fresh” covers the store contract and exact compiler-owned generated bytes. A
matching planned `idempotency_store` output additionally binds the reviewed
inputs to that plan. Neither says Terraform was applied or that the deployed
identity can reach Firestore.

After applying the exact reviewed plan and obtaining an authorized network path
to the service, run:

```bash
curl --fail --silent --show-error "$ANVIL_SERVICE_URL/readyz"
```

Require HTTP 200 and:

```json
{ "ready": true, "service": "payments" }
```

`/readyz` performs a field-masked, non-mutating Firestore data-plane lookup
using the runtime identity. It returns 503 when the database is missing,
inaccessible, or unavailable. `/healthz` only proves the process is alive; it
is not ledger proof. A Cloud Run ingress/IAM 401 or 403 means the probe did not
reach the runtime and says nothing about Firestore.

This is a **store gate**, not an identity or write-semantics gate. It does not
prove issuer/audience validation, delegated/OBO token exchange, the upstream
credential carrier, or that the upstream honors its idempotency key. For
delegated identity, require an explicitly opted-in live **read** through
`anvil conformance <bundle> --live <config.json>` and a passing
`identity-live` gate. Discovery, JWKS reachability, tool listing, and `/readyz`
do not upgrade that claim.

Anvil conformance never drives a live mutation. Before enabling a write, require
fresh `certify`, `selftest`, `conformance`, and `simulation` evidence for the
same bundle digest; a fresh store contract; `/readyz` HTTP 200; and an
operator-reviewed upstream idempotency carrier. Exercise `anvil run ... --dry-run`
first. Any real canary write remains subject to the normal approval and
confirmation gates plus the estate owner's test-data, rollback, and upstream
audit policy.

## 4. Reconcile a retained reservation

An `in_progress` refusal or an uncertain post-response failure includes a
sanitized locator:

```json
{
  "details": {
    "operator_action_required": true,
    "ledger_reference": "firestore/anvil_idempotency_ab12cd34ef56ab78/7e6d..."
  }
}
```

The reference contains only the generated collection group and a SHA-256
document id. It never contains the caller key, identity, project, database, or
credentials. Take the project, database, and expected collection from a fresh
`anvil deploy ledger --json` report. Reject any locator that does not have the
exact generated shape or collection before making a cloud request:

```bash
BUNDLE=generated/payments
PROJECT_ID=acme-prod-1
DATABASE=bank-shared-ledger
LEDGER_REPORT=$(mktemp)
node packages/cli/dist/bin-anvil.js deploy ledger "$BUNDLE" \
  --project "$PROJECT_ID" --database "$DATABASE" --json > "$LEDGER_REPORT"
jq -e '.contract.state == "fresh" and .contract.backend == "firestore"' \
  "$LEDGER_REPORT" >/dev/null
test "$(jq -er '.store.databaseId' "$LEDGER_REPORT")" = "$DATABASE"
EXPECTED_COLLECTION=$(jq -er '.store.collectionGroup' "$LEDGER_REPORT")

LEDGER_REFERENCE='firestore/anvil_idempotency_ab12cd34ef56ab78/7e6d0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab'
[[ "$LEDGER_REFERENCE" =~ ^firestore/anvil_idempotency_[a-f0-9]{16}/[a-f0-9]{64}$ ]]
DOCUMENT_PATH=${LEDGER_REFERENCE#firestore/}
REFERENCE_COLLECTION=${DOCUMENT_PATH%%/*}
test "$REFERENCE_COLLECTION" = "$EXPECTED_COLLECTION"
DOC_URL="https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases/$DATABASE/documents/$DOCUMENT_PATH"
ACCESS_TOKEN=$(gcloud auth print-access-token)

curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --url-query "mask.fieldPaths=status" \
  --url-query "mask.fieldPaths=fingerprint" \
  --url-query "mask.fieldPaths=operation_id" \
  --url-query "mask.fieldPaths=trace_id" \
  --url-query "mask.fieldPaths=started_at" \
  --url-query "mask.fieldPaths=response_status" \
  --url-query "mask.fieldPaths=expires_at" \
  "$DOC_URL" > ledger-row.json

STATUS=$(jq -er '.fields.status.stringValue' ledger-row.json)
EXPECTED_FINGERPRINT=$(jq -er '.fields.fingerprint.stringValue' ledger-row.json)
test "$STATUS" = in_progress
```

Correlate `operation_id`, `trace_id`, and `started_at` with the upstream's
authoritative state and audit trail. Stop immediately if the row is completed,
missing, malformed, or has an unexpected fingerprint. Then choose exactly one
reviewed outcome:

- **Proven not committed:** conditionally delete the still-current reservation,
  after which the original key may be retried.
- **Proven committed with the exact response/status:** conditionally change the
  row to `completed`, preserving its fingerprint and storing the reviewed replay
  result and expiry.
- **Unknown:** do nothing. The reservation remains quarantined; elapsed time is
  never treated as proof.

Every resolution must re-read the row immediately, prove it is still the same
`in_progress` reservation, and use that read's `updateTime` as a precondition.
For example, only after proving the upstream did **not** commit:

```bash
curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --url-query "mask.fieldPaths=status" \
  --url-query "mask.fieldPaths=fingerprint" \
  "$DOC_URL" > ledger-row.current.json

test "$(jq -er '.fields.status.stringValue' ledger-row.current.json)" = in_progress
test "$(jq -er '.fields.fingerprint.stringValue' ledger-row.current.json)" \
  = "$EXPECTED_FINGERPRINT"
UPDATE_TIME=$(jq -er '.updateTime' ledger-row.current.json)
curl --fail-with-body --silent --show-error \
  --request DELETE \
  --header "Authorization: Bearer $ACCESS_TOKEN" \
  --url-query "currentDocument.updateTime=$UPDATE_TIME" \
  "$DOC_URL"
```

Completing a committed row must apply the same fresh-read checks for the exact
generated reference, `in_progress` status, expected fingerprint, and
`updateTime`. It is then a conditional Firestore `PATCH` over
`status`, `fingerprint`, `result_json`, `response_status`, `expires_at`, and
`reservation_id` (the omitted reservation field is cleared). The response body
must be stored as a JSON string exactly as the runtime would replay it. Keep
that higher-risk repair in reviewed incident tooling rather than pasting an
unverified payload into a generic command. A failed precondition means another
actor changed the row: stop and re-read it.

`anvil deploy ledger` itself remains offline and read-only. It prints
coordinates and proof boundaries; it never performs reconciliation or hides a
cloud mutation behind an inspection command.

## 5. Know the guarantee boundary

| Event | What Anvil does |
| --- | --- |
| First key + request | Atomically reserves a hashed ledger document before the upstream call. |
| Same key + same request after completion | Returns the stored result until logical expiry. |
| Same key + different request | Refuses with a conflict. |
| Concurrent same-key request | Refuses as `in_progress`; it does not execute a second mutation. |
| Upstream succeeds, runtime crashes before completion | Leaves `in_progress` for deliberate operator reconciliation; it never guesses that retrying is safe. |
| Successful response exceeds 819,200 serialized bytes | Leaves `in_progress` for reconciliation because one Firestore document cannot safely cache the replay result. |
| Completed record reaches retention limit | Replay protection for that record ends; provider deletion may happen later. |

This is durable deduplication, **not an exactly-once claim**. The document key is
scoped to the generated service/environment/upstream credential-profile
namespace. When inbound identity is verified, the request fingerprint
separately binds that principal, so two callers reusing one raw key conflict
before the upstream rather than receiving one another's cached response.
Without verified inbound identity, the key is a shared operation coordinate.
Requests sent directly to the upstream—or through a differently scoped
service—remain outside Anvil's ledger.

Production execution is bounded as well: AIR allows at most five attempts and
20 seconds of backoff, the configured per-attempt upstream deadline is at most
30 seconds, and generated Cloud Run services use a 600-second request deadline.
The maximum upstream/retry segment is 230 seconds; the generated deadline also
budgets the bounded worst-case Firestore reservation and completion/readback
path, then retains more than 100 seconds for credential acquisition, hooks,
serialization, and response delivery.

AIR's `required` mode also does not by itself mean the human must always type
`--idempotency-key`. Check `keyDerivation`:

- `client_supplied` or `none`: the flag/input is required.
- `request_fingerprint`: Anvil can derive a deterministic key; an explicit key
  remains recommended for audit and cross-attempt correlation.

Explicit keys must be 1–255 visible ASCII bytes with no spaces or control
characters. The generated CLI schema, `validate-input`, MCP input schema, and
runtime enforce the same portable carrier contract.

Use the generated CLI's `--policy` view for the exact required flags:

```bash
anvil run generated/payments refunds create --policy
```
