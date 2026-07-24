# Coverage Bug-Bash Plan — mixed Sonnet + Haiku fleet

Goal: run a fleet of agents (a **mix of Sonnet and Haiku**) over the Anvil
monorepo to (1) find and file bugs and (2) add tests that **massively raise
coverage**, without weakening Anvil's safety contract or the CI gate.

This plan is grounded in a real coverage baseline captured on
`claude/bug-bash-test-coverage-doln1g` (2026-07-24), measured with
`@vitest/coverage-v8` over `packages/*/src/**` (cookbook end-to-end tests
excluded from the instrumented run because they spawn the built CLI as a
subprocess, so their coverage is not attributed to source).

---

## 1. Where we stand (baseline)

Overall: **88.1% lines · 91.4% functions · 75.6% branches** (15 315 / 17 387 lines).

Branch coverage is the weakest metric and the highest-value target.

| Package        | Lines  | Funcs | Branch | Notes |
|----------------|--------|-------|--------|-------|
| cli            | 81.0%  | 87.2% | 68.6%  | biggest absolute gap; command handlers |
| mcp-runtime    | 81.1%  | 78.8% | 72.6%  | small (185 lines), thin serving path |
| harness        | 84.6%  | 88.1% | 70.1%  | bundle-driver / loopback / live drivers |
| air            | 87.5%  | 93.2% | 78.9%  | idempotency-carrier branch gaps |
| runtime        | 89.1%  | 92.9% | 79.5%  | executor / idempotency / credentials |
| refinement     | 90.3%  | 90.0% | 77.8%  | case battery + effectiveness |
| system-pack    | 91.4%  | 83.3% | 85.5%  | function gaps |
| targets        | 92.4%  | 97.5% | 78.0%  | validate branch gaps |
| simulator      | 92.7%  | 96.8% | 77.8%  | |
| compiler       | 93.4%  | 95.3% | 79.5%  | postman / wso2 adapter / normalize branches |
| generators     | 95.2%  | 96.2% | 79.8%  | |
| certification  | 97.0%  | 98.4% | 90.6%  | already strong |

### Highest-value target files

**Under 70% lines (fix first — quick, large wins):**

| File | Lines% | Size |
|------|--------|------|
| `cli/src/commands/refine.ts`                     | 9%  | 88 L  |
| `cli/src/commands/case.ts`                        | 30% | 158 L |
| `refinement/src/case/battery/effectiveness.ts`    | 31% | 42 L  |
| `cli/src/commands/conformance.ts`                 | 52% | 60 L  |
| `cli/src/commands/sources.ts`                     | 12% | (small) |

**Biggest absolute line gaps:** `cli/src/commands/estate.ts` (195 uncovered),
`case.ts` (111), `capability-composition.ts` (88), `refine.ts` (80),
`status.ts` (51), `harness/src/bundle-driver.ts` (47),
`cli/src/commands/idempotency-store.ts` (45), `approve.ts` (42),
`runtime/src/idempotency.ts` (37).

**Biggest branch gaps:** `estate.ts` (300 uncovered branches),
`capability-composition.ts` (152), `status.ts` (152),
`compiler/src/protocols/postman.ts` (112), `tool-cli.ts` (94),
`compiler/src/gateway/wso2/adapter.ts` (70), `runtime/src/executor.ts` (61),
`estate-adoption.ts` (57), `runtime/src/credentials.ts` (54),
`air/src/idempotency-carrier.ts` (50).

---

## 2. Ground rules (every agent must obey)

**Toolchain**
- Test runner: **vitest**. Whole suite: `pnpm test` (turbo, per-package).
  Single package: `pnpm --filter @anvil/<pkg> test` or
  `npx vitest run --root . packages/<pkg>/src`.
- Single file while iterating: `npx vitest run --root . packages/<pkg>/src/<file>.test.ts`.
- Config: `vitest.config.ts` aliases `@anvil/*` → each package's `src/index.ts`,
  so **no build is needed** for unit tests. `globals: false` → **import
  `describe/it/expect` from `vitest` explicitly** in every test file.

