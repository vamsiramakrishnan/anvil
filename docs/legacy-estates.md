# Inventory legacy application estates

Anvil can discover callable *candidates* from legacy deployment artifacts,
application-server configuration, and messaging exports even when no HTTP API
description exists. Discovery is deliberately weaker than compilation: a queue,
EJB, WCF endpoint, or stored binding proves that an invocation boundary exists;
it does not prove what the business operation means or that an agent may use it.

Use the legacy workflow to answer three questions before building an MCP bridge:

1. What is deployed and how is it bound?
2. Which sources agree or conflict about that deployment?
3. Which candidates have enough reviewed semantics to become AIR operations?

No inventory command connects to a live server, executes bytecode, loads a .NET
assembly, expands an untrusted archive, reads secrets, consumes a queue, or creates
an MCP tool.

## Start from evidence, not a vendor name

A legacy inventory rarely comes from one authoritative repository. Capture the
offline exports available for the selected environment:

| Evidence | What it can establish | What it cannot establish |
| --- | --- | --- |
| Git checkout | Intended source, descriptors, schemas, and configuration | The bytes or configuration deployed now |
| Artifact repository | The immutable EAR, WAR, JAR, RAR, DLL, or executable that was built | The environment where it runs |
| Deployed artifact export | The application bytes installed at one deployment coordinate | Runtime bindings held outside the artifact |
| Application-server export | Modules, JNDI/JCA resources, endpoints, and environment topology | Business meaning and authorization |
| Broker export | Destinations, bindings, delivery policy, and schema coordinates | The application effect of a message |
| Runtime observation | Shapes and paths exercised in practice | The complete permitted contract |
| CMDB/catalog export | Owner, criticality, environment, and lifecycle | Callable wire semantics |
| Reviewed Anvil manifest | Accepted business meaning and safety posture | Whether the runtime is reachable now |

Anvil retains these as separate evidence lanes. It does not let Git silently
override production configuration, or let one observed message override the
declared schema.

## Prepare an offline collection

Export or harden-expand the selected artifacts into one directory. Keep source
lanes separate when practical:

```text
refunds-prod/
├── deployments/
│   ├── refund-service/META-INF/application.xml
│   ├── refund-service/META-INF/ejb-jar.xml
│   └── refund-service/WEB-INF/web.xml
├── middleware/
│   ├── websphere-jndi.xml
│   └── activation-specs.xml
├── messaging/
│   ├── queue-manager.mqsc
│   ├── ccdt.json
│   └── asyncapi.yaml
├── dotnet/
│   └── refund-worker.exe.config
└── ownership/
    └── applications.json
```

Do not place credentials, keystores, message payloads, heap dumps, or database
contents in the collection. Use names of credential profiles and secret aliases,
not their values.

The first implementation accepts regular files and directories. It refuses
symbolic links and never opens nested archives. Expand an EAR, WAR, RAR, or ZIP
through an existing hardened artifact pipeline before inventorying it.

## Inventory the collection

```bash
anvil legacy inventory refunds-prod \
  --environment prod \
  --application refund-service \
  --out refunds-prod.inventory.json
```

Use `--collector java-ee`, `--collector dotnet`, or `--collector messaging` to
select one lane. The default `auto` lane runs every applicable offline collector
and reconciles their observations.

Use `--json` when another harness drives the command. The inventory is content
addressed: member hashes, normalized observations, explicit conflicts, and the
resulting inventory hash are deterministic. Collection time is provenance only
and never part of identity.

### Drive the same pipeline from the SDK

Use the Node-only legacy compiler entrypoint when a coding harness already owns
artifact acquisition:

```ts
import { collectLegacyInventory } from "@anvil/compiler/legacy";

const result = collectLegacyInventory({
  estate: { id: "refunds-prod" },
  environment: "prod",
  application: "refund-service",
  source: {
    kind: "deployed_configuration",
    systemId: "websphere-export",
    revision: "sha256:export-receipt-or-revision",
  },
  collector: "auto",
  members: [{ path: "refunds/META-INF/ejb-jar.xml", bytes }],
});
```

The SDK returns the verified snapshot, reconciled candidates, and collector-run
summary. It accepts caller-supplied bytes and performs no filesystem or network
access. The caller remains responsible for acquiring those bytes safely; use the
CLI when you want Anvil's bounded, no-symlink directory reader.

