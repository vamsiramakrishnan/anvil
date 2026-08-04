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

## The operator contract (wave 4)

The findings above are about Anvil's internals. This one is about what a customer
touches, and it is the same defect one level up.

**Anvil compiles the agent's contract and hand-writes the operator's contract.**
AIR → CLI/MCP/skill is real and tested; the agent stopped guessing. But the
operator-facing surface Anvil itself owns — exit codes, JSON envelopes,
`reportType` values, which verb is the release gate — was authored by hand, per
command. Nothing was a projection of anything.

Three consequences, all verified through the built CLI rather than by reading:

| Symptom | What an operator sees |
| --- | --- |
| `--json` emitted nothing on three refusal paths | `anvil estate import ... --json` exits 1 with **zero bytes on stdout**. A script piping to `jq` gets a parse error, indistinguishable from Anvil crashing. |
| One `reportType`, two envelope shapes | A consumer reading `output.created` got `false` from one refusal and `undefined` from another. No single parser worked. |
| `estate inventory --json` success carried no `reportType` | The document could not be dispatched on. Only the `--summary` branch was typed. |

**Why it went unnoticed:** every test in the package calls Anvil's *functions*.
None consumed Anvil's *interface*. Twenty test files call `JSON.parse` on success
paths; not one pinned a refusal.

`operator-json-contract.test.ts` closes that: it runs commands through
`runAnvilCli` and asserts stdout always parses, always names its shape, and that
one `reportType` yields one set of envelope keys. Each fix was verified by
reverting it and watching the harness go red.

**The release gate.** `anvil status` computes a deterministic `nextAction` and
always exited 0 — so a pipeline could gate on the verdict only by reimplementing
the ladder, or by gating on `anvil certify`, which answers a narrower question and
*also* exits 0 with no executable evidence present. `--require <action>` turns the
existing verdict into an exit code, defaults unchanged, and fails closed on an
unrecognized action. It does not resolve the naming hazard that the command called
*certify* is not the release gate; that remains a product decision.

**The self-skill drift.** `.agent/skills/anvil/` — the copy a Codex or Antigravity
harness reads — was missing five of nine files and three commands, including
`anvil status`, which is step 2 of the loop its own SKILL.md documents. That
harness could not know the gateway-estate flow existed at all. The drift guard was
exhaustive over *files* and blind to a second *destination*; it now covers both
roots, verified by dirtying the new one.

## The error-code contract (wave 5)

Anvil emits **305 machine-readable error codes**. An operator writing
`if (r.code === "gateway_receipt/output_lineage_stale")` depends on that exact
string; rename or drop it and their branch stops matching silently on an upgrade,
with the `else` path — usually "proceed" — taking over. That is worse than a
crash, because nothing reports it.

**76 of the 305 had no assertion anywhere in the workspace.** A refactor could
have changed any of them without a single test going red. The estate-only scan
earlier in this document found 11; widening to every package found the real
number.

`error-code-registry.json` records all 305 with the package that owns each and
whether a test names it. `error-code-registry.test.ts` ratchets it four ways, each
verified by breaking it:

| Rule | Prevents |
| --- | --- |
| every emitted code is registered | a new public string arriving without review |
| every registered code is still emitted | a silent removal breaking whoever matched on it |
| `asserted` never regresses | a code losing its only assertion, so a rename goes unnoticed |
| improvements are banked | coverage rising in the code but not in the floor |

**The extractor counts position, not shape.** A first draft matched any
`namespace/word` literal and reported 435 codes — a third of them file paths like
`reference/workflow.md` and MIME types like `application/json`. It now counts a
string only where it is *used* as a code: a `code:` property, a `code =`
assignment, the first argument to a `*Error` constructor, or an argument to a
shared `emit*`/`refuse*`/`reject*` helper.

Two self-inflicted bugs worth recording, both of the same family this programme
keeps finding. The test first walked `packages/` wholesale, so `dist/*.d.ts` passed
its `.ts` filter — mis-attributing every code to whichever package built last, and
taking three minutes. And the file is now excluded from its own corpus: its doc
comment quotes a real unasserted code, which counted as an assertion. A
measurement that flatters itself is the recurring failure mode here, not an
occasional one.

