# ADR-0018 — Static versus executable certification

**Status:** Accepted; implemented — see "Implementation status" below.

## Context
Calling a bundle "certified" because its files exist, or because unit tests pass,
is a lie an agent platform will act on. A certification is only meaningful if the
generated surfaces were actually *started and exercised*, and if a deliberate
safety regression cannot slip through it.

## Decision
Add `@anvil/certification` with a graded status and two real phases.

- **Status** is `failed | static_passed | simulator_exercised | certified |
  expired`. `static_passed` and `certified` are distinct: static success is
  never certified. `simulator_exercised` is executable success on a surface
  with no applicable safety mutant — booted and held, but no safety-regression
  claim proven.

- **Static checks** confirm internal coherence: no unapproved/blocked operation on
  the certified surface, the signature matches the contract, and — when a pack is
  supplied — `verifyPack` passes and the pack's declared surface digest matches.

- **Executable checks boot the simulator** (Increment 7's contract-faithful,
  in-process surface) and exercise it: live tools vs the signature, representative
  reads, confirmation refusal, scope enforcement, idempotent replay, response
  shape against the declared item schema, injected faults, and error
  normalization (every returned error is in the AIR `ErrorCode` taxonomy). A check
  with no applicable operation passes with a note, so certification generalizes.
  Every expectation is read from an *oracle* contract that defaults to the booted
  one; the mutation battery is the caller that separates the two.

- **The mutation battery must be killed.** Each standard mutant deliberately
  weakens a control — remove confirmation, enable unsafe retry, drop an OAuth
  scope, weaken a mutation to a read, corrupt an output schema. A mutant is
  *killed* only when the surface signature classifies the change (a **safety**
  mutant specifically as `safety-sensitive`) **and** at least one check fails
  against the weakened contract: the static checks, plus the executable checks
  run by booting the weakened surface with the certified contract as oracle. A
  digest change alone is not a kill. Each result names the check that killed it
  (`killedBy`) or why it lived (`survivedBy`); a safety mutant that moves the
  digest but fails no check is a survivor, and a finding about the checks. An
  inapplicable mutant is neither killed nor survived. `certified` requires every
  applicable mutant killed and at least one applicable safety mutant among them.

- **The attestation binds** the pack, contract, capability, and surface-signature
  digests plus the target-profile and certification versions. `isExpired` recomputes
  and compares, so a weakened contract cannot silently reuse a prior certification
  — its digests no longer match.

Booting the *actual* generated MCP server in a container (Testcontainers) and
driving the generated CLI (execa) are the deferred impure shell; the simulator is
the deterministic executable substrate that makes the contract exercisable in-process
today, and the same checks run unchanged against a live server when that shell lands.

## Consequences
- "Certified" now means the surfaces were exercised and the safety gates held.
- A safety regression expires the certification instead of passing silently.
- **Deferred:** the containerized live-server/CLI phase (Testcontainers + execa +
  p-limit), StrykerJS-driven source mutation, and skill-example replay against a
  running server. The in-process battery already makes the core invariant
  executable.

## Implementation status

This section records what shipped. An audit once found the executable ladder
unreachable from any command; see
[`docs/architecture/certification-authority.md`](../architecture/certification-authority.md)
for that finding and the remaining split.

**Implemented.** `@anvil/certification` exists with the graded status, the static
checks, the executable checks (with the oracle seam), the mutation battery with
the check-must-fail kill rule, and the attestation binding, all tested.

**Reachable from one shipped command.** `anvil certify --executable` calls
`certify(air, { executable: true })`, so `simulator_exercised` and `certified`
are minted by the product. The record lands in `certification.json` under
`assurance` — `level: "executable"` and `engineStatus` carry the phase and the
engine's verdict — and the engine's executable and mutation checks are bridged
into the record as `contract.certification-core.exec.*` and
`contract.certification-core.mutation.*`. The default `anvil certify` stays
static (`assurance.level: "static"`, `engineStatus: static_passed`); the ladder
is opt-in, never implied.

**What else provides executable evidence.** `anvil simulate` runs the same
executable battery plus `coverageMatrix` directly, writing its own report, and
`anvil publish` requires fresh, bundle-hash-bound `selftest`, `conformance`, and
`simulation` reports with prod failing closed. The generated MCP/CLI surfaces
themselves are booted by `selftest`/`conformance`, not by certification.

**Still unstated above.** `@anvil/generators/certify.ts` owns a second, older
certification model — `certification.json`, four gates, status `passed | failed |
expired` — which is the artifact `publish`, `status`, `approve`, and `sync`
actually read. Reconciling the two is tracked in the document linked above;
`packages/cli/src/certification-authority.test.ts` pins current behaviour so the
reconciliation cannot drift silently.
