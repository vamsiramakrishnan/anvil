---
title: Quickstart
description: Turn a spec into a working CLI, MCP server, and agent skill; watch an irreversible operation refuse to run; see what your tools cost an agent to read; and end with a deployment plan someone can review.
sidebar:
  order: 2
---

You have an API. You want an agent to use it without breaking anything. This
page takes about five minutes and uses the example already in the repository, so
every command below is copy-pasteable exactly as written.

At the end you will have tools an agent can actually call, you will have watched
an irreversible operation refuse to run, and you will know what those tools cost
an agent to read. No cloud credentials are needed and nothing is deployed.

## Get the CLI running

From the repository root:

```bash
pnpm install
pnpm build
pnpm anvil --help
```

`pnpm anvil` runs the CLI you just built. Use it for every command below — no
global install, no shell alias.

## Turn a spec into tools

```bash
export ANVIL_BUNDLE=generated/quickstart-payments

pnpm anvil compile examples/payments/openapi.yaml \
  --manifest examples/payments/anvil.yaml \
  --service payments \
  --out "$ANVIL_BUNDLE"
```

```
Compiled 4 operations from src-f2ef2cb88b963085 (openapi) → generated/quickstart-payments (75 files).
  approved: 4  review_required: 0
  diagnostics: 0 error(s), 0 warning(s)
```

The second line is the one that matters. `approved: 4` means all four operations
are callable, because the manifest next to the spec records that a human reviewed
them. On your own API, `review_required` will usually not be zero — an operation
Anvil cannot prove is safe stays there, and no generated surface exposes it. That
is the default, not a failure.

The OpenAPI file supplied routes and schemas. The manifest supplied what OpenAPI
cannot state: which mutations are irreversible, which need a confirmation, which
carry an idempotency key, and who signed off.

What you just made, in `generated/quickstart-payments`:

| Path | What you do with it |
| --- | --- |
| `cli/payments.mjs` | Run any approved operation from a terminal, typed. |
| `mcp/server.js` | The deployable unit — the same operations as MCP tools. |
| `skill/SKILL.md` | Hand this to an agent so it stops guessing. |
| `air.yaml` | The single model the other three are generated from. |
| `runtime/` | The fail-closed policy the server enforces at call time. |
| `deploy/` | Credential contract and deployment inputs. |

You did not get three things that might disagree. You got three views of
`air.yaml`, which is why a later step can prove they say the same thing.

## Read what the agent is allowed to do

```bash
pnpm anvil status "$ANVIL_BUNDLE"
pnpm anvil inspect "$ANVIL_BUNDLE"
```

`status` answers "where am I and what is the next safe thing to do"; it ends
with a named next action and the command for it. `inspect` is the operation
contract — the answers an agent would otherwise have to guess:

```
  Create a refund · approved · id=payments.refunds.create
    command       payments refunds create
    try safely    anvil run 'generated/quickstart-payments' refunds create --payment-id example --amount 1 --currency example --reason example --idempotency-key create_refund-example-key --confirm --dry-run
    effect        mutation · financial risk · irreversible
    safeguards    confirm required · idempotency required · retry safe by contract
    access        oauth2_client_credentials · service principal · scopes payments.write
```

Three lines of posture per operation, and a `try safely` line that is a complete,
runnable command. It is printed with the installed spelling `anvil run`; in this
source checkout, run it as `pnpm anvil run`.

Two neighbours are worth knowing now and reaching for later. `pnpm anvil lint`
names weak or unproven evidence — the mutation whose idempotency nobody
established. `pnpm anvil assess` goes further and, for any operation, lists each
gap with its effect on the agent and the skill that would close it:

```
payments refunds create  —  Create a refund
  effect      mutation/financial
  disposition Human decision required

Gaps (8), worst first:
  [high    ] mutation_effect_unproven
    Mutation 'payments.refunds.create' has no proven idempotency (mode=none); auto-retry is disabled.
    impact: the agent cannot know whether repeating this call duplicates its effect
    remediation: classify-idempotency (anvil refine run --skill classify-idempotency)
```

(That excerpt is the same spec compiled *without* the manifest — which is what
your own API will look like on day one.)

## Watch it refuse

This is the part worth doing slowly, because it is the thing you are actually
buying. Ask for a refund the way an agent would, and deliberately leave out the
confirmation:

```bash
pnpm anvil run "$ANVIL_BUNDLE" refunds create \
  --payment-id pay_123 --amount 4200 --currency usd --reason duplicate_charge \
  --dry-run
```

```json
{
  "error": {
    "code": "confirmation_required",
    "message": "This operation creates an irreversible financial mutation.",
    "retryable": false,
    "safe_to_retry": false,
    "operation": "payments.refunds.create",
    "trace_id": "trace_ca31f982-2a5b-42a0-b533-e0e403c7b2f1",
    "required_flags": ["--confirm", "--idempotency-key"]
  }
}
```