**Deliberately out of scope**, as different contracts: certification check ids
(`static/*`, `exec/*`), AIR predicate names (`anvil/*`), MIME types.

## The mutation gate (wave 6)

Finding 2 is closed: test source is typechecked in all 13 packages. That removes
the condition, but not the defect class — a test can be well-typed, fully
covered, and still assert nothing. So the wave that follows it is the control
that makes *a check which reports success without having run* structurally hard.

`tools/mutation/run.mjs` deletes one safety control at a time and requires the
declared tests to notice. **18 mutants across four modules, all killed**, run in
CI after `pnpm test`. The roster is `mutants.json`; each entry names the
invariant its deletion removes, so a survivor is legible as either a gap or a
non-issue rather than a line number.

Coverage cannot see this defect class. Every example this programme has found —
the assertion after a swallowed `TypeError`, the test body behind
`if (res.ok && res.binding)` that skipped instead of failing,
`expect(x).toBe(true, "message")` where the message was discarded, the mutant
whose search string the shell expanded to nothing — reports full coverage of the
lines involved. A surviving mutant asks the different question: *if I break
this, does anything object?*

The runner refuses to call three things a pass, each being a way a mutation run
can flatter itself:

| Refusal | The failure it prevents |
| --- | --- |
| `find` must match exactly once | the patch silently not applying — the fake survivor found by hand |
| every test set must be green unmutated | a red baseline, against which every mutant dies for free |
| a run collecting zero tests is failure | a renamed or deleted test file reading as a kill |

**The third guard misfired on its first CI run, and the fix is the point.** It
counted tests by matching vitest's printed summary. On a runner that colorises,
`Tests  21 passed` arrives as `Tests ␛[22m ␛[1m␛[32m21 passed`; there is no
`\s+\d+` to match, and the gate called five green baselines "collected no
tests". It failed closed — a red build, not a fake pass — which is the correct
direction for a guard to fail, and worth separating from the four
self-flattering measurements elsewhere in this document: those reported success
they had not earned, this reported failure it could not substantiate.

The repair is not a better regular expression. A gate whose purpose is to
distrust self-reported success should not read a human display at all, so the
count now comes from vitest's json reporter. `numTotalTests` is a contract; the
summary line is a rendering. Verified by replacing the captured stdout with a
placeholder and confirming the verdict is unchanged.

**One control hangs rather than fails**, and the gate treats that as a kill.
Without `isFile()`, `readFileSync` on a FIFO blocks until a writer opens it;
vitest's `testTimeout` cannot interrupt it, because a blocking sync call never
yields to the event loop. The runner imposes its own timeout and kills the
process group, since a fork-pool worker blocked in a syscall does not notice its
IPC channel closing. That is worth stating precisely: the difference between
"import refuses this file" and "import never returns" is the difference between
an error message and a stuck pipeline.

**Scope, stated plainly.** 18 mutants over the estate install/import/attestation
path and the apictl reader. That is the code this programme moved, not the whole
safety surface — `runtime/executor.ts`, idempotency, and the approval gates are
covered by tests but not yet by mutants. The roster is meant to grow with each
wave rather than to claim completeness now.

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

### 2. Test source is excluded from typecheck in all 13 packages — **fixed**

*Fixed in wave 6.* All 13 packages now typecheck their tests; the exclusion is
gone and the 366 errors are resolved rather than cast away. Eleven were invalid
enum values in test fixtures — `mode: "not_idempotent"`, `proof: "jwt"`,
`status: "skip"` and others — meaning those tests were asserting against inputs
the schema would reject. Five `mcp-runtime` files built `AirDocument`s Zod would
refuse outright. The original finding follows.

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

## Verification after the second wave (estate decomposition, steps 0–1)

