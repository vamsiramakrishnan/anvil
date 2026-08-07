# Design a deployment-local legacy bridge

An approved legacy capability binding is the input to a future runtime bridge.
It is not an executable bundle. This page defines the boundary a bridge must
preserve and makes the remaining engineering work explicit.

> **Current status:** Anvil does not generate, package, deploy, or run legacy
> bridge adapters. Every approved binding has `runtime.status = not_implemented`.

## Why the bridge belongs near the estate

Legacy transports often depend on network placement, vendor client libraries,
native configuration, local identity, or application-server class loading.
Moving those concerns into a generic hosted MCP server creates a broad network
and credential boundary.

The intended topology keeps the protocol adapter inside the deployment domain:

```text
coding harness or agent
        |
        | business-shaped MCP request
        v
generated domain MCP surface
        |
        | reviewed capability binding
        v
deployment-local bridge
        |
        | JMS / MQ / WCF / MSMQ / EJB / JCA / procedure / job
        v
legacy application
```

The agent sees `refunds.submit`. The bridge, not the agent, knows that the
operation uses `PAY.REFUND.V2`, a reply queue, a correlation property, and a
vendor serializer.

## What an approved binding gives the bridge

The binding carries four relevant contracts:

| Contract | Bridge responsibility |
| --- | --- |
| Business operation | Validate the developer-facing input and return the declared output and stable errors |
| Transport plan | Address only the reviewed destination, endpoint, method, procedure, or job |
| Operational semantics | Enforce timeout, authorization, idempotency, retry, and completion boundaries |
| Review lineage | Record which inventory, task, proposal, and receipt authorized this exact mapping |

The binding does not contain credentials, connection pools, vendor binaries,
network policy, wire field mappings, deployment health, or runtime evidence.
Those are separate adapter and platform concerns.

## The missing adapter contract

A production bridge needs a narrow runtime interface rather than a collection
of vendor-specific MCP tools. Conceptually, an adapter should support:

```ts
interface LegacyBridgeAdapter {
  prepare(binding: ApprovedLegacyBinding, deployment: DeploymentConfig): PreparedBinding;
  invoke(request: InvocationRequest, signal: AbortSignal): Promise<InvocationResult>;
  health(): Promise<AdapterHealth>;
  close(): Promise<void>;
}
```

This is a design target, not a currently exported Anvil interface. The eventual
contract must make the following explicit:

- binding and deployment configuration are separate;
- credentials are resolved by reference at runtime;
- one prepared adapter is pinned to reviewed targets and schemas;
- cancellation and deadlines flow through the transport;
- transport acceptance and business completion are different results;
- retry is selected by policy, not by a vendor client default; and
- every execution record names the binding identity.

## A bridge must implement more than connectivity

### Wire mapping

The agent-facing JSON Schema and the legacy wire payload are rarely identical.
The bridge needs reviewed mappings for:

- domain field to XML element, message property, serialized class field,
  procedure parameter, or job parameter;
- required/default/null behavior;
- text encoding, decimal and date representation, and enum mapping;
- request and response envelope selection;
- stable error extraction; and
- redaction rules.

Do not hide this mapping in handwritten application code without binding it to
the review lineage. Otherwise the approved schema and runtime behavior can
drift independently.

### Identity and secrets

The binding declares an authorization mode and scopes. Deployment configuration
must resolve those requirements to a concrete local identity without placing
secret values in the binding or MCP catalog.

The adapter must fail closed when a required credential profile, certificate,
channel identity, or delegated-user token is unavailable. Falling back to a
more privileged bridge identity changes the reviewed authorization contract.

### Connection lifecycle

Vendor clients need bounded pools, reconnect policy, TLS configuration,
readiness checks, draining, and shutdown. A successful TCP connection is not
sufficient readiness: the adapter must also prove that the configured identity
can reach the reviewed target without mutating it.

### Transactions and acknowledgement

Message transports require a documented unit of work:

- when a send is committed;
- when an inbound message is acknowledged;
- what happens if reply processing fails;
- whether send and receive share a transaction; and
- where poison messages and exhausted attempts go.

Never expose a generic production queue consumer as an MCP tool. An interactive
agent can steal, acknowledge, reorder, or strand messages owned by the
application. Inbound queues should enter through a separately operated event
trigger with explicit concurrency, acknowledgement, and dead-letter policy.

### Correlation and completion

For request/reply messaging, the bridge must define:

- who creates the correlation identifier;
- whether the request ID, message ID, or a business key is used;
- where the reply destination comes from;
- how concurrent replies are demultiplexed;
- what happens after timeout; and
- whether an authoritative status query can reconcile an ambiguous result.

A reply does not automatically mean `business_completed`. Its schema and
evidence must establish that meaning.

### Idempotency and retry

A local deduplication ledger can suppress a repeated bridge request. It cannot
prove that the legacy application did not commit before a connection failed.

