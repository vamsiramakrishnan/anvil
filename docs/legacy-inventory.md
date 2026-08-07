# Build a legacy inventory

Use `anvil legacy inventory` when no useful API contract exists and the best
available evidence is an offline application-server, .NET, or messaging export.
The command produces a deterministic inventory and a set of technical
invocation candidates. It never invokes the estate.

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

## 1. Prepare one provenance-consistent collection

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

All members of one CLI invocation receive the same `--source-kind` and
`--source-id`. If the repository checkout and the production server export have
different provenance, inventory them separately rather than presenting both as
production configuration.

The current CLI does not merge several inventories into one cross-source
snapshot. A later refinement task is bound to one inventory. Evidence from a
different report must be cited through an appropriate immutable repository,
document, or attestation coordinate; its evidence IDs are not in scope as
`inventory` references for the selected task. Do not fabricate a shared
provenance label to force a merge.

## 2. Choose the evidence coordinates

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

## 3. Run the appropriate collector

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

## 4. Read the report

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

## 5. Interpret conflicts and diagnostics

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
