# ADR-0011 — Investigator benchmark design (conformance vs. effectiveness)

**Status:** Accepted

## Context
The investigation subsystem has to answer two different questions, and they demand
different tests. First: *does the protocol hold?* — identity binding, stale-run
prevention, policy enforcement, honest declines. Second: *does the investigator
actually help?* — how much genuine grounding a real agent contributes over the
deterministic baseline. Collapsing both into one suite corrupts both: a suite that
mocks the agent cannot measure a real agent's effectiveness, and a suite that
embeds the expected answer in files the agent can read measures answer-extraction,
not investigation.

## Decision
Two separate test surfaces.

**1. Protocol conformance suite — scripted, deterministic, ordinary CI.**
Runs against the `ScriptedAgentDriver` (no LLM, no network, no flakiness) and
verifies the framework's invariants:

- identity binding (a run is bound to its case identity and inputs),
- stale-run prevention (a new open never sees a prior run's `output/`; ADR-0009),
- policy enforcement (out-of-scope reads and non-writable fields are refused),
- parser rejection (malformed executor output fails loud; `case/model.ts`),
- deterministic reconcile (the same evidence yields the same outcome),
- honest declines (`conflicted` / `insufficient_evidence` surface as themselves),
- source immutability (evidence artifacts are frozen and hash-checked; ADR-0008),
- repository cleanliness (an investigation leaves the tree clean; ADR-0010).

**2. Investigator effectiveness battery — opt-in, real driver, excluded from unit CI.**
Invokes the **real Claude Code driver** against a **30-case taxonomy** of varied
deficiency scenarios (documented, implicit-in-impl, only-in-tests, conflicting,
generic-name, sensitive, unit-bearing, unused, weak-single-source, tautological,
error-loosen-weak, …; see `case/battery/types.ts`). Its **expected-outcome labels
live in an evaluator-owned directory outside the agent's allowed inspect scopes**,
so the agent cannot read the answer key — it measures *investigation*, not
*answer-extraction*.

Primary metrics are quality-of-grounding, explicitly **not** proposal rate (a
system that proposes on everything is worse, not better):

- **grounded-proposal precision** — of proposals made, how many are truly
  evidence-backed;
- **correct-decline rate** — of cases that *should* decline, how many do;
- **conflict-detection recall** — of planted docs-vs-code conflicts, how many are
  caught;
- **unsupported-claim rate** — claims lacking a valid frozen artifact (drive to 0).

## Consequences
- Unit CI stays fast, deterministic, and hermetic; the LLM-dependent, costly,
  potentially flaky battery is opt-in and never gates a normal build.
- Because the answer key is outside every allowed scope, a high score can only
  come from investigation — the benchmark cannot be gamed by reading labels.
- Optimising for the honest metrics rewards declining when evidence is thin;
  "proposed a lot" is not a win.
- The battery depends on ADR-0010's execution log for cost/latency and on ADR-0008
  for the unsupported-claim check. See `docs/INVESTIGATION_ARCHITECTURE.md`.

## Alternatives considered
- **One suite that both mocks the agent and embeds answers in agent-visible
  files.** Rejected: it can neither measure a real agent (it is mocked) nor trust
  its own score (answers are readable) — it conflates conformance with
  effectiveness and quietly measures extraction.
- **Proposal rate as a headline metric.** Rejected: it rewards over-proposing,
  the exact guessing behaviour Anvil exists to remove; precision and
  correct-decline rate are the honest signals.
