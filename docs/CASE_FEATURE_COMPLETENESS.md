# Case investigation — feature-completeness audit

An honest baseline of the case-investigation feature after the trust-loop
hardening (PR #7), before the sandbox is implemented and the real investigator
battery is run. Statuses: **complete**, **partial**, **not implemented**,
**intentionally deferred**.

The point of this table is to *not conceal* partial features. Bubblewrap is
listed as intentionally deferred (the execution-backend interface is ready);
nothing sandbox-related is marked complete.

## Deterministic refinement

| Feature | Implementation | Tests | CLI/API surface | Status |
| --- | --- | --- | --- | --- |
| Deficiency detection | `detect.ts`, `deficiency.ts` | `detect`/`plan` tests | `anvil refine plan` | complete |
| Refinement plan | `plan.ts` | `refinement.test.ts` | `anvil refine plan` | complete |
| Typed skill contracts | `skills/contract.ts` | `skills.test.ts` | `anvil refine skills` | complete |
| Skill discovery | `skills/registry.ts` | `skills.test.ts` | `anvil refine skills` | complete |
| Deterministic fallback executor | `skills/executor.ts` | `skills.test.ts` | `anvil refine run` | complete |
| Deterministic proposal validation | `skills/validate.ts` | `skills.test.ts`, `verification.test.ts` | `anvil refine run` | complete |
| Verification-aware validation | `skills/validate.ts` (`evidence_meets_verification`) | `verification.test.ts` | `anvil case validate-proposal` | complete |
| Targeted eval delta | `evals/` | `evals.test.ts` | `anvil refine run` | complete |
| Safety guard | `evals/families.ts`, `reconcile.ts` | `refinement.test.ts` | `anvil refine run` | complete |
| Approval routing | `approval.ts` | `artifacts-approval.test.ts` | `anvil refine run` | complete |
| Verification-aware approval | `approval.ts` (grounding guard) | `artifacts-approval.test.ts` | `anvil refine run`/`case close` | complete |
| Refinement packs | `pack.ts` | `pack.test.ts` | `anvil refine run --out` | complete |
| Review rendering | `pack.ts` (`renderReviewMarkdown`) | `pack.test.ts` | `anvil refine review` | complete |
| Apply approved refinements | `apply.ts` | `apply.test.ts` | `anvil refine apply` | complete |

## Case investigation

| Feature | Implementation | Tests | CLI/API surface | Status |
| --- | --- | --- | --- | --- |
| Immutable case run | `store.ts`, `identity.ts` | `protocol-conformance.test.ts` | `anvil case open` | complete |
| Canonical `case.json` | `schema.ts`, `model.ts`, `materialize.ts` | `protocol-conformance.test.ts` | `anvil case open` | complete |
| Generated `CASE.md` | `materialize.ts` | `protocol-conformance.test.ts` | `anvil case open` | complete |
| Generated case output schema | `schema.ts` (`expectedProposalSchema`) | `protocol-conformance.test.ts` | `anvil case open` | complete |
| Exact proposal-to-case binding | `identity-binding.ts` | `protocol-conformance.test.ts` | `anvil case validate-proposal`/`close` | complete |
| Explicit lifecycle | `lifecycle.ts` | `proposal-lifecycle.test.ts` | (internal) | complete |
| Tamper-evident frozen stages | `lifecycle.ts` (stage hashes) | `protocol-conformance.test.ts` | (internal) | complete |
| Honest decline outcomes | `proposal.ts`, `investigation.ts` | `proposal-lifecycle.test.ts` | `anvil case finalize --status` | complete |
| Explicit proposal-validation outcome | `lifecycle.ts` (`proposalValidation`) | `proposal-lifecycle.test.ts` | (internal) | complete |
| Finalization from lifecycle metadata | `proposal.ts` (`finalize`) | `proposal-lifecycle.test.ts` | `anvil case finalize` | complete |
| Rejected proposal cannot close | `executor.ts` (`closeCase` gate) | `proposal-lifecycle.test.ts` | `anvil case close` | complete |
| `supported` proves current value | `proposal.ts` (`evaluateSupported`) | `proposal-lifecycle.test.ts` | `anvil case finalize --status supported` | complete |
| Verified local evidence artifacts | `evidence.ts` | `evidence-acquisition.test.ts` | `anvil case add-evidence --path` | complete |
| Coordinate-derived artifact identity | `evidence.ts` | `evidence-acquisition.test.ts` | `anvil case add-evidence` | complete |
| Single verification truth (`verification.status`) | `evidence.ts`, `schema.ts` | `evidence-acquisition.test.ts` | (internal) | complete |
| Discriminated evidence coordinates | `schema.ts` (`zEvidenceCoordinate`) | `evidence-acquisition.test.ts` | `anvil case add-evidence` | complete |
| Async evidence providers | `evidence.ts` (`EvidenceAcquirer`) | `evidence-acquisition.test.ts` | (internal) | complete |
| Injectable evidence providers | `evidence.ts`, `service.ts` | `evidence-acquisition.test.ts` | `CaseService` ctor | complete |
| Artifact-derived final status | `executor.ts` (`readInvestigation`) | `protocol-conformance.test.ts` | `anvil case close` | complete |
| Source-change detection before close | `evidence.ts` (`verifyFrozenEvidence`) | `protocol-conformance.test.ts` | `anvil case close` | complete |
| Explicit delete operation | `store.ts` (`deleteRun`), `service.ts` | `protocol-conformance.test.ts` | `anvil case delete` | complete |
| Explicit resume operation | `store.ts` (`resumeCase`), `service.ts` | `protocol-conformance.test.ts` | `CaseService.resume` (no CLI verb) | partial |

## Agent execution

| Feature | Implementation | Tests | CLI/API surface | Status |
| --- | --- | --- | --- | --- |
| Asynchronous process runner | `process-runner.ts` | `driver.test.ts` | (internal) | complete |
| stdout/stderr streaming | `process-runner.ts` | `driver.test.ts` | `anvil case investigate` | complete |
| Timeout | `process-runner.ts` | `driver.test.ts` | (policy) | complete |
| Cancellation | `process-runner.ts` (AbortSignal) | `driver.test.ts` | (internal) | complete |
| Execution result metadata | `process-runner.ts` (`AgentRunResult`) | `driver.test.ts` | (internal) | complete |
| Minimal environment / allowlist | `process-runner.ts` (`allowlistedEnv`) | `driver.test.ts` | (policy) | complete |
| Named credential profile | `execution-policy.ts` (`CREDENTIAL_PROFILES`) | `driver.test.ts` | (driver option) | complete |
| Execution backend seam | `execution-policy.ts` (`ExecutionBackend`) | `driver.test.ts` | (internal) | complete |
| Backend capability declaration | `execution-policy.ts` (`ExecutionBackendCapabilities`) | `driver.test.ts` | (internal) | complete |
| Explicit degraded native execution | `execution-policy.ts`, `driver.ts` | `driver.test.ts` | `anvil case investigate --allow-degraded-native` | complete |
| Execution attestation | `execution-policy.ts` (`ExecutionAttestation`) | `driver.test.ts` | (run metadata) | complete |
| Bubblewrap backend | — (`ExecutionBackend` seam ready) | — | — | intentionally deferred — execution backend interface ready |
| Container / Cloud Run Job backend | — (`ExecutionBackend` seam ready) | — | — | intentionally deferred — execution backend interface ready |

## Investigator measurement

| Feature | Implementation | Tests | CLI/API surface | Status |
| --- | --- | --- | --- | --- |
| Protocol-conformance suite | `protocol-conformance.test.ts` | (is the suite) | `pnpm test` | complete |
| Real-agent effectiveness battery (opt-in) | `battery/effectiveness.ts` | `battery/effectiveness.test.ts` (skipped by default) | opt-in | complete |
| Benchmark labels hidden from investigator | `battery/effectiveness.ts` | `battery/effectiveness-metrics.test.ts` | (internal) | complete |
| 30-case taxonomy | `battery/effectiveness-cases.ts` | `battery/effectiveness.test.ts` | (internal) | complete |
| Scripted baseline-vs-investigation exemplars | `battery/scenarios.exemplars.ts`, `battery/run.ts` | `battery/run.test.ts` | (internal) | complete |
| Verification disposition reporting | `battery/run.ts`, `battery/types.ts` | `battery/run.test.ts` | (report) | complete |
| Metrics (outcome, groundedness, decline, conflict, verification, cost, runtime) | `metrics.ts`, `battery/effectiveness.ts` | `battery/effectiveness-metrics.test.ts` | (report) | partial |

Notes:

- **Resume** is implemented in `CaseService.resume` / `store.resumeCase` but has
  no dedicated `anvil case resume` CLI verb; a resumed run is reached by pointing
  the in-case helpers at an existing run directory. Marked *partial* on that
  basis.
- **Metrics** collects outcome, groundedness, decline, conflict, and verification
  disposition; cost/runtime are captured where the driver surfaces them
  (`AgentRunResult.durationMs`) but are not yet aggregated for the scripted
  battery, so it is *partial* rather than complete.
- **Bubblewrap / container / Cloud Run Job** backends are *intentionally
  deferred*: the `ExecutionBackend` interface and its capability declarations
  exist and native execution refuses to run degraded without explicit consent, so
  a sandbox is a drop-in backend, not a redesign.
