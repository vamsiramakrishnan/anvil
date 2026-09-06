# Anvil

**Give agents access to your API through a CLI, MCP server, and SDKs that enforce the same reviewed policy.**

Anvil compiles an API description and a policy manifest into an agent-facing
bundle. Review an operation once: its approval, confirmation, retry, and
authentication requirements follow it across the generated interfaces.

Use it when you own an API integration and need more than a tool schema.
The output includes executable tools, client libraries, agent instructions,
local mocks, and evidence for checking that the interfaces agree.

Source install · Node.js 22.17+ · pnpm · Apache-2.0

[Run the quickstart](apps/docs/src/content/docs/start/quickstart.md) ·
[Supported inputs](docs/SOURCE_FORMATS.md) ·
[Documentation site](https://vamsiramakrishnan.github.io/anvil/)

## Compile a tool you can inspect

The included payments example needs no credentials or upstream service for
compilation and dry runs:

```bash
git clone https://github.com/vamsiramakrishnan/anvil.git
cd anvil
corepack enable
pnpm install
pnpm build

pnpm anvil compile examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml \
  --service payments --out generated/payments

pnpm anvil status generated/payments
pnpm anvil inspect generated/payments
```

`status` reports the bundle's state and next action. `inspect` shows each
operation's generated name and policy. The fixture's refund operation requires
confirmation and an idempotency key.

Try it without those requirements:

```bash
pnpm anvil run generated/payments refunds create \
  --payment-id pay_123 --amount 4200 --currency usd \
  --reason duplicate_charge --dry-run
```

Expected result: `confirmation_required`, before request construction or
network access. Then supply the reviewed requirements:

```bash
pnpm anvil run generated/payments refunds create \
  --payment-id pay_123 --amount 4200 --currency usd \
  --reason duplicate_charge --idempotency-key refund-pay_123-001 \
  --confirm --dry-run
```

Expected result: a redacted request plan. `--dry-run` prevents execution after
policy checks pass. The [complete quickstart](apps/docs/src/content/docs/start/quickstart.md)
then tests the generated MCP server against a local mock.

## What lands in the bundle

| Artifact | Use it for |
|---|---|
| `air.yaml` | Review the canonical operation schema and policy |
| `cli/`, `mcp/` | Invoke approved operations from a terminal or an MCP client |
| `sdk/` | Call the same operations from TypeScript, Python, Go, or Java |
| `skill/`, `plugin/` | Give coding harnesses operation guidance and supported hooks |
| `mock/`, `tests/`, `skill/evals/` | Exercise generated behavior before connecting a real service |
| `deploy/` | Prepare runtime and infrastructure inputs for the operator |

AIR is the Anvil Intermediate Representation. Generated files are projections
of that model. Change the source contract or reviewed manifest, then recompile;
manual edits to generated files do not become a new source of truth.

The CLI, MCP server, and runtime require installed or linked Anvil packages.
The four generated SDK trees can be vendored independently and use their
platform standard libraries. [Client SDK details](docs/client-sdks.md).

## Choose your starting material

| You have | Begin with | Result and boundary |
|---|---|---|
| An API description | `anvil agentify` or `anvil compile` | Candidate bundle; unfamiliar operations still need review |
| A gateway export | `anvil estate support`, then `anvil estate inventory` | Inventory retaining gateway identity and provenance |
| Application-server, .NET, or broker configuration | `anvil legacy inventory` | Offline evidence and technical candidates; no runnable bridge |
| An existing MCP server | `anvil adopt` | Review artifacts and an adoption plan; unknown effects remain mutations |

For your first contract:

```bash
pnpm anvil agentify path/to/spec --service inventory --out generated/inventory
pnpm anvil status generated/inventory
pnpm anvil inspect generated/inventory
pnpm anvil assess generated/inventory
pnpm anvil lint generated/inventory
```

`agentify` captures, compiles, assesses, and proposes capability groups. It stops
for review. It preserves explicit approvals from a reviewed manifest and does
not infer new ones, certify the bundle, publish it, or deploy it.

## Take a reviewed bundle toward release

| Step | Command | Evidence |
|---|---|---|
| Resolve missing semantics | `anvil enrich`, reviewed manifest | Explicit operation behavior |
| Approve inspected operations | `anvil approve` | Deliberate exposure decision |
| Check generated artifacts | `anvil certify` | Agreement with AIR |
| Exercise the MCP server | `anvil selftest` | Local transport and refusal checks |
| Compare surfaces | `anvil conformance` | CLI, MCP, and skill consistency |
| Exercise policy scenarios | `anvil simulate` | Scenario results |
| Prepare release | `anvil publish` | Operator plan; no deployment performed |

Assurance records bind to a bundle hash. Changed bytes require new evidence.
Use `status` when a gate fails or you return to an unfinished bundle.
[CI integration](docs/CI.md).

## Runtime contract

| Condition | Anvil response |
| --- | --- |
| Operation is not approved | Omit it from callable CLI, MCP, and SDK surfaces |
| Mutation idempotency is unproven | Disable automatic retry |
| Required confirmation is absent | Return `confirmation_required` before execution |
| Durable deduplication is required but unavailable | Fail the write closed |
| Runtime host is outside the reviewed allowlist | Return `policy_denied` |
| Generated surfaces disagree with AIR | Fail certification or conformance |
| Bundle bytes change after assurance | Mark previous evidence stale |

Hooks can refuse earlier. The generated runtime repeats the authoritative checks before contacting the upstream API.

## Contract and wire support

Anvil parses OpenAPI 3.x, single-file Swagger 2.0, GraphQL SDL, gRPC/proto3, SOAP/WSDL 1.1, Google Discovery, OData v2/v4 metadata, and Postman Collection v2.x.

Parser support is not native transport support.

The current runtime executes HTTP+JSON, GraphQL queries and mutations, and supported SOAP document/literal operations. Native gRPC requires a declared JSON transcoder. Streaming RPCs, GraphQL subscriptions, and SOAP RPC/encoded bindings are refused.

See [source format support](docs/SOURCE_FORMATS.md) and [wire protocols](docs/wire-protocols.md) for the tested boundary.

## Decide whether Anvil fits

Use Anvil when several clients or agent harnesses must share reviewed operation
semantics, or when you need repeatable compilation and conformance checks.
A single hand-written integration may need less setup for a small API.

Anvil cannot infer missing business guarantees from transport syntax. In
particular, generating an idempotency key does not prove the upstream service
honors it. Record what the upstream contract establishes and keep uncertain
mutations unavailable until reviewed.

## Documentation

[Install](apps/docs/src/content/docs/cookbooks/install-anvil.md) ·
[Manifest](docs/MANIFEST.md) · [Gateway estates](docs/gateways.md) ·
[Legacy inventory](docs/legacy-estates.md) · [MCP adoption](docs/adopting-mcp-servers.md) ·
[Troubleshooting](docs/TROUBLESHOOTING.md) · [Product boundary](docs/PRODUCT_BOUNDARY.md) ·
[Architecture](docs/ARCHITECTURE.md) · [Command reference](skills/anvil/reference/commands.md)

The site publishes [llms.txt](https://vamsiramakrishnan.github.io/anvil/llms.txt)
and [llms-full.txt](https://vamsiramakrishnan.github.io/anvil/llms-full.txt).

## Development

```bash
pnpm build
pnpm test
pnpm lint
pnpm typecheck
pnpm docs:check
pnpm --filter @anvil/docs build
```

Apache-2.0. See [LICENSE](LICENSE).
