# Anvil

**Compile an API specification into agent tools you can review, test, and trust.**

Anvil turns one API contract into four aligned surfaces:

- a typed CLI for developers and automation;
- an MCP server for agents;
- a progressive-disclosure skill that explains how to use the tools; and
- harness hooks that stop unsafe calls before execution.

All four are generated from one canonical model. A refund cannot require
confirmation in the CLI and quietly omit it from MCP. Only operations you have
approved are callable.

## Try it locally

Anvil currently runs from source. You need Node.js 22.17 or later, Corepack,
and Git.

```bash
git clone https://github.com/vamsiramakrishnan/anvil.git
cd anvil
corepack enable
pnpm install
pnpm build

pnpm anvil compile examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml \
  --service payments \
  --out generated/payments

pnpm anvil inspect generated/payments
```

You now have a runnable bundle in `generated/payments`:

| Path | Purpose |
| --- | --- |
| `air.yaml` | Canonical operation, safety, auth, and evidence model |
| `cli/` | Typed commands for approved operations |
| `mcp/` | MCP server exposing the same approved operations |
| `skill/` | Agent operating instructions and reference material |
| `plugin/` | Enforcement hooks for supported agent harnesses |
| `mock/` and `evals/` | Deterministic test surfaces |
| `deploy/` | Deployment contracts and generated infrastructure inputs |

Preview a financial mutation without sending a request:

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

The result is the exact request plan, with credentials redacted. Remove
`--confirm` and Anvil returns a structured `confirmation_required` refusal
before any network call.

[Follow the quickstart](apps/docs/src/content/docs/start/quickstart.md) for the
complete first-run walkthrough.

## Choose your starting point

| What you have | Use | Result |
| --- | --- | --- |
| An OpenAPI, WSDL, proto, GraphQL, OData, Discovery, or Postman contract | `anvil compile` or `anvil agentify` | An AIR bundle with aligned CLI, MCP, skill, hooks, tests, and deployment inputs |
| An API gateway export | `anvil estate inventory` | An estate audit and review-safe adoption plan |
| Application-server, .NET, or broker configuration but no useful API contract | `anvil legacy inventory` | An evidence-backed inventory of technical invocation candidates |

Legacy mode has a different lifecycle from compilation. It can inventory and
refine a candidate into a human-approved capability binding, but this release
does not generate or run the deployment-local Java, Windows, or broker bridge.

## Bring your own API

Use `agentify` for a first pass over an unfamiliar contract:

```bash
pnpm anvil agentify path/to/spec \
  --service inventory \
  --out generated/inventory
```

`agentify` locks the supplied source, compiles it, assesses every operation,
and proposes capability groupings. It then stops. It does not certify or
publish the bundle, and it does not silently approve uncertain mutations.

Continue from the command Anvil prints, or orient at any time with:

```bash
pnpm anvil status generated/inventory
pnpm anvil inspect generated/inventory
pnpm anvil assess generated/inventory
```

When the source contract cannot express an important fact—such as the
idempotency key for a POST—record that fact in a small, reviewed `anvil.yaml`
manifest and recompile. Do not edit generated files.

When a coding harness such as Codex or Claude Code investigates those gaps, use
the [refinement SDK](docs/refinement-sdk.md). The harness gathers evidence and
proposes a bounded patch; Anvil owns validation, measurement, review receipts,
and the only write path into AIR.

## The operating loop

```text
source → compile → inspect → enrich → approve → assure → release plan
```

The important boundaries are deliberate:

1. **Unknown is not safe.** Unproven mutations remain `review_required` and
   are absent from callable surfaces.
2. **Approval controls exposure.** `anvil approve` changes what the generated
   CLI and MCP server can expose; it is not a documentation annotation.
3. **The runtime rechecks the contract.** Hooks improve the developer
   experience, but runtime enforcement remains authoritative.
4. **Evidence follows the bytes.** Certification, self-test, conformance, and
   simulation records are bound to the bundle hash and become stale when the
   bundle changes.
5. **Publishing prepares a plan.** `anvil publish` does not deploy or make a
   cloud API call.

## Supported source contracts

