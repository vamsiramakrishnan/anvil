# Autonomous repair and evaluation controller

Anvil now has a bounded controller for semantic AIR repairs:

```sh
anvil refine loop generated/google_docs --out repair/google_docs
anvil refine loop generated/google_docs --out repair/google_docs --resume --max-rounds 5
```

The original bundle remains the input on every invocation. The controller writes
`checkpoint.json` and regenerates a separate `bundle/` from accepted AIR. Exit 0
means no detected deficiencies remain; exit 2 means stalled, budget-limited or
canceled work with remaining findings; exit 1 means an execution error. Completion
is a detector result, not vendor certification or production readiness.

## The acceptance loop

Each round audits the latest accepted AIR and dispatches its deficiencies through
the existing typed skills. The default executor uses AIR-resident evidence and
schema facts. A declined task can become actionable after another repair changes
its context. An unchanged context is not investigated twice.

For every proposal, the controller:

1. Checks the assigned skill, version, deficiency and target; validates evidence
   and patch boundaries using the existing refinement validators.
2. Reconciles through the existing approval policy. Review-tier changes remain
   pending. No human review receipt is fabricated.
3. Applies an auto-tier patch to a candidate copy. Source coordinates, operation
   inventory, auth, approval state, wire schemas, retries, idempotency and
   confirmation remain protected.
4. Requires the targeted deficiency to disappear without introducing another
   deficiency. Candidate-authored operation intents must also route correctly
   against the full catalog, including unapproved siblings.
5. Evaluates the original cases against the candidate. A previously passing case
   cannot fail, even if another case improves. Changed case IDs, missing cases,
   duplicates and empty external evaluations are rejected.
6. Accepts the candidate, saves the checkpoint, and re-audits it. Otherwise the
   latest accepted AIR remains unchanged.

The fixed cases cover original operation presence, safety, required argument
values, field interpretation, errors and original intent phrases. These are
deterministic completeness and lexical-routing proxies. Newly authored intents
do not increase the evaluation denominator or prove agent routing accuracy.
The CLI additionally rejects newly introduced compiler errors. Existing compiler
errors stay visible; an unchanged failure is not a repaired failure.

## Budgets, recovery and trust boundaries

Defaults are three rounds, 100 investigations and 60 seconds per invocation.
Round and investigation budgets include checkpoint history. Resumption requires
the same original AIR, executor name and evaluator ID. Accepted proposals are
revalidated, reevaluated and replayed in sequence; stored status fields do not
authorize application. A new invocation has a fresh time budget.

Checkpoint writes use atomic replacement. The CLI serializes writers using an
exclusive directory lock. After a killed process, inspect the output and remove
its stale `.controller-lock` only after confirming the writer has stopped.
The regenerated bundle is installed transactionally; a failed installation can
be retried from the checkpoint.

The SDK accepts `SkillExecutor` and `RepairEvaluation` implementations. The latter
supplies versioned, operator-owned case IDs and pass/fail outcomes. Use it to run
independent wire replay, conformance or agent-task tests. Keep those fixtures
outside the repair worker's writable workspace. The controller treats the
evaluation implementation as trusted; it cannot establish the honesty of an
arbitrary callback or an edited checkpoint's externally claimed evidence.
External investigators should use Anvil's existing verified case/protocol path.

Abort signals reach the SDK executor and evaluation callback. Late asynchronous
results are discarded. Synchronous JavaScript cannot be preempted by this SDK;
use the existing process runner/backend timeout and containment for external
coding agents and hard resource limits. A saved checkpoint is a recovery record,
not a signed authorization artifact.

## Enterprise references and improvements

Run the controller over an existing locked conversion sweep:

```sh
node tools/corpus/enterprise/repair.mjs
node tools/corpus/enterprise/repair.mjs --systems google_docs,workday_common,slack
```

The report records each original source hash and conversion status, implementation
fingerprint, budgets, accepted patches, remaining deficiencies, unchanged inputs
and preserved contracts. Source exports remain separate requirements. The
[enterprise corpus](enterprise-corpus.md) documents the actual product/module
scope and source provenance; [repair results](enterprise-repair-results.json)
record the measured controller run. All operations retain their original grants.
No vendor tenant is called.

The 2026-09-14 run evaluated **38 contracts / 9,329 operations**, with up to 40
investigations per contract. It accepted **74 routing-example patches across 13
contracts**, left 22 proposals for review, rejected 92, and recorded 1,260
declines. Detected deficiencies fell from 37,461 to 37,387. All 38 inputs and
protected contracts remained unchanged. Thirty-five runs reached a budget and
three stalled; none resolved every finding. Thirteen additional systems still
need source exports.

All 74 accepted patches added operation intent examples. This is a measured
completeness gain with no regression on the fixed original cases; it is **not a
measured gain in agent routing accuracy**. The new examples were checked against
the full catalog but were not added to the evaluation denominator. Existing
conversion failures and policy blocks remain unresolved.

Separate CLI runs regenerated Google Docs, Workday Common and Slack bundles.
The existing reviewed-read smoke lane then exercised copies of those outputs
against local mocks: **10 selftests passed / 5 skipped, and 9 conformance checks
passed / none skipped**. Each selected read had a passing fidelity and wire
agreement check. [Replay results](enterprise-repair-smoke-results.json) bind the
repaired AIR hashes and preserve the distinction between raw grants and the
previously inspected reads approved only in smoke copies.

Developing this controller exposed two reusable defects:

- Coverage detection ignored `schema.examples`, where the example repair writes
  its result. Detection and evaluation now share value-source recognition, so
  a successful repair disappears from the next audit. Existing schema examples
  and defaults also avoid unnecessary coverage repairs.
- A Google Docs batch-update intent conflicted with its unapproved create sibling.
  The controller now validates new intents against the entire operation catalog.

Owned regression tests cover both findings, multi-round dependencies, review
deferral, rollback, per-case regressions, removed evaluation cases, executor
mutation, timeouts, stale/tampered checkpoints and CLI recovery.

## Scope of autonomy

This controller autonomously applies evidence-backed semantic repairs within
Anvil's current auto-approval boundary. It does not autonomously rewrite compiler
source, change tests, infer missing authentication, approve enterprise operations,
or obtain private tenant exports. Discovery endpoint collisions and Graph/DocuSign
parameter collisions remain compiler investigations. To automate those repairs,
add an isolated code-edit worker with a pinned source corpus, immutable regression
tests, full rebuild/replay evaluation and a reviewed code-promotion boundary.
That code-edit lane is not implemented by `refine loop`.
