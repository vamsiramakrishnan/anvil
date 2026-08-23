# Drive refinement from a coding harness

Anvil can ask Codex, Claude Code, Antigravity, or another coding harness to
investigate an API contract without giving that harness permission to rewrite the
contract.

The responsibilities are separate:

- the harness searches the repository, connects implementation details, and
  proposes a narrow semantic change;
- Anvil owns the task boundary, evidence verification, deterministic validation,
  measurement, and approval policy. It validates an accepted proposal before
  applying a change.

Use this workflow when an API is callable but still makes an agent guess. Typical
examples include an input named `val`, an amount with no unit, an error with no
recovery action, a hidden pagination cursor, or a response that mixes durable data
with dashboard button state.

This workflow refines an operation that already exists in AIR. If no API
contract exists and the starting point is an EJB, WCF endpoint, queue, procedure,
or batch binding, use [legacy candidate refinement](legacy-refinement.md) and the
separate [`@anvil/compiler/legacy` SDK](legacy-sdk.md).

## Choose the integration that fits your harness

| Integration | Use it when | What the harness depends on |
| --- | --- | --- |
| Portable task protocol | The harness runs as a separate process, CLI, CI job, or product | JSON and a Git checkout |
| TypeScript SDK | The harness is embedded in the same Node.js process | `@anvil/refinement` |
| Case workflow | A developer wants an interactive, staged investigation directory | The `anvil case` CLI |

For Codex or Claude Code, start with the portable task protocol. It keeps process
and language choices out of the trust model.

`@anvil/refinement` is currently a workspace API. Use it from an Anvil checkout
after `pnpm install` and `pnpm build`. The package is not yet documented as an
independently published install.

## Run the portable task protocol

### 1. Find a refinement target

```bash
anvil case list generated/payments
```

Copy the target key you want to investigate. If the same target has more than one
deficiency, select the intended skill explicitly when you export it.

### 2. Export one deterministic task

```bash
anvil refine export-task \
  generated/payments \
  'field:payments.refunds.create#input.body.val' \
  --skill rename-field \
  --repo-root . \
  --inspect src,test,docs \
  --out .anvil/refinement/refund-amount.task.json
```

The task is portable JSON. It contains the exact AIR contract hash, Git revision,
skill version and contract hash, semantic target, read-only context, admissible
evidence policy, writable fields, investigation procedure, and a JSON Schema for
the expected submission.

The task ID and task hash are content-derived. Exporting the same target from the
same AIR and Git revision produces the same task, so a harness can resume or cache
work without inventing its own identity scheme.

### 3. Let the harness investigate

Give the task file to the harness. It returns a submission shaped like this:

```json
{
  "schemaVersion": 1,
  "taskId": "rt_…",
  "taskHash": "…",
  "executor": { "name": "codex", "model": "gpt-5" },
  "status": "proposal_generated",
  "summary": "The handler and contract tests define val as a refund amount in minor units.",
  "evidence": [
    {
      "id": "handler",
      "kind": "repository",
      "source": "source_impl",
      "path": "src/refunds/create.ts",
      "startLine": 41,
      "endLine": 58
    },
    {
      "id": "contract-test",
      "kind": "repository",
      "source": "test_fixture",
      "path": "test/refunds/create.test.ts",
      "startLine": 77,
      "endLine": 94
    }
  ],
  "claims": [
    {
      "predicate": "field.agent_name",
      "value": "refund_amount_minor_units",
      "evidenceId": "handler",
      "confidence": 0.95
    },
    {
      "predicate": "field.agent_name",
      "value": "refund_amount_minor_units",
      "evidenceId": "contract-test",
      "confidence": 0.9
    }
  ],
  "patch": {
    "set": {
      "agent_name": "refund_amount_minor_units",
      "aliases": ["refund_amount"]
    }
  }
}
```

The harness supplies coordinates, not trusted excerpts. For repository evidence,
Anvil reads the file from the task's pinned Git commit during import. It records the
Git blob ID, SHA-256 of the complete blob, SHA-256 of the selected excerpt, and line
range. A dirty working tree cannot silently redefine evidence for an older task.

