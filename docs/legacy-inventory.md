# Build a legacy inventory

Use legacy inventory to extract technical evidence from captured application,
server, and broker configuration. The result helps identify capabilities and
missing facts before proposing an integration.

Inventory does not establish business meaning or executable access. Continue
through review and a [supported runtime bridge](legacy-runtime-bridges.md)
when the goal is to invoke the capability.

## Before you begin

You need:

- Node.js 22.17 or later and a built Anvil checkout;
- one regular file or one already-expanded directory;
- a stable environment and application coordinate; and
- a truthful description of where the export came from.

If you have an EAR, WAR, RAR, ZIP, or another archive, expand it through your
existing hardened artifact pipeline first. Anvil does not open nested archives.

Do not include credentials, private keys, keystores, production message bodies,
heap dumps, database contents, or secret values. Configuration may refer to a
credential profile or secret alias, but the value belongs in the deployment's
secret system.

## 1. Declare what complete evidence means

For a non-trivial estate, begin with a collection plan. The plan records source
roots, deployment context, required evidence dimensions, and the only supported
acquisition policy: offline, bounded, secret-refusing, and non-executing.

```json
{
  "schemaVersion": 1,
  "estate": { "id": "payments-au" },
  "sources": [
    {
      "id": "refunds-source",
      "kind": "source_repository",
      "systemId": "github-refunds",
      "root": "source",
      "revision": "8ce12d4",
      "expectedRoles": ["source_manifest", "deployment_descriptor"],
      "context": {
        "environment": "prod",
        "application": "refund-service",
        "platform": "weblogic-14",
        "domain": "payments-domain",
        "cluster": "payments-cluster"
      }
    },
    {
      "id": "refunds-broker",
      "kind": "broker_configuration",
      "systemId": "mq-prod",
      "root": "exports/mq",
      "revision": "export-17",
      "expectedRoles": ["broker_export"],
      "context": {
        "environment": "prod",
        "application": "refund-service",
        "queueManager": "PAYMENTS.QM1"
      }
    }
  ],
  "requirements": [
    "deployment_identity",
    "invocation_binding",
    "message_direction",
    "input_schema",
    "error_semantics"
  ],
  "policy": {
    "networkAccess": "deny",
    "processExecution": "deny",
    "classloading": "deny",
    "bytecodeExecution": "deny",
    "xmlExternalEntities": "deny",
    "secrets": "refuse",
    "archiveExpansion": "hardened",
    "unknownArtifacts": "report",
    "unsupportedEvidence": "fail",
    "ambiguousEvidence": "fail"
  }
}
```

Address and validate it:

```bash
pnpm anvil legacy plan collection-plan.json \
  --out collection-plan.report.json
```

Repository and artifact-repository sources require an immutable `revision`.
The command does not clone repositories, connect to servers, expand archives,
or run export commands. It gives the collection intent a deterministic
`planId`; acquisition remains an explicit external step.

## 2. Prepare provenance-consistent inputs

Keep the collection scoped to one application, one environment, and one
evidence authority. For example:

```text
refunds-prod-websphere/
├── refund-service/
│   ├── META-INF/application.xml
│   ├── META-INF/ejb-jar.xml
│   └── WEB-INF/web.xml
└── server-export/
    ├── ibm-ejb-jar-bnd.xml
    └── activation-specs.xml
```

All members of one filesystem CLI invocation receive the same `--source-kind`,
`--source-id`, and `--revision`. If the repository checkout and production
server export have different provenance, inventory them separately rather than
presenting both as production configuration.

The TypeScript SDK supports a `source` override on each `LegacySourceMember`.
Use that when one inventory genuinely needs several authorities and the caller
can map every member to its source. Anvil preserves those authorities per
artifact; it does not upgrade source-repository evidence into deployed truth.
The CLI does not merge several inventories into one cross-source snapshot.
Do not fabricate a shared provenance label to force a merge.

## 3. Choose the evidence coordinates

Use stable coordinates that another developer can recognize later:

```bash
pnpm anvil legacy inventory ./refunds-prod-websphere \
  --estate payments-au \
  --estate-name "Payments Australia" \
  --environment prod \
  --application refund-service \
  --source-kind deployed_configuration \
  --source-id websphere-prod-cell-1 \
  --revision sha256:4a12... \
  --out refunds-prod.inventory.json
```

`--revision` should identify the immutable export, artifact, or repository
revision. It is optional because some operational exports do not provide one,
but omitting it weakens later review.

Common source kinds are:

| Source kind | Use it for |
| --- | --- |
| `deployed_artifact` | An artifact exported from the selected running deployment |
| `deployed_configuration` | Application-server, IIS, or service configuration exported from that deployment |
| `broker_configuration` | MQ, Artemis, RabbitMQ, Kafka, or related broker configuration |
| `artifact_repository` | Immutable bytes downloaded from an artifact repository |
| `source_repository` | A checkout pinned to a commit |
| `runtime_observation` | A bounded, approved observation captured outside Anvil |
| `service_catalog` | CMDB or ownership data |
| `documentation` | A revisioned design, runbook, or interface contract |
| `operator_attestation` | A separately authenticated operator statement |
| `naming_inference` | A name-based lead with the weakest authority |

