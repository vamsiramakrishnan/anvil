# Stateful fuzzing

`anvil fuzz` runs generated call sequences against isolated loopback fixtures,
checks explicit properties, shrinks failures, and saves exact calls for replay.
The reusable kernel is `packages/fuzz`; Anvil's adapters live in
`packages/harness/src/fuzz`. Neither changes an operation's approval state.

## Run a campaign

Build the workspace with `pnpm install` and `pnpm build`. Python SDK execution
requires `python3`, Go requires Go 1.21+, and Java requires a JDK 11+ with both
`javac` and `java` on `PATH`. The harness includes the TypeScript compiler.
All four generated SDKs use their language's standard runtime libraries.

```sh
node packages/cli/dist/bin-anvil.js fuzz --example payments \
  --surfaces mcp,cli,cli-mcp,typescript,python,go,java \
  --seed 39 --runs 5 --timeout-ms 120000 --budget-ms 300000
```

The owned payment contract has two approved operations and an explicit
confirmation and idempotency policy. Each driver gets its own fresh HTTP ledger.
The generator varies refund amount, irrelevant reads, missing confirmation,
key conflicts, and a connection loss immediately after the ledger commits.
The oracle checks committed refund count and total independently of generated
client responses. A lost response can remain ambiguous; a later identical
request must recover its result without a second commit.

For an existing generated bundle:

```sh
node packages/cli/dist/bin-anvil.js fuzz out/payments \
  --surfaces mcp,cli,python --seed 42 --runs 5 --out .anvil/fuzz
```

This uses the bundle's generated mock. It varies approved operation examples
and confirmation/key presence, checks request path, query, and body against AIR, and
compares surface outcomes. It is contract consistency evidence. Business
invariants require an independently authored fixture and oracle, as in the
payment example. This first contract generator does not exhaustively fuzz
arbitrary JSON Schema constraints or malformed transport frames.

| Surface | Execution |
|---|---|
| `mcp` | Generated MCP server over an actual stdio MCP connection |
| `cli` | Generated CLI entry point in a child process |
| `cli-mcp` | Generated CLI with `--mcp stdio` |
| `typescript` | Compile copied sources with TypeScript, invoke the public client method in Node |
| `python` | Generated Python client's public method in a child process |
| `go` | Compile copied sources with `go build`, populate the public input struct and call the public method |
| `java` | Compile copied sources with `javac`, construct the public input class and call the public method |

The default surfaces remain `mcp,cli,python`; select additional SDKs explicitly.
A missing compiler or runtime is unsupported coverage, and a compilation error
is inconclusive coverage. Neither is a passing test. The first compiled SDK run
can be slow, particularly when Go builds its standard library; the command above
allows a longer startup deadline. No package installers or dependency downloads
run during a campaign.

Successful build artifacts are cached by exact source and toolchain identity in
a bounded process-local cache. Every case, shrink, and replay gets fresh fixture
state and a fresh copy of the client. Each step invokes a new SDK process; these
drivers cover API call sequences, not state retained within a client instance.
Prebuilt artifacts supplied in the bundle are not used in place of compilation.
Typed clients cannot express every malformed JSON input. For example, omitting
a required Go or Java constructor field reports unsupported coverage instead of
silently replacing it with a zero value. Transport-frame fuzzing remains separate.

The exact bundle bytes are copied before execution, including any hand-edited
client defect. Regenerating clients inside the driver would hide that defect.
Fixtures must bind loopback; the default adapters supply synthetic credentials
and do not inherit application credentials. Delegated identity and TLS require
additional fixture support and report unsupported coverage. These local checks
do not attest a deployed endpoint. Only execute trusted generated bundles and
harness commands: process isolation here is not an OS security sandbox.

## Read the result

Each invocation writes a unique `run-*` directory under `--out`. Keep this root
outside the input bundle. Reports use file mode `0600`; the output directory
uses `0700`. Input values, response values, and fixture state can appear in
evidence, so review reports before sharing them. Raw process error messages and
ambient credentials are not included by the supplied drivers.

| Artifact | Contents |
|---|---|
| `report.json` | Verdict, bundle/toolchain/adapter/fixture/oracle identity, coverage, and diagnostic trace |
| `replay.json` | Exact failing calls, seed, driver set, source identity, and failing check fingerprint |
| `bundle/` | Generated owned contract, only when using `--example payments` |

Exit `0` means the evaluated checks passed, `1` means a semantic assertion
failed, and `2` means unsupported or inconclusive coverage. Configuration refusals
also exit `1` and emit an `anvil.fuzz-error` envelope under `--json`. Missing assertions,
unavailable tools, protocol errors, or a time budget exhausted before completion
cannot pass. Coverage counts include evaluations performed while shrinking.
Failure traces retain the first failing check's identity while shrinking.
Minimality is relative to the supplied generator's shrink tree and time budget.

