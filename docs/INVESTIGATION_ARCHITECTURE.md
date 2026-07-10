# The case-based investigation framework

This document describes the **case** subsystem (`packages/refinement/src/case/`):
the part of Anvil that lets a coding agent (Claude Code, Codex, a human) do
the one thing a deterministic pass cannot — go read the repository and find the
truth a spec omits — without letting that agent become an unaccountable oracle.

It documents the **target design**. Some of it is implemented today; where the
current code is being hardened toward a stricter shape, this document describes
the target and says so. The rule that governs every decision here:

> A coding agent owns investigation, navigation, evidence-discovery, synthesis,
> and critique. Anvil owns case identity, the semantic target, evidence
> admissibility, mutation boundaries, runtime validation, reconciliation, eval
> delta, and application. **An agent is never trusted to define or widen the
> boundary of its own investigation.**

The refinement loop already knows how to *detect* a deficiency, *validate* a
proposal against a skill contract, *measure* it against evals, and *reconcile*
it under the asymmetric-trust rule. What it could not do was the messy middle:
turn "this field has no description" into a grounded, sourced answer. The case
framework is that middle, boxed so its output re-enters the existing rails
unchanged.

## 1. What a case is

A **case** is an isolated, bounded investigation for exactly **one** detected
deficiency — one semantic target in AIR (a field, an operation, an error, a
capability) that a deterministic pass flagged and could not close on its own.

The design's central move is: *give a coding agent a case, not a prompt.* An
unstructured prompt ("write a description for this field") reduces a capable
agent to a summariser and gives Anvil no way to check its work. A case instead
hands the agent:

- a **semantic target** it may act on, and no other;
- an **evidence policy** — which sources are admissible and how strong they must be;
- a **mutation boundary** — the exact fields and predicates it may write;
- an **investigation procedure** — a repeatable method, phased;
- a `workspace/` to think in and an `output/` to deposit machine-readable results.

The agent does the intelligent work: plan retrieval, navigate the codebase,
discover and read evidence, extract atomic claims, draft a patch, and try to
falsify it. Anvil does everything that must be trustworthy: it decides what
counts as evidence, freezes it, holds the patch to the boundary, re-validates,
measures the eval delta, and only then applies. Nothing in a case mutates AIR;
a case only ever *proposes*.

The division is not a nicety — it is the safety property. If the agent could
widen its own boundary (write a field outside the skill's scope, admit a source
the policy forbids, redefine the target), the entire refinement loop would
inherit the agent's judgment as authoritative. It cannot, by construction.

## 2. Canonical `case.json` vs generated views

A case has **one canonical document**: `case.json`. Everything else in the case
directory is either a *generated view* of it (which must never drift) or a
*phase output* the agent deposits.

`case.json` (target shape) carries:

| field | meaning |
| --- | --- |
| `version` | schema version of the case document |
| `identity` | the immutable run identity (see §3) |
| `task` | the one-line question, the skill, the phases to run, the outputs to produce |
| `target` | the semantic coordinate + the denormalised AIR facts needed to investigate it |
| `workspace` | scratch scope the agent may write freely |
| `skill` | skill name + version the case is opened against |
| `policy` | admissible sources, minimum strength, writable predicates, writable fields, prohibitions |
| `procedure` | the phased method + retrieval hints |
| `context` | prior target-scoped evidence AIR already holds (a starting point, not a licence to skip work) |
| `expectedOutput` | the contract the deposited proposal will be held to |

Two **generated views** are derived from `case.json` and written alongside it.
They are convenience renderings and are regenerated, never authored:

- **`CASE.md`** — the human/agent brief. Prose rendering of task, target,
  admissible evidence, the "you may not" list, the phased method, and retrieval
  hints. This is what the driver feeds the agent.
- **`expected-output.schema.json`** — the JSON Schema the proposal must satisfy,
  parameterised by the skill's writable fields (see §6).

Neither view may contain a fact that is not in `case.json`. If they disagree
with it, `case.json` wins and the views are stale.