**Gate — a packet is not done until all three are green locally:**
1. `pnpm lint` (Biome). Always run `pnpm lint:fix` before committing — the
   original CI failure this branch fixed was *only* formatting/import-sort.
2. `pnpm typecheck`.
3. `pnpm test` for the touched package (and `pnpm test` whole-suite before the
   coordinator merges).

**Test idioms to match** (copy from existing neighbours, e.g.
`packages/cli/src/cmd-distill.test.ts`, `packages/runtime/src/retry.test.ts`):
- Co-locate tests as `<name>.test.ts` beside the source.
- CLI commands are driven through `runAnvilCli(argv, { io: bufferIO() })` and
  asserted on exit code + `io.text()`; fixtures live under `examples/` (e.g.
  `examples/payments/openapi.yaml` + `anvil.yaml`).
- Use `mkdtempSync(join(tmpdir(), "anvil-<x>-"))` for scratch dirs and clean up
  in `afterEach` (push roots to an array, `rmSync(..., {recursive,force})`).
- Prefer pure-function unit tests where the module allows; reserve
  temp-dir/subprocess tests for genuinely I/O-bound commands.
- `fast-check` is available (compiler, air) for property tests — use it for
  serializers, naming, digests, normalizers.

**Safety contract (from `CLAUDE.md` — do NOT violate in tests):**
- Only **approved** operations are exposed; non-idempotent mutations are never
  auto-retried and need `--confirm`. Tests must **assert** these invariants,
  never bypass or weaken them to make a test pass.
- Never log/echo secrets; the runtime redacts auth material. Add tests that
  *prove* redaction rather than asserting the redacted value leaks.

**Bug protocol (the "bug bash" half):**
- When a test surfaces genuinely wrong behavior, **do not write a test that
  locks in the bug.** Instead: mark it `it.fails(...)` or `it.skip` with a
  `// BUG:` comment, and record it in the shared bug log
  (`docs/coverage-bug-bash-findings.md`, appended by each agent).
- Trivial, unambiguous, in-scope fixes (off-by-one, wrong error string, missing
  guard) may be fixed in the same packet with a clear commit message.
- Anything ambiguous or architecturally significant → log it, don't fix it;
  the coordinator escalates.

---

## 3. Work decomposition — packets by model tier

One packet ≈ one source file (or a tight cluster) → one test file, isolated so
agents don't collide. Assign by *ambiguity*, not size.

### Haiku packets — mechanical, pure, well-scoped
High volume, low ambiguity: pure functions, serializers, type guards, small
validators. Deterministic input→output, no orchestration to reason about.

- `air/`: `serialize.ts`, `naming.ts`, `enums.ts`, `mcp.ts`, `jsonschema.ts`,
  and **branch-fill** `idempotency-carrier.ts` (50 uncovered branches — table-
  driven cases over carrier shapes).
- `compiler/`: `hash.ts`, `digest.ts`, `xml.ts`, `detect.ts`, `signature.ts`,
  `parse-safe.ts`, `capability-matrix.ts`.
- `simulator/`: `rng.ts`, `model.ts`, `define.ts`.
- `system-pack/`: `digest.ts`, `diff.ts`, `graph.ts`, `inspect.ts` (close the
  function gaps that drag it to 83% funcs).
- `refinement/`: `delta.ts`, `metrics.ts`, `identity-binding.ts`, `schema.ts`.
- `runtime/`: `retry.ts`, `observability.ts`, `policy.ts`, `errors.ts`.

### Sonnet packets — stateful, branch-heavy, bug-prone
Requires understanding invariants and adversarial edge cases.

- **cli command handlers (the biggest prize):**
  `commands/refine.ts` (9%→), `commands/case.ts` (30%→),
  `commands/conformance.ts` (52%→), `commands/sources.ts` (12%→),
  `commands/estate.ts` (300 branch gaps), `capability-composition.ts`,
  `commands/status.ts`, `commands/approve.ts` (approval invariants!),
  `commands/idempotency-store.ts`, `tool-cli.ts`, `commands/capability-compose.ts`,
  `commands/target.ts`, `commands/estate-adoption.ts`.
