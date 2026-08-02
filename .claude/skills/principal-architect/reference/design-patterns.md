# Recurring design patterns

## The dominant shape: detect → typed skill contract → evidence-gated proposal → review

This exact pipeline appears three times in the codebase, independently
converged on rather than shared as one literal module, because each
subsystem operates over a different kind of evidence:

1. **A deterministic detector finds a gap.** `packages/refinement/src/detect.ts`'s
   detectors (`mutation_effect_unproven`, `undocumented_pagination`,
   `contested_safety_semantic`, …) and `packages/harness/src/workflow-candidates.ts`'s
   `detectWorkflowCandidates` are both pure functions over an `AirDocument` —
   no evidence, no MCP calls, no LLM. They only prove a *structural* fact
   ("this mutation has mode=none", "this operation's output covers that
   operation's required params"), never a business one.
2. **A typed contract declares what's allowed to close the gap.**
   `RefinementSkill` (`packages/refinement/src/skills/contract.ts`) names its
   triggers, allowed evidence sources, minimum evidence strength/verification,
   and constraints (`do_not_loosen_safety`, `do_not_invent_business_rules`).
   This is intentionally declarative and separate from the executor that
   fills it in — the same contract can be satisfied by a heuristic executor
   today and a real LLM-driven case investigation later without changing
   what's considered valid.
3. **A proposal is gathered, then deterministically validated — never
   trusted because an agent produced it.** `validateProposal` runs the
   skill's declared checks (schema-boundary, evidence-strength, and
   subsystem-specific ones like `idempotency_carrier_resolves`) against ANY
   proposal, heuristic or agentic. This is what makes an unreliable executor
   safe to use: the machine only accepts demonstrated, grounded
   improvements, never a plausible-sounding one.
4. **Approval is a separate, asymmetric decision from validation.**
   A proposal can be perfectly valid and still route to `review` — validity
   answers "is this internally consistent and evidenced," approval answers
   "is this safe to apply without a human," and conflating them is the most
   common mistake a new contributor makes here.

When you see a request for a new capability that "detects X and fixes it,"
check whether it's actually a new instance of this shape before endorsing a
bespoke pipeline. `packages/harness/src/workflow-probe.ts`'s
`reconcileWorkflow` is a recent worked example of extending the shape to a
brand-new evidence source (external MCP connectivity) without inventing new
machinery — it reuses `reconcile.ts`'s tighten/loosen vocabulary conceptually
even though workflows don't have a loosen direction of their own.

## Deterministic detectors are cheap; evidence gathering is not — don't conflate them

A structural detector (`detectWorkflowCandidates`, the `output_duplicate`/
`structural_leaf_overlap` candidates in `capability-composition.ts`) can run
offline, instantly, on every compile. It should never be the thing that
decides a proposal is *true* — only that it's *worth asking about*. The
FLEXCUBE dogfooding run is the concrete cautionary tale here: a purely
structural signal (`/fcubsWarningResp` appearing identically across all 29
sources) produced 139 candidate members out of ~217 total — 64% pure
transport-envelope noise, not real composition opportunities. See
`findings-log.md`. The fix for this class of problem is a cheap statistical
pre-filter (commonality ratio) *before* anything reaches evidence-gathering
or human review — not a smarter evidence bar after the fact.

## Drift-guard testing — and the one gotcha that will cost you an hour

Anvil generates documentation (`skills/anvil/`, `skills/refinement/`) from
its own command registry / skill definitions via `anvil skill` / `anvil
refine skill`. The drift-guard pattern (see
`packages/cli/src/self-skill.test.ts`, `packages/refinement/src/skilldoc.test.ts`)
asserts, exhaustively and by construction (iterating the generator's own
output keys, not a hand-picked list), that a fresh regeneration produces
byte-for-byte the checked-in copy. This exists because "the skill never
drifts from the CLI" was, at one point, an honestly false claim: the
generator template had changed and nobody had re-run + recommitted the
output.

**The gotcha**: these tests are written as
`expect(onDiskStaleCopy).toBe(freshCorrectGeneration)`. Vitest/Jest ALWAYS
labels the argument inside `expect()` as "Received" (`+` in the diff) and the
argument inside `.toBe()` as "Expected" (`-`) — regardless of which one is
conceptually correct. When this test fails, the `-`/"Expected" lines are very
often your correct, freshly-generated output, and the `+`/"Received" lines
are the stale checked-in file that needs regenerating — the opposite of the
instinctive reading. Before hypothesizing a bug in your source change, run
the actual generator command and diff its output against what the test
printed; don't trust which side "looks red."

**When you add or change anything that flows into generated docs**: rebuild
the package whose dist the generator reads from (`pnpm --filter <pkg>
build`), THEN rebuild the CLI that bundles it (`pnpm --filter @anvil/cli
build`), THEN regenerate. Regenerating against a stale dist is a second,
distinct trap from the diff-direction one above — both have independently
cost real time in this codebase's history.

## The "detector exists, no skill closes it" gap — check for this specifically

Twice now, a real deficiency detector or schema field existed for months
before anything actually closed the gap it named:
- `mutation_effect_unproven`/`retry_basis_unproven` existed in `detect.ts`
  with `suggestedSkill: "classify-idempotency"` named in the catalog, but no
  such skill was registered — the highest-leverage gap in the whole
  refinement suite, since it's the one class of finding that gates
  auto-retry on real financial mutations.
- `Workflow`/`WorkflowStep` existed as a fully-typed AIR schema (with the
  compiler's `buildWorkflows` already able to turn a manifest entry into a
  real `Workflow`), and the schema's own comment said workflows are
  "authored or enriched, never guessed" — but `enrich.ts` hardcoded
  `workflows: {}` in every proposed manifest and nothing ever populated it.

**When reviewing a "should we build X" question**: grep for whether AIR
already has a field, `detect.ts` already has a detector, or a manifest schema
already has a slot for X before assuming it needs new architecture. The
highest-leverage work in this codebase has repeatedly been "wire up
something that was already half-built and load-bearing in its own comments,"
not "invent a new subsystem."