## What the collectors understand

The initial collectors intentionally cover declarative configuration rather than
pretending to understand an entire application server:

### Java EE

- `application.xml`, `web.xml`, `ejb-jar.xml`, and `ra.xml`;
- session-bean remote/local declarations;
- message-driven beans and activation properties;
- resource references, resource-environment references, JNDI mappings, connection
  factories, destinations, and resource adapters; and
- grounded WebLogic, WebSphere, and JBoss binding fragments.

A local-only EJB is reported as local-only. It is not converted into a remotely
callable candidate merely because its implementation class is public.

### .NET Framework

- `web.config`, `app.config`, and `*.exe.config`;
- WCF services, endpoints, contracts, addresses, and configured bindings;
- `netMsmqBinding` and MSMQ-backed endpoint coordinates; and
- explicit IIS or Windows Service deployment metadata supplied as JSON.

DLL and EXE files are content-addressed but remain opaque. The collector never
loads them into the Anvil process. A future Windows collector may run trusted SDK
metadata tools in a separate sandbox and return their offline output.

### Messaging

- bounded AsyncAPI JSON/YAML channel, message, operation, and binding declarations;
- Artemis broker configuration;
- RabbitMQ definitions exports;
- Kafka topic/schema-registry manifests supplied as JSON;
- IBM MQ MQSC declarations and CCDT JSON coordinates; and
- declared request/reply, destination, correlation, and dead-letter facts where
  the source actually states them.

The messaging collector never creates a consumer. In particular, it does not
sample a production queue to guess a schema.

## Reconciliation does not choose a convenient winner

Consider four observations:

```text
ejb-jar.xml       resource-ref       jms/refundRequests
WebSphere export jndi mapping       jms/refundRequests → PAY.RFND.V2
MQSC              local queue        PAY.RFND.V2
AsyncAPI          message schema     RefundCommandV3
```

The Java declaration and its WebSphere mapping can reconcile into one logical
invocation because the component coordinate is stable. If another server export
maps that same logical name to `PAY.RFND.V1`, the candidate carries both physical
`binding_target` claims and an explicit conflict. Source ranking may tell a
reviewer which evidence is normally stronger; it never deletes the losing claim.

The MQ object and AsyncAPI channel remain separate candidates until reviewed
evidence establishes their cross-protocol relationship. Matching strings are
useful leads, not proof that two systems mean the same thing.

Every candidate begins in `triage` or `review_required`. Inventory alone cannot set:

- business effect or risk;
- reversibility;
- idempotency or safe retry;
- end-user versus service authority;
- human-confirmation policy;
- agent-facing field names; or
- permission to publish or consume messages.

Those facts enter through reviewed evidence and Anvil's existing refinement and
approval rails.

## From inventory to an MCP bridge

The intended progression is:

```text
offline evidence
  → legacy inventory
  → conflict-preserving reconciliation
  → reviewed capability selection
  → AIR interaction + transport binding
  → generated domain MCP
  → deployment-local Java or Windows bridge
```

The MCP surface must remain domain-shaped. A reviewed candidate might eventually
produce `submit_refund` plus `get_refund_status`; it must not produce generic
`put_queue_message`, `consume_queue`, `invoke_any_ejb`, or `call_any_mbean` tools.

Transport acknowledgement and business completion are different states. If a
broker accepted a message but no reply or authoritative status source exists, the
bridge may report `accepted`; it may not claim `completed`. A generated correlation
identifier can track work and suppress a local replay, but it does not make the
legacy application idempotent.

## Trust boundary

- Run vendor-specific live collectors, when they exist, inside the customer's
  network and export their result for offline ingestion.
- Give collectors read-only identities and narrowly scoped inventory permissions.
- Keep credentials outside inventory artifacts.
- Treat JMX, wsadmin, WLST, JBoss management, IIS administration, and broker admin
  surfaces as operational evidence—not business APIs.
- Never expose an inbound queue as a generic MCP consumer; doing so can steal or
  acknowledge application messages.
- Require a new content-addressed inventory when any artifact, binding, destination,
  environment, or candidate evidence changes.
