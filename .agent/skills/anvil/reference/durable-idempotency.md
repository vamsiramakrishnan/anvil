---
name: anvil-durable-idempotency
description: Inspect and prove the durable idempotency store for approved writes without confusing generated wiring with live readiness or exactly-once execution.
---

# Durable idempotency for writes

Use the generated store contract; never invent a database or collection name:

```bash
anvil deploy ledger <bundle> \
  --project <project-id> \
  --database <existing-trust-domain-database>
```

This command is read-only and offline. It lists every approved mutation and its
AIR idempotency/key/retry posture, parses
`<bundle>/deploy/idempotency-store.json`, and accepts its coordinates only when
the contract exactly matches canonical AIR **and every compiler-owned bundle
byte matches a fresh deterministic projection using the persisted generator
inputs**. Missing, corrupt, stale, or tampered contract, Terraform, or runtime
bytes fail; recompile rather than reconstructing them by hand.

## Generated backend

For an approved mutation with idempotency mode `required`, the generated Cloud
Run deployment uses **Firestore Native**. Provisioning is explicit:

- `shared` (default) uses one existing, platform-owned database per reviewed
  trust/regulatory domain. Capability Terraform consumes zero additional
  database quota slots and must never create or import the shared singleton.
- `dedicated` creates one named, delete-protected database for the capability,
  consuming one database quota slot. It requires a reviewed immutable location.

In both modes Terraform configures:

- the exact `ANVIL_LEDGER=firestore://PROJECT/DATABASE/NAMESPACE` URI;
- a deployment-namespace-hashed collection group, materialized on the first atomic
  reservation (Firestore has no separate collection-creation resource);
- a TTL policy for completed records, with unused single-field indexes disabled;
- conditionally database-scoped `roles/datastore.user` for the runtime service
  account; and
- a Cloud Run startup probe on `/readyz`.

`firestore.googleapis.com` is a shared project prerequisite, not owned by the
per-service capability module. Firestore IAM does not isolate collection groups:
the database is the security boundary. Use separate shared databases or
dedicated mode across trust/regulatory boundaries. Google Cloud console access
does not enforce database IAM conditions; restrict console users separately and
administer through condition-aware APIs/client libraries.

The persisted `deploymentNamespace`—not the agent-facing AIR service id—keys
Cloud Run resources, Terraform state, the Firestore URI namespace, and the
hashed collection group. Estate imports derive it from the full stable gateway
coordinate so two environments/revisions with the same service id do not
collide.

## Decommission and reintroduction

Both Firestore field-policy resources use `deletion_policy = "ABANDON"`. A
dedicated database also uses ABANDON, delete protection, and `prevent_destroy`.
If a later AIR revision removes the last approved required-idempotency mutation,
its reviewed plan detaches `ANVIL_LEDGER`, runtime IAM, and dependencies while
abandoning the TTL policy and index exemption. A dedicated database is also
abandoned; a shared database stays in platform state. Replay evidence and
retention behavior remain intact.

If a later revision requires the ledger again, review the preserved resources
and import both field policies into initialized capability state. In dedicated
mode, also import the database:

```bash
# Dedicated mode only:
terraform -chdir="$TF_WORK" import 'google_firestore_database.ledger[0]' \
  "projects/$PROJECT_ID/databases/<database-id>"
# Shared and dedicated modes:
terraform -chdir="$TF_WORK" import google_firestore_field.ledger_no_single_field_indexes \
  "projects/$PROJECT_ID/databases/<database-id>/collectionGroups/<collection-group>/fields/*"
terraform -chdir="$TF_WORK" import google_firestore_field.ledger_result_expiry \
  "projects/$PROJECT_ID/databases/<database-id>/collectionGroups/<collection-group>/fields/expires_at"
```

Take all coordinates from `anvil deploy ledger`; never reconstruct the hashed
collection group by hand.

Firestore is the built-in managed backend. Firebase client SDKs are not used.
AlloyDB or Spanner require an explicitly registered ledger backend, an
equivalent atomic/precondition/readiness contract, and separately reviewed
infrastructure; Anvil never silently substitutes them.

Emit non-secret external Terraform input before planning:

```bash
anvil deploy ledger <bundle> \
  --project <project-id> \
  --database <existing-trust-domain-database> \
  --database-mode shared \
  --ttl-seconds 604800 \
  --tfvars > /EXTERNAL_TF_WORK/ledger.auto.tfvars.json
```

For dedicated mode, set `--database-mode dedicated` and supply
`--location <firestore-location>`; `(default)` is not a dedicated database
id. Shared mode rejects `--location` because the platform-owned database
already has an immutable location. Completed results can contain application
response data, so choose the shortest retention that covers the real retry and
reconciliation window. In-progress reservations never expire automatically.
The generated contract exposes the 819,200-byte serialized replay-result
ceiling; a larger successful response remains `in_progress` for reconciliation
instead of reopening the duplicate window.