The runtime therefore needs explicit states such as reserved, dispatched,
transport accepted, application accepted, completed, rejected, timed out, and
ambiguous. Automatic retry should remain disabled unless the reviewed binding
provides natural or client-key idempotency and the adapter can preserve the
carrier exactly.

### Errors and observations

Normalize transport and business failures separately:

```text
bridge_unavailable       local adapter cannot attempt the call
transport_rejected       broker/server rejected the invocation
transport_timeout        completion is unknown after the deadline
business_rejected        authoritative application response rejected the request
response_invalid         reply does not match the reviewed output contract
```

The generated operation should expose the reviewed stable business codes where
possible. Adapter diagnostics remain available for operators without leaking
hostnames, queue-manager details, stack traces, or secret material to the
agent.

Each invocation should emit a redacted execution record containing the binding
ID, operation, outcome state, attempt count, elapsed time, correlation hash,
adapter version, and relevant trace coordinates.

## Adapter families still required

| Family | Required runtime work | Deployment shape |
| --- | --- | --- |
| JMS | Connection factories, destinations, selectors, transactions, acknowledgement, reply-to, serializers | Java sidecar near the application server or broker |
| IBM MQ | Queue-manager/channel/TLS references, MQMD properties, correlation, syncpoint, reason-code normalization | Java or native sidecar inside the MQ network boundary |
| WebLogic remote EJB | T3 client, JNDI bootstrap, vendor libraries, subject propagation, serialization/class compatibility | Java sidecar with pinned WebLogic client libraries |
| WebSphere remote EJB | IIOP/JNDI, security bootstrap, vendor client compatibility, transaction semantics | Java sidecar with pinned WebSphere client libraries |
| JBoss remote EJB | Remote EJB client configuration, naming, identity, serialization | Java sidecar with pinned JBoss client libraries |
| WCF | `basicHttp`, `wsHttp`, `netTcp`, security modes, data contracts, fault normalization | Windows/.NET bridge near the service |
| MSMQ | Queue ACLs, recoverable messages, transactions, acknowledgements, poison handling | Windows service or .NET sidecar |
| JCA resource adapter | Managed connection factory, interaction spec, transaction and credential contract | Application-server-local Java component |
| Stored procedure | Driver, parameter modes/types, transaction boundary, result-set pagination, database errors | Sidecar with narrow database identity |
| Batch or scheduler | Submit, job identity, status query, cancellation, terminal-state mapping | Adapter for the authoritative scheduler |

These rows are not a support matrix. They are the work required before support
can be claimed.

## Build one vertical slice first

The highest-value first slice is a reviewed IBM MQ or JMS request/reply
operation:

```text
refunds.submit
  -> validate business input
  -> map to reviewed message schema
  -> write reviewed idempotency/correlation carriers
  -> send to the pinned request destination under a transaction
  -> await the pinned reply strategy
  -> validate and map the reply
  -> return completed, rejected, accepted, timed_out, or ambiguous truthfully
  -> emit a redacted execution receipt
```

This slice forces the architecture to solve the hard general problems:
separation of business and transport schemas, correlation, transactions,
ambiguous completion, idempotency, retry, secrets, observability, and
deployment-local packaging.

A send-only demo would prove connectivity but avoid most of the semantics that
make the SDK and review protocol valuable.

## Definition of done for an adapter

A protocol adapter should not move from `not_implemented` to callable until it
has:

- a versioned adapter and deployment configuration schema;
- reviewed field and error mappings bound to the capability binding;
- secret references and least-privilege deployment guidance;
- deterministic validation before any transport call;
- timeout, cancellation, retry, and ambiguous-outcome behavior;
- transaction, acknowledgement, correlation, and dead-letter behavior where
  applicable;
- health, readiness, draining, and shutdown behavior;
- structured redacted execution records;
- contract tests against the adapter interface;
- failure-injection tests for disconnects, duplicate delivery, late replies,
  malformed payloads, and poison messages;
- an integration test against the supported vendor/runtime version; and
- a generated domain MCP surface that exposes no generic middleware primitive.

The runtime status must be generated from verified adapter evidence. It must
not be changed by manually editing a binding JSON file.

## Live inventory exporters are a separate concern

Deployment-local read-only exporters will also be needed for estates where Git
and supplied files do not describe current state. Likely acquisition adapters
include WLST, WebSphere `wsadmin` or JMX, JBoss CLI, IIS/PowerShell, IBM MQ PCF
or `runmqsc`, and broker administration APIs.

Those exporters should emit bounded, content-addressed offline evidence. They
should not share an execution identity with the business bridge, consume
messages, retain credentials, or turn management operations into agent tools.

## Continue

- [Understand the current legacy boundary](legacy-estates.md)
- [Build an offline inventory](legacy-inventory.md)
- [Refine and approve a candidate](legacy-refinement.md)
- [Use the TypeScript SDK](legacy-sdk.md)