> **Current vs target.** Today the canonical inputs are split across
> `task.json`, `target.json`, `evidence-policy.json`, and `allowed-tools.json`
> (see `model.ts` `CASE_FILES`), and `CASE.md` is rendered from those. The
> target consolidates these into a single `case.json` with the views derived
> from it, so there is exactly one source of truth per case and drift is
> impossible by shape rather than by discipline.

Phase outputs live **separately**, under `output/`, and are written by the agent:

```
output/evidence.json     research      located evidence artifacts (frozen — §5)
output/claims.json       extract       atomic, sourced claims referencing artifact ids
output/proposal.json     synthesize    the evidence-backed patch (SkillProposal shape)
output/critique.json     critique      falsification pass + deterministic check outcomes
output/tests.json        test          the checks that would prove the change holds
output/result.json       finalize      the honest outcome (including "no proposal")
```

> **Current vs target.** The critique output is presently named
> `validation-report.json`; the target name is `critique.json`. The set and
> ordering are otherwise as above.

## 3. Case identity and immutable runs

Every case has a stable **case key**:

```
<skill>--<target-key>          e.g.  describe-field--op.get_user.input.body.email
```

path-safe (unsafe characters folded), deterministic, and collision-free for a
given `(skill, target)`. The same deficiency always yields the same case key.

A case key is not a directory you overwrite. Each **run** of a case is an
**immutable directory**:

```
.refinement/cases/<case-key>/<run-id>/
├── case.json                 canonical input (§2)
├── CASE.md                   generated view
├── expected-output.schema.json  generated view
├── workspace/                agent scratch space
└── output/                   phase outputs (§2)
```

The run's `identity` (stored in `case.json`, and this is the target set of
fields) records enough to prove *what world the investigation ran against*:

- **run id** — unique per run;
- **AIR content hash** — the exact model state the case was opened from;
- **source revision** — the repository revision the agent was pointed at;
- **skill version** — the version of the skill contract in force;
- **policy hash** — a hash of the evidence/boundary policy;
- **executor identity** — which driver/agent produced the outputs;
- **creation timestamp**.

Rules:

- **Opening a case creates a NEW run.** Re-opening never reuses an old run's
  `output/`.
- **Resume requires an explicit run path.** You cannot implicitly "continue"
  a case; you name the run directory you mean.
- **Stale `output/` is never consumed implicitly.** A run's outputs are only
  ever read in the context of *that run's* identity. An investigation done
  against a different AIR hash or source revision is a different run, and its
  outputs are not silently harvested.

This is what makes a case auditable months later: given a `result.json`, you can
recover the precise AIR, revision, skill, and policy it was produced under.

> **Current vs target.** `openCase` today materialises `.refinement/cases/<id>/`
> directly (no per-run subdirectory) and records no `identity` block; a re-open
> overwrites in place. The target inserts the immutable `<run-id>/` layer and
> the identity metadata so runs are append-only and provenance is explicit.

## 4. Proposal ↔ identity binding

A proposal produced for field A must never be able to patch field B. This is
enforced by **exact-equality checks at parse time and again at close time** —
never by silently rewriting a mismatched value to "fix" it.

At both boundaries Anvil requires:

```
case.target  ==  proposal.target  ==  proposal.patch.target
case.skill        ==  proposal.skill
case.skillVersion ==  proposal.skillVersion
case.deficiency   ==  proposal.deficiency
```

Any mismatch is **rejected loudly**. A proposal whose `patch.target` differs
from its own `target`, or from the case's target, is not coerced into
alignment — it is refused, because a coerced target is exactly the failure mode
(the agent quietly investigated the wrong thing) that the check exists to catch.

> **Current vs target.** The synthesize rail (`synthesizeProposal`) sets both
> `target` and `patch.target` from the case's own target, and `closeCase`
> re-validates against the case's rebuilt context — so today the binding holds
> because the rail constructs it. The target design adds the *independent
> equality assertion* at parse and at close, so that a hand-written or
> agent-authored `proposal.json` (not produced via the rail) is checked rather
> than trusted.

## 5. Evidence freezing

Evidence is the load-bearing input to every proposal, so the agent is not
allowed to *assert* evidence — only to *point at a source*, which Anvil then
reads and freezes.

Evidence is ingested via a **source coordinate**:

```
{ repositoryRevision?, path, startLine?, endLine? }
```

