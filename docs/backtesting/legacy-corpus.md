# Legacy estate corpus: first GitHub run

This backtest runs `anvil legacy inventory` against 13 files from real,
publicly licensed GitHub projects at immutable commits. It covers WebLogic,
WebSphere, JBoss/WildFly, .NET Framework/WCF, IBM MQ, ActiveMQ Artemis,
RabbitMQ, Kafka/Strimzi, and AsyncAPI 3.

The headline is useful but not a production-readiness claim:

- **8 of 13 inputs (61.5%) produced actionable candidates.** Five were cleanly
  supported and three were partial, with the warning or conflict preserved.
- **2 of 13 were correctly refused for safety.** One old WebLogic descriptor
  used a DTD; one RabbitMQ export contained an active password.
- **3 of 13 produced no candidate.** Annotation-only WildFly, convention-only
  WCF, and a standard Strimzi `KafkaTopic` resource remain unsupported.
- **All 13 reports were deterministic.** Each input was run twice through the
  public CLI with byte-identical output.

The corpus and executable oracles live in
[`tools/legacy-corpus`](https://github.com/vamsiramakrishnan/anvil/tree/main/tools/legacy-corpus).
Third-party files are fetched by pinned commit and digest; they are not copied
into this repository.

## Results

| Specimen | Result | What Anvil recovered |
| --- | --- | --- |
| KIE Server WebLogic bindings | Supported | Two JMS-consuming candidates with destination and connection-factory evidence. |
| Apache TomEE WebLogic 7 descriptor | Safety refusal | The DTD-bearing XML was rejected without resolving or loading it. |
| Open Liberty WebSphere bindings | Partial | Nine JMS-consuming candidates; one opaque session binding remained explicit. |
| WildFly `@MessageDriven` quickstart | Unsupported | Java annotations are not an input lane, so no collector ran. |
| WCF convention-only HTTP service | Unsupported | The config has bindings and behaviors but no explicit endpoint; Anvil returned zero candidates and no diagnostic. |
| WCF transacted MSMQ service | Supported | The MSMQ endpoint and metadata endpoint became two distinct candidates. |
| IBM MQ MQSC request/reply setup | Partial | Three objects were recovered, but MQSC itself supplied no queue-manager coordinate. |
| IBM MQ CCDT | Supported | Three client channels retained their queue-manager and connection facts. |
| Artemis broker XML | Supported | One address and one queue became distinct candidates. |
| AsyncAPI 3 Kraken request/reply | Partial | Operations were recovered, but seven logical channels sharing `/` collapsed into one explicit schema conflict. |
| RabbitMQ topology export | Supported | Four queues, one exchange, and five routing bindings were recovered. |
| RabbitMQ export with a password | Safety refusal | The entire document was refused; no secret-bearing evidence was retained. |
| Strimzi `KafkaTopic` | Unsupported | The real CRD shape does not match Anvil's current custom `topics[]` manifest. |

## What works well

Anvil is strongest when the artifact is an explicit deployment or broker
export. Modern WebLogic/WebSphere binding descriptors, WCF endpoints, IBM MQ
MQSC/CCDT, Artemis broker XML, and RabbitMQ topology all yielded stable,
evidence-linked candidates. It did not invent business verbs or pretend an
unknown message direction was known.

The refusal behavior is also valuable. The collector did not resolve an old
WebLogic DTD, and it did not ingest a RabbitMQ export containing a password.
Both failures were structured and deterministic rather than parser crashes.

## Where it falls short

### 1. Source annotations are invisible

Modern JBoss/WildFly applications often declare MDBs with `@MessageDriven` and
`@ActivationConfigProperty` instead of `ejb-jar.xml`. The current auto
collector ignores `.java` and class metadata, so a common application shape
looks empty.

Add a non-executing source/metadata lane that can read Java annotations and
constant strings. It must never classload or execute bytecode. A compiled-code
fallback should inspect static class metadata only and keep its lower evidence
rank visible.

### 2. WCF can fail silently

WCF configuration permits convention-based service activation and default
endpoints. The real HTTP sample contains `system.serviceModel`, bindings, and
behaviors but no explicit `<service><endpoint>`. Anvil selected the .NET
collector, returned zero observations, and emitted no diagnostic.

At minimum, a recognized WCF document with no discoverable endpoint should
emit `dotnet/no_discoverable_endpoint` with remediation. Better coverage needs
`.svc` activation, `serviceActivations`, code/config correlation, and default
endpoint rules—still without loading the assembly.

### 3. Old DTD-based Java EE needs a safe compatibility path

Rejecting all `DOCTYPE` declarations is a sound default because entity
expansion and external resolution are dangerous. It also excludes genuine
WebLogic 7-era descriptors, precisely the estate this feature targets.

Do not enable a general DTD resolver. Add a tightly bounded normalizer that
rejects every entity declaration and external read, recognizes an allowlisted
legacy public identifier, strips only the inert document-type declaration, and
then passes the remaining XML through the existing safe parser. Preserve a
diagnostic that the descriptor was normalized.

### 4. AsyncAPI needs operation-level channel identity

The AsyncAPI 3 sample models several logical WebSocket channels at the same `/`
address and distinguishes them with message/discriminator semantics. Anvil
keeps the disagreement as a conflict—which is safer than choosing—but loses the
operation-level identity a harness needs for request/reply refinement.

Keep the channel key separate from its physical address, preserve correlation
IDs and reply relationships, and treat message discriminators as routing facts.

### 5. Kafka support targets a custom manifest, not common estate exports

The collector accepts an Anvil-shaped `topics[]`/`schemaRegistry.subjects[]`
document. A standard Strimzi `KafkaTopic` custom resource is reported as
unsupported. Add adapters for Strimzi resources, Kafka Admin API JSON exports,
and Schema Registry subject/config exports before calling Kafka coverage broad.

### 6. Useful context is sometimes outside the file

MQSC has no portable queue-manager identity, so all three objects correctly
land under `unspecified`. The SDK/CLI needs an explicit collection-context
object (queue manager, cluster, cell/node/server, IIS site, application module)
whose provenance is recorded separately from facts parsed out of the file.

### 7. Whole-document secret refusal sacrifices safe topology

The RabbitMQ safety case proves Anvil will not retain an active password, but it
also loses otherwise safe queues, exchanges, and bindings. A RabbitMQ-specific
projection can copy only allowlisted topology sections and ignore users,
permissions, credential hashes, and parameters before general normalization.
The original artifact should remain digest-only; secret values must never enter
evidence, diagnostics, logs, or reports.

## Recommended implementation order

1. Emit a diagnostic whenever a recognized artifact yields zero observations.
2. Add allowlisted, secret-free RabbitMQ topology projection.
3. Add Strimzi `KafkaTopic` and Schema Registry export adapters.
4. Preserve AsyncAPI channel keys, discriminators, correlation IDs, and reply links.
5. Add non-executing Java annotation and WCF activation discovery.
6. Add the constrained legacy-DOCTYPE normalizer.
7. Add explicit, separately evidenced collection context for queue managers and application-server coordinates.

The benchmark should grow by failure mode, not by repository count. Each new
collector adapter needs at least one clean case, one ambiguous case, and one
secret/unsafe case from a pinned public source.
