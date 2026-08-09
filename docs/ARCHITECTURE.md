# Architecture

Anvil is a compiler with a thin generated runtime. Its primary path captures an
API source, builds one canonical contract, and projects that contract into a
CLI, an MCP server, a skill, hooks, tests, and deployment inputs. A separate
legacy path inventories offline technical evidence and produces reviewed,
non-executable capability bindings when no useful API contract exists.

This page describes the implementation architecture. For ownership and
non-goals, read [Product boundary](PRODUCT_BOUNDARY.md).

## Design invariants

The architecture protects seven invariants:

1. **One semantic model.** CLI, MCP, skill, hooks, mocks, and deployment inputs
   are projections of AIR, not separate sources of truth.
2. **Captured inputs.** Compilation reads a content-addressed source snapshot,
   not a mutable remote contract.
3. **Conservative safety.** Unknown mutation semantics cannot become callable
   by default.
4. **Approval controls exposure.** Only approved operations enter callable
   projections.
5. **Runtime enforcement remains authoritative.** A missing harness hook cannot
   remove a safety requirement.
6. **Evidence binds to bytes.** Assurance records identify the bundle hash they
   tested and become stale after change.
7. **Legacy discovery is not execution authority.** A technical candidate or
   approved binding cannot imply that a runtime bridge exists.

## System flow

| Stage | Input | Responsibility | Output |
| --- | --- | --- | --- |
| Source capture | Files or a source directory | Detect entrypoints, follow permitted local references, reject path escape, store verbatim bytes | Immutable source snapshot |
| Protocol adaptation | One locked entrypoint | Lower OpenAPI, Swagger, GraphQL, proto3, WSDL, Discovery, OData, or Postman into the shared HTTP-shaped compiler input | Normalized source document |
| Semantic compilation | Adapted document plus optional manifest | Normalize operations, classify effects, apply reviewed facts, validate safety, discover capabilities | AIR document |
| Projection | AIR | Generate CLI, MCP, skill, hooks, mocks, evals, runtime documents, targets, and deploy inputs | Bundle directory |
| Review | Bundle | Inspect diagnostics, enrich missing facts, review capabilities, approve operations | Reviewed bundle |
| Assurance | One immutable bundle | Check static identity, exercise transport, compare surfaces, simulate safety behavior | Hash-bound evidence records |
| Release planning | Assured bundle plus target inputs | Verify required evidence and emit an operator plan | Publication plan; no deployment |

`anvil agentify` orchestrates the first four discovery activities—capture,
compile, assess, and capability proposal—then stops for review.

## Legacy inventory and refinement flow

Legacy mode does not pass deployment descriptors or broker configuration
through the API protocol adapters. It uses a separate evidence model:

| Stage | Input | Responsibility | Output |
| --- | --- | --- | --- |
| Offline acquisition | Caller-supplied file or hardened-expanded directory | Bound filesystem reads and preserve provenance | Relative member paths and bytes |
| Collection | Java EE, .NET, or messaging members | Parse only declared configuration; hash opaque binaries | Artifacts, evidence, observations, diagnostics |
| Reconciliation | Verified inventory snapshot | Group exact coordinate and invocation matches; retain every assertion | Technical candidates and explicit conflicts |
| Task creation | One exact candidate | Freeze required decisions and non-negotiable policy | Content-addressed harness task |
| Harness proposal | Task plus external evidence access | Propose business schema, errors, transport, and operational semantics | Untrusted submission bound to the task |
| Assessment and review | Inventory, task, proposal, human decision | Verify lineage and completeness; keep approval separate | Assessment, receipt, and reviewed binding |

Candidates are reconciliation products, not AIR operations. The approved
binding records `runtime.placement = deployment_local_bridge` and
`runtime.status = not_implemented`. No generator or runtime currently consumes
it as executable input.

This deliberate gap prevents the compiler architecture from implying that
configuration parsing also solved vendor client compatibility, field mapping,
transactions, identity, network placement, or completion semantics.

## Layer 0: source capture

Source capture is intentionally separate from parsing. The store records:

- verbatim file bytes;
- discovered entrypoints and formats;
- the role of each file in the graph;
- external references that were observed but not fetched;
- structured diagnostics;
- a content-derived snapshot id and source hash; and
- optional origin metadata such as a gateway vendor.

Local references must remain inside the import root. Remote references are not
fetched. A malformed input can be preserved as an invalid snapshot for
diagnosis, but only a valid snapshot can enter the compiler.

This separation answers a foundational question: *which exact bytes did the
compiler read?* Later evidence can bind to that identity rather than to a path
or URL that may have changed.

