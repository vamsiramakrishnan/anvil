# Design a deployment-local legacy bridge

An approved capability binding can now be compiled into a deterministic bridge
plan and assessed against a driver descriptor. For one transport — a message
binding whose reply mode is `reply_to` or `fixed_destination` — it can also be
*served*: `@anvil/legacy-bridge` is a real HTTP facade, proven by
`anvil legacy bridge conformance` against a deterministic in-process broker
double. Every other transport family described on this page is still exactly
what it was: a bridge plan and nothing that executes it.

> **Current status:** `bridgePlan.executionAllowed` is still `false` for
> every plan — planning never claims live readiness, for any transport. What
> changed is narrower: one binding shape now has a real, conformance-tested
> server behind it, and `anvil legacy bridge conformance` can move that
> binding's `runtime.status` from `not_implemented` to `conformance_passed`.
> That status is earned against a double, never against a real broker — see
> [The first executable bridge](#the-first-executable-bridge-queue-requestreply)
> below for exactly what it does and does not prove. WebLogic, WebSphere,
> JBoss remote EJB, WCF, MSMQ, JCA resource adapters, stored procedures, and
> batch/scheduler jobs remain fully undescribed by any generator, prepared
> driver, or deployment path.

## Start with the precise boundary

The legacy workflow produces progressively stronger design-time records:

```text
verified inventory
    ↓
reviewed capability binding
    ↓
bridge plan
    ↓
driver descriptor assessment
    ↓
STOP — no generator, prepared driver, deployment, or execution path exists
```

The bridge plan is useful because it turns an approved operation into explicit
runtime obligations. It does not make those obligations true.

## Create a non-executable bridge plan

```ts
import {
  planLegacyBridge,
} from "@anvil/compiler/legacy";

const bridgePlan = planLegacyBridge(binding);

console.log(bridgePlan.planId);
console.log(bridgePlan.requiredCapabilities);
console.log(bridgePlan.conformance);
console.log(bridgePlan.unverifiedLiveFacts);

bridgePlan.executionAllowed satisfies false;
```

`planLegacyBridge` verifies the content-addressed binding and derives:

- the reviewed operation name, transport, and operational semantics;
- required driver capabilities;
- concrete conformance assertions;
- live facts that remain unverified; and
- a content-derived bridge-plan identity.

The baseline capabilities are:

- transport client;
- wire serialization;
- authorization;
- timeout and cancellation;
- stable error mapping;
- completion observation;
- health and readiness;
- telemetry; and
- recorded conformance.

The plan additionally requires idempotency enforcement for a client-key
binding, bounded retry for reviewed safe-transient retry, and reply correlation
for message request/reply.

Every plan retains these live unknowns until a future deployed runtime proves
them:

- target existence;
- network reachability;
- credential validity;
- identity authorization;
- runtime compatibility; and
- observability of business completion.

## Assess a driver declaration

A driver descriptor states what an implementation claims to support:

```ts
import {
  assessLegacyBridgeDriver,
  LegacyBridgeDriverDescriptor,
} from "@anvil/compiler/legacy";

const descriptor = LegacyBridgeDriverDescriptor.parse({
  schemaVersion: 1,
  id: "ibm-mq-request-reply",
  version: "1.0.0",
  transports: [
    {
      kind: "message",
      protocols: ["ibm_mq"],
    },
  ],
  capabilities: [
    "transport_client",
    "wire_serialization",
    "authorization",
    "timeout_and_cancellation",
    "stable_error_mapping",
    "idempotency_enforcement",
    "bounded_retry",
    "reply_correlation",
    "completion_observation",
    "health_and_readiness",
    "telemetry",
    "recorded_conformance",
  ],
  deterministicGeneration: true,
  liveDiscovery: false,
  acceptsSecrets: false,
});

const assessment = assessLegacyBridgeDriver(bridgePlan, descriptor);

if (!assessment.supported) {
  console.error(assessment.missingCapabilities);
  console.error(assessment.reasons);
}
```

Assessment compares the plan's transport and required capabilities with the
descriptor. It does not import driver code, inspect an artifact, execute a
conformance case, validate generated output, or contact a target. A
`supported: true` result means only that the declaration covers the static
plan.

`LegacyBridgeDriver` currently contains only the descriptor. There is no
exported `generate`, `prepare`, `invoke`, `health`, or `close` method for the
transports below this section. This is intentional: Anvil can define and
assess the contract before exposing a runtime it cannot yet secure or test.

## The first executable bridge: queue request/reply

One shape has a real driver today, and this section is exact about what that
does and does not mean.

### What exists

`@anvil/air`'s `WireBinding` gained a `queue_request_reply` member: a request
destination, a reply strategy (`reply_to` or `fixed_destination`) with its
correlation field, request/response schema pointers, a timeout, and —
load-bearing — `legacyBindingContentHash`, the exact reviewed
`LegacyCapabilityBinding` this exchange executes. A bridge with a mismatched
hash refuses to serve, structurally: it can never silently start answering
for a different, unreviewed, or since-changed candidate.

`@anvil/legacy-bridge` is a new, deployment-local package that:

- derives that wire binding from a reviewed `LegacyCapabilityBinding`
  (`buildQueueWireBinding`);
- serves an HTTP facade (`createLegacyBridgeFacade`) that translates one
  `POST /invoke` into one queue request/reply exchange, with the caller's
  idempotency key (or a freshly generated one) as the message correlation
  value, and makes **exactly one** broker call per HTTP call — there is no
  retry loop anywhere in the facade;
- speaks a real STOMP 1.2 client over `node:net`
  (`packages/legacy-bridge/src/stomp-client.ts`) — chosen, and the choice
  justified in the file's own header, as the protocol a zero-dependency
  client can honestly implement (AMQP 0-9-1/1.0 are binary, negotiated
  protocols with real implementation weight; STOMP is a text protocol most
  brokers this package's estates use already speak, natively or via a
  gateway); and
- runs conformance (`runLegacyBridgeConformance`, `anvil legacy bridge
  conformance`) against `InProcessBrokerDouble`, a deterministic in-process
  fake — never a real broker, in this package's own tests or in the CLI
  command.

This is exactly the "protocol facade" `docs/SOURCE_FORMATS.md` already
documents for a gRPC JSON transcoder: the runtime's existing HTTP/JSON codec
calls it once an operator declares `--protocol-facade` /
`ANVIL_PROTOCOL_FACADE`, so nothing in `packages/runtime` needed a new codec
or a new retry path for this to be callable — only the new wire-binding shape
in `@anvil/air`.

### What `conformance_passed` proves, and what it does not

```bash
anvil legacy bridge conformance bridge-plan.json --binding binding.json \
  --out conformance.json --emit-binding binding.conformance-passed.json
```

Drives every required case from the plan plus three fixed safety invariants
against the double:

- **idempotent replay** — a repeated idempotency key returns the identical
  cached reply without re-executing the business side;
- **timeout maps to a structured error** — a broker that never replies
  produces a `504`/`upstream_timeout`, explicitly `retryable: false`, never a
  hang and never a false success; and
- **non-idempotent sends are never auto-retried** — one HTTP call to the
  facade produces exactly one broker exchange, win or fail, with no retry
  loop inside the bridge itself. (An *outer* caller, like the runtime, is
  free to call again under its own reviewed retry policy — that call is safe
  precisely because replay is a no-op, not because the bridge intervened.)

On a full pass, `runtime.status` moves from `not_implemented` to
`conformance_passed` on a *new*, re-addressed binding — `bindingId` and
`contentHash` change because they are derived from the whole record including
`runtime`; every other reviewed fact and the full inventory → task → proposal
→ receipt lineage carries over unchanged, and `runtime.conformanceReportHash`
pins exactly which report earned it.

What it does not prove: that a real broker exists, is reachable, authorizes
this identity, or would actually deliver a reply — the same
`unverifiedLiveFacts` every bridge plan already lists. `conformance_passed`
is a statement about the bridge's own code against a double standing in for
"any correctly-behaving broker," not a live-readiness claim. See [Build one
complete vertical slice
first](#build-one-complete-vertical-slice-first) below — the queue
request/reply slice is what this section describes, and it stops exactly
where that section says a first slice should: proven logic, zero live
connections.

## Why the bridge belongs near the estate

Legacy transports often depend on network placement, vendor client libraries,
native configuration, local identity, or application-server class loading.
Moving those concerns into a generic hosted MCP server broadens the network,
credential, and serialization boundary.

The intended deployment keeps protocol-specific code inside the estate:

```text
coding harness or agent
        |
        | business-shaped MCP request
        v
domain MCP surface
        |
        | reviewed capability binding
        v
deployment-local bridge
        |
        | JMS / MQ / WCF / MSMQ / EJB / JCA / procedure / job
        v
legacy application
```

The agent sees `refunds.submit`. The bridge knows that the operation uses
`PAY.REFUND.V2`, a reply queue, a correlation property, and a vendor
serializer. Those middleware primitives must not leak into the agent-facing
tool surface.

## What the approved binding contributes

| Contract | Future bridge responsibility |
| --- | --- |
| Business operation | Validate developer-facing input; return the reviewed output and stable errors |
| Transport plan | Address only the reviewed destination, endpoint, method, procedure, or job |
| Operational semantics | Enforce timeout, authorization, idempotency, retry, and completion boundaries |
| Review lineage | Record the inventory, task, proposal, and receipt authorizing the mapping |

The binding contains no credentials, connection pools, vendor binaries,
network policy, deployment health, or live runtime evidence. It also cannot by
itself prove that an agent-facing JSON field maps to the correct wire field.
Those remain driver, deployment, and conformance concerns.

## What the executable driver contract still needs

A later runtime SPI will need to separate deterministic generation from live
execution. Conceptually:

```ts
interface FutureLegacyBridgeDriver {
  readonly descriptor: LegacyBridgeDriverDescriptor;

  generate(plan: LegacyBridgePlan): GeneratedBridgeArtifact;
  prepare(
    artifact: GeneratedBridgeArtifact,
    deployment: DeploymentConfig,
  ): Promise<PreparedBridge>;
}

interface PreparedBridge {
  invoke(
    request: InvocationRequest,
    signal: AbortSignal,
  ): Promise<InvocationResult>;
  readiness(): Promise<ReadinessResult>;
  close(): Promise<void>;
}
```

This is illustrative, not an exported Anvil interface. The eventual contract
must guarantee that:

- generation consumes only a verified plan and is deterministic;
- deployment configuration is separate from the reviewed binding;
- credentials are resolved by reference and never embedded in artifacts;
- one prepared driver is pinned to reviewed targets and schemas;
- deadlines and cancellation propagate through the transport;
- transport acceptance and business completion remain different states;
- retry follows reviewed policy rather than vendor defaults;
- every execution record names the exact binding and driver versions; and
- live readiness cannot rewrite design-time evidence.

## Required runtime behavior

### Wire mapping

Agent JSON Schema and legacy wire payloads are rarely identical. A generated
bridge needs a reviewed mapping for:

- domain fields to XML elements, message properties, serialized class fields,
  procedure parameters, or job parameters;
- required, default, omitted, and null behavior;
- encoding, decimal, date, time-zone, and enum representation;
- request, response, and fault envelope selection;
- stable business-error extraction; and
- payload and telemetry redaction.

Bind this mapping to the bridge-plan lineage. Handwritten mapping code that can
drift independently invalidates the approval boundary.

### Identity and secrets

Deployment configuration must resolve the binding's authorization mode and
scopes to a concrete local identity without placing secret values in the
binding, plan, generated catalog, or execution record.

Fail closed when a credential profile, certificate, channel identity, or
delegated-user token is absent. Falling back to a more privileged bridge
identity changes the reviewed authorization contract.

### Connection lifecycle

Vendor clients need bounded pools, reconnect policy, TLS configuration,
readiness, draining, and shutdown. TCP connectivity is not readiness. A bridge
must prove that its configured identity can reach the reviewed target without
performing a business mutation.

### Transactions and acknowledgement

Message drivers must define:

- when a send commits;
- when an inbound message is acknowledged;
- whether send and receive share a unit of work;
- what happens when reply processing fails; and
- where poison messages and exhausted attempts go.

Never expose a generic production queue consumer as an MCP tool. An interactive
agent can steal, acknowledge, reorder, or strand application-owned messages.
Inbound queues belong behind a separately operated event trigger with explicit
concurrency, acknowledgement, and dead-letter policy.

### Correlation and completion

Request/reply requires a reviewed answer to each of these questions:

- Who creates the correlation identifier?
- Is the carrier a request ID, transport message ID, or business key?
- How is the reply destination selected?
- How are concurrent replies demultiplexed?
- What happens to late replies after timeout?
- Can an authoritative status query reconcile an ambiguous outcome?

A reply is not automatically `business_completed`. The response schema and
evidence must establish that meaning.

### Idempotency and retry

A local deduplication ledger can suppress repeated bridge requests. It cannot
prove that the legacy application did not commit before a connection failed.

The runtime therefore needs explicit states such as reserved, dispatched,
transport accepted, application accepted, completed, rejected, timed out, and
ambiguous. Automatic retry remains disabled unless the reviewed binding proves
natural or client-key idempotency and the driver preserves the carrier exactly.

### Errors and execution records

Keep transport and business failure categories distinct:

```text
bridge_unavailable       driver cannot attempt the operation
transport_rejected       broker or server rejected the invocation
transport_timeout        completion is unknown after the deadline
business_rejected        authoritative application response rejected the request
response_invalid         response violates the reviewed output contract
```

Return reviewed stable business codes when possible. Operator diagnostics must
not leak hostnames, queue-manager details, stack traces, payloads, or secrets to
the agent.

Each invocation needs a redacted record containing the binding ID, bridge-plan
ID, driver ID and version, operation, outcome, attempt count, elapsed time,
correlation hash, and trace coordinates.

## Conformance obligations are generated today

`bridgePlan.conformance` contains required assertions derived from the binding.
Depending on its semantics, cases cover:

- exact target binding;
- wire serialization;
- authorization;
- timeout behavior;
- stable error mapping;
- completion truthfulness;
- readiness;
- telemetry;
- recorded fixtures;
- idempotency carrier preservation;
- bounded retry; and
- reply correlation.

These are test specifications, not passing test results, for every transport
this table's adapter families describe. For a message-queue request/reply
binding specifically, `anvil legacy bridge conformance` is now that runner —
see [The first executable bridge](#the-first-executable-bridge-queue-requestreply)
— and `LegacyBridgeConformanceReport` is its receipt format. Every other
transport still has neither.

## Adapter families still required

| Family | Required implementation work | Likely deployment shape |
| --- | --- | --- |
| JMS | Connection factories, destinations, selectors, transactions, acknowledgement, reply-to, serializers | Java sidecar near the application server or broker |
| IBM MQ | Queue-manager/channel/TLS references, MQMD properties, correlation, syncpoint, reason-code normalization | Java or native sidecar inside the MQ network boundary |
| WebLogic remote EJB | T3 client, JNDI bootstrap, subject propagation, serialization and client-library compatibility | Java sidecar with pinned WebLogic libraries |
| WebSphere remote EJB | IIOP/JNDI, security bootstrap, transaction behavior, vendor-client compatibility | Java sidecar with pinned WebSphere libraries |
| JBoss remote EJB | Remote EJB client configuration, naming, identity, serialization | Java sidecar with pinned JBoss libraries |
| WCF | `basicHttp`, `wsHttp`, `netTcp`, security modes, data contracts, fault normalization | Windows/.NET bridge near the service |
| MSMQ | Queue ACLs, recoverable messages, transactions, acknowledgements, poison handling | Windows service or .NET sidecar |
| JCA resource adapter | Managed connection factory, interaction spec, transaction and credential contract | Application-server-local component |
| Stored procedure | Parameter modes/types, transaction boundary, result-set pagination, database errors | Sidecar with narrow database identity |
| Batch or scheduler | Submission, job identity, status query, cancellation, terminal-state mapping | Adapter for the authoritative scheduler |

These are engineering requirements, not a support matrix.

## Build one complete vertical slice first

The most informative initial slice is an IBM MQ or JMS request/reply operation:

```text
refunds.submit
  → validate the reviewed business input
  → map it to the reviewed wire schema
  → write reviewed idempotency and correlation carriers
  → send to the pinned request destination in a defined unit of work
  → await only the pinned reply strategy
  → validate and map the reply
  → report completed, rejected, accepted, timed_out, or ambiguous truthfully
  → emit a redacted execution receipt
```

This forces the implementation to solve schema mapping, correlation,
transactions, ambiguous completion, idempotency, retry, secrets,
observability, packaging, and live readiness. A send-only demo proves
connectivity while avoiding most of the semantics that justify the review
protocol.

`@anvil/legacy-bridge` is a narrower cut of exactly this slice, done first
because it is cheap to make honest: schema mapping (pass-through JSON,
verified byte-for-byte), correlation, idempotent replay, timeout, and
non-retry are solved and conformance-tested; transactions, secrets/identity
resolution, packaging, and — the biggest one — live readiness against a real
broker are not. It proves the *shape* of a vertical slice is buildable and
testable without a live connection; it does not shorten the list above for a
real IBM MQ or JMS deployment.

## Definition of done for a driver

A driver must not become callable until it has:

- a versioned descriptor and deployment-configuration schema;
- deterministic generated artifacts bound to the bridge-plan hash;
- reviewed field and error mappings;
- secret references and least-privilege deployment guidance;
- validation before any transport call;
- timeout, cancellation, retry, and ambiguous-outcome behavior;
- transaction, acknowledgement, correlation, and dead-letter behavior where
  applicable;
- readiness, draining, and shutdown behavior;
- structured redacted execution records;
- tests for disconnects, duplicate delivery, late replies, malformed payloads,
  poison messages, cancellation, and partial commit;
- conformance results bound to the plan and generated artifact;
- integration evidence for each supported vendor/runtime version; and
- a domain MCP surface exposing no generic middleware primitive.

Runtime status must be derived from verified build, conformance, deployment,
and live-readiness evidence. Editing a binding or bridge-plan JSON file must
never enable execution.

## Keep live inventory acquisition separate

Deployment-local read-only exporters remain necessary where Git and supplied
files do not describe current state. Likely acquisition adapters include WLST,
WebSphere `wsadmin` or JMX, JBoss CLI, IIS/PowerShell, IBM MQ PCF or `runmqsc`,
and broker administration APIs.

Exporters should emit bounded, content-addressed offline evidence through the
inventory SDK. They must not share an execution identity with the business
bridge, consume messages, retain credentials, or convert management operations
into agent tools. `LegacyCollectorV2` defines the pure/offline parsing boundary;
it is not a live exporter interface.

## Continue

- [Understand the current legacy boundary](legacy-estates.md)
- [Build an offline inventory](legacy-inventory.md)
- [Use the TypeScript SDK](legacy-sdk.md)
- [Refine and approve a candidate](legacy-refinement.md)