On ingestion Anvil:

1. verifies `path` exists and is **within an allowed scope** (the inspect
   scopes / evidence policy — not an arbitrary path);
2. reads the **exact content** at that path;
3. validates the line range (`startLine`/`endLine`) against the file;
4. computes a **content hash** over the excerpt;
5. stores an immutable **`EvidenceArtifact`**:

```
EvidenceArtifact {
  id            stable artifact id claims reference (see "identity" below)
  uri           the source coordinate, canonicalised
  source        evidence kind (implementation, contract_test, doc, …)
  revision?     repository revision the excerpt was read at
  contentHash   hash of the frozen excerpt
  excerpt       the exact bytes Anvil read (not agent-supplied)
  acquiredAt    acquisition timestamp
  verification  { status: "verified", verifier } | { status: "unverified", reason }
}
```

**Artifact identity is the source coordinate, not the content.** A local
repository artifact's `id` is derived from `{kind, repositoryRevision, path,
startLine, endLine, contentHash}`; an external artifact's from `{kind, source,
uri, contentHash}`. Two *distinct* coordinates that happen to hold the same
excerpt therefore receive **different** ids — content alone can never collapse
two independent sources into one, or let a file "corroborate itself." A changed
revision changes the id, so provenance is coordinate-exact.

**Verification has one source of truth: `verification.status`.** There is no
separate `verified` boolean that could drift from it. A local-repository artifact
is `verified` (Anvil read and hashed the exact bytes itself); an external
artifact is `unverified` (the excerpt is caller-supplied and cannot be
independently confirmed until a real second-source provider resolves it).

Claims (`output/claims.json`) then reference **frozen artifact ids**. A claim
cannot carry an authoritative excerpt of its own; the excerpt is whatever Anvil
read from the verified source. This closes the obvious attack: an agent cannot
write a persuasive quote and attribute it to a file that does not say that.

**Verification participates in validation and approval, not just storage.**
- The deterministic check `evidence_meets_verification` resolves each patched
  value's grounding claims to their frozen artifacts and holds them to the
  skill's per-field trust bar (`fieldVerification[field] ?? minimumVerification`).
  A field that requires `verified` evidence (e.g. an error's `retryable`) rejects
  a proposal grounded only in unverified claims.
- The approval policy routes any auto-eligible proposal grounded **only** by
  unverified artifacts to `review`, however strong its aggregate strength.
  Verified grounding is *necessary but not sufficient* — every existing strength
  and safety rule still applies. Only the artifacts that ground the patched
  values count; an unrelated verified artifact elsewhere in the case does not
  upgrade an unverified proposal.

Non-filesystem sources (GitHub, Confluence, and other MCP-served sources, added
later) use the **same canonical artifact form** and the same freeze-then-hash
discipline, so the trust boundary does not depend on where evidence came from.

## 6. Schema as the single source of truth

Every case document and every phase output is defined by a **Zod schema**. From
those schemas, three things are **derived, not hand-maintained**:

- the **TypeScript types** (via `z.infer`);
- the **runtime parser** (via `schema.parse`) at the boundary between untrusted
  agent output and typed data;
- the **JSON Schema** handed to the agent as `expected-output.schema.json`.

There are **no hand-written parsers** and **no `as unknown as` casts** at the
trust boundary. Rejection is total and specific:

- an inadmissible evidence source → rejected;
- a confidence outside `[0, 1]` → rejected;
- a malformed target (unknown `kind`, missing coordinate) → rejected;
- an invalid deficiency code → rejected;
- a non-JSON patch value → rejected.

The **case-specific proposal JSON Schema** is generated *per case* with the
skill's parameters baked in as constants:

- `skill`, `skillVersion`, `deficiency` — fixed to the case's values;
- `target` and `patch.target` — constrained to the case's target;
- `predicate` — constrained to the allowed predicate set (§7);
- `patch.set` property names — constrained to the skill's writable fields, with
  `additionalProperties: false` where appropriate.

So the schema the agent is handed does not merely describe *a* proposal — it
describes *this case's only admissible proposal*, and anything else fails schema
validation before it reaches business logic.

> **Current vs target.** `model.ts` currently uses hand-written parsers
> (`parseCaseProposal`, `asClaim`, with a couple of `as unknown as` casts) and
> `expectedOutputSchema()` emits a generic draft-07 schema keyed only on
> writable fields. The target moves all of this to Zod-derived types + parsing
> and generates a fully-constant-baked per-case proposal schema.

## 7. Predicate policy

A claim's `predicate` is not free-form. It must be one of:

- an **`outputPredicate`** — a predicate the skill's patch actually asserts
  (e.g. `field.description`, `error.retryable`); or
- a narrow, per-skill **`supportingPredicate`** — an intermediate observation
  that grounds an output predicate without itself being written to AIR.

Anything else is rejected **twice, independently**: once at **ingestion**
(`add-evidence` refuses it) and again at **validation** (the deterministic
critic re-checks the deposited claims). Two independent checks matter because
the ingestion rail and the validator are different code paths; an agent that
bypasses the rail and writes `claims.json` directly still hits the validator.

There is no "unconstrained free-form claim" escape hatch. If a skill needs a new
kind of supporting observation, that predicate is added to the skill's contract
— it does not arrive by an agent inventing one.

> **Current vs target.** `addEvidence` today *warns* when a predicate is not a
> final patch predicate but still records it as supporting evidence, and the
> allowed set is not yet split into `outputPredicate` / `supportingPredicate`.
> The target formalises the two-tier predicate vocabulary and makes the
> out-of-vocabulary case a rejection at both boundaries rather than a warning.

## 8. Case lifecycle

```
detect deficiency        deterministic  — the refinement plan flags a target
      │