## Protocol adapters

The downstream compiler consumes one internal document shape. Protocol adapters
perform deterministic lowering before semantic normalization:

| Adapter | Mapping |
| --- | --- |
| OpenAPI 3.x | Parsed and dereferenced directly |
| Swagger 2.0 | Upgraded with `swagger2openapi`, then parsed as OpenAPI |
| GraphQL SDL | Root fields become POST-shaped operations; GraphQL kind carries read/mutation meaning |
| gRPC/proto3 | RPCs become operations; messages and enums become JSON schemas |
| SOAP/WSDL 1.1 | `portType` operations become POST-shaped operations; WSDL/XSD types become schemas |
| Google Discovery | Resource methods and schemas become paths, operations, and components |
| OData v2/v4 | Entity sets become permitted CRUD operations based on metadata |
| Postman v2.x | Saved requests, folders, examples, and auth shapes become an API document |

Adapters own syntax and mechanical fidelity. They do not grant business
authority. A method named `TransferFunds` remains a mutation whose idempotency
must be established by evidence or a reviewed manifest.

See [Source format support](SOURCE_FORMATS.md) for exact boundaries.

## AIR: the canonical contract

AIR—the Anvil Intermediate Representation—is defined with Zod in `@anvil/air`.
One document contains the service, operations, capabilities, workflows, shared
schemas, evidence, and diagnostics.

Each operation carries:

| Axis | Examples |
| --- | --- |
| Identity | stable id, source reference, canonical name |
| Effect | read or mutation, action, risk, reversibility |
| Repeatability | idempotency mode, key location, retry eligibility |
| Intent gate | confirmation requirement, human-approval tier, reason |
| Access | auth type, principal, scopes, credential profile, carrier |
| Interface | input/output schemas, parameters, errors, pagination |
| Projection | CLI command, MCP tool name, skill intents |
| Lifecycle | generated, review required, approved, blocked, deprecated |
| Ownership | capability and workflow relationships |
| Evidence | claim-scoped provenance, confidence, reliability, review state |

### Claims and confidence

Evidence is recorded per semantic claim. A strong claim that an endpoint exists
must not increase confidence that it is idempotent. The reconciler evaluates
confidence by predicate and uses asymmetric trust:

- loosening safety requires strong evidence;
- tightening safety can proceed on weaker warning evidence; and
- conflicting safety-sensitive claims choose the safer posture and require
  review.

The aggregate confidence shown for an operation is descriptive. Safety gates
use the relevant claim, not a blended score.

### Capabilities and workflows

A capability groups related operations. Discovery uses source structure such as
tags and resource names and records provenance for the grouping. A capability
has its own review lifecycle and disclosure budget.

Workflows are authored, not guessed. Each step references an existing operation;
an unresolved reference or unapproved mutation blocks the workflow. A workflow
cannot grant authority that its steps do not have.

## Compiler passes

The semantic compiler applies ordered passes:

1. **Normalize** source operations into stable AIR identities and schemas.
2. **Classify** effect, action, risk, idempotency, retry, confirmation, auth, and
   pagination conservatively.
3. **Apply manifest** facts and reviewed decisions.
4. **Recompute derived policy** so idempotency, retries, confirmation, and effect
   remain coherent after overrides.
5. **Validate** invariants and force unsafe or uncertain operations into
   `review_required` or `blocked`.
6. **Discover capabilities** and attach authored workflows.
7. **Generate diagnostics and evidence** for every material decision.

The manifest wins where it explicitly supplies a value. Unset fields are
recomputed; stale derived values are not retained merely because a nearby field
changed.

## Generated projections

`@anvil/generators` treats AIR as read-only input and emits independent views:

- operation catalog and compiled runtime documents;
- typed CLI;
- MCP server and resource index;
- skill package and operation references;
- shared hook core plus harness adapters;
- mock server, evals, and conformance assets;
- target-specific connector kits;
- Cloud Run and infrastructure inputs; and
- certification metadata.

The bundle installer stages generated output, verifies surface agreement, and
swaps the complete candidate into place. Partial projection updates are not a
supported state.

## Runtime architecture

The deployed unit is the generated MCP server backed by `@anvil/mcp-runtime`
and `@anvil/runtime`. It does not parse source specifications or run enrichment.

Before an upstream call, the executor evaluates the following controls in a
deterministic order:

