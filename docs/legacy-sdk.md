# Use the legacy TypeScript SDK

Use `@anvil/compiler/legacy` when a coding harness already owns acquisition,
storage, or review orchestration and needs typed access to the same inventory
and refinement logic as the CLI.

The entrypoint is Node-only. It accepts caller-supplied bytes, performs no
filesystem or network acquisition, and never connects to a legacy runtime.

## Import the dedicated entrypoint

```ts
import {
  assessLegacyRefinementProposal,
  collectLegacyInventory,
  createLegacyRefinementProposal,
  createLegacyRefinementTask,
  createLegacyReviewReceipt,
  createReviewedLegacyCapabilityBinding,
  type LegacyRefinementSubmission,
  verifyLegacyCapabilityBinding,
  verifyLegacyInventory,
} from "@anvil/compiler/legacy";
```

Import from `@anvil/compiler/legacy`, not from an internal source path. The
package export supplies both ESM JavaScript and TypeScript declarations.

## Inventory caller-supplied bytes

```ts
import { readFile } from "node:fs/promises";
import { collectLegacyInventory } from "@anvil/compiler/legacy";

const bytes = await readFile(
  "exports/refunds/META-INF/ejb-jar.xml",
);

const result = collectLegacyInventory({
  estate: { id: "payments-au", name: "Payments Australia" },
  environment: "prod",
  application: "refund-service",
  source: {
    kind: "deployed_configuration",
    systemId: "websphere-prod-cell-1",
    revision: "export-receipt-018f6c2d",
  },
  collector: "java-ee",
  members: [
    {
      path: "refunds/META-INF/ejb-jar.xml",
      bytes,
    },
  ],
});

console.log(result.snapshot.inventoryId);
console.log(result.candidates);
console.log(result.collectors);
```

`members[].path` must be a safe relative POSIX path. The SDK validates paths,
byte types, duplicate paths, and the parsed model, but it does not apply the
CLI's file-count or aggregate-byte limits. It also does not read directories,
resolve symlinks, expand archives, or fetch URLs. Acquisition security and
input-size limits remain the caller's responsibility. Use the CLI when you want
Anvil's bounded, no-symlink directory reader.

One call has one `source` coordinate. Do not combine files from different
authorities under a misleading source kind. Multi-source inventory merge is not
part of the current high-level SDK, and a refinement task is bound to one
inventory. Treat other sources as external, immutable evidence coordinates
rather than pretending their evidence IDs belong to the selected snapshot.

## Understand the result

```ts
interface LegacyInventoryResult {
  snapshot: LegacyInventorySnapshot;
  candidates: LegacyCapabilityCandidate[];
  collectors: LegacyCollectorRun[];
}
```

- `snapshot` contains captured artifacts, evidence, observations, diagnostics,
  and the content-derived inventory identity.
- `candidates` are exact-coordinate reconciliation products. They are not
  stored inside the inventory hash and do not become approved operations.
- `collectors` records which collector lanes ran and how many observations and
  diagnostics each produced.

Persist the snapshot and candidate set together if another process needs to
select a candidate. A candidate can always be recomputed deterministically from
the verified snapshot.

## Create a hash-bound harness task

```ts
const candidate = result.candidates.find(
  (item) => item.coordinate.component === "RefundBean",
);

if (!candidate) {
  throw new Error("RefundBean was not present in the selected export");
}

const task = createLegacyRefinementTask(
  result.snapshot,
  candidate.candidateId,
);
```

The function verifies the inventory, recomputes candidates, and refuses an ID
that is not present. The returned task includes the exact candidate, required
decisions, conflicts, and immutable policy.

Serialize the task as JSON when crossing a process or harness boundary. Do not
ask the model to recreate the task schema from prose.

## Accept an untrusted submission

Parse the harness response with the exported schema before constructing a
proposal:

```ts
import {
  LegacyRefinementSubmission,
  createLegacyRefinementProposal,
} from "@anvil/compiler/legacy";

const submission = LegacyRefinementSubmission.parse(
  JSON.parse(harnessOutput),
);

const proposal = createLegacyRefinementProposal(task, submission);
```

The harness may return a complete proposal or decline:

```ts
const declined: LegacyRefinementSubmission = {
  schemaVersion: 1,
  taskId: task.taskId,
  taskHash: task.taskHash,
  status: "declined",
  executor: { name: "codex" },
  reason: "insufficient_evidence",
  summary: "No authoritative payload schema or completion signal was found.",
};
```