Exit code 3. Note what did *not* happen: it refused before doing anything, and
it refused even though you asked for a dry run — the gate sits in front of the
request, not in front of the network. The envelope is machine-readable on
purpose: `retryable: false` tells an agent not to loop, and `required_flags`
tells it exactly what a human would have to supply. Nothing about that refusal is
a message an agent has to interpret.

Now supply them:

```bash
pnpm anvil run "$ANVIL_BUNDLE" refunds create \
  --payment-id pay_123 --amount 4200 --currency usd --reason duplicate_charge \
  --idempotency-key refund-pay_123-001 --confirm --dry-run
```

```json
{
  "operation": "payments.refunds.create",
  "method": "POST",
  "url": "https://payments.internal.example.com/payments/pay_123/refunds",
  "headers": {
    "accept": "application/json",
    "Idempotency-Key": "refund-pay_123-001",
    "content-type": "application/json"
  },
  "body": { "amount": 4200, "currency": "usd", "reason": "duplicate_charge" },
  "idempotencyKeyPresent": true,
  "retryPlan": { "enabled": true, "maxAttempts": 3 },
  "confirmationRequired": true
}
```

That is the exact request that would go out, with auth material redacted — the
preview you want before letting an agent anywhere near a real refund. `retryPlan`
is enabled here only because the manifest declared the idempotency key; strip
that declaration and the same operation would never be auto-retried, whatever the
network did.

Everything an agent can be told about a failure has a stable code and a recovery
rule: see [Error taxonomy & recovery](/anvil/explore/errors/), and
[Handle a confirmation-required refusal](/anvil/cookbooks/handle-confirmation-required/)
for the three-step response an agent should give a user.

## See what your tools cost the agent that reads them

An agent pays for your tool list before it knows which tool it wants. Anvil
measures that:

```bash
pnpm anvil disclosure "$ANVIL_BUNDLE"
```

```
Disclosure BOM — payments 2026-07-09-prod  (tokens: o200k_base)

  Tool surface   968 tokens across 4 operation(s)
  Served         968 tokens across 4 approved operation(s)
  Budgets        1,200/tool · 8,000/response · 20,000/surface
  Ladder         flat (fits_budget) — 968 tokens at rest, within the 20,000-token surface budget

  Most expensive operations (measured tool surface):
    1.      360  payments.refunds.create  ✓
             68   19%  meta:_meta
             62   17%  input.idempotency_key
             51   14%  schema:inputSchema
    2.      226  payments.capture.create  ✓
             67   30%  meta:_meta
             42   19%  schema:inputSchema
             34   15%  annotations
```

Four operations is a cheap surface, so the interesting part is the shape of the
answer rather than the numbers. Every operation is ranked, and each one's cost is
broken down by the *field* responsible — a description, one input property, the
safety metadata. That turns "make your API agent-friendly" into a ticket someone
can close. The rollup below it does the same per capability, so you can see which
part of the API is eating the budget.

The `Ladder` line is what the MCP server will actually serve. Here it says `flat
(fits_budget)`: 968 tokens is nowhere near the 20,000-token surface budget, so
registering all four tools directly is cheaper than making the agent navigate.
Cross that budget and the same line changes to `laddered` — Anvil serves one
capability entry card per lane (`open_<capability>`) and discloses a lane's
operations only when the agent opens it. On a synthetic 100-operation service,
that line reads:

```
  Ladder         laddered (over_budget) — 10 lane(s) cut 37,116 to 386 at rest (saved 36,730), within the 20,000-token surface budget
```

Laddering changes only *when* a schema is disclosed, never *whether* an operation
may be called: an unapproved operation has no lane, no card, and no tool.

Add `--check` to gate a pipeline. It fails only on measured tool-surface
overruns, never on the projected response figures — an estimate should not turn a
build red.

Response cost is reported separately and honestly. Until responses have been
measured, this bundle says `Response cost: NOT MEASURED` rather than printing a
zero, because on a cost report a zero reads as "free".

## Prove it, instead of trusting it

```bash
pnpm anvil certify "$ANVIL_BUNDLE"
pnpm anvil selftest "$ANVIL_BUNDLE"
pnpm anvil conformance "$ANVIL_BUNDLE"
pnpm anvil simulate "$ANVIL_BUNDLE"
pnpm anvil status "$ANVIL_BUNDLE"
```

Each answers a different question you would otherwise have to take on faith.
`certify` checks the generated bytes against the model without running anything.
`selftest` boots the real MCP server and calls every approved tool over the real
transport, including proving the confirmation gates refuse *before* any side
effect. `conformance` checks that the CLI, the MCP tool list, and the skill name
the same operations and describe the same posture — the drift you would otherwise
discover in production.

`simulate` is the broadest of the four:

