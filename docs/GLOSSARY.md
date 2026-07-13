# Glossary

The canonical vocabulary of Anvil, defined once. The docs site auto-links the
first mention of each term on every synced page to its entry here, so a
definition is always one hover (or one click) away. Definitions are grounded in
the code and design docs — `packages/air/src/schema.ts`, `ARCHITECTURE.md`,
`mechanisms.md`, and `design/hooks-and-plugins.md` — not in aspiration.

## AIR

The Anvil Intermediate Representation — the canonical model every source format
compiles into and every generated artifact compiles from. It is defined in Zod
in `@anvil/air`, so one definition doubles as runtime validation and JSON
Schema emission. A single AIR document carries the service, its operations,
capabilities, workflows, shared schemas, and diagnostics.

## Approval (operation state)

The lifecycle state that gates exposure: an operation moves through
`generated` → `review_required` → `approved` (with `deprecated` and `blocked`
beside them), and only approved operations are compiled into the catalog and
served by generated artifacts. `anvil approve` grants the state after
inspection; the standing rule is to never approve an operation you have not
inspected.

## Bundle

The output directory `anvil compile` produces: the generated MCP server, CLI,
skill, catalog, compiled manifests, mocks, evals, conformance tests, and deploy
artifacts, all projected from one AIR document. The bundle — not the raw spec —
is what you inspect, enrich, approve, self-test, package, and deploy.

## Capability

A business unit such as Refunds or Payments that owns a set of operations and
workflows — the primary abstraction agents browse instead of URLs. The compiler
discovers capabilities by grouping operations by OpenAPI tag, falling back to
the resource noun, and records each grouping's source and confidence so it is
auditable rather than magical.

## Confirmation

The runtime gate that refuses to execute an irreversible, high-risk, or
non-idempotent mutation unless the call carries `confirm: true`. The refusal is
a structured `confirmation_required` error naming the exact required flags, so
an agent can re-invoke correctly instead of guessing.

## Conformance test

A generated test suite shipped with every bundle that proves the artifacts
honor the safety contract on real transports. It includes the hook–executor
agreement block: for every operation, `hookcore.decide()` and the runtime
executor must agree, which is what keeps the advisory outer ring from drifting
into a second implementation.

## Drift

Semantic divergence between the current source spec and a stored AIR contract,
detected by `anvil sync` and reviewed with `anvil drift`. Accepting a drift
record is bookkeeping only — it never edits AIR, never restores a
certification, and never changes capability lifecycles.

## Effect

An operation's classified side-effect semantics: read versus mutation, a
descriptive action verb, the touched resource, a risk level, and reversibility.
Classification is conservative by construction — an unknown side effect beats
assumed safety.

## Egress allowlist

The runtime's pin on upstream hosts (`ANVIL_ALLOWED_HOSTS`): a generated server
may only call the approved upstream, and a request to any other host fails with
`policy_denied`. Host pinning is enforced only in the runtime, because harness
hooks see tool name and arguments but never the URL a request will be built
against.

## Evidence claim (a.k.a. claim)

A single assertion about one semantic — a subject, predicate, and value — with
its own provenance, confidence, and source reliability. Confidence is resolved
per semantic from the active claims, discounted by source reliability, so ten
confident claims from a generated mock cannot drive a safety semantic to
certainty. Conflicting claims on a safety-sensitive predicate force review
instead of silently picking a winner.

## Harness hook

A generated PreToolUse script installed into an agent harness such as Claude
Code, Codex, or Antigravity that can deny, steer, or escalate a tool call
before it leaves the harness. Hooks are the advisory outer ring — fail-open by
design — while the runtime executor stays authoritative; no check may live only
in a hook.

## Hookcore

The shared, zero-dependency decision core (`plugin/hookcore.mjs`) behind every
harness hook shim. It reads the bundle's `catalog.json` — never duplicating
per-operation data — and returns allow, deny, or ask by mirroring the
executor's own refusals, so each per-harness shim stays a thin dialect
translation.

