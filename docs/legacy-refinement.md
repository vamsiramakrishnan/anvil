# Refine and review a legacy candidate

Legacy refinement turns one technical inventory candidate into a proposed
business operation and transport plan. A coding harness investigates and
proposes. Anvil validates. A person separately approves or rejects the exact
proposal.

The output is still not executable. Approval produces a reviewed capability
binding with `runtime.status = not_implemented`.

## Who is responsible for each decision

| Actor | Responsibility | Must not do |
| --- | --- | --- |
| Anvil | Freeze the task, require decisions, validate identities, assess the proposal, and bind receipts | Invent business meaning or choose a conflict winner |
| Coding harness | Investigate declared evidence and prepare a bounded submission | Execute the runtime or approve its own submission |
| Domain or service owner | Confirm business intent, schemas, errors, and completion semantics | Treat transport configuration as sufficient evidence |
| Platform or middleware owner | Confirm active deployment and transport coordinates | Define business authorization merely because a queue exists |
| Reviewer | Approve or reject the exact assessed proposal with a reason | Approve a stale, invalid, or different proposal |

Separation is structural. The harness-facing API has no method that marks its
own proposal approved.

## The refinement transaction

```text
inventory + candidate ID
  -> task.json
  -> untrusted submission.json
  -> deterministic review.json
  -> human approval or rejection
  -> decision.json
```

Every transition binds the preceding content hashes. If the inventory,
candidate, task, proposal, or receipt changes, the downstream identity changes
and stale combinations are refused.

## 1. Choose one candidate

Inspect the candidate's coordinate, invocation, claims, evidence, conflicts,
and disposition before creating a task:

```bash
jq '.candidates[] | {
  candidateId,
  coordinate,
  invocation,
  disposition,
  conflicts
}' refunds-prod.inventory.json
```

Choose the candidate because it represents the technical boundary you intend
to investigate, not because its name resembles the desired business action.

## 2. Export the harness task

```bash
pnpm anvil legacy refine task \
  refunds-prod.inventory.json \
  lc_<candidate-hash> \
  --out refunds-submit.task.json
```

The task embeds:

- the exact inventory and candidate identities;
- the reconciled candidate and its unresolved conflicts;
- every decision the submission must address; and
- policies that the harness cannot relax.

Those policies require human approval, forbid runtime execution, distinguish
broker acknowledgement from business completion, and forbid generic
middleware tools.

Do not edit the task to remove a difficult decision. Its content address would
change, and the review path reconstructs the canonical task from the inventory.

## 3. Give the task and evidence to the harness

The task is a protocol object, not a prompt. Supply it to Codex, Claude Code,
Antigravity, or another coding harness together with access to the repositories,
documents, and runbooks it is permitted to inspect.

Ask the harness to either:

- return a `proposal_generated` submission with evidence for every material
  claim; or
- return `declined` with `insufficient_evidence`, `conflicted`,
  `unsupported_transport`, or `blocked_by_missing_source`.

Declining is a valid result. It is better than manufacturing an operation from
a queue name.

## 4. Require a business-shaped contract

The proposal must define the operation independently of its middleware:

| Surface | Required decision |
| --- | --- |
| Name | Stable domain name such as `refunds.submit`, not `send_message` |
| Description | What the operation does, its meaningful outcome, and relevant constraints |
| Effect | `read`, `create`, `update`, `delete`, `trigger`, or `event` |
| Exposure | MCP tool, event trigger, or internal operation |
| Input | JSON Schema with clear domain field names and required fields |
| Output | JSON Schema for the business result, not UI control state |
| Errors | Stable code, meaning, retryability, and caller recovery |
| Pagination | Cursor, offset, or page contract when a read can return a large set |

Field names such as `val`, `data1`, or `flag` are not made acceptable by a long
description. Rename them at the agent boundary and preserve the wire mapping in
the eventual bridge.

Output such as `showButton`, `enableRetry`, or `dialogState` couples the agent
contract to a presentation. Return domain state and let the client decide how
to render it.

### Errors are part of the operation

Do not collapse every failure into `LEGACY_ERROR`. The caller needs to know
whether to correct input, retry, query status, request approval, or escalate.

```json
{
  "code": "REFUND_REJECTED",
  "meaning": "The refund service rejected the business request.",
  "retryable": false,
  "recovery": "Correct the request or escalate to the refunds team."
}
```

The code is stable and machine-readable. The meaning is for diagnosis. The
recovery text tells a developer or harness what action is safe next.

### Pagination must describe the real retrieval model

If a read may return an unbounded result set, the proposal must state:

- `mode`: `cursor`, `offset`, or `page`;
- `requestField` used to continue;
- `responseItemsPath` containing the page;
- `responseCursorPath` when cursor-based; and
- `maxPageSize` when the service enforces one.

Do not add pagination cosmetically if the legacy interface cannot continue a
query. In that case, constrain the operation or decline until an authoritative
status/query surface exists.

