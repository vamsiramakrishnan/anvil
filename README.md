# Anvil

**Turn one API contract into agent tools that share one policy.**

Give Anvil an API contract and reviewed policy. It generates:

- a typed CLI;
- an MCP server;
- client SDKs for TypeScript, Python, Go, and Java;
- an agent skill;
- harness hooks;
- mocks and evaluations; and
- deployment inputs.

All of them come from AIR, the Anvil Intermediate Representation.

AIR records the operation schema, effect, risk, auth, approval, confirmation, idempotency, retry, and evidence contract. That matters because hand-written surfaces drift. A refund can end up requiring confirmation in the CLI but not in MCP. Anvil makes that disagreement a compiler and runtime problem instead of a prompt problem.

Three rules define the model:

1. Unapproved operations are not callable.
2. Mutations are not retried unless idempotency is proven.
3. Assurance evidence is valid only for the bundle hash it verified.

## Run the example

Anvil currently runs from source. You need Node.js 22.17 or later, Corepack, and Git.

```bash
git clone https://github.com/vamsiramakrishnan/anvil.git
cd anvil
corepack enable
pnpm install
pnpm build
```

Compile the included payments API:

```bash
pnpm anvil compile examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml \
  --service payments \
  --out generated/payments

pnpm anvil status generated/payments
pnpm anvil inspect generated/payments
```

`compile` creates the bundle. `status` tells you what state it is in and what to do next. `inspect` shows which operations are callable and why.

The bundle contains:

| Path | Contains |
| --- | --- |
| `air.yaml` | Canonical operation and policy model |
| `cli/` | Typed commands for approved operations |
| `mcp/` | MCP server exposing the same approved operations |
| `sdk/` | TypeScript, Python, Go, and Java clients |
| `skill/` | Agent setup and operation reference |
| `plugin/` | Hooks for supported coding harnesses |
| `mock/`, `tests/`, `skill/evals/` | Mock, conformance, and agent-evaluation assets |
| `deploy/` | Runtime and infrastructure inputs |

The generated CLI, MCP server, and runtime run from this checkout or another environment where the Anvil packages are installed or linked. The four SDK trees can be vendored independently and use only their platform standard libraries.

## See a refusal before a network call

The payments fixture contains a refund operation. It moves money. The manifest therefore requires confirmation and an idempotency key.

Omit both:

```bash
pnpm anvil run generated/payments refunds create \
  --payment-id pay_123 \
  --amount 4200 \
  --currency usd \
  --reason duplicate_charge \
  --dry-run
```

Anvil returns `confirmation_required` before request construction or network access.

Now supply both requirements:

```bash
pnpm anvil run generated/payments refunds create \
  --payment-id pay_123 \
  --amount 4200 \
  --currency usd \
  --reason duplicate_charge \
  --idempotency-key refund-pay_123-001 \
  --confirm \
  --dry-run
```

Anvil prints a redacted request plan. `--dry-run` still prevents execution.

[Run the complete quickstart](apps/docs/src/content/docs/start/quickstart.md) to test the generated MCP surface and assurance records.

## Use your API

For an unfamiliar contract:

```bash
pnpm anvil agentify path/to/spec \
  --service inventory \
  --out generated/inventory
```

`agentify` captures the source, compiles it, assesses operations, proposes capability groups, and stops for review. It does not infer approval, certify, publish, or deploy. Existing approvals in a reviewed manifest are preserved.

Then inspect the candidate:

```bash
pnpm anvil status generated/inventory
pnpm anvil inspect generated/inventory
pnpm anvil assess generated/inventory
pnpm anvil lint generated/inventory
```

If the contract omits a business fact, put that fact in reviewed `anvil.yaml` and compile again. Do not edit generated files.

## Start from the evidence you actually have

| Starting material | First command | Result |
| --- | --- | --- |
| OpenAPI, Swagger, GraphQL, proto3, WSDL, Discovery, OData, or Postman | `anvil agentify` or `anvil compile` | Candidate AIR bundle and generated surfaces |
| API gateway export | `anvil estate support`, then `anvil estate inventory` | Gateway-aware inventory for later audit and import |
| Application-server, .NET, or broker configuration | `anvil legacy inventory` | Offline evidence and technical candidates |
| Existing MCP server | `anvil adopt` | Conservative review artifacts and an adoption plan |

These inputs do not grant the same execution authority.

- A supported API contract can become executable after review and assurance.
- A gateway export keeps gateway identity and provenance during import.
- Legacy inventory produces evidence and candidates. It does not create or run a Java, Windows, or broker bridge in the current release.
- An adopted MCP tool without an explicit read-only signal remains a mutation until reviewed.

Read [source format support](docs/SOURCE_FORMATS.md), [gateway estates](docs/gateways.md), [legacy estates](docs/legacy-estates.md), or [MCP adoption](docs/adopting-mcp-servers.md) before choosing a path.

## Operating loop

```text
source -> compile -> inspect -> enrich -> approve -> assure -> release plan
```

| Stage | Rule | Primary command |
| --- | --- | --- |
| Compile | Capture exact source bytes before deriving semantics | `anvil compile` |
| Inspect | Keep unknown mutations unavailable | `anvil status`, `anvil inspect`, `anvil lint` |
| Enrich | Add evidence-backed facts | `anvil distill`, `anvil enrich` |
| Approve | Change exposure through an explicit decision | `anvil approve` |
| Assure | Bind every report to the same bundle hash | `anvil certify`, `anvil selftest`, `anvil conformance`, `anvil simulate` |
| Release | Prepare a plan; leave deployment with the operator | `anvil publish` |

Run `status` whenever you return to a bundle or a gate fails. It reports the first action still required.

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

## Development

```bash
pnpm build
pnpm test
pnpm lint
pnpm typecheck
pnpm docs:check
pnpm --filter @anvil/docs build
```

Repository map:

- `packages/air`: canonical schemas and semantics;
- `packages/compiler`: source capture, adapters, classification, and manifests;
- `packages/generators`: CLI, MCP, SDK, skill, hook, test, and deployment projections;
- `packages/runtime`: validation, policy, auth, retries, idempotency, and execution;
- `packages/mcp-runtime`: generated MCP serving path;
- `packages/certification` and `packages/simulator`: assurance gates; and
- `packages/cli`: command orchestration over the libraries above.

## Documentation

- [Documentation site](https://vamsiramakrishnan.github.io/anvil/)
- [Install Anvil](apps/docs/src/content/docs/cookbooks/install-anvil.md)
- [Quickstart](apps/docs/src/content/docs/start/quickstart.md)
- [Manifest](docs/MANIFEST.md)
- [Client SDKs](docs/client-sdks.md)
- [CI](docs/CI.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Product boundary](docs/PRODUCT_BOUNDARY.md)
- [Command reference](skills/anvil/reference/commands.md)

The documentation site also publishes [`llms.txt`](https://vamsiramakrishnan.github.io/anvil/llms.txt) and [`llms-full.txt`](https://vamsiramakrishnan.github.io/anvil/llms-full.txt).

## License

Apache-2.0.
