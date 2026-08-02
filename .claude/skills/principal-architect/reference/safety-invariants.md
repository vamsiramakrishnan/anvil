# Safety invariants (the ones a review must never wave through)

## Asymmetric trust — the single load-bearing rule

Tightening a safety semantic (refuse more, retry less, require confirmation)
is cheap to accept, because the worst case is an unnecessary human review.
Loosening one (enable auto-retry, drop a confirmation requirement, invent a
business rule Anvil didn't observe evidence for) is exactly backwards — the
worst case is a non-idempotent mutation firing twice, a real financial or
irreversible action taken without sign-off — so it demands the strongest
evidence bar, *regardless of which mechanism proposed it*.

This shows up as concrete, checkable code, not just prose:
- `packages/harness/src/reconcile.ts`: `LOOSEN_THRESHOLD = 0.85`,
  `TIGHTEN_THRESHOLD = 0.4`. A safety-loosening claim needs a source at
  0.85+ reliability (implementation code, recorded traffic); a
  tightening claim needs only 0.4+.
- `packages/refinement/src/approval.ts`: `classifyApproval` — every rule
  that returns `auto` is either a plain description (no safety weight) or an
  explicit *tightening* direction (e.g. `retryable=false`). Any proposal
  touching an idempotency carrier field returns `review` unconditionally,
  checked on the **patch keys themselves**, not on which skill produced
  them — so a future skill that also happens to write those fields can't
  accidentally slip past the guard by omission.
- `packages/harness/src/reconcile.ts`'s conflict gate: even a loosening claim
  that clears 0.85 gets rejected if a second source disagrees by a narrow
  margin — a razor-thin majority is a review signal, not a fact.

**When reviewing anything new**: find the equivalent gate. If a proposal can
loosen safety or assert business logic with no equivalent asymmetric
threshold, that's a defect in the proposal, not a stylistic nitpick.

## The idempotency/retry model

- `Operation.idempotency`: `{ mode, mechanism, key, keyDerivation }`.
  `mode` ∈ `natural | key_supported | client_id | required | none`. `none` is
  the schema's own default and the most conservative state possible — every
  reclassification moves *away* from it, never further from it. This is why
  `classify-idempotency` proposals are NEVER auto-approved: there is no safe
  "tightening" direction the way `retryable=false` has one for errors.
- `resolveIdempotencyCarrier` (in `@anvil/air`) is the single source of truth
  for whether a claimed carrier (mode + mechanism + key + keyDerivation)
  actually resolves — e.g. `required` mode with `mechanism: "none"` is
  rejected. Refinement's `idempotency_carrier_resolves` validation check
  calls this function directly rather than reimplementing the rule, so
  proposal-time and compile-time enforcement can never drift apart.
- `Operation.retries`: `{ mode: safe|none, basis }`. `basis` is the
  *auditable why* behind the binary gate — `read_safe`, `natural_idempotent`,
  `idempotency_key`, `ledger_guarded`, `transport_only`, `unproven`.
  `unproven` retries are themselves a detected deficiency
  (`retry_basis_unproven`) — an enabled retry with no defensible basis is
  a bug, not a feature.

## The `ReadinessConstraint` disposition ladder

`none < refinementRequired < humanDecisionRequired < blocked`. This ordering
determines whether a skill's output can EVER be auto-approved, independent of
evidence strength. A skill whose predicate carries `humanDecisionRequired`
(idempotency classification is the canonical example) cannot be promoted to
`auto` no matter how strong its evidence gets — the constraint itself, not
just the evidence bar, gates it. When designing a new skill or detector, name
which rung its output sits on before designing the evidence bar; don't invent
a bespoke threshold that happens to reproduce a rung that already has a name.

## Propose-only is the default posture, not a special case

Three independent subsystems all converge on the same shape, and it's not a
coincidence:
- **`anvil refine run`** — a validated proposal is still just a
  `SemanticPatch`; nothing writes to AIR until `applyPatches` is invoked
  explicitly (and even then, `approval.ts` gates auto vs. review).
- **`anvil capability compose`** — `boundary: { autoApproved: false,
  buildReady: false }` is baked into every report. It "stops at a review-,
  evidence-, and contract-bound composition plan" by declared design; there
  is no code path that turns a structural overlap candidate into a built
  artifact without an explicit `--review` manifest.
- **`anvil enrich`** — `runEnrichment` returns a `proposedManifest`; it is
  documented and enforced as never mutating the input `AirDocument`. Real,
  live MCP connectivity to GitHub/Confluence is used to *gather evidence*,
  never to *act*.

If you're evaluating a proposal that adds a fourth "gather evidence, decide
something automatically" subsystem, the default assumption should be that it
follows this same shape until proven otherwise — and if it doesn't, that's
the first question to ask the author, not an oversight to quietly fix later.

## Where this has been dogfooded

`packages/refinement/src/skills/registry.ts`'s `classifyIdempotency` skill
(evidence bar: `minimumStrength: "authoritative"`, `minimumVerification:
"verified"` — the highest bar in the codebase) and
`packages/harness/src/workflow-probe.ts`'s `reconcileWorkflow` (workflow
candidates always propose `state: "review_required"`, never `approved`,
regardless of how many sources corroborate them) are both real,
recently-built instances of this rule, not aspirational description — read
them as worked examples when reviewing a new safety-adjacent proposal.
