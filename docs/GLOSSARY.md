# Glossary

Anvil's vocabulary, defined once. The docs site auto-links the first mention of
each term on every synced page back to its entry here, so a definition is always
one hover (or one click) away. Every entry below leads with a plain-language
summary, then the precise detail. Definitions are grounded in the code and
design docs — `packages/air/src/schema.ts`, `ARCHITECTURE.md`, `mechanisms.md`,
and `design/hooks-and-plugins.md` — not in aspiration.

## AIR

**One shared model that every part of Anvil reads from and writes to.** Whatever
format your API arrives in — OpenAPI, and later gRPC or GraphQL — it compiles
*into* AIR (the Anvil Intermediate Representation), and every generated artifact
compiles *from* it. Because the CLI, MCP server, and skill all come from this
one model, they can't disagree about what an operation does.

AIR is defined in Zod in `@anvil/air`, so a single definition doubles as runtime
validation and JSON Schema emission. One AIR document carries the service, its
operations, capabilities, workflows, shared schemas, and diagnostics. Mention
the acronym once, then just call it "the model."

## Approval (operation state)

**The gate that decides whether an agent can see an operation at all.** An
operation moves through `generated` → `review_required` → `approved` (with
`deprecated` and `blocked` off to the side), and only approved operations are
compiled into the catalog and served to agents.

`anvil approve` grants the approved state after you inspect the operation. The
standing rule: never approve an operation you have not inspected.

## Bundle

**The folder `anvil compile` produces — everything needed to run and ship the
tools.** You inspect, approve, test, package, and deploy the bundle, not the raw
spec.

A bundle holds the generated MCP server, CLI, and skill, plus the catalog,
compiled manifests, mocks, evals, conformance tests, and deploy artifacts — all
generated from one AIR document.

## Capability

**A group of related operations, like *Refunds* or *Payments*.** It's what an
agent browses instead of a list of URLs — a business unit that owns a set of
operations and workflows.

The compiler discovers capabilities by grouping operations by their OpenAPI tag,
falling back to the resource noun. It records where each grouping came from and
how confident it is, so the result is auditable rather than magical.

## Confirmation

**A safety stop: some operations refuse to run until the caller explicitly says
"yes, do it."** This covers mutations that are irreversible, high-risk, or not
safe to repeat.

When the runtime blocks such a call, it returns a structured
`confirmation_required` error that names the exact flags to supply (for example
`--confirm`), so an agent can re-issue the call correctly instead of guessing.

## Conformance test

**A generated test suite, shipped in every bundle, that proves the tools
actually enforce the safety rules.** It runs against real transports, not just
in theory.

Its core is the hook–executor agreement check: for every operation,
`hookcore.decide()` and the runtime executor must reach the same allow/deny/ask
verdict. That check is what stops the advisory hook layer from drifting into a
second, conflicting implementation.

## Drift

**"The spec changed underneath you."** Drift is a difference between the current
source spec and the AIR contract you compiled earlier — a signal that upstream
moved.

`anvil sync` detects it and `anvil drift` reviews it. Accepting a drift record
is bookkeeping only: it never edits the model, never restores a signed check,
and never changes a capability's lifecycle.

## Effect

**What an operation actually does to the world — read something, or change it.**
This is the classifier's verdict, and it drives most of the safety decisions
that follow.

For each operation the classifier records: read versus mutation, a short action
verb, the resource touched, a risk level, and whether it can be undone.
Classification is conservative — an unknown side effect is treated as unsafe
rather than assumed harmless.

## Egress allowlist

**A list of the only hosts a generated server is allowed to call.** Set through
`ANVIL_ALLOWED_HOSTS`, it pins a server to its approved upstream; a request to
any other host fails with `policy_denied`.

This check lives only in the runtime, not in the harness hook, because a hook
sees the tool name and arguments but never the actual URL a request will be
built against.

## Evidence claim (a.k.a. claim)

**One fact about one operation, with a note on where it came from and how much to
trust it.** A claim is a subject, a predicate, and a value — for example, "this
operation is idempotent" — plus its provenance, confidence, and source
reliability.

Confidence is resolved per fact from the active claims and discounted by how
reliable the source is, so ten confident claims from a generated mock still
can't push a safety-sensitive fact to certainty. When claims about a
safety-sensitive fact conflict, Anvil forces a human review instead of silently
picking a winner.

## Harness hook

**A script the agent's harness runs before a tool call, which can block or
escalate it.** Anvil generates one of these (a PreToolUse hook) for harnesses
like Claude Code, Codex, and Antigravity, so an unsafe call can be stopped
before it ever leaves the harness.

The hook is the outer safety ring and is fail-open by design: if it's missing,
the runtime executor still refuses the call. No safety check may live only in a
hook.

## Hookcore

**The one shared brain behind every harness hook.** `plugin/hookcore.mjs` is a
small, zero-dependency module that decides allow, deny, or ask — and each
per-harness hook is just a thin translator on top of it.

