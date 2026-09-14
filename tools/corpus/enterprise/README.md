# Enterprise application corpus

This lane runs complete selected REST contracts through the built Anvil CLI.
The [research and findings](../../../docs/backtesting/enterprise-corpus.md)
describe the enterprise application selection and its limits.

## Replay

Run these commands sequentially from the repository root. Workspace tasks can
rebuild dependencies, so finish build, typecheck and tests before starting the
corpus; concurrent rebuilds can remove a distributable while a conversion uses it.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm corpus:enterprise --list
pnpm corpus:enterprise
node tools/corpus/enterprise/smoke.mjs
```

The full lane currently reports known conversion and policy findings and exits
nonzero. A nonzero result does not prevent the report from being written. Run
the smoke command separately even when conversion reports findings.

```bash
pnpm corpus:enterprise --systems gmail,canva,sap_s4hana
pnpm corpus:enterprise --industry retail
pnpm corpus:enterprise --offline
```

`--industry` accepts catalog tags: `fsi`, `retail`, `manufacturing`, `education`.
`--systems` accepts comma-separated catalog IDs. `--timeout-ms` bounds each
compile and lint process (default 120000). `--out` and `--cache` override the
report and download directories. Each run replaces its report, so use separate
`--out` directories when keeping different selections.

## Download identity and exports

`catalog.json` records scope, publisher, immutable source revision, Git blob
identity and byte size. `sources.lock.json` records the exact SHA-256 of each
acquired file. Downloads use HTTPS, have time and size limits, and reject HTML,
empty files and invalid UTF-8. Verified cached files can replay without network
access. No whitespace normalization, operation trimming or synthetic schema
substitution is performed.

`--refresh` records a reviewed acquisition or source update. For a pinned public
source, even refresh refuses bytes that do not match its catalog Git blob.
Changing a vendor version therefore requires updating the catalog revision and
blob deliberately, downloading it, then reviewing the resulting lock diff.

When network access is unavailable, place exact public downloads in an external
directory as `<id>.<extension>`, for example `gmail.json` or `graph_users.yaml`:

```bash
pnpm corpus:enterprise --offline --source-dir /path/to/contracts
```

Entries marked `export-required` are coverage gaps. Their catalog instructions
identify the actual tenant or release contract needed. Supply the corresponding
file through the same directory and record its identity on the first run:

```bash
pnpm corpus:enterprise --systems netsuite_rest --offline --refresh --source-dir /path/to/exports
```

Do not commit vendor definitions, tenant exports, generated bundles or raw logs.
The default `.cache/` and `report/` directories are ignored. Private exports may
contain tenant schema names and examples; keep their reports and lock changes
within the intended project scope. Export acquisition does not collect tokens.

## What the lane proves

Each acquired source is independently inventoried, compiled twice without an
approval manifest, and linted. Checks cover:

- Source operation accounting: original HTTP method/path or Discovery method
  IDs must all survive, with no additions or duplicates. OData checks entity-set
  presence only; metadata does not provide an equivalent REST operation count.
- Unique operation IDs, MCP tool names and CLI commands.
- No approval of writes with unproven idempotency.
- Lossless AIR YAML round-trip and byte-identical repeated AIR JSON output.
- Canonical AIR agreement across CLI and MCP bundles.
- Generated skill and TypeScript, Python, Go and Java SDK artifacts; SDK method
  count equals the approved operation count.

Artifact presence does not prove an SDK method works. The raw import has zero
approved operations, so its generated executable surface is intentionally empty.
Warnings, blocked operations and review requirements remain visible in metrics.
The corpus does not replace runtime, authorization or business-semantic review.

## Reviewed runtime samples

`smoke.json` lists exact inspected read operations and the reasoning for each.
`smoke.mjs` requires a passing full-contract conversion, verifies each selector
still identifies exactly one eligible read, copies the raw bundle, and approves
only that operation in the copy. It runs the actual `anvil selftest` and
`anvil conformance` commands against local mocks. A passing fidelity check and a
passing CLI/MCP wire-agreement check for that exact operation are required;
an empty run cannot pass.

The smoke lane also generates a Gemini Enterprise custom-MCP OAuth registration
kit using `.invalid` fixture endpoints. This checks artifact generation only.
It does not register, deploy, contact an identity provider or invoke a vendor API.
Skipped self-test scenarios remain recorded, including write scenarios that a
read-only sample cannot exercise.

```bash
node tools/corpus/enterprise/smoke.mjs --systems gmail,canva
node tools/corpus/enterprise/smoke.mjs --report /path/to/full-report
```

## Results and CI

`report/report.json` and `report/summary.md` contain per-source identity,
operation inventory, posture, diagnostics and check outcomes. The report also
records the base Git tree, whether the worktree was dirty and a SHA-256 over
implementation source files. Run it after building that source. Compiler errors
that consist entirely of `query_language_passthrough` are `policy-blocked`;
they require reviewed query constraints rather than bypassing the gate.

Exit 0 means every acquired source passed; export requirements are reported but
do not enter the passing denominator. Exit 1 means a conversion, acquisition or
check failed, including policy blocks. Exit 2 means no source was acquired.

The nightly/manual `enterprise` matrix lane in `corpus.yml` keeps failures red
and uploads both conversion and smoke reports even on failure. Acquisition and
accounting tests run in ordinary PR CI without downloading vendor contracts:

```bash
pnpm exec vitest run tools/corpus/enterprise/enterprise.test.ts
```
## Autonomous semantic repair

After generating the corpus, run `node tools/corpus/enterprise/repair.mjs`.
Use `--systems google_docs,workday_common,slack` for a subset. This preserves each
original bundle and records repair decisions under `report/repair/`. It does not
call vendor APIs or approve operations. See
[controller behavior and limits](../../../docs/backtesting/repair-controller.md).
