# PR #5 hardening report — case-based investigation framework

This report summarises the refactor that made the investigation framework smaller,
safer, and measurable, per the review brief. The north star is unchanged: **give an
intelligent coding agent a bounded investigation case, not an unstructured prompt** —
but the agent is now bounded and attributable in code, not in prose.

> Division of labour: Claude Code owns investigation, repository navigation, evidence
> discovery, synthesis, and critique. Anvil owns case identity, semantic target,
> evidence admissibility, mutation boundaries, runtime validation, reconciliation,
> eval delta, and application. **A coding agent can no longer define or widen the
> boundary of its own investigation.**

## Deleted (surface removed)

- **Fake symbol tooling.** `search-symbol` and `list-callers` (the latter a grep alias
  masquerading as call-hierarchy) are gone, along with the hand-rolled recursive
  synchronous filesystem walk that backed them. Repository search is the coding
  agent's own capability; Anvil no longer ships a weak re-implementation of it.
- **`show-schema`** was folded into `inspect` (one read-only introspection rail).
- **The blocking `spawnSync` driver** was removed in favour of an async runner.
- **The warn-and-accept predicate path** in `add-evidence` was removed — off-policy
  predicates are now rejected, not noted.

## Simplified (consolidated)

- **One introspection rail** (`inspect`) instead of `inspect-target` + `show-schema`.
- **Generic process lifecycle** was consolidated into one reusable
  `AgentProcessRunner`; the Claude driver only *configures* it. Timeouts, streaming,
  cancellation, exit status, and the execution log live in one place.
- **Workspace + run identity** are computed once at case creation and carried as
  structured data (`run.json`, `allowed-tools.json` workspace) instead of ad-hoc flags.
- The helper set is now exactly the rails that enforce Anvil semantics: `inspect`,
  `add-evidence`, `validate-claims`, `synthesize`, `validate-proposal`, `finalize`.

## Enforced (documentary → code)

| Previously documentary | Now enforced in code |
| --- | --- |
| "a proposal is for its target" | **Identity binding**: skill, version, deficiency, `proposal.target`, and `patch.target` must all equal the case; mismatches are rejected loudly at parse and close. A proposal for field A cannot patch field B. |
| "don't reuse stale output" | **Immutable runs**: each open creates a fresh content+time-addressed run dir; a new run never consumes stale `output/`; resume/replace is explicit. |
| "only inspect these paths" | **Containment**: inspect scopes resolve against an explicit repository root and are rejected if they escape it (path traversal). The repo is read-only; the case dir is the only writable place. |
| "use admissible evidence" | **Predicate policy**: claims must assert an output or a narrow supporting predicate; enforced at ingestion *and* independently at validation (even for a hand-written `claims.json`). |
| "cite real sources" | **Frozen evidence**: filesystem evidence is ingested by coordinate; Anvil verifies the path is in scope, validates the line range, reads the exact bytes, hashes them, and freezes an immutable artifact the claim references by id. Close re-verifies every excerpt against the repo and refuses a tampered/stale source. |
| "don't invent, don't guess" | **Honest declines** are first-class statuses the reconciler already understood; the battery now measures them. |
| "separate the phases" | **Immutable staging**: research+claims freeze on synthesize; the proposal freezes on validate. |

## Remaining limitations (stated honestly)

- **Local process isolation is not a sandbox.** The case directory is an *isolated
  workspace*, not a kernel/container boundary. Enforcement is: read-only repository
  expectation, a git/hash re-verification of frozen evidence at close (detects
  post-hoc source changes), and a minimal env allowlist for the driver. A container
  mode (`/case` writable, `/repo` read-only) is a documented future option, not a
  claimed guarantee.
- **Phase separation is self-critique, not independent review.** A single driver
  process performs research → synthesis → critique; the stages are *frozen* so the
  later phase cannot rewrite the earlier output, but true independence would require a
  second driver run against the frozen artifacts.
- **One canonical case document (§6) and Zod-as-source-of-truth (§5) are not yet
  landed.** The case still materialises several input files and uses hand-written
  parsers (with loud runtime validation) rather than one `case.json` + derived Zod
  schemas. This is the primary remaining refactor; it is additive to the guarantees
  above (which already hold) and is scoped in `docs/INVESTIGATION_ARCHITECTURE.md`.

## Benchmark readiness — what the battery can and cannot prove

Two distinct surfaces:

- **Protocol conformance suite** (`case/protocol-conformance.test.ts`, in CI, no real
  agent). Proves the mechanics end-to-end: case creation, identity binding, stale-run
  prevention, source + predicate policy, parser rejection, deterministic
  close/reconcile, honest declines, evidence freezing + tamper detection, phase
  staging, and repository containment. **This is green and gating.**
- **Investigator effectiveness battery** (`case/battery/effectiveness.ts`, opt-in,
  real driver). A 30-case taxonomy (explicit / distributed / ambiguous / conflicting /
  safety-sensitive / structurally-complex evidence) run against real repository
  fixtures, with the answer LABELS held in an evaluator-owned structure **outside the
  agent's inspect scope** — so it measures investigation, not answer extraction.
  Primary metrics: grounded-proposal precision, correct-decline rate,
  conflict-detection recall, unsupported-claim rate (explicitly **not** proposal rate).

  *What it can prove:* given a real coding-agent binary, which deficiency classes the
  investigator handles well and where it over-proposes. *What it cannot prove here:*
  it does not run in this environment or in unit CI (no agent binary; slow). The
  scoring logic is unit-tested (`effectiveness-metrics.test.ts`); the harness is ready
  to run under `ANVIL_EFFECTIVENESS_BATTERY=1` with a configured driver.