The CLI defaults to five generated cases. Increase `--runs` and `--budget-ms`
together for longer campaigns. `--runs` bounds generated cases, `--budget-ms` bounds campaign work, and
`--timeout-ms` bounds driver startup and calls. Cleanup has its own bounded
grace period, so wall time can exceed the campaign budget. Drivers must honor
abort signals. The seed reproduces generation for the same generator version;
it does not make external systems or model decisions deterministic. Keep the
installed toolchain fixed for a campaign; rebuilding it mid-run invalidates
the report's execution identity.

## Replay a failure or test its repair

Use the bundle and replay paths printed by the command:

```sh
anvil fuzz .anvil/fuzz/run-EXAMPLE/bundle --fixture payments \
  --surfaces python --replay .anvil/fuzz/run-FAILURE/replay.json
```

Replay executes the recorded calls without resampling. The driver set and
recorded identities must match. To test edited bundle bytes, add
`--against-current`; the report records changed bundle and toolchain hashes and
retains the original replay identity. The toolchain hash covers installed Anvil
execution binaries (including generators), Node/platform identity, selected SDK
compiler/runtime versions, and protocol/schema/generator dependency versions.
Declared fixture and oracle version changes still refuse.

The regression suite plants a defect in each generated SDK's public client that
replaces the caller's idempotency key on each call. An isolated refund succeeds.
The campaign finds the duplicated commit, shrinks the case to read → refund →
repeat with amount `1`, reproduces it, then passes after restoring the client.

## Execute a skill through an agent harness

The separate skill lane supplies the generated skill, its references, an
explicitly authorized task, and an operation catalog to a configured harness.
The host executes requested operations through one selected surface and judges
the resulting fixture state. The built-in task requires exactly one refund of
17 units. Merely reading the payment or printing a success message cannot pass.

```json
{
  "command": "node",
  "args": ["./my-agent-bridge.mjs"],
  "cwd": ".",
  "env": { "PROVIDER_TOKEN": "MY_PROVIDER_TOKEN" },
  "metadata": { "harness": "my-harness-version", "model": "my-model-version" },
  "maxCalls": 20
}
```

Paths are relative to the config directory. Environment values name existing
environment variables; credentials do not belong in the JSON file or metadata.
The configured command must implement the protocol below. A raw model CLI is
not automatically a compatible bridge.

```sh
anvil fuzz --example payments --surfaces cli-mcp \
  --agent-config ./agent.json --budget-ms 120000
```

The host writes one JSON line to stdin:

```json
{"protocol":"anvil-fuzz-agent/v1","task":"...","skill":"...","references":{},"catalog":[{"operation":"...","description":"...","inputSchema":{}}]}
```

The bridge emits a tool invocation on stdout and waits for its response:

```json
{"id":"call-1","method":"invoke","operation":"fuzz-payments.payments.get","input":{"payment_id":"p1"}}
```

The host responds with `{"id":"call-1","outcome":{...}}`. When finished, the
bridge emits `{"method":"complete"}`, consumes EOF, and exits successfully.
Stdout is protocol-only. Calls are sequential, IDs must be unique, unknown
operations refuse, and combined stdout/stderr is limited to 1 MiB. The bridge
can use its own model SDK internally; the host trusts only observed tool calls
and fixture state. Model-provider adapters are supplied by the caller.

Skill reports include skill/task digests and caller-declared model/harness
metadata. Captured failing trajectories can be replayed through the same driver
and task oracle without another model call. This verifies the captured calls;
it does not reproduce model reasoning. Automatic shrinking applies to seeded
campaigns, not model trajectories. The repository tests use explicitly labeled
scripted bridges to verify the protocol and real generated tool execution;
they do not establish live-model effectiveness.

## Bring evidence into an existing investigation

Use `--case <case-dir> --predicate <predicate> --value <json>` to attach the
report through the existing `caseService.addEvidence` path. The case must have
the same AIR identity and be allowed to read the report's location. Its source
and predicate policies still apply: contract reports are `generated_mock`,
while the independent payment example is `test_fixture`.

Anvil freezes the actual report bytes. The operator supplies the semantic
claim; the fuzzer does not infer a live API's idempotency policy from a synthetic
ledger. Attachment does not approve an operation, apply a proposal, or satisfy
the existing certification and deployment gates.

For custom domains, import `runCampaign` from `@anvil/fuzz`, provide your own
sequence arbitrary and properties, and supply a `FuzzFixtureFactory` to
`bundleFuzzDrivers`. The independent kernel also accepts non-Anvil drivers.
See [the package contract](../packages/fuzz/README.md) for extension points.
