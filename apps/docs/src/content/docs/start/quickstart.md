---
title: Quickstart
description: Compile the payments example, inspect its safety contract, observe a mutation refusal, and verify the generated MCP surface locally.
sidebar:
  order: 2
---

This walkthrough gives you one complete success path before you use your own
API. It uses a local fixture and dry runs, so it does not need credentials and
does not contact an upstream service.

This path starts from an API contract. If the system has only application-server,
.NET, or broker configuration, use [Build a legacy inventory](/anvil/guides/legacy-inventory/)
instead; legacy refinement currently stops before runtime bridge generation.

You will:

1. compile one API contract into a bundle;
2. inspect what an agent may call;
3. watch an unsafe call fail before execution; and
4. test the generated MCP surface.

Allow about five minutes after the repository has been built.

## Before you begin

Complete [Install Anvil](/anvil/cookbooks/install-anvil/), then work from the
repository root. Confirm the CLI is available:

```bash
pnpm anvil --version
```

## 1. Compile the example

```bash
export ANVIL_BUNDLE=generated/quickstart-payments

pnpm anvil compile examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml \
  --service payments \
  --out "$ANVIL_BUNDLE"
```

Anvil reports the number of operations, their approval states, and any
diagnostics. The bundle contains the canonical model plus every generated
surface:

| Path | What it contains |
| --- | --- |
| `air.yaml` | The canonical contract: operations, effects, risk, auth, approval, and evidence |
| `cli/` | Typed commands for approved operations |
| `mcp/` | The MCP server an agent calls |
| `skill/` | Progressive-disclosure instructions for the agent |
| `plugin/` | Hook adapters that enforce the same preconditions earlier in the call path |
| `mock/`, `evals/` | Local verification assets |
| `deploy/` | Deployment contracts and infrastructure inputs |

The example manifest is intentionally pre-reviewed. It supplies facts that the
OpenAPI document cannot express, including the refund idempotency key and
confirmation policy, and marks the example operations approved. Your own first
compile will usually contain `review_required` operations. That is expected.

## 2. Orient with `status`

```bash
pnpm anvil status "$ANVIL_BUNDLE"
```

Use `status` whenever you are unsure what to do next. It checks the source
binding, generated projections, approval state, assurance evidence, target
configuration, and release plan. It ends with one next safe action.

Now inspect the operation contracts:

```bash
pnpm anvil inspect "$ANVIL_BUNDLE"
```

For each operation, `inspect` shows:

- the stable operation id;
- the CLI command and MCP tool name;
- read or mutation effect;
- risk and reversibility;
- idempotency and retry posture;
- confirmation requirements; and
- auth principal and scopes.

For `payments.refunds.create`, look for a financial, irreversible mutation that
requires confirmation and a caller-supplied idempotency key.

## 3. Observe a refusal

Ask Anvil to prepare a refund but omit confirmation:

```bash
pnpm anvil run "$ANVIL_BUNDLE" refunds create \
  --payment-id pay_123 \
  --amount 4200 \
  --currency usd \
  --reason duplicate_charge \
  --dry-run
```

The command exits with a structured error similar to:

```json
{
  "error": {
    "code": "confirmation_required",
    "message": "This operation creates an irreversible financial mutation.",
    "retryable": false,
    "safe_to_retry": false,
    "required_flags": ["--confirm", "--idempotency-key"]
  }
}
```

The refusal happens before request construction or network access. `--dry-run`
does not bypass policy; it only prevents execution after every precondition has
been satisfied.

Supply the required intent and deduplication key:

```bash
pnpm anvil run "$ANVIL_BUNDLE" refunds create \
  --payment-id pay_123 \
  --amount 4200 \
  --currency usd \
  --reason duplicate_charge \
  --idempotency-key refund-pay_123-001 \
  --confirm \
  --dry-run
```

This time Anvil prints the request plan: method, URL, headers, body, retry plan,
and confirmation posture. Auth material is redacted. No request is sent.

## 4. Verify the generated surfaces

Run static certification, then exercise the actual MCP transport:

```bash
pnpm anvil certify "$ANVIL_BUNDLE"
pnpm anvil selftest "$ANVIL_BUNDLE"
pnpm anvil status "$ANVIL_BUNDLE"
```

`certify` checks that generated artifacts still agree with `air.yaml`.
`selftest` boots the generated mock and MCP servers, calls the approved tools,
and verifies that gated operations refuse before side effects. Both records are
bound to the current bundle hash; changing the bundle makes them stale.

For the complete assurance sequence, continue with `conformance` and
`simulate` in [Operating Anvil](/anvil/guides/operating-anvil/).

## 5. Use your own contract

For a first pass over an unfamiliar API, use `agentify`:

```bash
pnpm anvil agentify path/to/spec \
  --service inventory \
  --out generated/inventory
```

This imports the source into an immutable snapshot, compiles it, assesses
readiness, and proposes capability groupings. It then stops for review. It does
not certify or publish the result.

Start with the commands it prints. If an operation is uncertain, inspect the
reason before changing its state:

```bash
pnpm anvil status generated/inventory
pnpm anvil inspect generated/inventory
pnpm anvil assess generated/inventory
```

Do not edit `generated/inventory`. Add missing facts to an
[Anvil manifest](/anvil/guides/manifest/), then recompile so the CLI, MCP
server, skill, and hooks change together.

## Choose the next guide

- Your source is GraphQL, gRPC, WSDL, OData, Discovery, or Postman: read
  [Source format support](/anvil/guides/source-formats/).
- Mutations remain `review_required`: use the
  [enrich and approve workflow](/anvil/guides/enrich-approve-workflow/).
- You are adding Anvil to CI: follow [Run Anvil in CI](/anvil/guides/ci/).
- A command refused or evidence became stale: use
  [Troubleshooting](/anvil/guides/troubleshooting/).
- Your APIs live behind a gateway: begin with
  [Import a gateway estate](/anvil/cookbooks/import-a-gateway-estate/).