Use `naming_inference` only when the evidence is genuinely a naming clue. A
plausible queue name is not deployed configuration.

## 4. Run the appropriate collector

The default `auto` mode runs each applicable offline collector:

```bash
pnpm anvil legacy inventory ./refunds-prod-websphere \
  --environment prod \
  --application refund-service \
  --out refunds-prod.inventory.json
```

Select one vocabulary when the collection is intentionally narrow:

```bash
pnpm anvil legacy inventory ./mq-export \
  --environment prod \
  --application refund-service \
  --source-kind broker_configuration \
  --source-id ibm-mq-qm-payments \
  --collector messaging \
  --out refunds-mq.inventory.json
```

Valid collector values are `auto`, `java-ee`, `dotnet`, and `messaging`.

`auto` does not depend only on familiar filenames. It examines a bounded prefix
for supported signatures, including Java EJB annotations, WebLogic/JBoss XML
roots, WCF `system.serviceModel` and `ServiceHost`, Strimzi resources, and known
broker export shapes. Content detection only selects a collector. It does not
make an unsupported declaration authoritative.

For Java source, simple annotation names require an explicit `javax.ejb` or
`jakarta.ejb` import. The collector reads EJB type declarations and activation
properties without compiling source. It never runs annotation processors or
loads `.class` files. For WCF, `.svc` and `serviceActivations` establish hosting
identity; they do not prove a service contract. Relative endpoints are resolved
only when one compatible declared base address exists.

### Try the repository fixture

The synthetic WebLogic fixture declares one remote refund EJB and two competing
JNDI targets. It gives you a deterministic conflict to inspect:

```bash
node packages/cli/dist/bin-anvil.js legacy inventory \
  examples/legacy-refunds/export \
  --estate payments-example \
  --environment prod \
  --application refund-service \
  --source-kind deployed_configuration \
  --source-id weblogic-example \
  --revision fixture-v1 \
  --out generated/legacy-refunds.inventory.json

jq '.summary, .candidates[].conflicts' \
  generated/legacy-refunds.inventory.json
```

The report contains one candidate and one `binding_target` conflict between
`ejb/refunds-v1` and `ejb/refunds-v2`. See the
[fixture walkthrough](../examples/legacy-refunds/README.md) to create its
refinement task.

The CLI filesystem boundary is bounded:

| Limit | Value |
| --- | ---: |
| Files per collection | 20,000 |
| Bytes per file | 16 MiB |
| Total bytes | 512 MiB |

The command refuses symbolic links, path escape, non-regular members, empty
collections, and different content at an existing output path. These are
refusals, not files to skip silently.

## 5. Project the evidence graph

Project the inventory into typed, evidence-linked nodes and edges:

```bash
pnpm anvil legacy graph refunds-prod.inventory.json \
  --out refunds-prod.graph.json
```

The graph preserves artifact, evidence, observation, deployment occurrence,
logical lineage, and candidate relationships. It is a deterministic view of
the inventory, not a second inference engine. If the inventory lacks a schema,
owner, destination, or contract, the graph lacks it too.

## 6. Measure coverage and generate acquisition work

Candidate count measures collector yield. It does not measure whether a harness
can safely expose the operation. Assess the inventory against the plan:

```bash
pnpm anvil legacy gaps refunds-prod.inventory.json \
  --plan collection-plan.report.json \
  --out refunds-prod.gaps.json
```

The report classifies collector outcomes as `supported`, `partial`,
`unsupported`, or `safety-refusal`, then evaluates every required evidence
dimension. Its gap plan names the missing evidence and acceptable source kinds.
Use `--check` only when CI should fail unless semantic coverage is complete.

`authorization_context` and `completion_semantics` currently remain missing:
the inventory model does not treat transport acknowledgement or configuration
as proof of either. A plan requiring those dimensions will therefore fail
`legacy gaps --check` until appropriately modeled evidence is available.

## 7. Explain one candidate before refinement

Trace one exact candidate back to every claim, observation, diagnostic, and
source artifact:

```bash
candidate_id=$(jq -r '.candidates[0].candidateId' refunds-prod.inventory.json)
pnpm anvil legacy explain refunds-prod.inventory.json "$candidate_id" \
  --out refunds-prod.candidate.json
```

Use the exact `lc_` identifier from the inventory. Unknown dimensions remain in
the explanation. The command does not rank competing values or choose a binding
for the reviewer.

## 8. Read the inventory report

The output contains four kinds of captured fact and a separate reconciliation
result:

