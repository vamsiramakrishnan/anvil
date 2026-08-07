# Design a deployment-local legacy bridge

An approved capability binding can now be compiled into a deterministic bridge
plan and assessed against a driver descriptor. It still cannot be executed.

> **Current status:** Anvil does not generate, package, deploy, load, or run a
> legacy bridge. Every bridge plan has `executionAllowed: false`. Static driver
> compatibility is not runtime support.

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
exported `generate`, `prepare`, `invoke`, `health`, or `close` method. This is
intentional: Anvil can define and assess the contract before exposing a
runtime it cannot yet secure or test.

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

These are test specifications, not passing test results. Anvil currently does
not supply a runner or receipt format for them.

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
