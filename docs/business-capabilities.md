# Business capability execution

Anvil compiles a business contract into MCP tools, CLI commands, a skill, and
TypeScript, Python, Go, and Java clients. All clients call one business gateway.
The gateway executes a private plan against approved source operations.

The agent supplies business facts and receives a business outcome. API paths,
intermediate identifiers, credential profiles, and vendor errors stay inside
the execution boundary. Consequential effects, refusals, partial completion,
and recovery instructions remain visible.

| Owner | Responsibility |
|---|---|
| Business definition | Input and result schemas, intent, clarification, effects, source authority, preconditions, and recovery |
| Shared runtime | Trusted context, authorization, approval, bindings, source execution, intent records, and result validation |
| MCP / CLI / SDK | Discover and invoke the same public business actions |
| Skill | Choose an action, ask for missing facts, compose actions when judgment is needed, and escalate uncertainty |

## Compile and inspect

The repository includes three owned synthetic calibration contracts:

| Action | What it tests |
|---|---|
| `complete_return` | Order identity → billing refund → support case; multiple effects across systems |
| `amend_order` | Tenant and lifecycle checks, private revision handling, and an upstream conditional update |
| `grant_account_access` | Directory authority, manager authorization, trusted human approval, and tenant scope |

From the repository root after `pnpm build`:

```sh
node packages/cli/dist/bin-anvil.js capability compile examples/business/definition.json \
  --source orders=examples/business/sources/orders.json \
    billing=examples/business/sources/billing.json \
    identity=examples/business/sources/identity.json \
    support=examples/business/sources/support.json \
  --out /tmp/anvil-business

node packages/cli/dist/bin-anvil.js capability preview /tmp/anvil-business
node packages/cli/dist/bin-anvil.js capability preview /tmp/anvil-business --execution
```

The default preview shows the agent contract. `--execution` shows private
bindings, authority declarations, preconditions, and recovery instructions.
Both previews are static: they do not read current business state or reserve a
transaction. Compilation refuses an existing output directory.

The example source approvals cover owned fixture behavior. Their placeholder
servers are exercised by the tests below. Rebind and review real source
snapshots before using these definitions in a real service. The compiler never
promotes source operations into approval. Actions default to `proposed`; only
explicitly approved actions are exposed.

## Author business semantics

Each action owns its input and output schema. Neither is inherited from an API
operation. Fields use portable snake_case names; object schemas must declare
`additionalProperties: false`.

Bindings declare provenance explicitly:

```json
{
  "txn": { "from": "step", "step": "order", "pointer": "/pay_txn" },
  "minor": { "from": "input", "pointer": "/refund_amount" }
}
```

Other bindings are `{"from":"context","field":"tenant"}` and
`{"from":"literal","value":true}`. RFC 6901 pointers may address nested
values. Bindings cannot execute code, coerce types, reference future steps, or
guess joins. Missing values fail before the next operation executes. Source
inputs and outputs are validated at runtime.

Every step names an approved source operation and states why that source is
authoritative. This is a reviewed decision, not automatically established
evidence. The plan digest binds that declaration to exact source snapshots.
The compiler checks declared pointers and types; reviewers own the meaning of
a cross-system identity link.

Every mutation must disclose its effect. Preconditions compare explicit
bindings before a step executes. Each step declares a public failure message
and next action. Vendor payloads and raw exceptions stay out of those answers.

The execution vocabulary is bounded: up to 20 actions, 32 ordered steps per
action, equality preconditions, explicit bindings, and result projection.
Resolve JSON Schema references, unions, and unsupported keywords before
authoring, or provide an adapter. Asynchronous sources need a separate
submit/status business contract. There is no arbitrary expression language,
automatic compensation, or automatic workflow resumption.

## Configure the gateway

Generated `runtime/server.js` and `deploy/runtime/server.js` serve `/mcp` and
`POST /business/<action>`. Deployed MCP invokes the engine in process; generated
CLI, stdio MCP, and language clients call the gateway over HTTP. Their
`ANVIL_BASE_URL` points to the gateway.

The public `caller` setting is `service` for bearer-authenticated machine
callers or `end_user` for an OAuth authorization-code caller. It is independent
of backend credentials. See [client SDKs](client-sdks.md) for authentication.

Outside development, the gateway refuses to boot without verified inbound
authentication. Configure `ANVIL_INBOUND_AUTH_MODE=oidc` or
`google_service_account` with the existing inbound authentication settings.
Verified claims supply issuer/subject, `tid` or `tenant`, and scopes. Set
`ANVIL_BUSINESS_POLICY_VERSION` to the active operator policy version. Missing
tenant, principal, or policy version refuses execution before backend calls.
For a deployment serving one tenant whose tokens omit a tenant claim, set the
trusted operator default `ANVIL_BUSINESS_TENANT`.

