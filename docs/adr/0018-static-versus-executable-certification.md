# ADR-0018 — Static versus executable certification

**Status:** Accepted

## Context
Calling a bundle "certified" because its files exist, or because unit tests pass,
is a lie an agent platform will act on. A certification is only meaningful if the
generated surfaces were actually *started and exercised*, and if a deliberate
safety regression cannot slip through it.

## Decision
Add `@anvil/certification` with a graded status and two real phases.

- **Status** is `failed | static_passed | certified | expired`. `static_passed`
  and `certified` are distinct: static success is never certified.

- **Static checks** confirm internal coherence: no unapproved/blocked operation on
  the certified surface, the signature matches the contract, and — when a pack is
  supplied — `verifyPack` passes and the pack's declared surface digest matches.

- **Executable checks boot the simulator** (Increment 7's contract-faithful,
  in-process surface) and exercise it: live tools vs the signature, representative
  reads, confirmation refusal, idempotent replay, injected faults, and error
  normalization (every returned error is in the AIR `ErrorCode` taxonomy). A check
  with no applicable operation passes with a note, so certification generalizes.

- **The mutation battery must be killed.** Each standard mutant deliberately
  weakens a control — remove confirmation, enable unsafe retry, drop an OAuth
  scope, weaken a mutation to a read, corrupt an output schema. A mutant is
  *killed* when the surface signature detects the change; a **safety** mutant must
  be detected specifically as `safety-sensitive`. A `certified` status requires
  every applicable mutant killed.

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
