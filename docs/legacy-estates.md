# Legacy application estates

Anvil can turn offline Java EE, .NET Framework, and messaging configuration into
an evidence-backed inventory of possible invocation boundaries. It can then
help a coding harness describe one candidate as a business operation and bind a
human review to that exact proposal.

It does not yet execute the approved binding. Today, the workflow ends with a
reviewed, content-addressed plan whose runtime status is `not_implemented`.

## Choose the right entry point

Start with the source that is authoritative for the system you need to expose:

| What you have | Start here | Why |
| --- | --- | --- |
| OpenAPI, WSDL, proto, GraphQL, OData, Discovery, or Postman contract | `anvil compile` or `anvil agentify` | A declared API contract is stronger than reconstructing one from deployment configuration. |
| An API gateway export | `anvil estate inventory` | Gateway inventory preserves API coordinates, policies, products, and gateway provenance. |
| Application-server, .NET, or broker configuration but no useful API contract | `anvil legacy inventory` | Legacy inventory discovers technical invocation candidates without pretending that configuration proves business meaning. |
| Only a running server and no safe offline export | Export first | The current collectors never connect to a live server, broker, queue, registry, or management plane. |

Do not use legacy inventory merely because the application is old. A maintained
WSDL is still an API contract. A queue declaration, JNDI binding, or WCF endpoint
is a weaker starting point because it says how something might be reached, not
what a caller is permitted to accomplish.

## The artifacts have different jobs

The workflow is easier to reason about when each artifact is read literally:

| Artifact | What it establishes | What it does not establish |
| --- | --- | --- |
| Collection plan | Which sources and evidence dimensions are required, with fail-closed acquisition policy | That Anvil acquired those sources or that the resulting inventory is complete |
| Inventory | Which bytes were inspected and which technical facts were observed | Business intent, permission, or a callable API |
| Candidate | A reconciled invocation coordinate with every supporting and conflicting claim retained | Which conflicting claim is correct |
| Evidence graph | Typed links from artifacts and evidence through observations to candidate lineage | New facts beyond the inventory |
| Coverage and gap plan | Which required evidence dimensions are satisfied, partial, missing, unsupported, or refused | That candidate yield equals semantic completeness |
| Candidate explanation | The observations, claims, unknowns, diagnostics, and artifacts behind one candidate | Approval or a preferred resolution for conflicts |
| Harness proposal | A proposed business operation, schemas, errors, transport plan, and operational semantics | Approval or runtime availability |
| Review receipt | A named reviewer accepted or rejected the exact assessed proposal | That a bridge was deployed or reached production |
| Capability binding | The approved operation and transport plan, bound to inventory, task, proposal, and receipt hashes | Executable Java, Windows, or broker connectivity |

This separation prevents two common errors: treating discovery as authority and
treating approval as deployment.

## The workflow

```text
fail-closed collection plan
  -> provenance-preserving offline exports
  -> content-addressed inventory
  -> conflict-preserving candidates
  -> evidence graph + coverage gaps + candidate explanations
  -> one hash-bound harness task
  -> deterministic proposal assessment
  -> separate human approval or rejection
  -> reviewed binding (runtime.status = not_implemented)
  -> future deployment-local bridge
  -> future business-shaped MCP tool
```

The harness can investigate source code, tests, schemas, runbooks, and change
records. It cannot remove required decisions from the task, approve its own
proposal, invent a destination, or turn broker acknowledgement into business
completion.

## Where the inventory comes from

A reliable inventory rarely comes from Git alone. Collect the smallest set of
offline exports needed to describe one deployment coordinate:

| Evidence source | Useful facts | Important limitation |
| --- | --- | --- |
| Source repository | Interfaces, serializers, validation, tests, and intended configuration | May not match the deployed revision |
| Artifact repository | Immutable EAR, WAR, JAR, RAR, DLL, or EXE bytes | Does not prove where an artifact is deployed |
| Deployed artifact export | Bytes installed for one application and environment | May omit external bindings |
| Application-server export | JNDI names, activation specs, endpoints, and resource mappings | Management configuration is not a business API |
| Broker export | Destinations, bindings, dead-letter policy, and transport coordinates | Does not prove the effect of a message |
| Runtime observation | Paths and payload shapes exercised in practice | Observed behavior is not the complete authorized contract |
| CMDB or service catalog | Owner, environment, lifecycle, and criticality | Usually lacks wire semantics |
| Runbook or change record | Operational intent and active-version decisions | Must be tied to an immutable revision or digest |

`anvil legacy plan` can describe several source roots and their distinct
contexts before collection. The TypeScript SDK can also attach an authority to
each `LegacySourceMember`; that member-level source overrides the invocation
default and survives into artifact and evidence records.

The filesystem CLI still assigns one `--source-kind`, `--source-id`, and
`--revision` to every member in one inventory run. Do not place unrelated Git,
broker, and production exports in one directory and label the directory as one
authority. Run separate CLI collections, or use the SDK with explicit
per-member sources. A collection plan validates intent and policy; it does not
acquire files, execute management commands, or merge inventories. Refinement is
still bound to one inventory.

## What Anvil understands today

### Java EE and application servers

- `application.xml`, `web.xml`, `ejb-jar.xml`, and `ra.xml`;
- explicit `javax.ejb` and `jakarta.ejb` source annotations for stateless,
  stateful, singleton, remote, local, and message-driven declarations;
