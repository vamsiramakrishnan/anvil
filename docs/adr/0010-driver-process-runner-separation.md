# ADR-0010 — Driver / process-runner separation

**Status:** Accepted

## Context
The live agent driver (`ClaudeCodeAgentDriver`, `case/driver.ts`) shells out to a
headless coding agent to run an investigation inside a case. The first
implementation used `spawnSync`: it blocks the event loop for the whole
investigation (up to a 20-minute cap), streams nothing while it runs, cannot be
cancelled, exposes no structured execution log, and does not compose — you cannot
run two investigations concurrently or observe one in flight. It also entangled
two unrelated concerns: *how you run a subprocess* and *how you configure this
particular agent*.

## Decision
Split the two concerns.

- A reusable **`AgentProcessRunner`** owns the generic asynchronous process
  lifecycle: streamed stdout/stderr, a wall-clock timeout, cooperative
  cancellation, exit status, and a **structured execution log** with timestamps
  (and optional token/cost accounting). It knows nothing about Claude Code.
- The **Claude Code driver only configures** that runner: the command, its args
  (print mode, model, permission mode), the permission policy, and the environment
  allowlist. Swapping in Codex or another headless agent is a different
  configuration of the same runner, not a new lifecycle implementation.

This keeps the driver a narrow, swappable seam (as `AgentDriver` already is) while
moving the observability and control that every driver needs into one tested
place.

### Isolation, honestly
The case directory is an **isolated workspace, not a sandbox.** The driver runs
the agent with its working directory set to the case dir and instructs it to write
only under that dir, but nothing at the OS level *enforces* that on the local
runner. The containment measures that are real today are:

- a **git-cleanliness check** — the run asserts the repo is clean, so any stray
  write the agent makes outside the case dir is detected as a dirty tree;
- a **minimal environment** — the runner passes an explicit env allowlist rather
  than the ambient environment, so secrets and unrelated config are not inherited.

A true OS/container sandbox (filesystem and network confinement enforced by the
kernel) is an **optional future mode**, not a claim we make now. Calling the
current setup a "sandbox" would overstate the guarantee.

## Consequences
- Investigations are observable while they run and cancellable; concurrency
  becomes possible instead of one blocking call at a time.
- Every driver inherits the same execution log, timeout, and cost accounting —
  the effectiveness battery (ADR-0011) reads that log rather than re-implementing
  process capture.
- The honest "isolated workspace, not a sandbox" framing sets expectations: local
  containment is git-cleanliness + minimal env; kernel-enforced isolation is
  staged. See `docs/INVESTIGATION_ARCHITECTURE.md`.
- Migration cost: `driver.ts` still calls `spawnSync`; extracting
  `AgentProcessRunner` and rebasing the Claude Code driver onto it is the change
  this ADR records.

## Alternatives considered
- **`spawnSync` inside the driver (the prior design).** Rejected: blocking,
  unobservable, uncancellable, and not concurrency-friendly; it also conflates
  process lifecycle with agent configuration.
- **A full container sandbox now.** Rejected as premature: it is the right
  eventual boundary, but the build-time-only driver runs on trusted developer/CI
  hosts today, and the git-cleanliness + minimal-env measures cover the immediate
  risk without the operational weight.
