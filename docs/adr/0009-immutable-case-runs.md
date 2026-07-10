# ADR-0009 — Immutable case runs

**Status:** Accepted

## Context
`caseId(skill, targetKey)` is deterministic — the same deficiency always names the
same case. The first materialisation therefore wrote every case into a single
fixed directory, `.refinement/cases/<case-key>/`, reusing it across invocations.

Reusing one directory is a stale-output hazard. A second investigation of the
same target opens onto the *previous* run's `output/` — its `evidence.json`,
`proposal.json`, `result.json` are all still sitting there. If the new run
declines early, or crashes before overwriting a file, the harness can read a
prior run's proposal and treat it as the current outcome. There is also no record
of *which* inputs a given output was produced against: the AIR could have changed,
the skill version bumped, the policy tightened, and nothing on disk would say so.

## Decision
The **case key** is `<skill>--<target-key>` (path-safe). Each invocation creates a
**new immutable run directory**:

```
.refinement/cases/<case-key>/<run-id>/
```

Every run carries its own metadata: `runId`, the AIR hash it was opened against,
the source revision, the skill version, the policy hash, the executor identity,
and a timestamp. That record binds an output to the exact inputs that produced it,
so a proposal is only ever interpreted against the world it was made in.

- **Opening never consumes a prior run's `output/`.** A fresh run starts with an
  empty `output/`; there is no path by which stale results leak into a new
  investigation.
- **Resume is explicit.** Continuing an existing run requires naming it — a run
  path, or `--resume` / `--replace`. The default is always a new run; reuse is a
  deliberate, named act.

## Consequences
- Runs are an append-only history per case key: every investigation of a target is
  retained and attributable, which the effectiveness battery (ADR-0011) and audit
  both depend on.
- The identity/stale-run guarantees are directly testable — "a second open does
  not see the first run's proposal" is a conformance check (ADR-0011).
- Disk grows per invocation; runs are cheap directories and expected to be pruned
  out-of-band, not reused in-band.
- The metadata hashes make a run **reproducible-checkable**: if the AIR hash or
  policy hash no longer matches, the run's output is known-stale rather than
  silently trusted.

## Alternatives considered
- **A single deterministic case directory reused across runs (the prior design).**
  Rejected: opening lands on the last run's `output/`, so a decline or crash can
  surface a stale proposal — the stale-output hazard this ADR removes.
- **Overwrite in place but back up the previous `output/`.** Rejected: a backup is
  not addressable or metadata-stamped; immutable per-run dirs give history and
  input-binding in one move. See `docs/INVESTIGATION_ARCHITECTURE.md`.