Set `ANVIL_BUSINESS_SOURCES` to an operator-owned JSON object, for example:

```json
{
  "orders": {
    "baseUrl": "https://orders.example.com",
    "authProfile": "orders",
    "scopes": ["orders:read", "orders:update"]
  }
}
```

Each source pins its configured host. The existing credential resolver supplies
secrets under the source auth profile. Source grants are explicit and default
to no scopes; they do not grant the caller public business scopes. The gateway
checks `requiredScopes` separately. Delegated backend authentication receives
the verified inbound identity.

For owned development fixtures, `ANVIL_ENV=dev` permits an operator-supplied
`ANVIL_BUSINESS_CONTEXT` with `tenant`, `principal`, `policyVersion`, and
`scopes`. Production ignores that development context. Tool inputs cannot
override trusted context in either environment.

## Approval and recovery

Mutations require one stable idempotency key per business intent. The ledger
reserves the intent before execution. Each key-bearing backend mutation gets
a distinct deterministic key. A backend without key support is never described
as gaining upstream idempotency from composition.

Production mutations require a durable ledger through `ANVIL_LEDGER`. Completed
results, including partial or uncertain outcomes, are recorded before
acknowledgement and replayed without re-entering the plan. An in-progress record
requires reconciliation. Ledger retention bounds deduplication. This is not
an atomic distributed transaction or an exactly-once guarantee.

| Status | Required handling |
|---|---|
| `completed` | Inspect the declared `result` and `completed_effects` |
| `rejected` | Correct the refused request; no known business effect completed |
| `approval_required` | Have this exact request and its declared effects reviewed by the trusted authority |
| `partial` | Report completed effects and follow `next_action`; do not restart the journey |
| `reconciliation_required` | Reconcile uncertain completion or recording before another mutation |

These are structured business responses. HTTP success or a non-error MCP
response does not alone mean business completion: inspect `status`. Operators
can correlate `trace_id` with backend execution records using
`ANVIL_RECORDS_DIR` and the existing observation workflow.

For `humanApproval: true`, model confirmation is insufficient. The runtime's
`BusinessHost.approvalFor` hook must return a trusted, unexpired approval bound
to the request, intent key, tenant, principal, policy version, and plan digest.
It also binds the environment, source targets, and grants. The built-in server
derives this execution identity from operator configuration; custom hosts must
provide `BusinessContext.executionBinding` from their trusted configuration.
The built-in server accepts an operator-managed JSON array at
`ANVIL_BUSINESS_APPROVAL_FILE`. Records contain `digest`, `approvedBy`, and
`expiresAt` as epoch milliseconds. This is a trusted integration, not an
agent-editable input. Missing or malformed approval fails closed.

The refusal's `approval_digest` identifies the exact request to review. It is
not an authorization token or a quote of resolved backend writes. Source facts
can change after approval. Use preconditions and upstream conditional writes
where required: the gateway cannot make a read followed by a write atomic.

## Calibrate changes

```sh
ANVIL_FUZZ_REQUIRE_SDKS=true pnpm exec vitest run \
  packages/harness/src/business/business.test.ts \
  packages/harness/src/business/serving.test.ts
```

Install Python, Go, and a JDK with `javac` for the full language lane. Tests run
actual generated interfaces against isolated loopback gateways and independent
business state. They check guards, partial effects, lost responses, replay,
approval binding, private disclosure, and the prebuilt server. Stateful fuzzing
varies valid and invalid amounts and repeats intent keys, using the existing
shrinking and replay kernel.

These checks prove bounded behavior, not model effectiveness. Evaluate tool
selection, grounded arguments, and completed business outcomes on held-out
tasks with the actual agent harness. The process-agent bridge described in
[stateful fuzzing](fuzzing.md) provides that integration. A lexical routing
baseline is not a lower bound on model accuracy.

## Artifact boundary

Public AIR, MCP resources, CLI, SDKs, and skills contain the business surface.
Private source AIR and execution details live in generator inputs
(`generation.json`) and `runtime/business.plan.json`, including its deployment
copy. Treat the full deployment bundle as an operator artifact; distribute the
generated skill package to agents.

Regeneration and certification bind public AIR to the private plan and compare
generated bytes. Change the definition and recompile; editing public AIR alone
is rejected as drift. Existing `capability compose` remains audit-only.
Execution requires an explicit definition and `capability compile`.

For versioned authoring, comparative evaluations, and execution inspection, see the [business capability workbench](business-workbench.md).
