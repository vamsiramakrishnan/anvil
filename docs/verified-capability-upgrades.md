# Verified capability extensions

These APIs extend business authoring, runtime policy, and qualification. Business
bindings work through the existing compiler and business executor. The invocation
hook loads through the existing extension loader. Other additions are embedding
APIs: the operator supplies the model, database, qualification runner, and backend
receipt verifier described below.

| Area | Entry point | Result and boundary |
| --- | --- | --- |
| Business authoring | `BusinessBinding.transforms`, step `when` and `forEach`; `proposeBusinessUpgrade` in `@anvil/harness` | Validated compositions; changed actions return to `proposed`. |
| Semantic types | `x-anvil-semantic` in reviewed schemas | Entity, unit, currency, tenant and authority compatibility at compile time. |
| Metered evaluation | `AgentUsage`, `compareBusinessProject`, `compareInterfaceCandidate` | Paired cost comparison requiring independent passing safety checks. |
| Invocation policy | `PolicyHooks.transformInvocation` in `@anvil/runtime` | Validated argument and custom-header edits before encoding and fingerprinting. |
| Connector knowledge | `createConnectorKnowledge`, `prepareConnectorInstall`, `connectorMigration` in `@anvil/system-pack` | Pinned source snapshots, fixtures and qualification references; local approval required. |
| Scoped discovery | `taskCatalog`, `buildMcpServer({ taskCatalog })` in `@anvil/mcp-runtime` | Authorized, budgeted session catalog; execution checks current authority again. |
| Incremental assurance | `planBusinessAssurance`, `planAssurance`, `executeAssurance`, `attestRelease` in `@anvil/system-pack` | Dependency-directed checks and a fresh statement for an exact bundle digest. |
| Controlled recovery | `recoverExecution`, `PostgresRecoveryStore` in `@anvil/runtime` | Durable compare-and-swap, backend fencing and receipt-based continuation. |
| Qualified drivers | `QualifiedDriverRegistry`, `postgresProcedureDriver` in `@anvil/legacy-bridge` | Approved procedure bindings, parameterized calls, bounded waits and no automatic retry. |
| Failure regressions | `captureRegression`, `minimizeRegression` in `@anvil/harness` | Explicitly projected scalar inputs and isolated, bounded fixture reduction. |

## Author a composition

A binding may declare up to eight transforms. `scale` converts safe integer
quantities by an exact positive rational factor. It requires a matching source
unit and preserves currency, tenant and authority. Rounding and overflow fail.
Nominal entity identifiers cannot be scaled.

```json
{
  "from": "input",
  "pointer": "/refund_dollars",
  "transforms": [{
    "kind": "scale", "numerator": 100, "denominator": 1,
    "fromUnit": "dollars", "toUnit": "cents"
  }]
}
```

The input schema for this example declares
`"x-anvil-semantic": {"unit":"dollars","currency":"USD"}`. The destination
declares cents and USD. An explicit factor records a reviewed conversion; the
compiler does not infer exchange rates or conversions from names.

`select_one` takes a declared array and a typed field equality, requires exactly
one match, and rejects an array exceeding `maxItems` (1–1000). It returns the
selected object. Ambiguity requires clarification; it never chooses the first
match. Literal bindings cannot manufacture semantic provenance, including inside
objects or arrays.

A step can declare:

```json
{
  "when": {
    "value": {"from":"input","pointer":"/enabled"},
    "equals": {"from":"literal","value":true}
  },
  "forEach": {
    "items": {"from":"input","pointer":"/order_refs"},
    "maxItems": 10
  },
  "input": {"opaque_order_ref":{"from":"item","pointer":""}}
}
```

Iteration is sequential and bounded to at most 100 items per step and 400 source
calls across an action, leaving room for durable journal and reconciliation records. The bound is
checked before the first item dispatch. Each iteration has a distinct journal
step and deterministic idempotency key under the original intent. The result is
an array. A false condition skips the entire step and records its output as null;
the declared result must accept null. A nullable parent cannot be traversed as an
unconditional child binding. Existing partial-effect and uncertain-outcome
handling applies to each iteration.

Use `proposeBusinessUpgrade(baseRevision, definition)` for harness suggestions.
It compiles against the unchanged source snapshots and returns the candidate,
impact report and base digest. It resets changed actions to `proposed`, preserving
only unchanged approvals. It does not save, approve or deploy the proposal.

## Transform semantic invocations

An operator extension can return a replacement argument object and custom headers:

```js
export default {
  name: "normalize-note",
  policy: {
    transformInvocation(plan) {
      return {
        arguments: {
          ...plan.arguments,
          note: String(plan.arguments.note).trim(),
        },
        headers: { "X-Policy-Revision": "notes-2" },
      };
    },
  },
};
```

Load the module with `ANVIL_EXTENSIONS`. Apply this example only to operations
whose reviewed input includes `note`; unknown fields fail validation. The frozen
plan contains operation, contract and target identities, principal, trace ID,
and arguments. Credentials are resolved later. Multiple modules receive the
preceding module's arguments; their custom headers accumulate in load order.

The executor validates the edited values and retains required-input checks.
Confirmation, idempotency controls, credential carriers and protocol headers
cannot be changed. Resolver-provided credential header collisions fail before
dispatch. Transformed arguments and headers participate in replay fingerprints;
ledger ownership remains tied to the upstream idempotency namespace. Edits reach
both HTTP codecs and MCP SDK dispatch. Legacy request hooks remain supported.

## Measure and compare interfaces

