---
title: Quickstart
description: Compile Anvil's bundled payments API, inspect the safety contract, package the skill, record static and executable assurance, and prepare a deployment plan.
sidebar:
  order: 2
---

This path starts with the example already in the repository, so every command
is copy-pasteable. In about five minutes you will have a real CLI + MCP + skill
bundle, a readable safety review, a certification record, and a Cloud Run
deployment plan. No cloud credentials are needed and no service is deployed.

## 1. Build Anvil

From the repository root:

```bash
pnpm install
pnpm build
pnpm anvil --help
```

`pnpm anvil` runs the locally built CLI. You can use it in every command below
without a global install or shell alias.

## 2. Compile the bundled API

```bash
export ANVIL_BUNDLE=generated/quickstart-payments

pnpm anvil compile examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml \
  --service payments \
  --out "$ANVIL_BUNDLE"
```

The OpenAPI file supplies the routes and schemas. The adjacent Anvil manifest
supplies what OpenAPI cannot prove on its own: confirmation, idempotency,
retry, workflow, and approval policy.

The result is one bundle projected from AIR, Anvil's shared model:

| Path | What to look for |
| --- | --- |
| `air.yaml` | The canonical operation contract |
| `cli/` | Typed commands for approved operations |
| `mcp/` | The same approved operations as MCP tools |
| `skill/` | The operating manual and examples an agent reads |
| `runtime/` | Fail-closed execution policy |
| `deploy/` | Credential contracts and deployment inputs |

## 3. Orient, inspect, and lint

Start with status. It checks whether the projections agree and tells you the
next safe action:

```bash
pnpm anvil status "$ANVIL_BUNDLE"
```

Then read the actual operation contract:

```bash
pnpm anvil inspect "$ANVIL_BUNDLE"
pnpm anvil lint "$ANVIL_BUNDLE"
pnpm anvil distill "$ANVIL_BUNDLE"
```

`inspect` prints effect, risk, reversibility, confirmation, idempotency, retry,
auth scopes, and a complete dry-run command for every operation. It uses the
installed command spelling, `anvil run`; in this source-checkout quickstart,
run that line as `pnpm anvil run`. `lint` names weak or unsafe evidence.
`distill` shows the smallest useful operation basis and the residue that still
needs human judgment.

The example manifest already approves its four operations. On your own API,
an unproven mutation remains `review_required`. Inspect it first, enrich its
manifest entry if the contract is incomplete, recompile, and only then run:

```bash
pnpm anvil approve "$ANVIL_BUNDLE" <operation-id>
```

Approval reprojects the CLI, MCP server, runtime, and skill together. Never use
approval to silence an idempotency warning you cannot prove.

## 4. Package, assure, and exercise

```bash
pnpm anvil package skill "$ANVIL_BUNDLE" --out dist/skills
pnpm anvil certify "$ANVIL_BUNDLE"
pnpm anvil selftest "$ANVIL_BUNDLE"
pnpm anvil conformance "$ANVIL_BUNDLE"
pnpm anvil simulate "$ANVIL_BUNDLE"
pnpm anvil status "$ANVIL_BUNDLE"
```

Packaging validates the skill before copying it. `certify` is static assurance:
it checks the contract, safety, semantic, and generated-runtime bytes without
starting them. `selftest`, `conformance`, and `simulate` then provide executable
evidence over the same bundle digest. Writing those reports does not change that
digest or stale fresh static assurance. A later generated-content change does.
The final `status` prints freshness and pass state for each lane and routes you
to the first report that must be run again.

## 5. Generate a deployment plan

```bash
pnpm anvil deploy ledger "$ANVIL_BUNDLE" \
  --project example-project-123 \
  --database example-shared-ledger \
  --database-mode shared
pnpm anvil publish "$ANVIL_BUNDLE" --env dev
pnpm anvil status "$ANVIL_BUNDLE"
```

`deploy ledger` is an offline inspection: it verifies the generated managed
store contract, lists every approved write, and resolves the Firestore
database, collection group, and `ANVIL_LEDGER` URI. It labels live readiness
`UNVERIFIED`; only the deployed `/readyz` data-plane probe can prove the
database and runtime IAM after apply. See
[Prove durable idempotency](/anvil/cookbooks/prove-durable-idempotency/) for the
Terraform input and guarantee boundaries.

Shared mode expects an existing platform-owned database in the capability's
reviewed trust domain. Choose dedicated mode only when you need a separate
database IAM boundary; it additionally requires `--location`.

Generated Terraform and Cloud Build default `ANVIL_ENV` from
`air.service.environment`; when AIR has no environment, the default is `prod`.
Review that value in the plan because it also selects the outbound credential
profile. Unknown runtime values retain production safety behavior and emit a
diagnostic; fix the source value instead of relying on that fallback.

Despite its compatibility name, `publish` prepares a gated deployment plan; it
does not publish or deploy anything. Cloud Run is the only target, so it is the
default. The command requires the fresh static certification and all three
fresh passing executable reports for the current bundle digest, then records
that evidence in the plan. A non-production experiment can explicitly use
`--allow-incomplete-evidence`; production cannot waive executable proof. Anvil
makes no cloud API call and leaves `status` at
`operator-action-required`—never complete or live. Review and apply the plan in
your delivery system, then record live evidence separately.

Connecting the MCP endpoint to Gemini Enterprise is also an explicit second
journey. Choose either [Custom MCP or Agent
Gateway](/anvil/cookbooks/connect-gemini-enterprise/) after the bundle and its
target configuration pass static assurance and executable checks.

## Bring your own specification

Once the example makes sense, change only the source coordinates:

```bash
pnpm anvil compile path/to/openapi.yaml \
  --manifest path/to/anvil.yaml \
  --out generated/my-service
```

The manifest is optional for a read-only, fully described API. It becomes the
normal place to add evidence the source format cannot express. When `lint`
finds uncertainty, target only that residue:

```bash
pnpm anvil distill generated/my-service \
  --as-enrich-plan \
  --write /tmp/anvil-enrich-plan.json
```

See [Operating Anvil](/anvil/guides/operating-anvil/) for the full loop and
[Import a gateway estate](/anvil/cookbooks/import-a-gateway-estate/) when the
source of truth is Apigee, Kong, WSO2, MuleSoft, or IBM API Connect.