The harness must not force a patch. It can return `supported` when the current
value is already correct, `conflicted` when sources disagree,
`insufficient_evidence` when proof is weak, or `blocked_by_missing_source` when
a required source is unavailable. These outcomes carry no patch and remain
auditable.

### 4. Import, validate, and measure

```bash
anvil refine import-proposal \
  generated/payments \
  .anvil/refinement/refund-amount.task.json \
  .anvil/refinement/refund-amount.submission.json \
  --repo-root . \
  --out .anvil/refinement/refund-amount.pack
```

Import fails closed when any binding moved: AIR, task bytes, task ID, skill
contract, Git revision, evidence coordinate, source policy, claim predicate, or
writable field. It then rebuilds authoritative context from AIR, validates the
proposal, measures only the affected behavior families plus the safety guard, and
writes the normal refinement-pack layout.

Use `--json` in automation. Rejections have a stable envelope:

```json
{
  "schemaVersion": 1,
  "reportType": "anvil.refinement-harness-import-error",
  "ok": false,
  "code": "refinement/proposal_rejected",
  "stage": "validation",
  "message": "The harness proposal failed Anvil's deterministic validation.",
  "issues": ["evidence_supports_value: …"]
}
```

Imported packs add three audit facets:

- `harness-tasks.json` — the exact exported task;
- `harness-submissions.json` — the exact parsed harness response;
- `harness-evidence.json` — evidence bytes and their Git/SHA-256 identities.

These facets are also embedded in `pack.json`, so the pack hash and every review
receipt cover them.

### 5. Review and apply the exact measured bytes

```bash
anvil refine review .anvil/refinement/refund-amount.pack

anvil refine approve \
  .anvil/refinement/refund-amount.pack \
  'rename-field:field:payments.refunds.create#input.body.val' \
  --reviewer api-owner@example.com \
  --reason 'Confirmed against the handler and refund contract tests.'

anvil refine apply-pack \
  generated/payments \
  .anvil/refinement/refund-amount.pack \
  --dry-run

anvil refine apply-pack \
  generated/payments \
  .anvil/refinement/refund-amount.pack
```

`apply-pack` never asks the harness to investigate again. It applies the proposal
that was measured and reviewed, or refuses if AIR, the pack, the proposal, or its
receipt changed.

## Embed the same rails with the TypeScript SDK

Use the SDK when your harness already runs inside the same Node.js process:

```ts
import {
  applyReviewed,
  createReviewReceipt,
  runRefinements,
  type SkillExecutor,
} from "@anvil/refinement";

const executor: SkillExecutor = codingHarnessExecutor;
const pack = await runRefinements(air, { executor });

const candidate = pack.refinements.find(
  (refinement) => refinement.approval.tier === "review",
);
if (!candidate) throw new Error("No review-tier proposal was produced");

const receipt = createReviewReceipt(
  pack,
  candidate.id,
  "approved",
  "api-owner@example.com",
  "Verified against the handler and contract tests.",
);

const result = applyReviewed(air, pack, [receipt]);
// Persist result.air, inspect result.changes, then regenerate the bundle.
```

Custom executors receive a detached context. Validation uses a separate pristine
context, so an adapter cannot rewrite the facts used to judge its proposal.

## Understand the trust boundary

The protocol does not make a coding harness authoritative. Repository access makes
the harness better at finding evidence; it does not let the harness approve its own
conclusions.

Changes to idempotency, auth authority, query exposure, UI projections, and
agent-facing names remain human decisions unless a narrow policy explicitly clears
them. Unknown fields, unsupported mutations, no-op patches, name collisions, stale
contracts, altered packs, altered proposals, and measured regressions fail closed.

A review receipt provides integrity and staleness protection. It is not a digital
signature and does not authenticate the free-form `reviewer` value. When reviewer
identity matters, keep receipts in a protected, signed review workflow.