- message-driven activation properties, including explicit destination and
  listener-interface declarations;
- resource references, destinations, connection factories, and resource
  adapters;
- WebLogic EJB bindings, JMS modules, deployment-plan modules, and domain JMS
  system resources;
- WebSphere/Liberty JMS destinations, connection factories, activation specs,
  and vendor bindings; and
- JBoss/WildFly EJB bindings, messaging destinations, pooled connection
  factories, and multiple JNDI aliases.

A local-only EJB remains local-only. A public implementation method is not
silently promoted to a remote capability. Simple annotation names count only
with an explicit `javax.ejb` or `jakarta.ejb` import. Java source inspection is
lexical and bounded: it does not compile code, run annotation processors,
resolve a build, or discover method schemas. `.class` members are recorded by
digest with a diagnostic; they are never loaded or executed.

### .NET Framework

- `web.config`, `app.config`, and `*.exe.config`;
- WCF services, endpoints, contracts, addresses, and configured bindings;
- `.svc` `ServiceHost` declarations and
  `serviceHostingEnvironment/serviceActivations`;
- declared base addresses, relative-address resolution, and protocol mappings;
- `netMsmqBinding` and MSMQ-backed endpoint coordinates; and
- explicit IIS or Windows Service deployment metadata supplied as JSON.

Assemblies are hashed but never loaded. The current collector does not
decompile IL or invoke reflection. A convention-only WCF service may receive a
runtime default endpoint, but Anvil does not invent its contract. It reports
`legacy/dotnet/default_endpoint_requires_contract_metadata` until an explicit
endpoint or bounded static contract export supplies that evidence. Conflicting
base addresses, binding settings, and protocol mappings remain ambiguous.

### Messaging

- bounded AsyncAPI JSON and YAML;
- IBM MQ MQSC and CCDT JSON;
- Artemis broker configuration;
- allowlisted RabbitMQ queue, exchange, binding, and topology arguments, even
  when an export also contains administration secrets that are excluded; and
- Kafka Admin topic collections, Schema Registry subjects, Strimzi
  `KafkaTopic`, and Strimzi `KafkaConnector` resources.

The collector never creates a producer or consumer and never samples a queue to
guess a schema.

### Content detection and explicit unknowns

In `auto` mode Anvil combines conservative filename checks with bounded content
signatures. This lets an arbitrarily named XML file containing a recognized
WebLogic/JBoss root, a `.java` file containing an EJB annotation, or a WCF file
containing `system.serviceModel` or `ServiceHost` reach the appropriate
collector. Detection is routing, not evidence: the collector must still parse
an explicit supported declaration.

A recognized artifact that produces no supported fact is not treated as a
successful empty result. It emits a stable diagnostic such as:

- `legacy/java-ee/no_discoverable_declaration`;
- `legacy/java-ee/source_annotation_incomplete`;
- `legacy/dotnet/no_discoverable_endpoint`; or
- `legacy/dotnet/default_endpoint_requires_contract_metadata`; and
- `legacy/<collector>/no_invocation_candidate` when useful declarations were
  retained but no callable technical boundary was proved.

These diagnostics are acquisition work. Renaming a file, suppressing a warning,
or asking a harness to guess the missing contract does not improve coverage.

## Reconciliation preserves disagreement

Suppose the same logical destination is mapped twice:

```text
ejb-jar.xml         resource-ref   jms/refundRequests
WebSphere export   binding        jms/refundRequests -> PAY.REFUND.V2
older export       binding        jms/refundRequests -> PAY.REFUND.V1
```

Anvil keeps both physical `binding_target` claims. Evidence ranking helps a
reviewer inspect stronger sources first; it never deletes the lower-ranked
assertion or chooses a convenient winner.

An MQ object and an AsyncAPI channel also remain separate candidates until
reviewed evidence establishes their relationship. A matching string is a lead,
not proof that two protocols describe the same business capability.

## Business shape is the point

The final agent surface should express the developer's or operator's intent:

```text
refunds.submit
refunds.get_status
```

It should not expose middleware administration as a universal tool:

```text
put_queue_message
consume_queue
invoke_any_ejb
call_any_mbean
```

Generic middleware tools discard the schema, effect, authorization, completion,
and retry constraints that make a capability safe enough to review. They also
give a harness more transport authority than the business operation requires.

## Current product boundary

Inventory, refinement, bridge-contract planning, and static driver-descriptor
assessment are implemented. Driver code generation, packaging, deployment,
conformance execution, live readiness, and invocation are not.

An approved binding always records:

```json
{
  "runtime": {
    "placement": "deployment_local_bridge",
    "status": "not_implemented"
  }
}
```

That value is not a placeholder to edit. It is a fail-closed statement that no
tested WebLogic, WebSphere, JBoss, IBM MQ, MSMQ, WCF, JCA, stored-procedure, or
batch adapter is present in this release.

Read [Designing deployment-local bridges](legacy-runtime-bridges.md) for the
runtime contract and the capabilities still required before a binding can
become callable.

## Continue

- [Build a legacy inventory](legacy-inventory.md)
- [Refine and review one candidate](legacy-refinement.md)
- [Use the legacy TypeScript SDK](legacy-sdk.md)
- [Design a deployment-local bridge](legacy-runtime-bridges.md)
