# Hardening audit — baseline and ranked findings

Written at the start of a hardening programme, from a clean baseline on
`main` (`8c530ca`, the PR #28 merge). Everything here is measured, not
estimated; the commands are reproducible.

## Baseline

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass — one warning: ignored build scripts for `sharp` |
| `pnpm lint` | pass — 0 errors, 11 warnings, 1 info, 528 files |
| `pnpm knip` | pass — clean |
| `pnpm typecheck` | pass — 14/14 packages |
| `pnpm build` | pass — 14/14 packages, 43s |
| `pnpm test` | pass — 25 tasks, 197 files, **3,315 passed, 1 skipped, 0 failed**, 3m48s cold |

The single skip is `effectiveness.test.ts` behind `describe.skipIf(!RUN_REAL)` —
an opt-in real-driver battery, correctly gated.

Test counts per package: cli 898, compiler 740, refinement 383, runtime 314,
generators 205, mcp-runtime 192, air 177, harness 177, certification 72,
targets 61, grammar 49, simulator 34, system-pack 14.

**The environment-sensitive review test passes here.** `review.test.ts` runs
18/18 including the Unix-socket case. It is a portability risk, not a current
failure.

## Structural measurements

**Package graph: acyclic, six tiers, clean.**

```
tier 0  air, grammar
tier 1  compiler, refinement, runtime, system-pack
tier 2  mcp-runtime, simulator, targets
tier 3  certification, generators
tier 4  harness
tier 5  cli
```

- **Zero** deep cross-package imports (`@anvil/x/y`).
- **Zero** relative imports reaching into another package's `src`.
- **Zero** cycles.
- Serving path (`runtime`, `mcp-runtime`) transitively reaches only `air`,
  `grammar`, `runtime` — no build-time package.

This is better than the hotspot list suggests, and it changes what the ratchets
are for: they preserve a property that already holds rather than repairing one
that does not.

**Where the layering differs from the diagram people draw**, the code is right:
`system-pack` depends only on `air` and belongs next to it, not up with the
generators; `certification` and `generators` are siblings, not stacked. The
boundary ratchet therefore encodes an explicit edge allow-list taken from the
graph as it is.

**Source volume:** ~90k lines of production TypeScript, ~72k lines of test.

## Ranked findings

Ranked by (invariant at risk) × (evidence that it is real), not by module size.

### 1. Certification has two authorities, and the accepted ADR documents the unreachable one

`@anvil/generators/certify.ts` (1,427 lines) owns `certification.json`, a
four-gate model, and `verifyCertification` — the gate `anvil publish` consults.
`@anvil/certification` (ADR-0018, Accepted) owns a different record with a graded
status ladder and an attestation binding. `certify(air, { executable: true })` —
the only path to the `certified` and `simulator_exercised` statuses — has **no
production caller anywhere in the workspace**; the sole caller is that package's
own test. `@anvil/system-pack` accepts those statuses, so a pack can declare a
level nothing can mint.

The merge rule between the two lives in `runCertify` in the CLI, and the other
three `certifyBundle` call sites do not apply it.

Not a fail-open — `publish` does enforce fresh hash-bound executable evidence
through `selftest`/`conformance`/`simulate`, with prod failing closed. This is
duplicate authority plus a stale ADR.

*Invariant:* AIR-derived judgements are single-authority and do not drift across
surfaces; the CLI is a delivery adapter, not a policy owner.
*Disposition:* documentation now (ADR corrected), product decision deferred.
*Evidence:* `packages/cli/src/certification-authority.test.ts`, 6 tests pinning
current behaviour. Full write-up: `certification-authority.md`.

### 2. Test source is excluded from typecheck in all 13 packages

Every `packages/*/tsconfig.json` carries `"exclude": ["src/**/*.test.ts"]`, so
roughly 72k lines of test code have no type coverage. This is the condition that
allowed finding 3.

Measured cost of removing the exclusion, errors per package: air 126, cli 82,
compiler 41, generators 27, runtime 22, harness 18, mcp-runtime 18, refinement
10, system-pack 2; certification, grammar, simulator, targets 0. **Total 366.**

Many are deliberate invalid inputs in negative tests, which must not be forced
through with casts. Deferred as its own change with that budget attached; a
narrow guard now covers the specific hole (see finding 3).

*Invariant:* a test cannot reference an API that does not exist.
*Disposition:* infrastructure, deferred.

### 3. A special-file test whose assertion had never once executed

`wso2-apictl.bugbash.test.ts` imported `mkfifoSync` from `node:fs`. No such
export exists in Node 22. The call threw `TypeError` into a bare `catch`
commented "FIFO creation may not be supported on all systems", so the assertion
after it never ran. The suite was green; the coverage was zero.

The invariant is load-bearing: mutating `!stat.isFile()` to `false` does not
merely mislabel the node — `readFileSync` on a FIFO blocks until a writer opens
it, so the estate import hangs indefinitely. An operator-creatable file could
stall an import.

*Invariant:* a collection containing a non-regular node is refused before it is
read. *Disposition:* test defect; root cause is finding 2.
*Evidence:* fixed, with a class-level guard in `boundaries.test.ts` asserting
every named value import from a `node:` module actually exists.

### 4. A test whose name promised an invariant its body could not check

The same file claimed to prove `semanticDigest` was "identical regardless of load
method" while comparing a directory load against *different* fixture content,
then asserting only that a directory load equals itself. Directory and ZIP loads
key members at different roots and are not comparable, so the named property was
never under test — and the real documented property (identity survives repacking)
had no coverage at all.

*Invariant:* `semanticDigest` is a content identity, not a packaging identity —
it is what gateway receipts and adoption lineage bind to.
*Disposition:* test defect, fixed.

### 5. `estate.ts` mixes four ownerships in 3,327 lines

99 `io` calls, 29 inline JSON envelope constructions, 32 filesystem calls, 34
exit-code returns. `runImport` alone is ~913 lines holding 46 of the `io` calls.
Domain rules ("`--attest-spec-override` is defined only for WSO2"; "a supplied
`--spec` requires an explicit `--gateway-url`") are expressed as *emit and return
1*, so they can only be tested through the CLI and cannot be reused by any other
surface.

The mitigating fact: its siblings `estate-audit.ts` and `estate-adoption.ts` are
*already* pure domain with rendering separated. This is an unfinished migration,
not an undesigned one.

*Invariant:* the CLI is a composition root and delivery adapter.
*Disposition:* product debt. Plan: `estate-decomposition.md`.

### 6. Environment-sensitive special-file test

`review.test.ts` binds a Unix-domain socket, which some sandboxes refuse with
EPERM. It passes in this environment. The risk was that an environmental failure
would later be "fixed" by weakening the assertion.

*Disposition:* infrastructure, fixed — falls back to a FIFO, then skips with the
reason printed rather than returning silently.

### 7. Lint warnings, all in test or low-risk paths

11 warnings. Two in production code: `naming.ts` built an intersection `Set` per
group member via spread and used `reduce` with no initial value (safe only
because the caller guarantees `group.length >= 2`); `skills/executor.ts`
collapsed to an optional chain. The other nine were stale imports in bug-bash
tests — leftovers from suites that were cut down, including a `live.bugbash.test.ts`
that still imported the entire bundle-writing toolkit and used none of it.

*Disposition:* cleared.

### 8. `sharp` build script ignored on install

`onlyBuiltDependencies` listed only `esbuild`. `sharp` is used solely by
`apps/docs`. Cleared by listing it.

## What was looked for and not found

Recorded so the next audit does not repeat the search: no cycles; no deep
cross-package imports; no relative cross-package imports; no build-time leak into
the serving path; no phantom `@anvil/*` dependency; knip clean; no non-deterministic
iteration found in the compiler's collision-resolution path (groups are sorted by
stable identity and keyed order-independently).

## Verification after the first wave

Re-run from a clean `pnpm install --frozen-lockfile`, all commands from the
repository root.

| Command | Before | After |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | pass, 1 warning (`sharp`) | pass, **no warnings** |
| `pnpm lint` | pass, 11 warnings + 1 info | pass, **0 warnings** |
| `pnpm knip` | clean | clean |
| `pnpm typecheck` | pass 14/14 | pass 14/14 |
| `pnpm build` | pass 14/14 | pass 14/14 |
| `pnpm test` | 197 files, 3,315 passed, 1 skipped | **200 files, 3,341 passed, 1 skipped, 0 failed** |
| `node tools/corpus/run.mjs estates` | — | **6/6 estates green** (import-completes, determinism, opaque-accounting, operations-accounting) |

**+26 tests, +3 files.** 13 architectural ratchets, 5 manifest checks, 6
certification characterisations, and a net +2 in the WSO2 suite (one vacuous test
removed, three real ones added).

**No dependency changes.** The package graph is byte-identical to the baseline;
the ratchet records it rather than altering it.

**Deleted:** the swallowed `catch` around the FIFO assertion, the self-comparing
digest test, a dead `CLI_PACKAGE_DIR`, and nine stale imports across four
bug-bash suites. No production module was deleted — this wave moved no ownership.

**Behaviour changes:** none intended. The only production edits are
`naming.ts` (intersection computed without a per-member `Set`; provably
equivalent, and the full 740-test compiler suite plus the estate corpus
differential agree) and a one-line optional chain in `skills/executor.ts`.

**Remaining hotspots**, unchanged and now ratcheted: `estate.ts` 3,327 ·
`capability-composition.ts` 2,163 · `deploy.ts` 1,630 · `self-skill.ts` 1,575 ·
`status.ts` 1,554 · `certify.ts` 1,427 · `tool-cli.ts` 1,425 · `executor.ts`
1,322. Full list with per-module plans in `module-size-baseline.json`.

**Known limitations.**

- The module-size ratchet counts lines. It cannot tell a long cohesive module
  from a long confused one; that judgement is the `plan` field, which is prose a
  human has to keep honest.
- The phantom-builtin check covers `node:` modules only, and only named value
  imports. It is a stopgap for the real fix (typechecking test source), not a
  substitute.
- The certification characterisation tests assert current behaviour, including
  behaviour the audit argues is wrong. They will need replacing — deliberately —
  when the split is resolved.
- Two certification tests scan source text (for `executable: true` and for which
  call sites import `@anvil/certification`). Source scanning is brittle; it is
  used because the property is "no code anywhere does X", which cannot be
  observed from behaviour alone.
- The FIFO-based tests skip on Windows and in sandboxes without `mkfifo(1)`. The
  skip names its reason, so a silent gap is not possible, but coverage there is
  genuinely absent rather than merely unreported.

## Deferred, with reasons

| Item | Why not now |
| --- | --- |
| Typechecking test source | 366 errors; many are deliberate invalid inputs that must not be cast away. Own change, budget recorded above. |
| Certification consolidation | Requires a product decision about what *certified* promises. Options and a recommendation are written; the decision is not mine to take. |
| `estate.ts` decomposition | Planned in detail; deliberately not started in the same change as the baseline and the ratchets. |
| `capability-composition.ts`, `deploy.ts`, `self-skill.ts`, `status.ts`, `tool-cli.ts` | Queued behind estate. One subsystem at a time. |
| `runtime/executor.ts` decomposition | **Recommended against.** `execute()` is a strictly ordered safety gauntlet with the ordering documented inline. Splitting it into stages trades a readable sequence for a reorderable pipeline. The right control is an ordering test; the size baseline records this explicitly. |
