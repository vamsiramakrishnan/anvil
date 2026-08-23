# Use the legacy TypeScript SDK

Use `@anvil/compiler/legacy` when your harness already owns evidence
acquisition, persistence, or review orchestration. The SDK exposes the same
content-addressed inventory and refinement model as the CLI, plus product-core
primitives for collection plans, evidence graphs, coverage, explanations,
inventory diffs, collector contracts, and bridge planning.

The entrypoint is Node-only. It compiles caller-supplied bytes. It does not
connect to an application server, broker, repository, or runtime.

`@anvil/compiler/legacy` is currently a workspace API. Use it from an Anvil
checkout after `pnpm install` and `pnpm build`. The package is not yet
documented as an independently published install.

## Import the public entrypoint

```ts
import {
  assessAndPlanLegacyCoverage,
  assessLegacyBridgeDriver,
  assessLegacyRefinementProposal,
  collectLegacyInventoryStream,
  createLegacyCollectionPlan,
  createLegacyRefinementProposal,
  createLegacyRefinementTask,
  diffLegacyInventories,
  explainLegacyCandidate,
  FAIL_CLOSED_LEGACY_COLLECTION_POLICY,
  LegacyRefinementSubmission,
  planLegacyBridge,
  projectLegacyEvidenceGraph,
  type LegacySourceMember,
  verifyLegacyInventory,
} from "@anvil/compiler/legacy";
```

Import from `@anvil/compiler/legacy`, not an internal source path. The package
export provides ESM JavaScript and TypeScript declarations.

## The developer workflow

```text
collection plan
    ↓
bounded caller-owned evidence stream
    ↓
verified inventory + reconciled candidates
    ├── evidence graph
    ├── coverage report → missing-evidence plan
    ├── candidate explanation
    └── inventory diff
              ↓
hash-bound refinement → human review → approved binding
              ↓
non-executable bridge plan → static driver assessment
```

Each step is deterministic and side-effect free after acquisition. None of
these steps approves a business meaning or executes a legacy operation.

## 1. Declare what the collection must prove

A collection plan separates the requested evidence coverage from whatever a
collector happens to find:

```ts
const collectionPlan = createLegacyCollectionPlan({
  schemaVersion: 1,
  estate: { id: "payments-au", name: "Payments Australia" },
  sources: [
    {
      id: "refund-source",
      kind: "source_repository",
      systemId: "payments-git",
      root: "source/refunds",
      revision: "b7d5f8478b9d",
      expectedRoles: ["source_manifest", "deployment_descriptor"],
      context: {
        environment: "prod",
        application: "refund-service",
        platform: "weblogic-14",
        domain: "payments-domain",
        cluster: "payments-cluster",
      },
    },
    {
      id: "mq-export",
      kind: "broker_configuration",
      systemId: "mq-prod",
      root: "exports/mq",
      revision: "dmpmqcfg-018f6c2d",
      expectedRoles: ["broker_export"],
      context: {
        environment: "prod",
        application: "refund-service",
        platform: "ibm-mq-9",
        queueManager: "PAYMENTS.QM1",
      },
    },
  ],
  requirements: [
    "deployment_identity",
    "invocation_binding",
    "message_direction",
    "input_schema",
    "output_schema",
    "error_semantics",
    "transaction_semantics",
    "authorization_context",
    "completion_semantics",
    "ownership",
  ],
  policy: FAIL_CLOSED_LEGACY_COLLECTION_POLICY,
});
```

The plan is strict and content-addressed. Unknown fields are rejected.
Repository sources require an immutable revision. The exported policy fixes
network access, process execution, class loading, bytecode execution, and XML
external entities to `deny`; secrets to `refuse`; and archive expansion to
`hardened`.

`createLegacyCollectionPlan` does not acquire a source or drive a collector.
Your acquisition layer must map every declared source to the bytes supplied to
inventory. Coverage currently checks the plan's estate and requirements; it
does not prove that every planned source was acquired. Keep that acquisition
receipt in your orchestration layer.

Use `verifyLegacyCollectionPlan` when loading a persisted plan. It checks both
the schema and content-derived identity.

## 2. Stream bounded evidence with per-member provenance

For large exports, use the asynchronous input API:

