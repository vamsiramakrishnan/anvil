# Product boundary

Anvil compiles source contracts and reviewed policy into agent tools and the
evidence used to assess them. An operation's approval is separate from upstream
authorization, deployment readiness, and successful execution.

Legacy inputs first produce an inventory and reviewed capability bindings.
Execution additionally requires a supported bridge, its declared prerequisites,
and the runtime checks described in [Legacy runtime bridges](legacy-runtime-bridges.md).
An inventory or binding alone is not a runnable integration.

## The contract

Anvil accepts:

- immutable API source bytes;
- offline legacy artifact, application-server, .NET, and broker evidence;
- reviewed semantic overlays;
- explicit operation and capability decisions;
- target and deployment coordinates; and
- executable evidence from generated test surfaces.

Anvil produces:

- one canonical AIR contract;
- aligned CLI, MCP, skill, client-SDK, hook, mock, eval, and deployment projections;
- runtime enforcement documents;
- structured diagnostics and readiness reports;
- hash-bound assurance records; and
- a gated release plan for an operator to apply.

The legacy path instead produces a content-addressed inventory, reconciled
technical candidates, hash-bound harness tasks and proposals, human review
receipts, and an approved binding whose runtime status remains
`not_implemented`.

Anvil does not convert unknown business meaning into authority.

## What Anvil owns

### 1. Source identity

Anvil owns the content-addressed snapshot of the bytes it compiles. Local
references are captured under a defined root; path escape is rejected; remote
references are recorded but not fetched.

This makes source identity reproducible and gives downstream evidence a stable
coordinate.

### 2. Protocol lowering

Anvil owns deterministic adapters from supported description formats into the
shared compiler input. It uses mature parsers for syntax and adds only the
Anvil-specific mapping required to preserve operations, schemas, auth shapes,
and source identity.

Protocol lowering is not permission. The adapter may identify a GraphQL
mutation or a WSDL operation; it cannot prove that a money movement is safe to
repeat.

### 3. AIR and semantic coherence

AIR is the product's central abstraction. It owns stable operation identity,
effect, risk, reversibility, idempotency, retries, confirmation, auth,
capabilities, workflows, schemas, lifecycle, and evidence.

Derived semantics must remain coherent. For example, enabling retries cannot
make a non-idempotent mutation safe; the compiler recomputes and validates the
whole posture.

### 4. Conservative classification

Anvil owns deterministic inference from transport and naming evidence, plus the
rules that turn uncertainty into `review_required` or `blocked`.

The classifier may propose. It may not silently approve a safety-sensitive
claim.

### 5. Reviewed enrichment

Anvil owns the manifest schema, structured evidence claims, reconciliation
rules, and proposed patches. It preserves provenance and applies asymmetric
trust: loosening safety requires stronger evidence than tightening it.

The API owner remains the authority for business facts.

### 6. Projection alignment

Anvil owns generation of every supported surface from AIR. A new generator is
acceptable; a second hand-maintained semantic contract is not.

The tool name, schema, approval state, and safety posture for one operation must
agree across CLI, MCP, skill, client SDKs, hooks, mocks, and runtime documents.

### 7. Runtime policy enforcement

Anvil owns the generated runtime checks for validation, confirmation,
idempotency, retry eligibility, host pinning, credential resolution, durable
ledger requirements, error normalization, and execution records.

Harness hooks are an early user-experience layer. They may deny or escalate,
but no safety requirement may exist only in a hook.

### 8. Assurance and evidence freshness

Anvil owns static certification, executable self-test, cross-surface
conformance, simulation, and their structured records. It verifies that every
record refers to the bundle being released.

Anvil can prove what its generated surfaces did under the defined harness. It
cannot prove that an external cloud deployment is live until the operator
supplies live evidence.

### 9. Release-plan preparation

Anvil owns verification of release prerequisites and generation of an operator
plan. `publish` is intentionally a planning verb with no provider mutation.

This separation prevents a local compiler command from becoming an ambiently
credentialed deployment control plane.

### 10. Legacy inventory and reviewed binding

Anvil owns deterministic offline collectors for the explicitly supported Java
EE, .NET Framework, and messaging configuration formats. It content-addresses
artifacts and observations, preserves conflicting claims, and reconciles only
exact technical coordinates.

For one candidate, Anvil owns the immutable refinement task, proposal schema,
deterministic assessment, and hash lineage through a separate human receipt.
The coding harness may investigate and propose; it may not approve itself,
invent a transport target, or execute the estate during refinement.