Anvil compiles OpenAPI 3.x, Swagger 2.0, GraphQL SDL, gRPC/proto3, SOAP/WSDL
1.1, Google Discovery documents, OData v2/v4 metadata, and Postman Collection
v2.x. Local multi-file references are captured into an immutable source
snapshot before compilation.

See [source format support](docs/SOURCE_FORMATS.md) for detection rules,
multi-file behavior, and format-specific boundaries. If the source of truth is
an API gateway estate, begin with [gateway estates](docs/gateways.md) instead
of compiling one exported file at a time.

If no API contract exists, use the separate legacy workflow below. Do not
compile reconstructed middleware configuration as though it were an authored
API contract.

## Inventory a legacy system without invoking it

Start from a hardened offline export:

```bash
pnpm anvil legacy inventory ./refunds-prod-export \
  --environment prod \
  --application refund-service \
  --source-kind deployed_configuration \
  --source-id websphere-prod-cell-1 \
  --out refunds-prod.inventory.json
```

The collectors understand declarative Java EE, WebLogic, WebSphere, JBoss,
.NET Framework, WCF, MSMQ, AsyncAPI, IBM MQ, Artemis, RabbitMQ, and Kafka
evidence. They do not connect to a server or broker, open an archive, load an
assembly, execute bytecode, consume a message, or read a secret.

Inventory produces technical candidates, not business APIs. It preserves every
conflicting queue, JNDI, endpoint, direction, and transport claim. A coding
harness can investigate one exact candidate and propose the missing contract:

```bash
pnpm anvil legacy refine task \
  refunds-prod.inventory.json lc_<candidate-hash> \
  --out refunds-submit.task.json

pnpm anvil legacy refine review \
  refunds-prod.inventory.json \
  refunds-submit.task.json \
  refunds-submit.submission.json \
  --out refunds-submit.review.json

pnpm anvil legacy refine approve \
  refunds-prod.inventory.json \
  refunds-submit.review.json \
  --reviewer refund-owner@example.com \
  --reason "Verified against the deployed binding and service contract." \
  --out refunds-submit.decision.json
```

The proposal must define a business-shaped operation, clear input and output
schemas, stable errors, pagination where the real interface supports it, the
exact transport target, completion semantics, authorization, idempotency, and
retry policy. Anvil assesses that proposal; a human separately approves or
rejects it.

An approved binding remains explicit about the current boundary:

```json
{
  "runtime": {
    "placement": "deployment_local_bridge",
    "status": "not_implemented"
  }
}
```

Start with [the legacy-estate model](docs/legacy-estates.md), then follow
[inventory](docs/legacy-inventory.md) and
[candidate refinement](docs/legacy-refinement.md). Harness authors can use the
[TypeScript SDK](docs/legacy-sdk.md). The runtime work still required is
specified in [deployment-local bridges](docs/legacy-runtime-bridges.md).

## Documentation

- [Install Anvil](apps/docs/src/content/docs/cookbooks/install-anvil.md)
- [Quickstart](apps/docs/src/content/docs/start/quickstart.md)
- [Write an Anvil manifest](docs/MANIFEST.md)
- [Refine an API with a coding harness](docs/refinement-sdk.md)
- [Understand legacy application estates](docs/legacy-estates.md)
- [Build a legacy inventory](docs/legacy-inventory.md)
- [Refine and review a legacy candidate](docs/legacy-refinement.md)
- [Use the legacy TypeScript SDK](docs/legacy-sdk.md)
- [Design a deployment-local legacy bridge](docs/legacy-runtime-bridges.md)
- [See how legacy inventory performs on real GitHub projects](docs/backtesting/legacy-corpus.md)
- [Run Anvil in CI](docs/CI.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Command reference](skills/anvil/reference/commands.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Product boundary](docs/PRODUCT_BOUNDARY.md)

The rendered documentation is available at
[vamsiramakrishnan.github.io/anvil](https://vamsiramakrishnan.github.io/anvil/).
It also publishes [`llms.txt`](https://vamsiramakrishnan.github.io/anvil/llms.txt)
and a complete
[`llms-full.txt`](https://vamsiramakrishnan.github.io/anvil/llms-full.txt).

## License

Apache-2.0.