Anvil validates a pagination contract when the proposal declares one. It cannot
infer production result cardinality from a deployment descriptor, so the
harness and reviewer must establish whether pagination is required from the
implementation, tests, data bounds, or an authoritative interface contract.

## 5. Describe transport without leaking it into the tool

The transport plan is explicit and separate from the business operation:

```json
{
  "kind": "message",
  "protocol": "ibm_mq",
  "target": "PAY.REFUND.V2",
  "direction": "request_reply",
  "payloadEncoding": "json",
  "reply": {
    "mode": "fixed_destination",
    "target": "PAY.REFUND.REPLY",
    "correlationField": "correlation_id"
  }
}
```

Supported plan shapes cover messages, remote methods, resource adapters,
stored procedures, and batch jobs. This is a schema for a reviewed plan, not a
claim that each transport has an executable adapter.

The selected target must be supported by candidate evidence or an explicit
conflict resolution. A harness cannot invent `PAY.REFUND.V3` because it looks
newer.

## 6. State what success means

Completion semantics are not a status-message detail. They determine what an
agent is allowed to claim to its caller:

| Completion value | Permitted claim |
| --- | --- |
| `transport_accepted` | The broker or transport accepted the request |
| `application_accepted` | The target application acknowledged ownership of the request |
| `business_completed` | Authoritative evidence says the business action finished |
| `job_accepted` | The scheduler accepted the job; completion requires another surface |
| `unknown` | Not approvable for an executable binding |

MQ `PUT` success, JMS acknowledgement, and a generated correlation ID do not
prove business completion. A correlation ID tracks work; it does not create
idempotency in the target application.

The submission also declares:

- timeout;
- authorization mode and scopes;
- idempotency mode and carrier; and
- retry mode and maximum attempts.

Automatic retry is accepted only when repetition is evidence-backed. Otherwise
use `never` or `operator_only`.

## 7. Cite evidence claim by claim

Evidence references can point to:

- an evidence record already inside the inventory;
- a repository, immutable revision, path, line range, blob digest, and excerpt
  digest;
- a revisioned document coordinate and content digest; or
- an authenticated operator attestation and statement digest.

`claimEvidence` maps required decisions to those references. Conflict
resolutions separately name the selected value, evidence references, and a
reason.

Anvil validates and content-addresses these coordinates. It does not fetch a
repository or independently attest the cited bytes during refinement. The
review environment remains responsible for verifying that the evidence system
and reviewer identity are authentic.

## 8. Import and assess the proposal

```bash
pnpm anvil legacy refine review \
  refunds-prod.inventory.json \
  refunds-submit.task.json \
  refunds-submit.submission.json \
  --out refunds-submit.review.json
```

The review pack is written even when assessment fails, so the issues remain
inspectable. The command exits non-zero when the proposal is not approvable.

Typical refusal classes include:

- stale or mismatched inventory, task, candidate, or proposal identity;
- missing claim evidence or unresolved conflicts;
- an invented or unsupported transport target;
- generic middleware operations;
- weak field names or UI-shaped output;
- duplicate or incomplete error mappings;
- incomplete, unbounded, or mutation-attached pagination when pagination is declared;
- missing reply or correlation behavior;
- unknown completion, authorization, or idempotency semantics; and
- automatic retries without a compatible idempotency decision.

Fix the submission or improve the evidence. Do not edit `assessment.ok`.

## 9. Record a separate decision

After a person has inspected the evidence and the exact proposal:

```bash
pnpm anvil legacy refine approve \
  refunds-prod.inventory.json \
  refunds-submit.review.json \
  --reviewer refund-owner@example.com \
  --reason "Verified against the deployed binding and service contract." \
  --out refunds-submit.decision.json
```

Or retain an auditable rejection:

```bash
pnpm anvil legacy refine reject \
  refunds-prod.inventory.json \
  refunds-submit.review.json \
  --reviewer refund-owner@example.com \
  --reason "The active production destination is not established." \
  --out refunds-submit.rejection.json
```

Approval is refused when assessment is not ready. Rejection emits a receipt but
no capability binding.

Existing output files are immutable by default. Re-running a command with the
same content succeeds; attempting to overwrite different content is refused.
Use a new path when the evidence or decision changes.

## Read the approved result correctly

An approved decision binds:

```text
inventory -> candidate -> task -> proposal -> review receipt -> binding
```

It establishes that a named reviewer accepted one business and transport plan.
It does not establish connectivity, deployment, readiness, or successful
execution. The binding therefore contains:

```json
{
  "runtime": {
    "placement": "deployment_local_bridge",
    "status": "not_implemented"
  }
}
```

Do not remove or reinterpret that status. The next engineering step is a
separately tested bridge that preserves the reviewed operation and semantics.

## Continue

- [Build the inventory first](legacy-inventory.md)
- [Drive refinement from TypeScript](legacy-sdk.md)
- [Design the runtime bridge](legacy-runtime-bridges.md)
- [Understand the complete legacy model](legacy-estates.md)
