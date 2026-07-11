# Corpus-differential harness

Automates the backtesting loop that found compiler bugs #1–#22 by hand:
compile **real vendor specs** every night, hold the result to a set of
invariant and differential oracles, and fail loudly when the compiler drifts.
The job of this directory is to find bug #23 before a user does.

Two modes, one runner (plain Node ESM, no build step):

```bash
node tools/corpus/run.mjs quick                      # 18 known systems, all oracles, gates CI
node tools/corpus/run.mjs sweep --limit 150 --seed 42  # random slice of apis.guru, invariants only
```

Both need a built repo (`pnpm install && pnpm build`) and network access —
which is exactly why this harness is **not** wired into `pnpm test`.

## Quick mode

Runs every system in `docs/backtesting/reproduce/systems.tsv` through the
existing recipe (`reproduce.sh` with `PREPARE_ONLY=1` for fetch + trim, so
network time never pollutes the compile measurement), then compiles and applies
**all** oracles, comparing against `baseline.json`. Any red system fails the
run.

Useful flags: `--systems slack,jira` (subset), `--work <dir>` (keep the work
tree), `--update-baseline` (see below).

## Sweep mode

Fetches the [apis.guru](https://apis.guru) directory (`/v2/list.json`), takes a
**deterministic seeded sample** (stable-sorted API names shuffled with a
mulberry32 PRNG — same `--seed` + `--limit` + universe ⇒ same sample) and
compiles each spec **raw**: no trim, no manifest. This is hostile-input
testing; many specs are legitimately broken, and that is data, not a harness
failure. Only invariant oracles apply. The run exits non-zero **only on
`crash`**.

### Outcome taxonomy

| class | meaning | fatal? |
|---|---|---|
| `ok` | compiled; every invariant oracle passed | no |
| `source-invalid` | the spec itself is unusable — fetch failed, or `anvil source add` refused it with a structured diagnostic. Not our failure. | no |
| `compile-error` | `anvil compile` failed **with structured diagnostics** (`ERROR <code>` rows). The compiler saw the problem and said so — working as designed. | no |
| `timeout` | compile exceeded the 90 s hard cap | no |
| `size-blowup` | compiled, but `air.json` > max(5 MB, 10× input spec bytes) — pathological schema materialization | no |
| `invariant-violation` | compiled cleanly but an invariant oracle (round-trip, determinism, lint) failed — a **prime bug candidate**, read the report | no |
| `crash` | non-diagnostic death: uncaught exception / stack trace / killed by signal. The compiler must never do this, on any input. | **yes** |

(`invariant-violation` is a harness extension to the base taxonomy: sweep
compiles that succeed but then break a law deserve their own bucket rather
than being lumped into `ok` or `crash`.)

## Oracles (`oracles.mjs`)

| oracle | what it checks | why |
|---|---|---|
| `compile-completes` | `anvil compile` exits 0 and writes `air.json`; wall-clock recorded (compile timed separately from fetch) | the floor: a spec that compiled yesterday must compile today |
| `time-budget` | quick: compile ≤ **2×** baseline ms; sweep: hard cap **90 s** (enforced by killing the child) | catches accidental quadratic behavior — finding #19-style bugs regress as time first |
| `size-budget` | quick: `air.json` ≤ **1.5×** baseline bytes; sweep: blow-up heuristic above | schema materialization bugs show up as multi-megabyte AIR long before anything else fails |
| `round-trip` | `airFromYaml(airToYaml(doc))` parses and its `contractHash` equals the original's | AIR is the canonical model; if YAML round-trip changes the contract, every downstream artifact silently disagrees |
| `determinism` | compiling the same **locked source** twice yields byte-identical `air.json` | reproducible builds are the basis for contract hashing and diffing. No volatile-field normalization is currently needed — verified byte-stable across all 18 systems at baseline time. If a volatile field is ever introduced, normalize it in `determinism()` and document it here. |
| `lint` | `anvil lint <bundle>` exits 0 (warnings allowed) | the generated bundle must satisfy Anvil's own consistency rules |
| `naming-differential` | quick only: fixtures in `expected/<system>.json` pin `operationId → mcp.toolName` and `effect.kind`/`effect.risk` for five systems (slack, twilio, jira, github_gql, temporal) | tool naming and effect/risk classification are the semantics agents route on; these fixtures were validated in the manual backtests and must never drift silently |
| `op-count` | quick only: operation count vs baseline. **Decrease ⇒ fail** (operations silently dropped); increase ⇒ warning (vendor added ops — drift, not a bug) | dropping operations is one of the quietest possible compiler failures |

## `baseline.json`

Per-system `compileMs`, `airBytes`, `opCount` recorded from a green quick run.
Time and size gates are tolerance-based (2× / 1.5×) so normal CI jitter and
small vendor spec drift don't flap; the op-count gate is exact on decrease.

**To update intentionally** (after a compiler change that legitimately alters
size/time/op-count, or after vendor spec drift):

```bash
pnpm build
node tools/corpus/run.mjs quick --update-baseline
git diff tools/corpus/baseline.json   # review — every delta should be explainable
```

Commit the new baseline together with the change that explains it, never on
its own.

Note on timing baselines: `compileMs` was recorded on one machine and CI runs
on another; the 2× tolerance absorbs that. If CI hardware is persistently
slower and time-budget flaps, refresh the baseline from a CI run.

## Fixtures (`expected/`)

One JSON file per pinned system:

```json
{ "operations": { "<operationId>": { "toolName": "...", "effect": "read|mutation", "risk": "none|...|destructive" } } }
```

`risk` is optional — omit it to assert the effect kind only. Add entries only
for operations whose classification has been human-validated (these came from
the manual backtests in `docs/backtesting/`).

## Known red: linear (bug #23 — found by this harness's first full run)

`linear` currently fails quick mode with two `duplicate_tool_name` **error**
diagnostics (exit 1): Linear's GraphQL schema has both `Query.initiativeUpdate`
and `Mutation.initiativeUpdate` (likewise `projectUpdate`). The compiler's
`resolveNameCollisions` (`packages/compiler/src/naming.ts`) groups colliding
operations by **CLI command**, which embeds the action (`… list` vs `… create`)
— but `mcp.toolName` does **not** embed the action, so the two operations get
distinct CLI commands yet the *same* tool name, the resolver never sees the
group, and validation then hard-errors. Consequence: any GraphQL schema with a
same-named query and mutation field cannot compile without a manifest rename.
`linear` therefore has no `baseline.json` entry and stays red until the
compiler disambiguates tool names by tool-name group (not just CLI-command
group). Do not "fix" this with a manifest — the red is the finding.

## Reports

Every run rewrites `tools/corpus/report/`:

- `report.jsonl` — one JSON record per system/spec: metrics, classification,
  per-oracle results.
- `summary.md` — human-readable table (quick) or taxonomy + non-ok specimens
  (sweep).

The directory is gitignored; CI uploads it as the `corpus-reports` artifact
(see `.github/workflows/corpus.yml` — nightly cron + manual dispatch).