- **runtime safety hot path:** `executor.ts` (61 branch gaps), `idempotency.ts`
  (37 lines), `credentials.ts` (54 branch gaps), `auth.ts`, `config.ts` — these
  guard retry/idempotency/redaction; adversarial tests here find real bugs.
- **compiler adapters/protocols:** `protocols/postman.ts` (112 branch gaps),
  `gateway/wso2/adapter.ts` (70), `gateway/receipt.ts`, `normalize.ts` (52),
  `classify.ts`, `resolution.ts`, `wsdl.ts`, `graphql.ts`, `grpc.ts`,
  `odata.ts` — feed malformed/edge specs and assert structured errors.
- **harness:** `bundle-driver.ts` (47 lines / 51 branches), `loopback.ts`,
  `live.ts`, `conformance.ts`, `agent.ts`, `reconcile.ts`.
- **refinement engine:** `case/battery/effectiveness.ts` (31%),
  `case/battery/run.ts`, `detect.ts`, `proposal.ts`, `materialize.ts`,
  `evidence.ts`, `validate.ts`.
- **targets:** `validate.ts` (branch gaps), `generate.ts`, `agent-registry.ts`,
  `connector-plan.ts`, `registration.ts`.

---

## 4. Orchestration

**Isolation.** Each agent works in its own git worktree
(`isolation: "worktree"`) so parallel test-file writes never collide. Packets
are file-scoped, so merges are near-conflict-free.

**Per-agent loop (identical for both tiers):**
1. Read the target source file + its nearest existing `*.test.ts` neighbour.
2. Enumerate uncovered lines/branches (agent may run
   `npx vitest run --coverage ... packages/<pkg>/src/<file>.ts` locally).
3. Write/extend the co-located test file matching repo idioms.
4. Run: single-file vitest → `pnpm lint:fix` → `pnpm typecheck` for the package.
5. If a real bug surfaced: `it.fails`/skip + `// BUG:` + append to findings doc.
6. Commit one packet per commit: `test(<pkg>): cover <file>`.

**Coordinator (this session or a Sonnet lead):**
- Owns the branch, merges worktrees, resolves the rare conflict.
- Runs full `pnpm lint && pnpm typecheck && pnpm test` before each push.
- Runs the estates gate (`node tools/corpus/run.mjs estates`) — it's a per-PR
  CI gate, so keep it green.
- Re-measures coverage after each wave and re-assigns to the next-worst files.

**Suggested batching (respects the medium workflow-size guideline):** waves of
~8–12 agents. Wave 1 = the five sub-70% files + air/runtime pure units (fast,
morale-building wins). Wave 2 = cli command handlers + runtime hot path. Wave 3
= compiler adapters + harness + refinement. Wave 4 = verification/dedup + gate.

---

## 5. Definition of done / targets

- **Line coverage ≥ 92%**, **branch coverage ≥ 85%** overall (from 88.1 / 75.6),
  no package below 85% lines.
- Every sub-70% file brought above 85%.
- CI green: lint + typecheck + test + estates differential.
- `docs/coverage-bug-bash-findings.md` lists every real bug found, each either
  fixed (linked commit) or triaged with a repro.
- Add a coverage gate to CI **last** (after the sweep), so it ratchets and
  doesn't block the bash itself:
  - add `@vitest/coverage-v8` devDep + `"coverage": "vitest run --coverage"` script,
  - set `coverage.thresholds` in `vitest.config.ts` at the achieved floor.

---

## 6. Reproduce the baseline

```bash
pnpm add -D -w @vitest/coverage-v8@4.1.10
npx vitest run --coverage --coverage.provider=v8 \
  --coverage.reporter=text-summary --coverage.reporter=json-summary \
  --coverage.include='packages/*/src/**' --coverage.exclude='**/*.test.ts' \
  --coverage.reportsDirectory=./coverage-baseline \
  --exclude='**/cookbook*.test.ts'
```

The `coverage-baseline/coverage-summary.json` is the machine-readable source of
truth; re-run after each wave to re-rank targets.