Do not convert a declined result into a partial proposal. Improve the evidence
or narrow the requested capability.

## Assess before asking for approval

```ts
const assessment = assessLegacyRefinementProposal(
  result.snapshot,
  task,
  proposal,
);

if (!assessment.ok) {
  for (const issue of assessment.issues) {
    console.error(`${issue.code} ${issue.path}: ${issue.message}`);
  }
  // Return the issues to the harness or a reviewer. Do not continue to approval.
}
```

Assessment is deterministic and side-effect free. It verifies lineage,
required claim evidence, conflict resolutions, operation quality, transport
compatibility, and operational semantics. It never grants approval.

## Keep human review outside the harness loop

Once a reviewer has inspected the evidence and exact proposal, record the
decision as a separate input:

```ts
if (!assessment.ok) {
  throw new Error("Proposal is not ready for review");
}

const receipt = createLegacyReviewReceipt(
  result.snapshot,
  task,
  proposal,
  {
    decision: "approved",
    reviewer: "refund-owner@example.com",
    reason: "Verified against the deployed binding and service contract.",
  },
);

const binding = createReviewedLegacyCapabilityBinding(
  result.snapshot,
  task,
  proposal,
  receipt,
);
```

`createLegacyReviewReceipt` refuses approval when assessment has issues.
`createReviewedLegacyCapabilityBinding` additionally checks that the approved
receipt matches the exact inventory, candidate, task, and proposal.

Keep reviewer authentication and authorization outside this library call. The
SDK records the supplied identity; it does not authenticate that person.

## Verify persisted records at trust boundaries

```ts
const inventoryReport = JSON.parse(
  await readFile("inventory.json", "utf8"),
);
const inventory = verifyLegacyInventory(inventoryReport.inventory);

const decisionReport = JSON.parse(
  await readFile("decision.json", "utf8"),
);
const binding = verifyLegacyCapabilityBinding(decisionReport.binding);
```

Verification checks the schema and content address. When producing a binding,
use the creation workflow as well: it checks the complete source lineage, not
only the binding's own hash.

## Public workflow APIs

| API | Input | Output | Authority |
| --- | --- | --- | --- |
| `collectLegacyInventory` | Coordinates and caller-owned bytes | Snapshot, candidates, collector summary | Captures technical facts only |
| `verifyLegacyInventory` | Unknown persisted value | Verified inventory snapshot | Checks schema and content identity |
| `reconcileLegacyInventory` | Verified snapshot | Deterministic candidates | Preserves every conflict |
| `createLegacyRefinementTask` | Snapshot and candidate ID | Hash-bound harness task | Declares required decisions |
| `createLegacyRefinementProposal` | Task and untrusted submission | Hash-bound proposal | Binds; does not approve |
| `assessLegacyRefinementProposal` | Snapshot, task, proposal | Structured assessment | Reports whether human review may proceed |
| `createLegacyReviewReceipt` | Exact lineage and human decision | Approval or rejection receipt | Records the supplied review decision |
| `createReviewedLegacyCapabilityBinding` | Exact lineage and approved receipt | Reviewed binding plan | Does not create a runtime |
| `verifyLegacyCapabilityBinding` | Unknown persisted value | Verified binding | Checks schema and binding content identity |

Lower-level collector and model exports are public for integrations that need a
single declarative parser or must construct a custom evidence pipeline. Prefer
the high-level workflow unless you also preserve its provenance, verification,
and conflict semantics.

## Failure handling

The library APIs throw validation or invariant errors for malformed inputs,
stale identity, missing candidates, invalid approval, and lineage mismatch.
Treat these as refused transitions, not transient runtime failures.

At a process boundary:

1. parse untrusted JSON with the exported Zod schema;
2. return structured assessment issues when a proposal is well-formed but not
   approvable;
3. keep the original task and proposal for audit; and
4. never retry by weakening required decisions or changing content-addressed
   fields.

## Current boundary

The SDK does not generate AIR from an approved binding, emit an MCP server, or
connect to JMS, IBM MQ, WCF, MSMQ, EJB, JCA, a database, or a scheduler. The
binding deliberately ends with:

```ts
binding.runtime satisfies {
  placement: "deployment_local_bridge";
  status: "not_implemented";
};
```

Read [Designing deployment-local bridges](legacy-runtime-bridges.md) before
building an executor around this plan.

## Continue

- [Build an inventory with the CLI](legacy-inventory.md)
- [Understand the review protocol](legacy-refinement.md)
- [Design the missing runtime bridge](legacy-runtime-bridges.md)
