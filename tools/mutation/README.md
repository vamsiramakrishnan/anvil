# Mutation gate

Deletes one safety control at a time and requires the declared tests to notice.

```
pnpm mutation                 # all mutants
pnpm mutation --filter wso2   # ids containing a substring
pnpm mutation --list          # print the roster, run nothing
```

Exit 0 only when every mutant died. Runs in CI after `pnpm test`.

## Why this and not coverage

Coverage says a line executed. It cannot say the line mattered. This
repository's recurring defect is narrower and worse than an uncovered branch —
it is a **check that reports success without having run**:

- an assertion sitting after a call that threw into a bare `catch`, so it never
  executed while the suite stayed green;
- a test body wrapped in `if (result.ok && result.binding)`, which skipped
  rather than failed when the guard was false;
- `expect(x).toBe(true, "message")`, where `toBe` takes one argument and the
  message was silently discarded;
- a hand-run mutation whose search string the shell expanded to nothing, so the
  file was never edited and the mutant "survived" without ever being applied.

Every one of those reports 100% coverage of the lines involved. A surviving
mutant is the only signal that catches them, because it asks a different
question: *if I break this, does anything object?*

## The roster

`mutants.json`. Each entry names one control:

| field | meaning |
| --- | --- |
| `id` | stable name, `area/control` |
| `file` | the production file to edit |
| `control` | prose: the invariant this deletion removes, and why it matters |
| `find` | exact source text — **must appear exactly once** |
| `replace` | what to put in its place |
| `tests` | the test files that must go red |

`control` is the point of the entry. A mutant that only says "line 412 changed"
tells a future reader nothing about whether the survival is a gap or a
non-issue.

Adding an entry is cheap and the right instinct. Pick controls that fail closed:
a refusal, a guard, a rollback, an integrity check.

## What the runner refuses to call a pass

Three things can make a mutation run report success without having tested
anything. Each has a check rather than a hope.

**The patch never applied.** `find` must match exactly once. Zero matches — the
source moved on — and two matches — an ambiguous site — are both hard errors.
This is the failure that produced a fake survivor by hand, so it is the first
thing verified.

**The tests were already red.** Every distinct test set runs once unmutated
first and must pass. Against a red baseline every mutant dies for free and the
gate is decorative.

**The tests never ran.** A vitest invocation that collects zero tests is
failure, not a pass. Otherwise a renamed or deleted test file reads as a kill.

That last count comes from vitest's **json reporter**, not from its printed
summary. The first version scraped the summary and broke the first time it met a
runner that colorises: `Tests  21 passed` arrives as
`Tests ␛[22m ␛[1m␛[32m21 passed`, there is no `\s+\d+` to match, and the gate
called five green baselines "collected no tests". It failed closed, so the cost
was a red build rather than a fake pass. But a gate whose entire purpose is to
distrust self-reported success has no business reading a human display —
`numTotalTests` is a contract, the summary line is a rendering. Nothing in the
verdict now depends on stdout; stdout is kept only to print on failure.

## Hangs count as kills

One control's removal does not fail — it hangs. Without the `isFile()` check,
`readFileSync` on a FIFO blocks until a writer opens it, and no writer ever
comes. Vitest's own `testTimeout` cannot save that: it is a timer on the event
loop, and a blocking sync call never yields to it.

So the runner imposes its own timeout (`--timeout <seconds>`, default 180) and
treats a timeout under mutation as a kill — a control whose removal wedges the
process is noticed about as loudly as a control can be. It kills the whole
process group, because a fork-pool worker blocked in a syscall does not notice
its IPC channel closing.

That mutant is also why the liveness property is worth stating in `control` and
not just the failure: the difference between "import rejects this file" and
"import never returns" is the difference between an error message and an
operator's stuck pipeline.

## Working-tree safety

Mutants are applied to real files. The runner refuses to start if any target
file has uncommitted changes, restores the original bytes in a `finally`, and
restores again on SIGINT/SIGTERM. An interrupted run cannot eat your edits.
