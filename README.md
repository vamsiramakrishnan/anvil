# Anvil

**Make your legacy APIs agent-ready.**

Bring the API contract you already have (REST/OpenAPI, SOAP/WSDL, gRPC, GraphQL,
OData, or a gateway export). Anvil compiles it into agent-ready SDKs and tools: a
skill, a CLI, an MCP server, and TypeScript, Python, Go, and Java clients, all
generated from one reviewed model, so every surface agrees on what each
operation does and whether it is safe to retry. A target command adds a Gemini
Enterprise connector kit.

Review the operations an agent may call before anything is exposed. When a task
spans several calls or systems, define a business action with its own inputs,
result, and execution plan.

[Quickstart](#try-it-locally) · [Business actions](#define-business-actions) ·
[Documentation](https://vamsiramakrishnan.github.io/anvil/) ·
[Supported inputs](docs/SOURCE_FORMATS.md)

Source install · Node.js 22.17+ · pnpm 10.33 · Apache-2.0

## From API to agent

An API specification describes requests and responses. An agent also needs to
know which operation fits a task, what a field means, what changes when it runs,
and whether a failed write can be retried.

Anvil makes those decisions explicit, then generates each interface from them.

| Step | Developer task | Result |
| --- | --- | --- |
| Import | Supply an API contract and supporting files | Source snapshot and candidate operations |
| Review | Establish names, types, effects, and retry guarantees | Approved operation contracts |
| Compose | Define a business task when several operations must work together | Public action and private execution plan |
| Verify | Exercise generated interfaces and inspect outcomes | Checks bound to the tested bundle |
| Use | Choose a skill, CLI, MCP server, SDK, or connector | Generated files and setup instructions |

A **bundle** contains the contracts, generated files, and review state for an
integration. An **API operation** represents an imported call. A **business
action** executes a reviewed task using one or more operations. An **interface**
is how an agent or application calls them.

## Try it locally

The payments fixture compiles and dry-runs without credentials or an upstream
service. Run from the repository root:

```bash
git clone https://github.com/vamsiramakrishnan/anvil.git
cd anvil
corepack enable
pnpm install --frozen-lockfile
pnpm build

pnpm anvil compile examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml \
  --service payments --out generated/payments

pnpm anvil status generated/payments
pnpm anvil inspect generated/payments
```

`status` reports the next action. Missing verification evidence is expected at
this stage. The example manifest contains explicit fixture approvals. A new API
still needs review. Find `payments.refunds.create`: it requires confirmation and an
idempotency key. Omitting them demonstrates the refusal:

```bash
pnpm anvil run generated/payments refunds create \
  --payment-id pay_123 --amount 4200 --currency usd \
  --reason duplicate_charge --dry-run
```

Expected: `confirmation_required`, with a nonzero exit code. Supply the
requirements to inspect the request:

```bash
pnpm anvil run generated/payments refunds create \
  --payment-id pay_123 --amount 4200 --currency usd \
  --reason duplicate_charge --idempotency-key refund-pay_123-001 \
  --confirm --dry-run
```

Expected: a redacted request plan. Both commands avoid upstream calls;
`--dry-run` still enforces policy. Check the generated artifacts and exercise
the MCP server against its local mock:

```bash
pnpm anvil certify generated/payments
pnpm anvil selftest generated/payments
pnpm anvil console . --open
```

The console opens the workspace. Select `generated/payments`, then use **API
operations** to inspect a call, **Request builder** to prepare CLI or MCP input,
and **Interfaces** to browse generated files. **Review** contains pending
decisions. [Console guide](docs/console.md).

For your own API, start with:

```bash
pnpm anvil agentify path/to/spec --service inventory --out generated/inventory
pnpm anvil status generated/inventory
pnpm anvil inspect generated/inventory
```

`agentify` captures, compiles, assesses, and proposes capability groups. It
preserves explicit manifest approvals and stops for review. Use the reported
diagnostics to refine the contract before approving operations.
[Enrich and approve](skills/anvil/reference/workflow.md).

## Define business actions

A task such as completing a return can involve an order lookup, a billing
refund, and a support case. The public action should accept business inputs and
return the outcome. Its private plan should resolve backend identifiers, bind
calls, check preconditions, and report partial completion.

| Layer | Responsibility |
| --- | --- |
| Business contract | Inputs, results, intent, source authority, effects, and recovery instructions |
| Shared runtime | Trusted caller context, policy checks, deterministic steps, and execution records |
| MCP, CLI, SDKs | Invoke the same business actions through a shared gateway |
| Skill | Explain when to call an action, what to ask, and when to escalate |

Skills guide judgment. The runtime executes the declared integration steps.
Approval of a public action does not establish that a backend is authoritative;
reviewers must verify those bindings and their effects.

Open **Business actions** in the console and import
[`examples/business/project.json`](examples/business/project.json). It contains
three synthetic calibration journeys: complete a return, amend an order, and
grant account access. Review an action, choose **Validate & preview**, save a
revision, then build its bundle. API import and business-project import accept
different inputs.

A **project** keeps the business definition, reviewed source snapshots, and
evaluation tasks together. The workbench shows what the agent sees alongside
what the runtime executes. It detects stale edits and reports which actions and
evaluations a source change affects.

The evaluation runner compares raw API tools, business tools, and business
tools with skill guidance. It requires an operator-configured agent adapter and
isolated fixtures. Scripted tests verify the runner; live-model effectiveness
requires measured trials. Optional execution journals retain attempted effects
and reconciliation evidence. Reconciliation records findings without replaying
writes.

[Author and run business actions](docs/business-capabilities.md) ·
[Projects, evaluations, and reconciliation](docs/business-workbench.md)

## Audit and refine the contract

```bash
pnpm anvil assess generated/inventory
pnpm anvil lint generated/inventory
pnpm anvil distill generated/inventory
```

Assessment and lint identify contract weaknesses. Distillation identifies
candidate capability boundaries and overlap. The refinement workflow lets
Codex, Claude Code, Antigravity, or another harness investigate findings and
submit changes with evidence. Anvil validates proposals against their declared
scope and approval policy before application.

This supports investigation of ambiguous names, pagination, idempotency,
response shape, and confusing tool groups. It does not establish missing
business guarantees or automatically repair every finding. Change the source,
manifest, or reviewed refinement, then regenerate and verify the interfaces.
[Harness refinement protocol](docs/refinement-sdk.md).

## Generated interfaces

| Files | Purpose |
| --- | --- |
| `air.yaml` | Canonical operation model, called AIR (Anvil Intermediate Representation) |
| `cli/`, `mcp/` | Commands and MCP tools for approved operations or actions |
| `sdk/` | TypeScript, Python, Go, and Java clients |
| `skill/`, `plugin/` | Agent instructions, references, and supported harness hooks |
| `mock/`, `tests/`, `skill/evals/` | Fixtures and checks for generated behavior |
| `deploy/` | Runtime and infrastructure inputs |
| `targets/gemini-enterprise/` | Connector kit, generated separately with `anvil target gemini-enterprise` |

Generated files are outputs of the reviewed model. Manual edits are replaced
when regenerated. The CLI and MCP runtime need installed or linked Anvil
packages. Generated SDK sources can be vendored independently and use platform
standard libraries. Business clients also need the shared gateway.
[SDK guide](docs/client-sdks.md) · [Gemini Enterprise setup](docs/targets.md).

## Verify before release

Use `certify` for agreement with AIR, `selftest` for local MCP behavior,
`conformance` for interface consistency, and `simulate` for policy scenarios.
`fuzz` adds stateful campaigns, failure shrinking, and replay across MCP, CLI,
CLI-over-MCP, and all four SDK languages.

Evidence records bind to a bundle hash. Changed bytes require fresh checks.
`anvil status` reports missing or stale evidence. `anvil publish` prepares an
operator plan; deployment and connector registration are separate steps.
[CI integration](docs/CI.md) · [Fuzzing](docs/fuzzing.md).

## Supported boundaries

Anvil also imports Google Discovery, OData metadata, Postman collections, and
review-only HAR captures. [Source support matrix](docs/SOURCE_FORMATS.md).

The runtime executes HTTP+JSON, GraphQL queries and mutations, and supported
SOAP document/literal operations. gRPC execution requires a declared JSON
transcoder. Streaming RPCs, GraphQL subscriptions, and SOAP RPC/encoded bindings
are refused. [Wire protocols](docs/wire-protocols.md).

Only approved operations are exposed. Unproven mutation idempotency disables
automatic retries. Required confirmation is checked before execution. Writes
that require durable deduplication fail when its store is unavailable.
Generating a request key does not prove that the upstream service honors it.

For other starting points:

| Input | Workflow |
| --- | --- |
| Gateway export | [Inventory and audit an estate](docs/gateways.md) |
| Application-server, .NET, or broker configuration | [Collect offline legacy evidence](docs/legacy-estates.md) |
| Existing MCP server | [Inspect and plan adoption](docs/adopting-mcp-servers.md) |

## Development

```bash
pnpm build
pnpm test
pnpm lint
pnpm typecheck
pnpm docs:check
pnpm --filter @anvil/docs build
```

[Architecture](docs/ARCHITECTURE.md) · [Manifest](docs/MANIFEST.md) ·
[Command reference](skills/anvil/reference/commands.md) ·
[Troubleshooting](docs/TROUBLESHOOTING.md) · [Product boundary](docs/PRODUCT_BOUNDARY.md)

The documentation site provides [llms.txt](https://vamsiramakrishnan.github.io/anvil/llms.txt)
and [llms-full.txt](https://vamsiramakrishnan.github.io/anvil/llms-full.txt).

Apache-2.0. See [LICENSE](LICENSE).
