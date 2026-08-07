# Legacy estate corpus: expanded GitHub run

This backtest runs `anvil legacy inventory` against 16 files from real,
publicly licensed GitHub projects at immutable commits. It covers WebLogic,
WebSphere, JBoss/WildFly, .NET Framework/WCF, IBM MQ, ActiveMQ Artemis,
RabbitMQ, Kafka Connect, Kafka/Strimzi, and AsyncAPI 3.

The headline is useful but not a production-readiness claim:

- **13 of 16 inputs (81.3%) produced actionable candidates.** Eleven were cleanly
  supported and two were partial, with the warning preserved.
- **2 of 16 were correctly refused for safety.** One old WebLogic descriptor
  used a DTD; one credential-bearing RabbitMQ export contained no projectable
  topology.
- **1 of 16 produced no candidate.** The convention-only WCF sample contains
  no explicit endpoint or static contract metadata, and Anvil reports that exact gap.
- **All 16 reports were deterministic and passed sensitive-output exclusion.**
  Each input was run twice through the public CLI with byte-identical output;
  credential, user, permission, and authentication-secret fields were absent.

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
| WildFly `@MessageDriven` quickstart | Supported | The inert Java source lane recovered the MDB, destination, listener type, and activation properties without compiling or loading code. |
| WCF convention-only HTTP service | Unsupported | The config has bindings and behaviors but no explicit endpoint; Anvil returned `dotnet/no_discoverable_endpoint`. |
| WCF transacted MSMQ service | Supported | The MSMQ endpoint and metadata endpoint became two distinct candidates. |
| IBM MQ MQSC request/reply setup | Partial | Three objects were recovered, but MQSC itself supplied no queue-manager coordinate. |
| IBM MQ CCDT | Supported | Three client channels retained their queue-manager and connection facts. |
| Artemis broker XML | Supported | One address and one queue became distinct candidates. |
| AsyncAPI 3 Kraken request/reply | Supported | Six logical channels and six operations remained distinct even when several shared the `/` WebSocket address. |
| AsyncAPI 3 Kafka request/reply | Supported | Logical request/reply channels, dynamic reply-address location, message references, and Kafka bindings were retained; secret-bearing security configuration was excluded. |
| RabbitMQ topology export | Supported | Four queues, one exchange, and five routing bindings were recovered. |
| RabbitMQ export with topology and a password | Supported | Six queues, six exchanges, and eleven bindings were projected; users, permissions, and the password were excluded. |
| RabbitMQ credential-only export | Safety refusal | With no safe topology to project, the document failed closed. |
| Strimzi `KafkaTopic` | Supported | The topic, cluster label, partitions, replicas, and allowlisted topic configuration were recovered. |
| Strimzi source `KafkaConnector` | Supported | The connector class, cluster, task count, topic, and source direction were recovered without executing the connector. |

## What works well

Anvil is strongest when the artifact is an explicit deployment or broker
export. Modern WebLogic/WebSphere binding descriptors, WCF endpoints, IBM MQ
MQSC/CCDT, Artemis broker XML, and RabbitMQ topology all yielded stable,
evidence-linked candidates. It did not invent business verbs or pretend an
unknown message direction was known.

The refusal and projection behavior is also valuable. The collector did not
resolve an old WebLogic DTD. It safely projected topology from one RabbitMQ
export containing credentials, while refusing another that had no topology.
Both paths were structured, deterministic, and free of secret-bearing output.

## Where it falls short

### 1. Source annotations work; compiled-only metadata remains a gap

Modern JBoss/WildFly applications often declare MDBs with `@MessageDriven` and
`@ActivationConfigProperty` instead of `ejb-jar.xml`. Auto-detection now finds
that source shape, and the collector only accepts simple annotation names when
the file imports `javax.ejb` or `jakarta.ejb`. Same-named application
annotations do not become false positives.

Compiled `.class` files remain digest-only. A future fallback may inspect
bounded static class metadata, but it must never classload or execute bytecode,
and its lower evidence authority must remain visible.