open case                materialize    — new immutable run; case.json + views
      │
investigate              agent, staged  — plan retrieval, navigate, read sources
      │
freeze evidence          Anvil          — verify/read/hash → EvidenceArtifacts (§5)
   + extract claims       agent+Anvil    — atomic claims referencing artifact ids
      │
synthesize proposal      agent          — patch built ONLY from accepted claims
      │
critique / validate      deterministic  — falsify each clause; run skill checks
      │
finalize (honest status) agent+Anvil    — result.json, even when "no proposal"
      │
close                    deterministic  — re-enter validate → measure → reconcile
```

The **honest statuses** a case can finalise with:

| status | meaning |
| --- | --- |
| `proposal_generated` | evidence grounds a validated, in-boundary patch |
| `supported` | the current semantic value is *proven* already correct; nothing to change |
| `conflicted` | sources disagree; declining is the correct answer |
| `insufficient_evidence` | not enough admissible evidence to ground a patch |
| `blocked_by_missing_source` | a required source was unavailable |

`supported` is a **positive claim that must be proven**, not the absence of a
proposal. Anvil derives the skill's current output value from the case's frozen
target snapshot (e.g. a field's existing description, an error's current
retryability) and accepts `supported` only when: no patch exists; a current value
actually *exists*; at least one admissible claim asserts that exact predicate and
exact value; that evidence meets the skill's minimum strength **and** verification
bar; and no unresolved conflict exists. A missing-description case can therefore
**never** finalise as `supported` — there is no current description to support.

**Finalization trusts lifecycle validation metadata, not `critique.json`.** The
authoritative pass/fail verdict for a proposal is the `proposalValidation` record
written into `lifecycle.json` by the `validate-proposal` rail — never the mutable
`critique.json`, which is review material and is not part of any stage-freeze
hash. `finalize` reads the lifecycle record to decide `proposal_generated`, and
refuses outright if a present `critique.json` disagrees with it (a tamper
signal). Editing a rejected `critique.json` to look validated therefore cannot
produce a dishonest `result.json`, and a proposal with no lifecycle validation
record cannot finalise as `proposal_generated`.

Only `proposal_generated` carries a patch. Every other status is a **first-class
outcome**, not a failure — it returns everything learned (plan, artifacts,
claims, conflicts, experiments, critique) so the finding is auditable and a
later, more expensive tier can build on it. **Knowing when *not* to refine is a
feature**, not a low completion rate to be optimised away. The reconciler and
escalation ladder (`escalate.ts`) treat a `conflicted` result, or an unground-
able *safety* deficiency, as a signal to route to a human rather than to force
a proposal.

Close is the join point: `closeCase` runs the **exact same** deterministic back
half every deterministic proposal goes through — `validateProposal` then
`reconcile` (measure + approve). A Claude Code investigation does not get a
privileged path into AIR; it re-enters the rails where every proposal does.

## 9. Phase separation

An undifferentiated agent that both invents a result and approves it is a single
point of failure. The case splits the work into **at least two immutable
stages**, each frozen and deterministically validated before the next begins:

- **Stage 1 — research + claims.** The agent locates evidence and extracts
  atomic claims. Output is frozen (`evidence.json`, `claims.json`) and
  deterministically checked: admissible sources, minimum aggregate strength,
  contradiction detection. Claims that fail are not silently dropped.
- **Stage 2 — synthesis + critique.** The agent drafts the patch **from the
  accepted claims only**, then falsifies each clause. The proposal is frozen
  (`proposal.json`) and deterministically validated: grounded, in-boundary,
  schema-valid (`critique.json`).
- **Stage 3 (optional) — independent critique.** A *separate* process reviews
  Stage 2's frozen output.

The honesty rule: **if only one process is used, Stage 2's critique is
`self-critique`, and it is labelled as such — not "independent review."** The
distinction is recorded so a reviewer knows whether a second pair of eyes
actually looked, or whether the same agent graded its own work.

Because each stage's output is frozen before the next reads it, a later stage
cannot retroactively edit an earlier one to make itself look supported.

## 10. Local containment — an honest accounting

The case directory is an **isolated case workspace**, not a sandbox. This is
stated plainly because over-claiming here would be a safety lie:

> A working directory plus a prose prohibition ("do not edit files outside this
> directory") is **not** a security boundary. A determined or confused agent
> can ignore it.

What local enforcement **does** provide today:

- **repository read-only expectation** — the agent is pointed at the repo to
  read, and told not to write it;
- **git-cleanliness check, before and after** — the framework records the git
  state on entry and re-checks on exit, so any file modified **outside the case
  directory** is *detected* (even if not prevented);
- **minimal inherited environment / env allowlist** — the driver passes a
  reduced environment rather than the full ambient one;
- **strict agent permission mode where available** — e.g. running the Claude
  Code driver in a restricted permission mode.

What is **not** claimed as present:

- **Full container isolation** (`/case` writable, `/repo` read-only, no network
  egress) is an **optional future mode**. **Bubblewrap and container backends are
  intentionally deferred — not implemented.** The `ExecutionBackend` seam and its
  capability declarations are ready for them, but no sandboxed backend exists yet.

**Degraded native execution now requires explicit consent.** Because the native
backend cannot enforce the filesystem split (repository read-only, case-only
writes), `defaultExecutionPolicy()` sets `allowDegradedNative: false`, and a
native investigation **refuses to start** unless the caller opts in:

```
anvil case investigate <case-dir> --allow-degraded-native
```

Without the flag, the driver fails fast with:

> Native execution cannot enforce repository read-only and case-only writes.
> Use a sandboxed backend or pass --allow-degraded-native to acknowledge the
> reduced containment.

Degradation is never enabled implicitly "because Bubblewrap is unavailable." When
it is acknowledged, the run still records an **execution attestation** naming
every guarantee the backend could not enforce, so the gap is visible in the run's
metadata rather than assumed away.

The security posture the framework actually relies on is **not** containment —
it is that the agent's output is *untrusted until deterministically validated*.
Containment reduces blast radius; validation is what makes the result safe to
apply.

## 11. Async, observable driver

The `AgentDriver` seam is the one place a real coding agent is invoked. It is
kept narrow and swappable so the rest of the framework — materialise, validate,
reconcile — stays agent-free and deterministic.

The target driver runs the agent as an **asynchronous child process** through a
reusable **`AgentProcessRunner`** that owns process lifecycle and exposes:

- **streamed** stdout/stderr (not buffered-until-exit);
- a **timeout** (hard wall-clock cap) and **cancellation**;
- **exit status** handling with actionable errors (e.g. "is `claude` on PATH?");
- a **structured execution log** with start/end timestamps;
- optional **token / cost** accounting.

The **Claude Code driver configures the runner** rather than owning the spawn
itself — it supplies the command, args (model, permission mode), env, and
timeout, and lets the runner stream, time, and log. A `ScriptedAgentDriver`
implements the same `AgentDriver` interface with an in-process function, so
every test drives a case deterministically with no LLM and no flakiness.

> **Current vs target.** `driver.ts` currently uses a synchronous `spawnSync`
> with inherited stdio and no structured execution log. The target extracts the
> reusable async `AgentProcessRunner` (streaming, cancellation, timing,
> token/cost) and reduces `ClaudeCodeAgentDriver` to configuring it.

## 12. Two test surfaces: conformance vs effectiveness

Testing a case framework by asking "did the agent get the right answer?"
measures the wrong thing — it measures answer-extraction, not investigation, and
it drags an LLM into ordinary CI. The framework therefore has **two distinct
test surfaces**, and keeping them separate is the point.

**(a) Protocol conformance suite** — scripted, deterministic, runs in ordinary
CI. It uses the `ScriptedAgentDriver` (no LLM) and proves the *mechanism*:

- case creation and materialisation;
- proposal ↔ identity binding (§4);
- stale-run prevention and immutable run identity (§3);
- evidence policy enforcement (admissible source, minimum strength, predicate
  vocabulary);
- parser rejection of malformed output (§6);
- deterministic close / reconcile;
- honest declines (`conflicted`, `insufficient_evidence`, …);
- source immutability (frozen artifacts, §5);
- repository cleanliness before/after (§10).

**(b) Investigator effectiveness battery** — opt-in, invokes the **real Claude
Code driver**, and is **not** in unit CI. It answers the empirical question the
design cares about: *which deficiency classes justify the extra investigation
cost, and how much intelligence does the investigator genuinely add over the
deterministic baseline?* It runs a corpus of deliberately varied scenarios
(documented, implicit-in-impl, only-in-tests, conflicting, generic-name,
sensitive, unit-bearing, weak-single-source, tautological, …) through both the
baseline and the investigation and compares contribution per class.

A critical discipline for (b): **benchmark labels are hidden from the agent** in
an evaluator-owned directory **outside the case's allowed scopes**, so the agent
cannot read the expected answer. Otherwise the battery measures whether the
agent can find the answer key, not whether it can investigate.

Why the split matters: (a) is fast, hermetic, and gates every commit — it proves
the safety mechanism holds. (b) is slow, costs tokens, and is run deliberately —
it measures the thing that is genuinely hard to measure. Collapsing them would
either put an LLM on the CI critical path or dilute the effectiveness signal
with mechanism tests. Keeping them apart lets each be honest about what it
proves.

> **Current vs target.** The effectiveness battery exists today under
> `case/battery/` but drives scenarios through the `ScriptedAgentDriver` (the
> evidence is pre-seeded per scenario). The target keeps that scripted battery
> as a fast approximation and adds the opt-in, real-driver variant with hidden,
> evaluator-owned answer keys as described.

## What Claude owns / What Anvil owns

| Concern | Owner |
| --- | --- |
| Planning retrieval, navigating the repository | **Claude** |
| Discovering and reading candidate evidence | **Claude** |
| Extracting atomic claims from sources | **Claude** |
| Drafting the patch from accepted claims | **Claude** |
| Falsifying its own clauses (self-critique) | **Claude** |
| Deciding to decline (honest "no proposal") | **Claude** (Anvil validates the honesty) |
| Case identity, run immutability, provenance | **Anvil** |
| The semantic target (what may be acted on) | **Anvil** |
| Evidence admissibility, freezing, hashing | **Anvil** |
| Predicate vocabulary + mutation boundary | **Anvil** |
| Schema-derived parsing and rejection | **Anvil** |
| Proposal ↔ identity binding | **Anvil** |
| Runtime validation against the skill contract | **Anvil** |
| Measurement (eval delta) and reconciliation | **Anvil** |
| Approval tier and application to AIR | **Anvil** |

The agent supplies intelligence *inside* guardrails it cannot widen. The
highest compliment remains the same as everywhere else in Anvil: **the agent
stopped guessing** — and, just as importantly, when it should not guess, it says
so, and Anvil can prove it was right to.