An `AgentAdapter.execute` may return `AgentUsage` with `provider`, `model`,
`inputTokens`, `outputTokens`, `cachedInputTokens` and `costUsd`. The process bridge
accepts the same object in `{ "method": "complete", "usage": ... }`. The trusted
adapter obtains these numbers from provider usage and billing data; model text
is not a metering source. Missing usage stays null. Invalid usage makes the run
inconclusive.

Business reports include total cost and cost per successful task, including the
cost of failed trials. `compareInterfaceCandidate(baseline, candidate, lane,
safetyCheckIds)` requires matching tasks, evaluator, configuration, model, provider,
and task/seed pairs. Every candidate trial and each named independent safety check
must pass. Candidate cost must be lower. The returned evidence digest supports a
review decision; it does not approve a candidate or establish statistical
superiority. Repository tests use labeled scripted adapters, not live model
measurements.

## Transfer connector knowledge

`createConnectorKnowledge` packages a definition, normalized source AIR, fixtures,
and per-source qualification report digests and check IDs. Its digest pins the
whole package. `prepareConnectorInstall` checks that pin and the normalized
destination source hashes, then resets action, operation and capability approvals.
A source mismatch requires migration review. `connectorMigration` reports changed
sources and definition changes. Hashes establish content identity; they are not
publisher signatures or a replacement for independent qualification.

## Scope a discovery session

Pass trusted `principal`, optional connector, task `query`, `maxTokens` (128–100000),
and negotiated `dynamicLists` to `buildMcpServer`'s `taskCatalog` option. Filtering
by approval, scopes and grants precedes lexical ranking. The token count estimates
name, description and input-schema characters. It excludes output schemas and
protocol overhead; provider metering measures actual usage. Clients
without dynamic-list support receive all authorized operations as a flat catalog.

Create a separate server per principal and rebuild it when the caller, grants or
task changes. This API selects a session view; it does not implement live catalog
notifications. Workflow and resource exposure is omitted in this view because
those require their own authority review. Execution uses `contextFor` and checks
current grants again, so stale discovery grants no execution authority.

## Reuse assurance evidence

`planBusinessAssurance(project, context, prior)` derives operation, source,
action and held-out-task dependencies from the private business project. Supply
compiler, runtime, policy and configuration identities. A source operation change
invalidates dependent actions; a policy or runtime change invalidates all checks.
`planAssurance` accepts an explicit graph for other artifact types. Missing or
cyclic edges are rejected; declaring any node incomplete forces every check to run.

`executeAssurance(plan, runner)` invokes the trusted runner for scheduled checks
and preserves reusable receipts. The runner must execute the named conformance
and independent oracle checks and return their verdict and report digest. Fresh
checks carry the plan's run ID. `attestRelease(bundleDigest, plan, evidence)` rejects
missing, duplicate, failed or stale receipts. This statement supplements existing
certification and publish gates; it does not disable them or sign a release.

## Recover under a backend fence

`PostgresRecoveryStore` provides parameterized insert, read and atomic revision CAS
over a schema-qualified table. Review and apply `recoveryTableDDL(table)` as a
separate migration. The supplied database client must acknowledge durable commits.
Constructing a store does not create a table or connect to a database.

A checkpoint binds execution, plan, request and original intent digests, plus an
ordered list of step input digests. A recovery host must materialize this exact
reviewed request and provide `RecoveryBackend.fence`, `verify`, and `dispatch`.
Fencing must be enforced atomically at the backend effect boundary by both the
original worker and recovery workers. A database lease alone is insufficient.

`recoverExecution` acquires a new fence through CAS, rechecks authorization before
dispatch, and durably records an attempt before calling the backend. An attempted
write is skipped only with a matching committed receipt, or dispatched only after
an authoritative not-committed receipt. Unknown outcomes stop recovery. Lease
expiry, competing CAS, stale identities and mismatched receipts also stop it.

Recovery is an explicit host API. Existing business execution still stops with
`reconciliation_required`; this addition does not automatically resume it or
replace its cached outcome. Do not enable continuation until the actual backend
can enforce the fence and verify receipts. Local tests exercise competing workers
and uncertain outcomes with controlled adapters; they do not qualify a deployment.

## Register a procedure driver

`QualifiedDriverRegistry.register(binding, driver, qualification)` requires an
approved binding with exact version, target, parameter order, input/output schemas,
scopes, timeout, and a matching qualification digest. Supply an operator-owned
authorization callback to `execute`; it must check current caller, tenant, grants
and any required human approval. Keep this adapter behind the existing AIR runtime
gates when exposing it through a protocol facade.

`postgresProcedureDriver(client)` executes only a fixed `schema.procedure` target
using `CALL "schema"."procedure"($1, ...)` and separately bound values. Credentials
stay in the supplied database client. It validates input/output contracts, caps
output at 8 MiB, and bounds waits to 100–30000 ms. Cancellation or any post-dispatch
failure returns `unknown` with `retryable: false`; it does not claim rollback.
The database client must implement cancellation and the operator must qualify
the actual stored procedure. No live PostgreSQL instance is used by repository
tests, and no procedure is automatically exposed or approved.

## Turn a failure into a regression proposal

`captureRegression` retains no payload by default. A trusted operator must list
allowed scalar fields; nested values and credential-named fields are refused.
Version identities and error codes are identifiers, not raw error messages or
credential-bearing URLs. Field allowlisting still requires a privacy review of
the values it may contain.

`minimizeRegression(capture, fixture, budget)` requires the exact identity and an
isolated fixture that resets state on every call. It first reproduces the same
independently checked failure, then removes fields within 1–100 oracle calls.
It returns a fixture proposal and digest. It never contacts production, changes
a schema, approves an operation or deploys a fix. A source-level finding that has
not reproduced remains a finding; it cannot become a verified regression through
this path.
