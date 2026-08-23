# Anvil

**Compile one API contract into agent tools that share one safety model.**

Anvil is an agent toolchain compiler. It compiles an API contract into AIR,
then generates:

- a typed CLI;
- an MCP server;
- client SDKs for TypeScript, Python, Go, and Java;
- an agent skill;
- harness hooks;
- mocks and evaluations; and
- deployment inputs.

AIR is the Anvil Intermediate Representation. It stores the operation schema,
effect, risk, auth, approval, confirmation, idempotency, retry, and evidence
contract. Assurance commands record which bundle hash they verified.

The rule is direct:

1. Hand-written surfaces can disagree.
2. Agent safety depends on those surfaces agreeing.
3. Therefore, Anvil records semantics once and generates each callable surface
   from the same model.

If an operation is not approved, it is not callable. If a mutation is not
proven safe to retry, Anvil does not retry it. If the bundle changes, its prior
assurance evidence becomes stale.

## Run the example

Anvil currently runs from source. You need Node.js 22.17 or later, Corepack,
and Git.

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

`compile` creates `generated/payments`. `status` reports the bundle state and
the next safe action. `inspect` shows which operations are callable and why.

The bundle contains:

| Path | Contains |
| --- | --- |
| `air.yaml` | Canonical operation and safety model |
| `cli/` | Typed commands for approved operations |
| `mcp/` | MCP server exposing the same approved operations |
| `sdk/` | TypeScript, Python, Go, and Java clients |
| `skill/` | Agent instructions and operation reference |
| `plugin/` | Hooks for supported coding harnesses |
| `mock/`, `tests/`, `skill/evals/` | Mock, conformance, and agent-evaluation assets |
| `deploy/` | Runtime and infrastructure inputs |

The generated CLI, MCP server, and runtime run from this checkout or another
environment where the Anvil packages are installed or linked. The four SDK
trees are independently vendorable and use only their platform standard
libraries.

## Test a refusal

The payments fixture contains a refund operation. The operation moves money,
so it requires confirmation and an idempotency key.

Omit those requirements:

```bash
pnpm anvil run generated/payments refunds create \
  --payment-id pay_123 \
  --amount 4200 \
  --currency usd \
  --reason duplicate_charge \
  --dry-run
```

Anvil returns `confirmation_required`. It does so before request construction
or network access.

Supply both requirements:

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

Anvil now prints a redacted request plan. It still sends no request because
`--dry-run` remains active.

[Complete the quickstart](apps/docs/src/content/docs/start/quickstart.md) to
exercise the generated MCP surface and assurance records.

## Use your own API

For a first pass over an unfamiliar contract:

```bash
pnpm anvil agentify path/to/spec \
  --service inventory \
  --out generated/inventory
```

`agentify` captures the source, compiles it, assesses each operation, and
proposes capability groups. It then stops for review. It does not infer
approval, certify, publish, or deploy the bundle. Explicit approvals in a
reviewed manifest are preserved.

Continue with:

```bash
pnpm anvil status generated/inventory
pnpm anvil inspect generated/inventory
pnpm anvil assess generated/inventory
pnpm anvil lint generated/inventory
```

If the source contract omits a business fact, record that fact in a reviewed
`anvil.yaml` manifest and recompile. Do not edit generated files.

## Choose the correct entrypoint

| Starting material | First command | Result |
| --- | --- | --- |
| OpenAPI, Swagger, GraphQL, proto3, WSDL, Discovery, OData, or Postman | `anvil agentify` or `anvil compile` | Candidate AIR bundle and aligned surfaces |
| API gateway export | `anvil estate support`, then `anvil estate inventory` | API inventory; audit and planning are separate commands |
| Application-server, .NET, or broker configuration | `anvil legacy inventory` | Offline evidence inventory and technical candidates |
| Existing MCP server | `anvil adopt` | Conservative review artifacts and an adoption plan; no replacement runtime |

These paths do not imply the same authority.

- An API contract with a supported wire binding can become executable after
  review and assurance.
- A gateway export carries gateway identity and provenance that must remain
  attached during import.
- Legacy inventory produces offline evidence and technical candidates. A later
  refinement workflow can produce a reviewed, non-executable binding. Anvil
  does not generate or run a Java, Windows, or broker bridge in the current
  release.
- An adopted MCP tool without an explicit read-only signal remains a mutation.

Read [source format support](docs/SOURCE_FORMATS.md),
[gateway estates](docs/gateways.md),
[legacy estates](docs/legacy-estates.md), or
[MCP adoption](docs/adopting-mcp-servers.md) before choosing a path.

## Operating loop

```text
source -> compile -> inspect -> enrich -> approve -> assure -> release plan
```

| Stage | Rule | Primary command |
| --- | --- | --- |
| Compile | Capture the exact source bytes before deriving semantics | `anvil compile` |
| Inspect | Unknown mutations remain unavailable | `anvil status`, `anvil inspect`, `anvil lint` |
| Enrich | Add only evidence-backed facts | `anvil distill`, `anvil enrich` |
| Approve | Approval changes exposure; it is not a comment | `anvil approve` |
| Assure | Every report must refer to the same bundle hash | `anvil certify`, `anvil selftest`, `anvil conformance`, `anvil simulate` |
| Release | Prepare a plan; deployment stays with the operator | `anvil publish` |

`status` is the recovery command. Run it whenever you resume a bundle or a gate
fails. It reports the first required action.

## Safety contract

| Condition | Anvil response |
| --- | --- |
| Operation is not approved | Omit it from callable CLI, MCP, and SDK surfaces |
| Mutation idempotency is unproven | Disable automatic retry |
| Confirmation is required but absent | Return `confirmation_required` before execution |
| Durable deduplication is required but unavailable | Fail the write closed |
| Runtime host is outside the reviewed allowlist | Return `policy_denied` |
| Generated surfaces disagree with AIR | Fail certification or conformance |
| Bundle bytes change after assurance | Mark prior evidence stale |

Hooks can reject a call earlier. The generated runtime repeats the authoritative
checks before contacting the upstream API.

## Supported contracts and wire protocols

Anvil compiles OpenAPI 3.x, single-file Swagger 2.0, GraphQL SDL, gRPC/proto3,
SOAP/WSDL 1.1, Google Discovery, OData v2/v4 metadata, and Postman Collection
v2.x.

Parsing a source format does not imply native transport support. The current
runtime executes HTTP+JSON, GraphQL queries and mutations, and supported SOAP
document/literal operations. Native gRPC requires a declared JSON transcoder.
Streaming RPCs, GraphQL subscriptions, and SOAP RPC/encoded bindings are
refused.

See [source format support](docs/SOURCE_FORMATS.md) and
[wire protocols](docs/wire-protocols.md) for the tested runtime boundary.

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

The documentation site also publishes
[`llms.txt`](https://vamsiramakrishnan.github.io/anvil/llms.txt) and
[`llms-full.txt`](https://vamsiramakrishnan.github.io/anvil/llms-full.txt).

## License

Apache-2.0.
