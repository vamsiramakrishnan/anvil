# The Anvil bug-bash taxonomy

Anvil already had bug-bash tests — 23 files named `*.bugbash.test.ts`, holding
real defect knowledge — but no way to say what had been swept, what a sweep is
*for*, or whether a given green tick means anything. This page supplies the
missing half: the categories a sweep covers, what counts as a finding, and the
manifest that records both.

The manifest is `manifest.json` in this directory. It is validated by
`packages/cli/src/bugbash-manifest.test.ts`, so it cannot drift from the tests it
claims to describe.

## Why a taxonomy rather than a list of edge cases

An unstructured pile of edge cases converges on whatever the last author found
interesting. Anvil's risk is not evenly spread: a wrong colour in a rendered
table costs a re-render, while a mutation that becomes retryable through
inference costs a customer a duplicated payment. The categories below are drawn
from *where an incorrect answer would violate a product invariant*, so that
sweeping a category means something specific.

The invariants being protected:

1. AIR is the canonical semantic authority.
2. Every surface — CLI, MCP, skill, docs, deploy artifacts, mocks, evals,
   certification — is a projection of that one model.
3. Approved exposure, mutation posture, confirmation, retry, idempotency,
   identity, disclosure, pagination, and long-running-operation semantics do not
   drift between surfaces.
4. Safety-sensitive behaviour fails closed.
5. Unproven mutations do not become callable, retryable, or idempotent by
   inference.
6. Build-time packages do not leak into the deployed serving path.
7. Generated code acquires no independent business logic.
8. Determinism and content-hash binding hold.

## Categories

| # | Category | What a defect here looks like |
| --- | --- | --- |
| 1 | `spec-parsing` | A supported dialect is misread, or an ambiguity is resolved silently rather than diagnosed. |
| 2 | `canonicalization` | Equivalent inputs produce different AIR; input map order, member order, or packaging changes a digest. |
| 3 | `operation-naming` | A collision resolves non-deterministically, or a disambiguator depends on input order. |
| 4 | `risk-classification` | An operation's effect, risk, or reversibility is inferred more permissively than the evidence supports. |
| 5 | `idempotency-carriers` | A carrier is modelled but unreachable, or a retry is enabled for a mutation not proven repeatable. |
| 6 | `confirmation-gates` | A confirmation-required call reaches a side effect before the gate, or the gate is satisfiable by the caller alone. |
| 7 | `identity-and-auth` | Delegated identity is forged, degraded, or promoted from an unverified mode. |
| 8 | `redaction-observability` | Credential material reaches a record, a log, a model context, or an error envelope. |
| 9 | `filesystem-boundaries` | Symlinks, special files, interrupted writes, or partial directories are followed, read, or left behind. |
| 10 | `gateway-estate-identity` | Import identity, receipts, lineage, or adoption bind to the wrong thing, or survive a change they should not. |
| 11 | `capability-composition` | Composition infers authority, approval, or executable behaviour from overlap. It is audit-only. |
| 12 | `disclosure-budgets` | A disclosure ladder leaks a rung early, or a context budget is exceeded or silently truncated. |
| 13 | `pagination-projection` | A page, projection, or truncation loses or duplicates records, or truncation is not reported. |
| 14 | `long-running-operations` | A call that returns before its work completes is not linked to its completion, or termination is unobservable. |
| 15 | `surface-conformance` | The generated CLI, MCP tool, and skill disagree about an operation's name, shape, or posture. |
| 16 | `certification-freshness` | A certification survives a change to what it certified, or a stale record passes a gate. |
| 17 | `deployment-config` | A production default is permissive, or a deployment setting has two owners that can disagree. |
| 18 | `simulator-realism` | The simulator accepts behaviour the contract forbids, or a mutation the battery should kill survives. |

## What a finding must carry

An entry in `manifest.json` under `findings` records:

| Field | Meaning |
| --- | --- |
| `id` | Stable kebab-case identifier. |
| `package` / `subsystem` | Where it lives. |
| `categories` | One or more of the categories above. |
| `invariant` | The specific thing that must be true, stated so it could be falsified. |
| `reproducer` | The minimal way to observe it. |
| `disposition` | `product`, `test`, `infrastructure`, or `documentation` — what kind of debt it is. |
| `whyMissed` | Why the existing tests did not catch it. This field is the point of the exercise. |
| `regressionTest` | Path to the test that now fails without the fix. |
| `status` | `fixed`, `open`, or `deferred`. |
| `fixture` / `seed` | When the reproducer needs them; `seed` must be printed on failure. |

`whyMissed` is mandatory because a defect that is merely fixed teaches nothing.
A defect whose *absence of coverage* is explained tells you where the next one
is. Two of the findings recorded here were tests that could never fail; they were
found by asking why a green tick was cheap, not by looking for bugs.

## Preferred test forms

Reach for the form that expresses the invariant, not the one that is quickest:

- **Metamorphic** where a transformation should not change an outcome: input map
  ordering must not affect compiled AIR; repacking must not move a semantic
  digest; adding an unrelated operation must not change an existing operation's
  posture.
- **Differential** where two paths should agree: the same estate through two
  loaders, the same AIR through two surfaces.
- **Property-based** where a class of inputs shares an invariant, with a printed
  seed so a failure is reproducible.
- **Mutation** where the question is whether a control is load-bearing. Deleting
  the control must fail a test. If nothing goes red, the control is decorative or
  the test is.
- **Fault injection** for interrupted writes, unavailable ledgers, and partial
  directories — the fail-closed paths.
- **State machine** for lifecycles: import → approve → certify → publish.

Example tests remain right for a specific known regression.

## Running a sweep

1. Pick a category, not a file.
2. Write down the invariant before looking at the code.
3. Try to falsify it — including by mutating the control and checking something
   goes red.
4. Record what you find in `manifest.json`, including the `whyMissed`.
5. A systemic finding gets a defect-class test, not only a point fix.