## Human-approval tier

A per-operation escalation above model confirmation: when
`confirmation.humanApproval` is set, a `confirm: true` supplied by the model is
not enough and the question must reach a real person. Harness hooks map the
tier to the human permission dialog (Claude Code's `ask`, Antigravity's
`force_ask`), and MCP elicitation can ask mid-call; when the tier is absent,
model confirmation suffices.

## Idempotency

Whether repeating a call yields the same outcome as making it once. AIR
classifies every operation as `natural`, `key_supported`, `client_id`,
`required`, or `none`, and retry safety gates on that mode — a non-idempotent
mutation is never auto-retried.

## Idempotency key

The caller-supplied token, carried in the header, query, or body field an
operation names, that lets the upstream deduplicate a replayed mutation.
Operations classified `required` refuse to execute without one, and the runtime
pairs the key with a request fingerprint (sha256 over canonical JSON) in the
idempotency ledger.

## Idempotency ledger

The external reserve/replay/in-progress store the runtime consults to
deduplicate required-idempotency mutations, because a stateless, horizontally
scaled service cannot remember its own requests. The ledger is a plugin
selected by `resolveLedger(ANVIL_LEDGER)`; outside `dev`, a
required-idempotency mutation fails closed with
`idempotency_ledger_unavailable` when no durable backend is configured.

## Manifest (enrichment)

The supplemental Anvil file that declares the semantics a spec omits —
idempotency, confirmation and human approval, retry policy, authored
workflows — and overrides inference at `anvil compile --manifest` time;
anything left unset is recomputed so the model stays coherent. Enrichment is
propose-only: the harness emits a proposed manifest patch for review and never
mutates AIR directly.

## MCP server

The deployed unit: one thin service per tool surface, generated from AIR and
depending only on `@anvil/mcp-runtime`, never on the build-time generators. It
exposes only approved operations and serves the skill and CLI as precomputed
MCP resources so an agent can materialize them adjacent to itself.

## Operation

A single callable unit of an API in AIR, with a stable dotted id such as
`payments.refund.create`. Each operation carries its effect, idempotency,
retry policy, confirmation, auth, errors, evidence, approval state, and
bindings for all three surfaces — one operation, one meaning, three
projections.

## Overlay

A layered set of evidenced semantic assertions applied on top of a contract
snapshot at compile time. The Anvil manifest is authoring syntax over an
`origin: "manifest"` overlay and gateway adapters emit `origin: "gateway"`
overlays; the same source plus the same overlays always compiles to an
identical contract.

## Projection

How a request body is presented on the agent surfaces without mutating the
canonical model: `fields` surfaces a flat object of scalars as individual CLI
flags or MCP properties, while `whole` surfaces anything richer as a single
body field carrying the full schema. The body's JSON Schema is always preserved
verbatim underneath.

## Reversibility

Whether an operation's effect can be undone. Irreversible mutations always
require confirmation, and reversibility feeds the MCP `destructiveHint`
annotation so well-behaved clients see the danger without installing anything.

## Risk

The severity grade on an operation's effect: `none`, `low`, `medium`, `high`,
`financial`, or `destructive`. The safety validator forces confirmation on
high-risk mutations, and the coarse `--human-approval unsafe` tier reads it to
decide which already-gated operations need a human.

## Skill

The generated progressive-disclosure operating manual — a `SKILL.md` with
reference material and evals — that teaches an agent to drive a tool surface
correctly. Anvil eats its own cooking: the `anvil` CLI is operated through its
own generated skill, and every bundle's MCP server serves its skill as
resources.

## Surface

One of the three aligned agent-facing artifacts generated from a single AIR
document: the CLI, the MCP server, and the skill. Every operation carries a
binding for each — `cli.command`, `mcp.toolName`, `skill.intentExamples` — so
the three surfaces agree on what an operation means.