The emitted tfvars deliberately contain `anvil_expected_project_id`, not
`project_id`. Submit Cloud Build with an explicit
`gcloud builds submit --project <project-id>`; that build project remains the
one actual Terraform deployment project, and Terraform refuses it unless it
exactly matches the reviewed expectation. Terraform also recomputes the
canonical ledger input digest and rejects drift in the bundle hash, database,
mode, location, namespace, retention, deployed-runtime hash, or store-contract
hash. External `var.env` and `credential_secret_refs` maps cannot redefine
compiler-owned safety settings or supply the same environment name twice.

Archive the tfvars, rendered plan, and planned `idempotency_store` output
together. An exact output comparison with `anvil deploy ledger --json` proves
the reviewed inputs reached that plan; it is not evidence that the plan was
applied.

## Explicit keys

`required` is an AIR idempotency mode, not enough on its own to infer a
caller-required flag. Read `keyDerivation` or use the generated operation's
`--policy` view:

- `client_supplied` or `none`: `--idempotency-key` is required.
- `request_fingerprint`: the runtime can derive a stable key; an explicit key
  is still recommended for audit and cross-attempt correlation.
- `key_supported` accepts the same optional explicit key and forwards it over
  direct CLI and MCP paths.

Explicit keys must be 1–255 visible ASCII bytes with no spaces or control
characters. The generated CLI schema, `validate-input`, MCP input schema, and
runtime enforce the same portable carrier contract.

## Reconcile a retained reservation

An `in_progress` refusal or uncertain post-response failure includes a
sanitized
`firestore/<collection-group>/<sha256-document-id>` `ledger_reference`.
It never contains the caller key, identity, project, database, URI, or
credentials. The row stores bounded `operation_id`, `trace_id`, and
`started_at` correlation.

Take project/database/collection coordinates only from a fresh
`anvil deploy ledger --json` report. Accept only an exact
`firestore/anvil_idempotency_<16 lowercase hex>/<64 lowercase hex>` reference
whose collection equals that report. Read that exact document with Firestore
field masks, require `status == in_progress`, capture its expected fingerprint,
then correlate it with the upstream's authoritative audit/state. Immediately
before resolution, re-read and require the same `in_progress` status and
fingerprint. Resolution is conditional on that fresh read's `updateTime`:

- proven not committed → conditional DELETE, then the original key may retry;
- proven committed with the exact status/result → conditional PATCH to
  `completed`, preserving the fingerprint and adding
  `result_json`/`response_status`/`expires_at`; or
- unknown → retain the row.

Never clear a completed, unknown, malformed, mismatched, or merely old row. A
failed precondition means another actor changed it; stop and re-read.
`anvil deploy ledger` is offline/read-only and never hides these cloud
mutations behind inspection.

## Proof boundary

A fresh store contract plus exact compiler-owned generated bytes and a matching
planned `idempotency_store` output prove **static wiring and plan identity**,
not provider state or apply completion. After the reviewed Terraform plan is
applied, require:

```bash
curl --fail --silent --show-error "$ANVIL_SERVICE_URL/readyz"
# HTTP 200: {"ready":true,"service":"<service-id>"}
```

`/readyz` performs a non-mutating Firestore data-plane lookup with the runtime
identity. `/healthz` proves only process liveness. Startup is readiness-gated;
provider failure does not create a liveness-restart loop.

The ledger provides bounded deduplication, **not exactly once**:

- atomic create reserves the first key/request fingerprint;
- a completed same-key/same-request replay returns the stored result until
  logical expiry;
- a different request under the same key conflicts;
- a concurrent replay is refused as `in_progress`;
- an upstream success followed by a crash before ledger completion deliberately
  remains `in_progress` for operator reconciliation; and
- a successful response above 819,200 serialized bytes also remains
  `in_progress`, because it cannot fit safely in one Firestore replay row.

The ledger document namespace follows the generated
service/environment/upstream credential-profile namespace. When inbound identity
is verified, the request fingerprint separately binds that principal, so two
callers reusing one raw key conflict before the upstream instead of receiving one
another's replay. Without verified inbound identity, the raw key is a shared
operation coordinate. Direct or differently scoped upstream calls are outside
the boundary.

Execution is also bounded: at most five attempts, 20 seconds of backoff, and a
30-second per-attempt upstream deadline. The 230-second maximum upstream segment
fits inside the generated 600-second Cloud Run request deadline together with
the bounded Firestore reservation and completion/readback path, leaving more
than 100 seconds for credential acquisition, hooks, serialization, and response
delivery.
