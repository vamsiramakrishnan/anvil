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
| `intent_examples` | Agent-phrased routing examples ("refund a customer") | Feed the skill surface and `anvil benchmark`; write them as a user would ask, not as the API names things |
| `name.resource`, `name.verb` | Repair weak routing names across CLI, MCP, and skill | Changes the projected name while preserving stable operation identity |
| `idempotency` | Declare how duplicate effects are prevented | Never claim retry safety without an upstream contract or equivalent evidence |
| `confirmation` | Require explicit intent and optionally human approval | `human_approval: true` implies confirmation |
| `auth` | Define principal, carrier, profile, issuer, audience, and source | Store identifiers and variable names only, never credential values |
| `retries` | Bound attempts and retryable conditions | Runtime still disables retries when idempotency does not make them safe |
| `pagination` | Declare how a paginated read is paged (`style`, `cursor_param`, `items_field`, …) when the spec did not make it inferable | Carrier parameters are validated against the operation's real inputs; a phantom parameter or a mutation declines with a review note |
| `query_policy` | Constrain a raw query passthrough | A policy moves the operation out of `blocked`, not directly to `approved` |
| `query_schema` | Add catalog-grounded tables, columns, sensitivity, and examples | Documentation input; runtime does not treat it as enforcement |
| `stream` | Resize a subscription's observation window (`max_events`, `max_seconds`) | Capped at 10,000 events / 300 seconds by AIR's schema; resizes an existing window, never creates one |
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

## Settle the estate's path grammar

