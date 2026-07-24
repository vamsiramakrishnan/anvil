# ADR-0026 — Firestore is the built-in durable idempotency ledger

**Status:** Accepted

## Context

Anvil's generated runtime is stateless and may run on several Cloud Run
instances. A process-local map cannot coordinate two instances that receive the
same write, so it is not a production idempotency boundary.

The store also cannot create an exactly-once guarantee that the upstream API
does not have. A process can reserve a key, call the upstream, and crash after
the upstream commits but before the result is recorded. Automatically expiring
that reservation could run the mutation twice.

## Decision

Anvil ships one production backend: a Firestore Native-mode ledger. The bundle
owns its field policies, runtime wiring, and IAM; database ownership depends on
the selected provisioning mode.

- `shared` is the estate-scale default. It uses one existing, platform-owned
  database per reviewed trust/regulatory domain, consumes zero per-capability
  database quota slots, and gives each capability a deterministic hashed
  collection group. Capability Terraform never creates or imports the shared
  singleton.
- `dedicated` creates one named, delete-protected database when a capability
  needs a separate database IAM boundary. It consumes one database quota slot
  and requires an immutable location decision. Services without an approved
  `required`-key mutation emit neither coordinate variables nor ledger
  resources.
- Firestore IAM does not isolate collection groups. The database is the
  security boundary, so shared databases cannot cross trust/regulatory domains.
  Google Cloud console access does not enforce database IAM conditions;
  operators must restrict console users separately.
- A persisted deployment namespace keys Cloud Run resources, Terraform state,
  the Firestore URI namespace, and the hashed collection group. Gateway imports
  derive it from the full stable gateway coordinate; capability builds derive a
  child namespace from the parent deployment identity and capability id. AIR's
  agent-facing service id does not change.
- The runtime stores a hashed ledger key, request fingerprint, lifecycle state,
  bounded replay result, completed-result expiry, and bounded operation/trace
  correlation. Caller keys and caller identity are never document IDs or
  plaintext ledger coordinates.
- The document-key namespace follows the effective upstream key namespace
  (service, environment, upstream, and credential profile), not the inbound
  caller. When inbound identity is verified, the request fingerprint separately
  includes that principal. Therefore two verified callers reusing one raw
  upstream key meet at one document and conflict before the upstream call
  instead of receiving each other's replay. Without verified inbound identity,
  the raw key is a shared operation coordinate. This is deliberately
  conservative for delegated upstreams whose own key namespaces may be narrower.
- Reservation is an atomic create-if-absent. Completion and release use the
  reservation's update-time precondition, so one instance cannot overwrite or
  delete another instance's reservation.
- Completed results have a configurable TTL. The runtime checks the expiry
  before replay because provider TTL deletion is asynchronous.
- Firestore replay results are bounded to 800 KiB of serialized JSON. If a
  larger successful response cannot be cached after the write, Anvil retains
  the reservation for reconciliation instead of reopening the duplicate
  window.
- In-progress reservations never expire automatically. They represent an
  uncertain write and require upstream reconciliation before an operator can
  clear them.
- The runtime service account receives database-scoped access. `/readyz`
  performs a bounded, field-masked, non-mutating data-plane probe and fails
  closed when the database or permission is unavailable.
- Ledger tfvars carry a reviewed expected project, never a second actual
  `project_id`. Cloud Build supplies the one deployment project, and Terraform
  refuses a mismatch.
- A canonical input digest binds the bundle, deployed runtime, store contract,
  project, database, mode, location, namespace, and retention to the Terraform
  plan. The planned `idempotency_store` output exposes those identities for
  comparison. This is plan evidence, not proof that the plan was applied.
- External environment maps fail planning if they redefine a compiler-owned
  runtime safety setting or supply the same name through both plain and
  secret-reference maps. There is no last-write-wins path.
- Outside `dev`, a required-key mutation refuses execution unless the selected
  ledger is durable. Local development may use the process-local ledger, but it
  is never described as horizontally safe.

Firebase does not provide a different server-side persistence primitive here;
its document database is Cloud Firestore. AlloyDB would add PostgreSQL schema,
networking, credentials, and connection-pool lifecycle to a single-row
compare-and-set problem. Spanner is appropriate only when an operator already
needs its global relational transaction model. Either can be supplied through
the runtime's explicit ledger-backend plugin seam, but Anvil does not generate
or imply those integrations.

## Write semantics

- An upstream `required` or `key_supported` contract is still the authority
  that makes retrying the external side effect safe. A `required` mutation also
  gets the generated ledger's cross-instance reservation, request-conflict
  detection, and response replay.
- A `key_supported` mutation relies on the reviewed upstream key semantics and
  does not cause a database to be provisioned by itself. If its service already
  has a ledger for a `required` mutation, the runtime may also use that ledger
  for coordination and replay; the upstream carrier remains the safety
  boundary.
- Naturally idempotent writes and deterministic client-ID writes rely on their
  reviewed upstream contract; a ledger is not used to invent a second one.
- A mutation with `idempotency.mode: none` remains confirmation-gated and is
  never automatically retried. Adding a database around it would not make a
  crash between the upstream commit and ledger completion safe.
- If the upstream succeeds but ledger completion cannot be proven, Anvil must
  not release or steal the reservation. A later request sees `in_progress` and
  stops for reconciliation. The error exposes a sanitized
  `firestore/<collection>/<hashed-document>` reference plus operation/trace
  correlation, never the raw key or database URI.
- Reconciliation is compare-and-set, never age-based. After proving the
  upstream outcome, an operator may conditionally delete an uncommitted row or
  conditionally complete a committed row with the exact response. If the
  outcome remains unknown, the row stays quarantined.

This is an at-most-one-active-attempt coordinator with replay, not a claim of
distributed exactly-once execution.

## Consequences

- The default path has no database driver, private VPC connector, or connection
  pool in the serving image.
- Terraform, runtime configuration, readiness, persisted generation inputs, and
  operator diagnostics must agree on the exact provisioning mode, database,
  deployment namespace, collection, location, IAM binding, and retention.
- Static bundle and plan identity remain separate from apply and live proof.
  Operators must apply the exact reviewed plan and then require `/readyz`; the
  plan digest alone never upgrades deployment state.
- Store unavailability prevents required writes but does not block dry-runs or
  read-only operations.
- The generated store contract and CLI expose the replay-result ceiling; large
  write responses must be designed around it or handled by reviewed
  reconciliation.
- Teams choosing a plugin backend own its schema migration, credentials,
  readiness probe, retention, concurrency tests, and production support.