| Field | Read it as |
| --- | --- |
| `inventory.artifacts` | Exact source members and their identities |
| `inventory.evidence` | Addressable excerpts or facts derived from those members |
| `inventory.observations` | Collector statements about a deployment coordinate and invocation |
| `inventory.diagnostics` | Unsupported, malformed, duplicate, ambiguous, or otherwise notable input |
| `candidates` | Observations reconciled only where the technical coordinate and invocation agree exactly |
| `summary` | Counts for humans and CI; not a substitute for reading conflicts |

Every `inventoryId`, artifact, evidence record, and observation is content
addressed. Collection time is not part of identity. Re-running the same
collector over the same bytes and coordinates produces the same inventory.

To inspect the report mechanically:

```bash
jq '.summary' refunds-prod.inventory.json
jq '.candidates[] | {
  candidateId,
  coordinate,
  invocation,
  disposition,
  conflicts
}' refunds-prod.inventory.json
```

Do not select the first candidate because it appears first. Candidate ordering
is deterministic; it is not a recommendation ranking.

## 9. Interpret conflicts and diagnostics

A candidate claim has state `single` or `conflicting`. A conflict retains each
asserted value and the evidence that supports it. Evidence rank affects review
order only; no rank automatically chooses the active production value.

Examples that require investigation:

- the same logical JMS reference maps to two physical queues;
- an EJB descriptor declares a local interface but a vendor file suggests a
  remote binding;
- WCF configuration gives two addresses for the same contract;
- an AsyncAPI channel and broker export disagree about direction or reply
  behavior; or
- two files declare the same component under the same path.

Diagnostics have `error`, `warning`, or `info` severity. An error makes the
command exit non-zero. Warnings and information remain in the content-addressed
snapshot so a later review cannot pretend they were absent.

Pay particular attention to zero-yield diagnostics. Examples include:

- `legacy/java-ee/no_discoverable_declaration`: the artifact was recognized,
  but no supported explicit declaration was found;
- `legacy/java-ee/source_annotation_incomplete`: an EJB type was explicit, but
  a remote interface or binding was not provable;
- `legacy/dotnet/no_discoverable_endpoint`: WCF configuration was present, but
  no explicit callable endpoint was found; and
- `legacy/dotnet/default_endpoint_requires_contract_metadata`: WCF may create a
  runtime default endpoint, but the contract is absent from safe offline
  evidence; or
- `legacy/<collector>/no_invocation_candidate`: the collector retained useful
  declarations such as hosting or schema metadata, but none proved a callable
  invocation boundary.

Ambiguous WCF base addresses, binding configurations, protocol mappings, and
multiple JNDI aliases are also retained without first-wins or last-wins
selection.

## Use inventory in CI

Use `--json` when a harness or CI job consumes stdout:

```bash
pnpm anvil legacy inventory ./refunds-prod-websphere \
  --environment prod \
  --application refund-service \
  --check \
  --json > inventory-run.json
```

Exit behavior is intentionally strict:

| Condition | Exit code |
| --- | ---: |
| Inventory produced without collector errors | `0` |
| Collector diagnostics contain an error | non-zero |
| `--check` is set and any candidate contains a conflict | non-zero |
| Input, coordinate, limit, parse, or output refusal | non-zero |

Without `--check`, conflicts remain reviewable output and do not by themselves
fail the command. This is useful during discovery. In a controlled adoption
pipeline, enable `--check` once the expected conflict policy is established.

The CLI emits stable refusal codes under `legacy/*` when `--json` is used. See
[Errors and recovery](https://vamsiramakrishnan.github.io/anvil/explore/errors/)
for the registry and recovery guidance.

## What not to infer

An inventory candidate does not establish:

- a business operation name or description;
- clear developer-facing field names;
- input or output schemas merely because one sample was observed;
- stable business error codes;
- pagination behavior for a large result set;
- authorization, idempotency, retry, or timeout semantics;
- whether acknowledgement means accepted or completed; or
- permission to publish, consume, or invoke anything.

Those decisions belong in the refinement task and must be supported by cited
evidence.

## Troubleshoot collection

### The directory contains an archive

Expand it outside Anvil with a hardened pipeline that rejects traversal,
symlinks, device files, and decompression limits. Pass the expanded directory.

### A symlink is refused

Create a self-contained export. Do not copy the target opportunistically during
collection; that would change the evidence set without an explicit export step.

### A binary is present but no operations appear

This is expected for DLL and EXE files. They are hashed as opaque artifacts and
are never loaded or reflected over. Supply WCF configuration or trusted offline
metadata produced by a separate Windows-side tool.

### Two systems appear to describe the same queue

Keep them separate unless their technical reconciliation key is exact. Similar
names across Java, MQ, and AsyncAPI do not prove shared ownership or semantics.
Record the relationship later with evidence rather than renaming inputs to make
them collide.

## Continue

- [Understand the legacy-estate model](legacy-estates.md)
- [Refine and review one candidate](legacy-refinement.md)
- [Call inventory from TypeScript](legacy-sdk.md)
- [Read the command reference](../skills/anvil/reference/commands.md#anvil-legacy)
