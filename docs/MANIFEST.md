# Write an Anvil manifest

An Anvil manifest records facts the source contract cannot express reliably.
It is a reviewed overlay, not a replacement API specification and not a place
to paste secrets.

Use a manifest to define operation safety, stable agent-facing names, auth
posture, authored workflows, capability review decisions, and constrained query
templates. Recompile after every change so all generated surfaces move together.

## Start from diagnostics

Do not begin by filling every available field. Compile first and let Anvil show
you what is missing:

```bash
anvil agentify path/to/spec --out generated/service
anvil inspect generated/service
anvil assess generated/service
anvil lint generated/service
```

For a focused enrichment plan:

```bash
anvil distill generated/service \
  --as-enrich-plan \
  --write /tmp/anvil-enrich-plan.json
```

Resolve the highest-risk gaps with the API owner. A missing description and an
unproven retry contract are not equivalent.

## Minimal example

```yaml
service:
  name: payments
  display_name: Payments API
  owner: payments-platform
  environment: prod

auth:
  type: oauth2
  scopes:
    - payments.read
    - payments.write

operations:
  createRefund:
    side_effect: mutation
    risk: financial
    reversible: false
    idempotency:
      strategy: required_request_key
      key_location: header
      header: Idempotency-Key
    confirmation:
      required: true
      reason: This operation moves money and cannot be reversed.
    retries:
      enabled: true
      only_on: [timeout, "429", "503"]
      max_attempts: 3
    state: approved
```

Operation keys may match the source operation id, canonical name, or AIR id.
Prefer the source operation id when it is stable and unique.

## Operation fields

| Field | Use it for | Review concern |
| --- | --- | --- |
| `side_effect` | Correct read vs mutation classification | Changing a mutation to a read loosens safety and requires strong evidence |
| `risk` | Record `none`, `low`, `medium`, `high`, `financial`, or `destructive` | Drives confirmation and human-approval policy |
| `reversible` | State whether the effect can be undone | Do not infer reversibility from HTTP method |
| `display_name`, `description` | Improve agent-facing explanation | Keep descriptions factual and task-specific |
| `name.resource`, `name.verb` | Repair weak routing names across CLI, MCP, and skill | Changes the projected name while preserving stable operation identity |
| `idempotency` | Declare how duplicate effects are prevented | Never claim retry safety without an upstream contract or equivalent evidence |
| `confirmation` | Require explicit intent and optionally human approval | `human_approval: true` implies confirmation |
| `auth` | Define principal, carrier, profile, issuer, audience, and source | Store identifiers and variable names only, never credential values |
| `retries` | Bound attempts and retryable conditions | Runtime still disables retries when idempotency does not make them safe |
| `query_policy` | Constrain a raw query passthrough | A policy moves the operation out of `blocked`, not directly to `approved` |
| `query_schema` | Add catalog-grounded tables, columns, sensitivity, and examples | Documentation input; runtime does not treat it as enforcement |
| `state` | Record lifecycle state | Approval must follow inspection and organizational review |

## Idempotency strategies

| Strategy | Meaning | Typical evidence |
| --- | --- | --- |
| `natural` | Repeating the operation has the same effect by definition | PUT to a stable resource id, or a documented state-set operation |
| `required_request_key` | The caller must provide a deduplication key | Upstream API contract naming a header, query parameter, path value, or body field |
| `key_supported` | A key can be used but is not required by the source contract | Upstream implementation or contract tests |
| `client_id` | A caller-controlled resource id prevents duplicate creation | Resource-creation contract |
| `none` | Repetition may duplicate the effect | Default for an unproven mutation |

For `required_request_key`, declare both the location and its exact source
name:

```yaml
idempotency:
  strategy: required_request_key
  key_location: body
  field: /input/idempotencyKey
```

Enabling retries in the manifest cannot override an unsafe idempotency posture.
The compiler recomputes the derived policy and the runtime checks it again.

## Stable agent-facing names

When a source operation is named `doTransition` or `getObject`, repair the
routing axes rather than editing generated tool names:

```yaml
operations:
  doTransition:
    name:
      resource: issue
      verb: transition
```

Anvil reprojects the canonical name, CLI command, MCP tool, and skill reference
together while preserving the operation's stable identity.

## Auth without secrets

The manifest describes how credentials are resolved; it must not contain
credential values.

```yaml
auth:
  type: oauth2
  principal: service
  credential_profile: payments_prod
  issuer: https://issuer.example.com/
  audience: https://payments.example.com/
  carrier:
    in: header
    name: Authorization
    scheme: Bearer
  secret_source: secret_manager
```

Use `anvil deploy credentials` to inspect the exact environment variable names
and deployment contract generated for a bundle.

## Author workflows; do not ask the compiler to guess them

```yaml
workflows:
  refund_customer:
    display_name: Refund a customer
    description: Verify the payment, then issue one idempotent refund.
    capability: refunds
    intent_examples:
      - refund a customer
      - return a duplicate payment
    human_approval: true
    rollback: Refunds are irreversible after the upstream accepts them.
    steps:
      - operation: getPayment
        description: Verify that the payment can be refunded.
      - operation: createRefund
        description: Issue the refund with a unique idempotency key.
        bindings:
          payment_id: $.steps.getPayment.id
```

Unknown operation references block the workflow. An unapproved mutation step
also prevents an executable workflow. This is deliberate: a valid sequence
cannot grant authority to an invalid step.

## Record capability review decisions

Capabilities are discovered deterministically and reviewed separately from
operations. Inspect the exact id first:

```bash
anvil capability list generated/service
anvil capability show generated/service <capability-id> \
  --operations --auth --evidence
```

You may persist the reviewed decision in the manifest so recompilation is
reproducible. Use the exact AIR capability id as the key. Large capabilities
require an explicit allowance and audit note; do not use that escape hatch to
avoid decomposing an incoherent surface.

## Constrain query passthroughs

Raw SQL or query-language endpoints are blocked until a machine-enforced policy
exists. Prefer a named query template when the task can be expressed narrowly:

```yaml
query_templates:
  branch_names:
    operation: run_query
    template: "SELECT name FROM accounts WHERE branch = '{branch}' LIMIT 10"
    target_param: sql
    params:
      branch:
        schema:
          type: string
          pattern: "^[A-Z0-9]+$"
    read_only: true
```

A template creates a constrained operation from a broader endpoint. Review the
generated schema and the query grammar policy before approval.

## Recompile and verify

```bash
anvil compile path/to/spec \
  --manifest path/to/anvil.yaml \
  --out generated/service

anvil status generated/service
anvil inspect generated/service
anvil lint generated/service
anvil assess generated/service
```

When the contract is ready, approve deliberately and run the assurance lanes.
Do not copy an approved state from an example without reproducing its evidence
and review in your environment.

## Review checklist

- Every operation entry matches the intended source operation.
- Read/mutation, risk, and reversibility describe business effect, not HTTP
  appearance.
- Idempotency claims cite an upstream contract, implementation, or test.
- Retry conditions are narrow and bounded.
- Human approval is used where the organization requires a person, not merely
  model confirmation.
- Auth describes a principal and credential carrier without embedding values.
- Workflows reference existing operations and do not smuggle approval across
  step boundaries.
- Query surfaces are constrained by grammar or templates.
- The bundle was recompiled and inspected after the change.

For the full operating sequence, continue with the
[enrich and approve workflow](../skills/anvil/reference/workflow.md).