```ts
import { readFile } from "node:fs/promises";

async function* evidence(): AsyncIterable<LegacySourceMember> {
  yield {
    path: "source/refunds/META-INF/weblogic-ejb-jar.xml",
    bytes: await readFile("source/refunds/META-INF/weblogic-ejb-jar.xml"),
    source: {
      kind: "source_repository",
      systemId: "payments-git",
      revision: "b7d5f8478b9d",
    },
  };

  yield {
    path: "exports/mq/payments.mqsc",
    bytes: await readFile("exports/mq/payments.mqsc"),
    source: {
      kind: "broker_configuration",
      systemId: "mq-prod",
      revision: "dmpmqcfg-018f6c2d",
    },
  };
}

const result = await collectLegacyInventoryStream({
  estate: { id: "payments-au", name: "Payments Australia" },
  environment: "prod",
  application: "refund-service",
  source: {
    // Default provenance for members that omit `source`.
    kind: "deployed_configuration",
    systemId: "weblogic-prod",
    revision: "export-018f6c2d",
  },
  collector: "auto",
  members: evidence(),
  limits: {
    maxMembers: 20_000,
    maxMemberBytes: 16 * 1024 * 1024,
    maxTotalBytes: 512 * 1024 * 1024,
  },
});
```

The stream applies backpressure, copies each yielded byte array, and enforces
member-count, per-member, and aggregate-byte limits before compilation. The
synchronous `collectLegacyInventory` remains available for an already bounded
array.

Every member may override the invocation-level default `source`. Use this for
mixed repository, deployed-configuration, and broker evidence. Anvil preserves
that authority on the artifact and its evidence records; it does not promote a
source file to deployed evidence. Paths must remain unique safe relative POSIX
paths, so namespace files from different systems under distinct directories.

The SDK still does not read directories, follow symlinks, expand archives, or
fetch URLs. Hardened acquisition remains the caller's responsibility. The CLI
is the safer default when you want Anvil's bounded directory reader.

## 3. Treat the inventory as the source of truth

```ts
interface LegacyInventoryResult {
  snapshot: LegacyInventorySnapshot;
  candidates: LegacyCapabilityCandidate[];
  collectors: LegacyCollectorRun[];
}
```

- `snapshot` contains artifacts, evidence, observations, diagnostics, and a
  content-derived inventory identity.
- `candidates` reconcile observations at an exact deployment and invocation
  coordinate. They are technical discovery products, not approved operations.
- `collectors` records which lanes ran and their input, observation, and
  diagnostic counts.

Persist the snapshot and candidate set together. Product-core APIs verify the
snapshot, recompute candidates, and reject omitted, injected, modified, or
stale candidate projections. A structurally valid candidate object is not
trusted merely because it passes a schema.

At a trust boundary:

```ts
const inventory = verifyLegacyInventory(JSON.parse(persistedInventory));
```

## 4. Project an exact evidence graph

```ts
const graph = projectLegacyEvidenceGraph(result);

console.log(graph.graphId);
console.log(graph.nodes);
console.log(graph.edges);
```

The graph contains typed artifact, evidence, observation, deployment,
component, capability, and claim nodes. Typed edges connect only records
present in the verified snapshot. Every non-artifact graph assertion carries
the exact `le_…` evidence IDs that support it; edge endpoints and content
identities are validated.

The graph is a projection, not a knowledge-completion engine. It does not infer
an owner, schema, authorization model, completion signal, or business meaning
from naming similarity.

Each capability has two identities:

- `occurrenceId` identifies the exact deployment coordinate and invocation;
- `logicalCapabilityId` preserves lineage across ordinary redeployments and
  physical endpoint changes.

Identity continuity does not assert semantic equivalence. Use the diff to see
what changed inside a lineage.

## 5. Measure coverage and plan missing evidence

```ts
const { report, gapPlan } = assessAndPlanLegacyCoverage(result, {
  plan: collectionPlan,
});

if (!report.semanticComplete) {
  for (const gap of gapPlan.gaps) {
    console.error(gap.category, gap.requirement, gap.request);
  }
}
```

The report distinguishes four collection outcomes:

- `supported`: observations exist, required coverage is satisfied, and no
  warning or error weakens the result;
- `partial`: useful observations exist, but evidence, semantics, or collector
  coverage remains incomplete;