The approved result is a reviewed business and transport plan. Lowering that
binding into AIR, generating a domain MCP surface, and executing a
deployment-local legacy adapter are outside the implemented boundary today.

## What stays outside Anvil

| Concern | Owner | Anvil's role |
| --- | --- | --- |
| Business meaning of an operation | API owner | Detect uncertainty and provide reviewed manifest fields |
| Upstream implementation correctness | Service team | Preserve contract and exercise generated mocks/clients; do not certify service internals |
| Production authorization | Identity platform and upstream API | Generate auth contracts and enforce caller/runtime prerequisites |
| Credential values | Secret-management system | Reference named profiles and environment variables only |
| Organizational approval workflow | Existing change/risk system | Emit reviewable state and evidence that workflow can consume |
| Cloud deployment | Platform delivery system | Generate artifacts and a plan; never imply that planning equals deployment |
| Live gateway capture | Gateway operator | Consume explicit offline exports at documented support tiers |
| Live legacy capture | Middleware operator | Consume bounded offline exports; never use management access as business authority |
| Legacy protocol execution | Platform and middleware teams | Preserve the reviewed binding and report `not_implemented` until a tested local adapter exists |
| Observability backend | Platform team | Emit structured execution records compatible with telemetry pipelines |
| Business workflow invention | Domain owner | Represent authored workflows and block unresolved steps |
| Exactly-once execution | Upstream design and transactional architecture | Provide bounded idempotency/deduplication guarantees with explicit failure boundaries |

## Non-goals

### A new API framework

Developers do not implement application logic against AIR. They maintain their
API and its contract. Anvil compiles that contract into agent-facing tools.

### A universal protocol proxy

Protocol adapters compile description formats. They do not automatically
implement every native transport, vendor policy, script, or extension. When
execution requires a protocol-specific bridge, that bridge remains an explicit
deployment component.

Legacy inventory makes this boundary especially important. Recognizing an MQ
destination, WCF endpoint, or EJB binding does not install a compatible client,
prove network reachability, define wire mapping, or make the invocation safe to
retry.

### An autonomous approver

Anvil can classify, assess, gather evidence, and propose a patch. It cannot
decide that an uncertain financial or destructive operation should be exposed.

### A secret store

AIR and generated documentation contain secret names and resolution contracts,
not values. Runtime credentials come from operator-managed systems.

### A hosted control plane

The compiler, source store, and review artifacts work locally and in CI. A
future catalog may distribute bundles, but the correctness model must not
depend on a central service.

### A deployment engine hidden behind `publish`

Anvil generates deployable artifacts and verifies readiness for a release plan.
The operator's delivery system owns provider credentials, mutation, rollback,
and live reconciliation.

### A claim of perfect safety

Anvil reduces specific failure modes: semantic drift across surfaces,
unapproved exposure, unsafe retries, missing confirmation, unbound evidence,
and silent source changes. It cannot compensate for a false reviewed claim, an
upstream authorization defect, or an incorrect business decision.

## Extension test

A proposed feature belongs inside Anvil when it answers at least one of these
questions without breaking the invariants:

- Can Anvil capture another authoritative source format?
- Can AIR express a missing operation or capability fact?
- Can a reviewed claim improve semantic confidence?
- Can another surface be generated from AIR without duplicating semantics?
- Can the runtime enforce a contract fact more completely?
- Can assurance detect a regression or stale claim?
- Can a target profile translate an assured bundle into operator-owned setup?

A feature is outside the boundary when it requires Anvil to become the system
of record for secrets, business authorization, live provider state, or
application workflows it did not author.

## Architectural consequences

The boundary produces several implementation rules:

- libraries hold behavior; the CLI orchestrates them;
- source adapters emit the shared compiler input rather than adding
  protocol-specific branches downstream;
- generators read AIR and never become semantic authorities;
- approval and capability review are explicit lifecycle transitions;
- generated output is replaced as a unit, not patched in place;
- legacy inventories and reviewed bindings remain distinct from AIR until an
  explicit, verified lowering path exists;
- runtime code depends on compiled documents, not parsers or enrichment;
- assurance records are content-addressed and fail stale; and
- external actions remain distinguishable from local plans.

Read [Architecture](ARCHITECTURE.md) for the package and data-flow design that
implements this boundary.