| Control | Purpose |
| --- | --- |
| Input validation | Reject arguments outside the generated schema |
| Confirmation | Require explicit intent for gated effects |
| Idempotency | Require and fingerprint deduplication keys where configured |
| Dry run | Return a redacted request plan after preconditions pass |
| Host pinning | Restrict upstream egress to reviewed hosts |
| Auth resolution | Resolve named credential profiles without placing secrets in AIR |
| Ledger durability | Fail closed when a required durable write ledger is unavailable |
| Retry policy | Retry only bounded transient conditions when repetition is safe |
| Response normalization | Produce structured outputs and stable error envelopes |
| Observation | Emit an OpenTelemetry-shaped execution record |

Runtime policy hooks can deny at defined pre/post phases. They are not the same
as harness hooks: runtime hooks execute inside the authority boundary, while
harness hooks improve the caller experience before transport.

### Durable idempotency

A horizontally scaled stateless runtime cannot keep deduplication state in
process. Required-idempotency writes therefore use a pluggable durable ledger.
Outside development, the runtime fails closed when the configured durable
backend is unavailable.

The built-in Firestore path provides reservation, replay, conflict, and
readiness behavior. It is bounded deduplication, not a claim of exactly-once
execution: a crash after upstream success but before ledger completion remains
an operator-reconciliation case.

## Assurance architecture

Assurance is split so one green check cannot hide another class of failure:

- **Certification** checks static artifact identity and contract coherence.
- **Self-test** boots the generated servers and exercises approved tools over
  the real local MCP transport.
- **Conformance** compares the operations and policy described by each surface.
- **Simulation** crosses operations with applicable safety dimensions and
  injects mutations to prove regressions are detected.
- **Benchmarking** measures discovery and callability rather than safety.

Each record names the bundle hash it evaluated. `status` verifies freshness and
selects the next required action. `publish` snapshots the required evidence into
a plan but performs no provider mutation.

## Build-time, deploy-time, and run-time boundary

| Phase | Contains | Must not contain |
| --- | --- | --- |
| Build | parsers, adapters, compiler, enrichment, generators, review, assurance | production credential values |
| Deploy | generated runtime, target configuration, IAM/network/secret references, ledger contract | source parsing or LLM enrichment |
| Run | validation, policy, auth resolution, ledger, upstream execution, telemetry | spec compilation, capability discovery, approval changes |

This boundary keeps the hot path small and reviewable. The runtime consumes
compiled documents; it does not reinterpret the source contract.

## Package map

| Package | Responsibility |
| --- | --- |
| `@anvil/air` | Canonical schemas, operation semantics, disclosure model |
| `@anvil/compiler` | Source store, protocol adapters, normalization, classification, manifest, validation, drift |
| `@anvil/grammar` | Bounded query grammar and template analysis |
| `@anvil/refinement` | Deficiency detection, readiness assessment, cases, review, enrichment plans |
| `@anvil/generators` | Bundle projections and static certification inputs |
| `@anvil/runtime` | Safety executor, auth, retries, idempotency, errors, observation |
| `@anvil/mcp-runtime` | MCP serving path, capability lanes, resource serving |
| `@anvil/harness` | Evidence-source orchestration and executable bundle drivers |
| `@anvil/certification` | Cross-artifact and async contract checks |
| `@anvil/simulator` | Scenario matrix and safety-regression mutation battery |
| `@anvil/targets` | Agent-platform connector profiles |
| `@anvil/system-pack` | Cross-bundle system packaging |
| `@anvil/cli` | Command tree and orchestration over the libraries above |

The CLI is an adapter over library APIs. Core behavior belongs in packages that
can be called and tested without parsing terminal output.

The legacy collectors, inventory model, reconciliation, and refinement
workflow currently live behind the Node-only `@anvil/compiler/legacy` package
export. This entrypoint accepts caller-supplied bytes and does not acquire files
or network resources itself.

## Extension seams

New behavior should enter through a narrow seam:

- new source syntax through a protocol adapter;
- new offline legacy evidence through a non-executing collector that emits the shared
  legacy artifact, evidence, observation, and diagnostic model;
- new executable legacy transport through a deployment-local adapter that
  consumes only reviewed bindings and cannot widen their target or semantics;
- new generated surface through a generator;
- new agent platform through a target profile;
- new durable store through the ledger interface;
- new evidence source through an MCP-published connector and structured claims;
- new harness through a thin adapter over shared hook decisions; and
- new assurance rule through a structured check and stable diagnostic code.

An extension may add evidence or a projection. It must not create a second
semantic model or bypass approval and runtime enforcement.

## Read next

- [Product boundary](PRODUCT_BOUNDARY.md)
- [Mechanisms](mechanisms.md)
- [Simulation and backtesting](simulation-and-backtesting.md)
- [Hooks and plugins](design/hooks-and-plugins.md)
- [Certification authority](architecture/certification-authority.md)