- `unsupported`: no typed observation was produced; and
- `safety-refusal`: input was rejected by a stable safety diagnostic, such as
  a secret-bearing export or forbidden XML construct.

Requirement coverage is independently `satisfied`, `partial`, `missing`, or
`not_applicable`. Candidate count is reported, but never used as a synonym for
semantic completeness. Finding a queue proves neither its payload schema nor
its authorization or business-completion semantics.

The gap plan contains bounded evidence requests with acceptable source kinds
and suggested artifacts. It does not fetch those artifacts or certify that a
suggestion will resolve the gap.

## 6. Explain one candidate without generated narrative

```ts
const candidate = result.candidates.find(
  (item) => item.coordinate.component === "RefundListener",
);

if (!candidate) throw new Error("RefundListener was not discovered");

const explanation = explainLegacyCandidate(result, candidate.candidateId);

for (const claim of explanation.claims) {
  console.log(claim.dimension, claim.state, claim.assertions);
}
console.log(explanation.unknownDimensions);
```

An explanation embeds the exact candidate, contributing observations,
artifact/evidence coordinates, assertions, conflicts, unclaimed evidence, and
unknown dimensions. It deliberately produces no prose interpretation. This is
the safe payload to show a harness or reviewer.

## 7. Diff inventories at two identity levels

```ts
const diff = diffLegacyInventories(previousResult, result);

for (const change of diff.changedLineages) {
  console.log(change.logicalCapabilityId, change.changeKinds);
}
```

The deterministic diff reports added and removed logical lineages separately
from added, removed, and retained deployment occurrences. A retained lineage
can report changes to:

- deployment;
- invocation;
- evidence;
- claims;
- conflicts;
- business-semantics disposition; or
- occurrence count.

A deployment digest change therefore does not masquerade as a new business
capability. Conversely, a different logical destination is not silently joined
to an existing lineage.

## 8. Implement a versioned collector contract

`LegacyCollectorV2` is the public contract for external collector work:

```ts
interface LegacyCollectorV2 {
  readonly descriptor: LegacyCollectorDescriptorV2;

  detect(
    member: LegacyCollectorMemberV2,
    context: LegacyCollectorContextV2,
  ): readonly LegacyCollectorDetectionV2[];

  plan(
    detections: readonly LegacyCollectorDetectionV2[],
    context: LegacyCollectorContextV2,
  ): readonly LegacyCollectorAcquisitionRequestV2[];

  collect(
    members: AsyncIterable<LegacyCollectorMemberV2>,
    context: LegacyCollectorContextV2,
  ): AsyncIterable<LegacyCollectorEmissionV2>;
}
```

The descriptor is versioned and declares accepted source kinds, artifact
roles, extensions, media types, evidence capabilities, and hard limits. Its
runtime boundary fixes the collector to pure, offline operation: no network,
process execution, class loading, bytecode execution, environment access,
external entity resolution, or filesystem access outside supplied members.

Use the exported creators for content-addressed values:

```ts
import {
  createLegacyCollectorMemberMetadataV2,
  createLegacyCollectorProblemV2,
} from "@anvil/compiler/legacy";

const member = createLegacyCollectorMemberMetadataV2({
  sourceId: "mq-export",
  path: "exports/mq/payments.mqsc",
  digest: "sha256:…",
  bytes: 42_771,
  role: "broker_export",
  sourceKind: "broker_configuration",
  mediaType: "text/plain",
});

const problem = createLegacyCollectorProblemV2({
  schemaVersion: 2,
  collectorId: "ibm-mq-v2",
  stage: "collect",
  category: "incomplete",
  severity: "warning",
  code: "legacy/ibm_mq/missing_queue_manager",
  message: "The export does not identify its queue manager.",
  remediation: "Supply a pinned dmpmqcfg export with collection context.",
  memberId: member.memberId,
  evidenceIds: [],
  retryable: false,
});
```

Facts reference bounded member coordinates rather than retaining source bytes.
Problems are structured, non-retryable compiler outcomes rather than generic
exceptions.

The boundary is a contract, not a JavaScript sandbox. The host must isolate
untrusted collector code. The current built-in collectors are not dynamically
loaded through this SPI, and Anvil does not yet provide a collector registry or
plugin loader. Custom orchestration must invoke a V2 collector and normalize
its emissions into inventory explicitly.