The compiler classifies whether the estate's URL paths are nouns (REST) or
verbs (RPC-over-HTTP) from estate-wide evidence and records the verdict, with
its counts, in `service.source.pathGrammar` (see
[SOURCE_FORMATS.md](./SOURCE_FORMATS.md#path-grammar-classification)). When the
evidence genuinely splits, the compile emits a `path_grammar_ambiguous` warning
and keeps the source kind's default reading. A top-level manifest key settles
it:

```yaml
path_grammar: rpc_plain
```

Accepted values are `resource_grammar`, `rpc_plain`, `rpc_dotted`, and
`adapter_lowered` — never `ambiguous`, because a declaration must settle the
question, not un-settle it. The declaration always applies; if it contradicts a
definite measured verdict, the compile records a
`path_grammar_override_contradicts_evidence` warning so the disagreement is
reviewable rather than silent.

### When the derived resource contradicts the operation's own name

`anvil refine plan` raises `resource_contradicted_by_own_name` when an
operation's path-derived routing resource never appears in its own name text —
GitHub's `/orgs/{org}/hooks/{hook_id}` derives resource `hook` while the
vendor's name says "webhook". This is deliberately a **detector, not a compiler
rewrite**: vendors use synonyms, so absence from the name proves nothing (a
measured audit of the automatic rule found more than half of its "fixes"
semantically wrong). What is deterministic runs in code; the grey area is
handed, with evidence, to a decision-maker:

```bash
# 1. Detect — deterministic, read-only.
anvil refine plan generated/service

# 2. Export one hash-bound task for the contradicted operation. Its facts carry
#    the path, method, segments, operationId, name text, derived resource and
#    action, the sibling operations on the same path, and the estate's naming
#    style — everything a coding harness needs to decide.
anvil refine export-task generated/service "operation:<id>" \
  --skill rehome-resource --out task.json

# 3. Any coding harness investigates and returns one submission JSON.

# 4. Import: deterministic validation re-runs before anything can reach review.
#    A proposed resource that is not a word the operation's own path or name
#    text states is REFUSED (`resource_grounded_in_contract`); a valid proposal
#    ALWAYS lands at review tier — never auto.
anvil refine import-proposal generated/service task.json submission.json --out pack/

# 5. A person decides, and only the reviewed bytes apply.
anvil refine review pack/
anvil refine approve pack/ <refinement-id> --reviewer you@example.com --reason "..."
anvil refine apply-pack generated/service pack/
```

The durable closure is this manifest's `name: { resource }` override: record
the decided resource here and recompile, and every routing surface reprojects
together. The heuristic executor (`anvil refine run --skill rehome-resource`)
proposes only the trivially safe subset — a non-word stem the old singularizer
produced (`releas`) whose real word the operation's own name spells
(`release`); every synonym question (`hook` vs `webhook`) goes to the harness
and then to a reviewer.

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

### mTLS, custom headers, and end-user authorization-code

Three more auth types the runtime executes, each declared by NAME only —
never a value:

```yaml
# Mutual TLS: cert/key/CA read from these env vars (PEM text, or a path
# starting with / or ./ to a PEM file). mtls without `tls` stays blocked.
operations:
  getBalance:
    auth:
      type: mtls
      tls:
        client_cert_ref: ANVIL_BANK_CLIENT_CERT
        client_key_ref: ANVIL_BANK_CLIENT_KEY
        ca_ref: ANVIL_BANK_CA          # optional

# A credential that rides a header AIR's other carriers cannot name — sent
# verbatim under `carrier`, never collapsed to `Authorization: Bearer`.
# custom_header without a `carrier` stays blocked.
  listWidgets:
    auth:
      type: custom_header
      carrier:
        in: header
        name: X-Vendor-Token           # any name/scheme the vendor requires

# End-user authorization-code (RFC 6749 §4.1, PKCE per RFC 7636). The
# interactive step never runs in the serving path — `anvil auth login <bundle>
# --profile <profile>` completes it once, on a loopback broker, and stores a
# refresh token the runtime replays/refreshes per call. This type always
# compiles review_required: end-user authority is a human decision, never a
# material-completeness one, so no manifest `state:` override moves it to
# approved directly.
  startCheckout:
    auth:
      type: oauth2_authorization_code
      provider:
        authorization_endpoint: https://idp.example.com/authorize
        token_endpoint: https://idp.example.com/token
        redirect_uri: http://127.0.0.1:0/callback   # port 0 = random, broker-assigned
        pkce: true
```

Every field here is validated by AIR's `authCoherenceIssues` (mtls material only
on `mtls`, authorization-code mechanics only on `oauth2_authorization_code`, an
`authorization_endpoint` always paired with `token_endpoint`) — the same rule
the compiler and certification both enforce, so a manifest can never declare an
incoherent combination that would only be caught later.

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

### Make composition subtractive with `supersedes`

A workflow that only ever *adds* a tool makes the surface an agent routes over
bigger — the opposite of what composing one is for. `supersedes` names the
operations the composite replaces on the MCP tool surface:

```yaml
workflows:
  refund_customer:
    capability: refunds
    state: approved
    supersedes:
      - createRefund
    steps:
      - operation: getPayment
      - operation: createRefund
        bindings:
          payment_id: $.output.id
```

Three rules, all enforced rather than advised:

- **Only what it performs.** Every entry must resolve to an operation this
  workflow already names as a step. A reference to anything else — or to no
  operation at all — blocks the workflow with a diagnostic.
- **Only when approved.** `@anvil/mcp-runtime` suppresses nothing for a workflow
  it will not register: unapproved, an unapproved step, a malformed binding, a
  later step needing the caller's idempotency key. A skipped workflow can never
  silently delete a tool.
- **Only the MCP surface.** A superseded operation is still in AIR, still
  generated into the CLI and all four client SDKs, and still callable there
  under exactly the same safety contract. Only `tools/list` shrinks.

Because `anvil capability approve` budgets the surface that is actually served,
superseding an operation *lowers* what the capability spends, while the
composite itself costs one tool.

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

### Author a capability discovery cannot produce

Discovery groups by the spec's own taxonomy (tags, resources); the task-shaped
groupings that routing accuracy depends on routinely cut across it. A
`capabilities:` entry with an `operations` list AUTHORS a new capability: the
key becomes its id, and members resolve by AIR id, canonical name, or the
source operationId, like every other manifest operation reference.

```yaml
capabilities:
  payments.refund_support:
    display_name: Refund support
    description: Look a payment up and refund it — the observed support task.
    intent_examples:
      - refund a customer end to end
    operations:
      - getPayment
      - createRefund
```

Authoring is a declaration, not an approval. The capability compiles in with
`source: manifest` and `lifecycle: proposed`, and reaches `approved` only
through the same review gate as a discovered grouping — `anvil capability
approve`, or `state: approved` on the same entry — including the same
disclosure budget (`allow_large` plus a note above the hard limit). Authoring
also grants nothing to the member operations: an authored capability whose
members are unapproved still builds nothing (`capability_empty`).

Validation is hard: an empty `operations` list is refused, a member that
resolves to no operation is a structured error
(`capability_author_member_unresolved`), and an id colliding with an existing
grouping is a structured error (`capability_author_id_collision`), never a
merge. `anvil capability diff` knows an authored capability has no discovery
counterpart by definition and checks its members against the document instead
of reporting phantom drift.

The observed-traffic loop feeds this section: `anvil capability propose
--from-records <spool>` emits a ready-to-review snippet per grouping
(`manifestSnippet` in the report, or `--snippet <grouping-id>` on the command)
that you copy here, review, and recompile — Anvil never writes it for you.

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