```
Simulation coverage — payments  (seed 1)

  Coverage by dimension:
    ✓ auth          4 op(s), 12/12 cells
    ✓ confirmation  2 op(s), 4/4 cells
    ✓ idempotency   1 op(s), 3/3 cells
    ✓ fault         4 op(s), 16/16 cells
    – pagination    no applicable operations
    ✓ disclosure    4 op(s), 8/8 cells  (projected from simulated data)
    Projected figures are estimates under seed 1, not measurements of live traffic.

  Mutation battery (safety-regression detection):
    ✓ remove_confirmation      killed (safety-sensitive)
    – enable_unsafe_retry      inapplicable
    ✓ drop_oauth_scope         killed (safety-sensitive)
    ✓ weaken_mutation_to_read  killed (safety-sensitive)
    ✓ corrupt_output_schema    killed (breaking)
```

The top half crosses every approved operation with every safety dimension that
applies to it — including `disclosure`, which checks each operation's context
cost against the agent's budget, and which is labelled as projected because it
was driven against simulated data. The bottom half is the more interesting claim:
Anvil deliberately breaks each safety control and proves the surface notices. A
`SURVIVED` line there means a safety regression could ship unseen.

All four reports bind to the bundle's content hash. The closing `status` prints
freshness per lane and sends you to the first one that needs rerunning; change a
generated byte and the evidence goes stale rather than quietly staying green.

## Hand it to an agent

```bash
pnpm anvil package skill "$ANVIL_BUNDLE" --out dist/skills
pnpm anvil serve mcp "$ANVIL_BUNDLE"
```

`package skill` validates the skill before copying it — frontmatter, resolvable
references, examples that match their schemas, no absolute paths — so what you
hand an agent cannot be half-written. `serve mcp` boots the same server you would
deploy, on stdio, and stays in the foreground waiting for a client; point a local
agent at that command. Its `tools/list` is exactly the four approved operations:

```
payments_get_customer
payments_get_payment
payments_create_refund
payments_capture_payment
```

Operations still at `review_required` are not in that list. They are not hidden
either — the skill names them as not callable, so an agent knows they exist and
knows not to try.

## End with a plan a human can review

```bash
pnpm anvil deploy ledger "$ANVIL_BUNDLE" \
  --project example-project-123 \
  --database example-shared-ledger \
  --database-mode shared
pnpm anvil publish "$ANVIL_BUNDLE" --env dev
pnpm anvil status "$ANVIL_BUNDLE"
```

`deploy ledger` is an offline inspection: it verifies the managed write-store
contract, lists every approved write, and resolves the Firestore database,
collection group, and `ANVIL_LEDGER` URI. It labels live readiness `UNVERIFIED`,
because only the deployed `/readyz` data-plane probe can prove the database and
runtime IAM after apply. See
[Prove durable idempotency](/anvil/cookbooks/prove-durable-idempotency/) for the
Terraform inputs and the exact guarantee boundary.

Shared mode expects an existing platform-owned database in the capability's
reviewed trust domain. Choose dedicated mode only when you need a separate
database IAM boundary; it additionally requires `--location`.

Despite its name, `publish` deploys nothing and makes no cloud API call — it
prepares a gated plan. It refuses unless the fresh static certification and all
three executable reports pass against the current bundle digest, then records
that evidence in the plan. A non-production experiment can waive it explicitly
with `--allow-incomplete-evidence`; production cannot. `status` deliberately
stops at `operator-action-required` — review and apply the plan in your own
delivery system, then record live evidence separately.

One value in the plan is worth reading before you apply it: generated Terraform
and Cloud Build default `ANVIL_ENV` from `air.service.environment`, falling back
to `prod` when AIR has none. It also selects the outbound credential profile.
Unknown runtime values keep production-safe behavior and emit a diagnostic — fix
the source value rather than relying on that fallback.

Connecting the endpoint to Gemini Enterprise is a separate, explicit journey:
choose [Custom MCP or Agent Gateway](/anvil/cookbooks/connect-gemini-enterprise/)
once the bundle and its target configuration pass assurance.

## Point it at your own API

Once the example makes sense, only the source coordinates change:

```bash
pnpm anvil compile path/to/openapi.yaml \
  --manifest path/to/anvil.yaml \
  --out generated/my-service
```

The manifest is optional for a read-only, fully described API, and becomes the
normal place to record evidence the source format cannot express. Expect
`review_required` operations the first time; that is the tool telling you where
the spec is thin. When `lint` and `assess` find uncertainty, target just that
residue instead of writing a manifest by hand:

```bash
pnpm anvil distill generated/my-service \
  --as-enrich-plan \
  --write /tmp/anvil-enrich-plan.json
```

Read [Operating Anvil](/anvil/guides/operating-anvil/) for the day-to-day loop —
what to run when the spec changes upstream, when an operation is stuck at review,
and what belongs in CI. If your source of truth is Apigee, Kong, WSO2, MuleSoft,
or IBM API Connect, start instead with
[Import a gateway estate](/anvil/cookbooks/import-a-gateway-estate/).