### 2. WCF can fail silently

WCF configuration permits convention-based service activation and default
endpoints. The real HTTP sample contains `system.serviceModel`, bindings, and
behaviors but no explicit `<service><endpoint>`. Anvil now emits
`dotnet/no_discoverable_endpoint` instead of failing silently. Better coverage needs
`.svc` activation and `serviceActivations` are now captured, as are explicit
base addresses, protocol mappings, and ambiguity. The remaining gap is bounded
static contract metadata and safe cross-file correlation; Anvil deliberately
does not turn an activation class name into a callable contract.

### 3. Old DTD-based Java EE needs a safe compatibility path

Rejecting all `DOCTYPE` declarations is a sound default because entity
expansion and external resolution are dangerous. It also excludes genuine
WebLogic 7-era descriptors, precisely the estate this feature targets.

Do not enable a general DTD resolver. Add a tightly bounded normalizer that
rejects every entity declaration and external read, recognizes an allowlisted
legacy public identifier, strips only the inert document-type declaration, and
then passes the remaining XML through the existing safe parser. Preserve a
diagnostic that the descriptor was normalized.

### 4. AsyncAPI identity now survives shared transport addresses

The AsyncAPI 3 sample models several logical WebSocket channels at the same `/`
address. Channel and operation coordinates now use logical keys, while the
physical address remains a separate fact. Reply channels, dynamic reply-address
locations, correlation locations, message IDs, content types, and discriminator
properties are retained when declared. The inventory normalizer now keeps the
logical channel separate from the physical address, projects request/reply and
schema claims, and carries the result into the product-level evidence graph.
Cross-file schema-subject linkage remains future work.

### 5. Kafka coverage now includes common control-plane artifacts

The collector accepts Anvil manifests, Strimzi `KafkaTopic` and
`KafkaConnector`, Confluent-style Kafka Admin topic collections, and Schema
Registry subject/version responses. Schema bodies are reduced to SHA-256
digests; subject identity, type, version, compatibility, ID, and references are
retained. Coverage is still not broad until Kafka CLI text, Connect REST
responses, MirrorMaker, Schema Registry compatibility exports, and multi-file
topic-to-subject linking have pinned specimens.

### 6. Useful context is sometimes outside the file

MQSC has no portable queue-manager identity, so all three objects correctly
land under `unspecified`. The new collection-plan DSL can request queue manager,
cluster, cell/node/server, IIS site, and application-module context, while
per-member source metadata preserves which system supplied each artifact. The
remaining work is acquisition adapters that fulfill those requests from
deployment tooling without laundering context into parser-derived facts.

### 7. RabbitMQ projection is safe but deliberately narrow

RabbitMQ definitions are projected through allowlisted queue, exchange,
binding, and topology-argument fields. Users, permissions, policies,
parameters, credential hashes, and passwords are not traversed into
observations. A secret-bearing export with topology remains useful; an export
with only sensitive administration state fails closed. Future expansion should
add separately reviewed policies and federation/shovel topology without
weakening this projection boundary.

## Recommended implementation order

1. Add bounded Java class metadata and WCF contract metadata without loading code.
2. Add the constrained legacy-DOCTYPE normalizer.
3. Implement collection adapters for Git, artifact repositories, deployment exports, CMDBs, and broker control planes against the versioned Collector V2 boundary.
4. Link multi-file schema subjects, reply/correlation facts, activation declarations, and physical bindings across complete deployment bundles.
5. Add Kafka CLI, Connect REST, MirrorMaker, and compatibility-export specimens.
6. Add separately allowlisted RabbitMQ policy, federation, and shovel projections.
7. Implement deployment-local bridge drivers and recorded conformance tests; keep execution blocked until a driver is compatible and live readiness is verified.

The benchmark should grow by failure mode, not by repository count. Each new
collector adapter needs at least one clean case, one ambiguous case, and one
secret/unsafe case from a pinned public source.