| Command | Wave 1 | Wave 2 |
| --- | --- | --- |
| `pnpm lint` | 0 warnings | 0 warnings |
| `pnpm knip` | clean | clean |
| `pnpm typecheck` | 14/14 | 14/14 |
| `pnpm build` | 14/14 | 14/14 |
| `pnpm test` | 3,341 passed | **3,433 passed, 1 skipped, 0 failed** |
| `node tools/corpus/run.mjs estates` | 6/6 green | 6/6 green |

`estate.ts` **3,327 → 2,498** (−829), across three modules:

| Module | Lines | Shape |
| --- | --- | --- |
| `estate-bundle-install.ts` | 592 | transactional install; no `CliIO`, discriminated result |
| `estate-contract-attestation.ts` | 314 | pure attestation; diagnostics and decisions out |
| `estate-import-policy.ts` | 168 | pure rules; rejection-or-`undefined` |

**+63 tests** (23 install, 21 policy, 19 attestation). **Twenty-two mutants** were used to confirm the new suites bite before they were
trusted. Each of these turns a suite red: removing the unmanaged-output refusal,
the identity-collision check, the rollback, the backup-cleanup warning, the
stale-output replace gate, the stale-state integrity check, the untrusted-path
guard, the lifecycle-collision check, the install-failure code, the non-WSO2
attestation refusal, the HTTPS constraint, the credential constraint, the
`unscoped` reservation, the strict-identity requirement, the unnecessary-override
refusal, the absent-entrypoint refusal, the missing-coordinate supersession, the
duplicate-route flag, the unattestable-coordinate flag, path-parameter
normalization, inferring authority among several definitions, and an off-by-one
on the reason-length bound.

One mutant initially appeared to survive. It had not been applied — the search
string contained `$1`, which the shell expanded to nothing. Re-run with correct
quoting, it was killed. Worth recording: a mutation harness can lie in exactly
the direction that flatters it.

**Deliberately preserved**, each recorded as a finding rather than tidied: two
import refusals carry no machine-readable code; two error codes emit a JSON
envelope shape that differs from the rest under the same `reportType`; and
`runVerify` re-implements bundle-vs-receipt verification inline with a different
code set. All three are contract changes, not mechanical moves.

**Error-code coverage.** 12 of the 17 originally-uncovered `estate.ts` codes are
now asserted. A correction to an earlier claim in this document: the first pass
covered 6, not 13 — 13 codes *lived in* the extracted subsystem, but only 6 had
tests at that point.

Widening the scan from `estate.ts` to the whole estate directory shows **73
codes, 62 asserted, 11 not**. The eleven, with why:

| Codes | Why not yet |
| --- | --- |
| `bundle_receipt_missing`, `output_lineage_stale`, `output_unreadable` | Inside `runVerify`; reachable when that verb is extracted (step 6). |
| `lifecycle_incompatible` | Needs a target kit that validates under one AIR and not another. Not constructible from a hand-written fixture; needs real target generation. |
| `audit_inventory_mismatch`, `baseline_vendor_mismatch`, `duplicate_inventory_coordinate`, `duplicate_selection`, `vendor_mismatch`, `gateway/missing_contract` | In `estate-audit.ts` and `estate-adoption.ts`, which the original `estate.ts`-only scan never looked at. Their own gap, not this one's. |

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
| ~~Typechecking test source~~ | **Done in wave 6.** All 13 packages, 366 errors resolved without casts; 11 were invalid enum values in fixtures. |
| Certification consolidation | Requires a product decision about what *certified* promises. Options and a recommendation are written; the decision is not mine to take. |
| `estate.ts` decomposition | Planned in detail; deliberately not started in the same change as the baseline and the ratchets. |
| `capability-composition.ts`, `deploy.ts`, `self-skill.ts`, `status.ts`, `tool-cli.ts` | Queued behind estate. One subsystem at a time. |
| `runtime/executor.ts` decomposition | **Recommended against.** `execute()` is a strictly ordered safety gauntlet with the ordering documented inline. Splitting it into stages trades a readable sequence for a reorderable pipeline. The right control is an ordering test; the size baseline records this explicitly. |
