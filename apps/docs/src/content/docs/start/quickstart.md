---
title: Quickstart
description: Compile the payments fixture, inspect one mutation, observe a policy refusal, and verify the generated MCP surface.
sidebar:
  order: 2
---

This guide produces one verified local bundle. It dry-runs the example mutation
and sends self-test traffic only to a generated local mock. It needs no
credentials and contacts no external service.

If your starting point is application-server, .NET, or broker configuration,
use [legacy inventory](/anvil/guides/legacy-inventory/) instead.

## Prerequisite

Complete [Install Anvil](/anvil/cookbooks/install-anvil/). Then confirm the CLI
from the repository root:

```bash
pnpm anvil --version
```

## 1. Compile and inspect

Run the complete first path:

```bash
export ANVIL_BUNDLE=generated/quickstart-payments

pnpm anvil compile examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml \
  --service payments \
  --out "$ANVIL_BUNDLE"

pnpm anvil status "$ANVIL_BUNDLE"
pnpm anvil inspect "$ANVIL_BUNDLE"
```

Expected state:

- `compile` creates the bundle;
- `status` reports its release state and next safe action; and
- `inspect` shows the operation id, generated names, effect, risk,
  idempotency, confirmation, auth, and approval state.

Find `payments.refunds.create`. The fixture declares it as a financial,
irreversible mutation. It requires confirmation and a caller-supplied
idempotency key.

The example manifest is intentionally reviewed. A new API will usually contain
`review_required` operations. Compilation does not approve them.

## 2. Observe the refusal

Omit confirmation and the idempotency key:

```bash
pnpm anvil run "$ANVIL_BUNDLE" refunds create \
  --payment-id pay_123 \
  --amount 4200 \
  --currency usd \
  --reason duplicate_charge \
  --dry-run
```

The error contains these stable fields. It also includes a message, operation
id, and trace id.

```json
{
  "error": {
    "code": "confirmation_required",
    "retryable": false,
    "safe_to_retry": false,
    "required_flags": ["--confirm", "--idempotency-key"]
  }
}
```

The call fails before request construction and network access. `--dry-run`
does not bypass policy. It prevents execution after policy checks pass.

## 3. Satisfy the policy

Supply explicit intent and a stable deduplication key:

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

Expected result: a redacted request plan containing the method, URL, headers,
body, retry posture, and confirmation state. No request is sent.

## 4. Verify the generated MCP path

```bash
pnpm anvil certify "$ANVIL_BUNDLE"
pnpm anvil selftest "$ANVIL_BUNDLE"
pnpm anvil status "$ANVIL_BUNDLE"
```

`certify` checks that generated artifacts agree with AIR. `selftest` starts the
generated mock and MCP servers, calls the approved tools over local transport,
and checks refusal behavior.

Both records identify the current bundle hash. Change the bundle and the
records become stale.

For the complete release gate, also run `conformance` and `simulate`. See
[Operating Anvil](/anvil/guides/operating-anvil/).

## What you created

| Path | Contains |
| --- | --- |
| `air.yaml` | Canonical operation and safety model |
| `cli/` | Typed commands for approved operations |
| `mcp/` | Generated MCP server |
| `sdk/` | TypeScript, Python, Go, and Java clients |
| `skill/` | Agent setup and operation reference |
| `plugin/` | Hooks for supported coding harnesses |
| `mock/`, `tests/`, `skill/evals/` | Mock, conformance, and agent-evaluation assets |
| `deploy/` | Runtime and infrastructure inputs |

Do not patch these files. Change the source contract or manifest and recompile.

## 5. Compile your contract

Use `agentify` for an unfamiliar input:

```bash
pnpm anvil agentify path/to/spec \
  --service inventory \
  --out generated/inventory

pnpm anvil status generated/inventory
pnpm anvil inspect generated/inventory
pnpm anvil assess generated/inventory
pnpm anvil lint generated/inventory
```

`agentify` captures, compiles, assesses, and proposes capability groups. It
then stops. It does not infer approval, certify, publish, or deploy. Explicit
approvals in a reviewed manifest are preserved.

If a required fact is missing, add it to a reviewed
[Anvil manifest](/anvil/guides/manifest/) and recompile.

## Remove the generated bundle

```bash
rm -rf "$ANVIL_BUNDLE"
unset ANVIL_BUNDLE
```

The content-addressed source snapshot remains under `.anvil/sources` for reuse
and provenance.

## Continue by task

- Non-OpenAPI input: [source format support](/anvil/guides/source-formats/)
- Unresolved mutations: [enrich and approve](/anvil/guides/enrich-approve-workflow/)
- CI integration: [run Anvil in CI](/anvil/guides/ci/)
- Gateway export: [import a gateway estate](/anvil/cookbooks/import-a-gateway-estate/)
- Failure or refusal: [troubleshooting](/anvil/guides/troubleshooting/)