It reads the bundle's `catalog.json` rather than duplicating any per-operation
data, and it reaches its verdict by mirroring the runtime executor's own
refusals. That keeps every per-harness shim a simple dialect translation.

## Human-approval tier

**A stricter gate where a real person — not the model — must sign off.** When an
operation sets `confirmation.humanApproval`, a `confirm: true` from the model is
no longer enough; the question has to reach a human.

Harness hooks map this tier to each harness's human permission dialog (Claude
Code's `ask`, Antigravity's `force_ask`), and MCP elicitation can raise the
question mid-call. When the tier isn't set, ordinary model confirmation is
enough.

## Idempotency

**Safe to repeat: calling twice does the same thing as calling once.** This is
the property that decides whether a failed call can be retried automatically.

AIR classifies every operation as `natural`, `key_supported`, `client_id`,
`required`, or `none`. Retry safety gates on that mode — a mutation that isn't
safe to repeat is never auto-retried.

## Idempotency key

**A token the caller sends so the upstream can recognize a repeated request and
not do the work twice.** It rides in whichever header, query, or body field the
operation names.

Operations classified `required` refuse to run without one. The runtime pairs
the key with a request fingerprint (a sha256 over canonical JSON) in the
idempotency ledger so a replayed mutation is caught.

## Idempotency ledger

**A shared store the runtime uses to remember which requests it has already
handled.** A stateless service scaled across many instances can't remember its
own past calls on its own, so this external store does the remembering.

The ledger is a plugin, selected by `resolveLedger(ANVIL_LEDGER)`. Outside
`dev`, an operation that *requires* an idempotency key fails closed with
`idempotency_ledger_unavailable` when no durable backend is configured — the
runtime refuses rather than pretend it has protection it doesn't. The generated
Firestore backend expires completed replay results after a bounded retention
window, while in-progress reservations never expire automatically. Its live,
non-mutating readiness probe keeps `/readyz` closed when the named database
cannot be reached.

## Manifest (enrichment)

**A small YAML file where you fill in what the spec left out.** Specs rarely
state which POSTs are safe to repeat or which calls need confirmation; the
manifest lets you declare those facts by hand.

It sets idempotency, confirmation and human approval, retry policy, and authored
workflows, and it overrides the compiler's guesses at
`anvil compile --manifest` time. Anything you leave unset is recomputed, so the
model stays coherent. Enrichment is propose-only: the harness emits a proposed
manifest patch for you to review and never edits the model directly.

## MCP server

**The small service that actually gets deployed — one per set of tools.** It's
generated from the model and exposes only approved operations to agents.

It depends only on `@anvil/mcp-runtime` (the thin serving path), never on the
build-time generators, so the build/run boundary is enforced by the dependency
graph. It also serves the skill and CLI as precomputed MCP resources, so an
agent can pull them in right next to itself.

## Operation

**A single callable action of an API** — one endpoint, given a stable dotted id
like `payments.refund.create`.

Each operation carries everything the tools need to treat it correctly: its
effect, idempotency, retry policy, confirmation, auth, errors, evidence, and
approval state, plus a binding for each of the three surfaces. One operation,
one meaning, generated into three places.

## Overlay

**A layer of extra facts added on top of the spec.** Rather than editing the
spec, Anvil stacks evidenced assertions over a snapshot of it at compile time.

The Anvil manifest is just friendly authoring syntax over an `origin: "manifest"`
overlay, and gateway adapters emit `origin: "gateway"` overlays. The same source
plus the same overlays always compiles to an identical contract.

## Projection

**How an operation's input is shown to the agent as command flags or tool
fields.** It's a presentation choice made without changing the underlying model.

Simple bodies (a flat object of scalars) are surfaced as individual CLI flags or
MCP properties (`fields` mode); anything richer is surfaced as a single body
field carrying the whole schema (`whole` mode). Either way, the body's JSON
Schema is preserved verbatim underneath.

## Reversibility

**Whether an operation's effect can be undone.** A refund can't be un-refunded;
a read changes nothing. This is one of the facts that drives confirmation.

Irreversible mutations always require confirmation. Reversibility also feeds the
MCP `destructiveHint` annotation, so well-behaved clients can see the danger
without installing anything extra.

## Risk

**How much damage an operation could do — from harmless to destructive.** The
grades are `none`, `low`, `medium`, `high`, `financial`, and `destructive`.

The safety validator forces confirmation on high-risk mutations, and the coarse
`--human-approval unsafe` tier reads the risk grade to decide which
already-gated operations also need a human.

## Skill

**A generated manual that teaches an agent how to use a set of tools correctly.**
It's a `SKILL.md` with reference material and evals, revealed progressively so
the agent reads only what it needs.

Anvil uses its own medicine: the `anvil` CLI is itself operated through a
generated skill, and every bundle's MCP server serves its skill as resources.

## Surface

**Each place an API shows up for an agent: the CLI, the MCP server, and the
skill.** All three are generated from one AIR document, which is why they agree.

Every operation carries a binding for each surface — `cli.command`,
`mcp.toolName`, `skill.intentExamples` — so the command, the tool, and the
manual all describe the same operation the same way.