## 9. Refine one exact candidate

```ts
const task = createLegacyRefinementTask(
  result.snapshot,
  candidate.candidateId,
);

const submission = LegacyRefinementSubmission.parse(
  JSON.parse(harnessOutput),
);
const proposal = createLegacyRefinementProposal(task, submission);
const assessment = assessLegacyRefinementProposal(
  result.snapshot,
  task,
  proposal,
);

if (!assessment.ok) {
  throw new Error("The proposal is not ready for human review");
}
```

The task is bound to the exact inventory and candidate. The harness may submit
a proposal or decline for insufficient evidence. Assessment checks lineage,
claim evidence, conflicts, operation quality, transport compatibility, and
operational semantics. It never grants approval.

Human approval remains a separate authenticated workflow using
`createLegacyReviewReceipt` and `createReviewedLegacyCapabilityBinding`. The
SDK records a supplied reviewer identity; it does not authenticate or
authorize that person.

## 10. Plan a bridge without claiming a runtime

After approval:

```ts
const bridgePlan = planLegacyBridge(binding);
const driverAssessment = assessLegacyBridgeDriver(
  bridgePlan,
  driverDescriptor,
);

bridgePlan.executionAllowed satisfies false;
```

The plan derives required driver capabilities, conformance cases, and
unverified live facts from the reviewed binding. Driver assessment compares a
strict descriptor with that plan. It does not load a driver, generate code,
run conformance tests, connect to a target, or permit execution.

Read [Design a deployment-local legacy bridge](legacy-runtime-bridges.md) for
the exact boundary.

## Public workflow APIs

| API | Output | What it proves |
| --- | --- | --- |
| `createLegacyCollectionPlan` | Content-addressed evidence contract | Required sources, context, coverage, and fail-closed policy |
| `collectLegacyInventory` | Snapshot, candidates, collector summary | Technical facts from a bounded in-memory member set |
| `collectLegacyInventoryStream` | Same result from an async stream | Bounded acquisition intake with backpressure and copied bytes |
| `verifyLegacyInventory` | Verified snapshot | Schema, record references, and content identity |
| `projectLegacyEvidenceGraph` | Typed evidence graph | Exact graph projection without invented evidence |
| `assessLegacyCoverage` | Coverage report | Collection outcome and per-requirement evidence status |
| `planLegacyCoverageGaps` | Evidence acquisition gaps | What evidence is still required; performs no acquisition |
| `explainLegacyCandidate` | Exact candidate explanation | Claims, conflicts, coordinates, provenance, and unknowns |
| `diffLegacyInventories` | Logical and occurrence diff | Deterministic estate drift between verified inventories |
| `createLegacyRefinementTask` | Hash-bound task | Decisions required before review |
| `assessLegacyRefinementProposal` | Structured assessment | Whether a proposal may proceed to human review |
| `createReviewedLegacyCapabilityBinding` | Approved binding plan | Reviewed mapping; does not create a runtime |
| `planLegacyBridge` | Non-executable bridge plan | Required capabilities and conformance obligations |
| `assessLegacyBridgeDriver` | Static support assessment | Descriptor compatibility only; no live or executable proof |

## Failure handling

Library functions throw validation or invariant errors for malformed input,
unknown fields, stale identities, candidate mismatch, unsafe transitions, and
lineage mismatch. Treat these as refused transitions, not transient runtime
failures.

At a process boundary:

1. Parse untrusted JSON with the exported Zod schema.
2. Preserve the original content-addressed input and output for audit.
3. Return structured coverage, gap, collector, or refinement issues where
   available.
4. Never recover by deleting required evidence or rewriting identity fields.

## Current boundary

The SDK does not generate AIR or an MCP server from a legacy binding. It does
not package, deploy, or run JMS, IBM MQ, WCF, MSMQ, EJB, JCA, stored-procedure,
or scheduler adapters. Bridge planning remains deliberately non-executable.

## Continue

- [Build an inventory with the CLI](legacy-inventory.md)
- [Understand the review protocol](legacy-refinement.md)
- [Design a deployment-local bridge](legacy-runtime-bridges.md)
