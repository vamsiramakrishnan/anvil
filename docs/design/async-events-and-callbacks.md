# Async completion, unified — stateless MCP over a durable ledger

Status: design (researched 2026-08-03, substantially revised 2026-08-04 after
folding in a human-approval mechanism, a queue-systems deep dive, and a
corrected DLQ-triage pattern — all resolved through one underlying principle,
§2). Nothing here is implemented; the staged plan is at the end. Written to
be handed to an implementing agent directly — every section names the real
files it touches, and every vendor/protocol claim is checked against this
repo's own backtest evidence or flagged as unverified.

## 1. Why

Anvil already has one working async primitive: `packages/air/src/async-contract.ts`.
An operation that returns before its work finishes carries an `AsyncContract`
— which operation to poll, where the job handle lives, which states mean
stop. `resolveAsyncContract` validates it; `asyncContractSentence` renders it
for the agent. It works, and the agent-facing shape of it is exactly right:
one tool, a handle, a poll loop, a stopping condition.

Three gaps sit on top of that primitive, and this document used to treat them
as three separate problems:

1. Some APIs push a webhook instead of accepting a poll (Stripe, GitHub,
   most payment/CI providers).
2. Some mutations need a human to answer a question mid-job, not just
   confirm before it starts (`confirmation.humanApproval` exists in AIR but
   has no real channel today).
3. Some completion signals arrive over a message queue, not HTTP at all —
   and, per an outside pitch reviewed during this design's development, a
   *bidirectional* pattern (read a failed message, repair it, write it back)
   is a real, named use case (dead-letter-queue triage) with real safety
   gaps as usually built.

They are not three problems. §2 is the single mechanism that resolves all
three, and it's not a new invention — it's Anvil's own existing architecture,
taken seriously.

## 2. The throughline: stateless MCP over a durable ledger

**"Stateless" is doing real, checkable work in Anvil's architecture, not
just an adjective.** `docs/PRODUCT_BOUNDARY.md` §1 states it as a design
law: *"The deployed unit is a thin, stateless runtime — nothing on the hot
path parses specs or runs an LLM."* Concretely, that's already true of two
different things in the shipped code:

- **The compute layer is stateless.** `packages/generators/src/deploy.ts`
  targets Cloud Run — a request/response service with a bounded per-request
  timeout (`GENERATED_CLOUD_RUN_TIMEOUT_SECONDS`, `deploy.ts:34`), no
  server affinity, scale-to-zero between requests. Any instance can serve
  any request.
- **Durable state is externalized, not held in the process.**
  `packages/runtime/src/idempotency.ts`'s `IdempotencyLedger` is where
  anything that must survive past one request lives — a reservation, a
  cached result, now (this doc) a webhook completion.

There is exactly one place Anvil's MCP server holds real in-memory session
state today: `packages/mcp-runtime/src/lane.ts`'s progressive tool-disclosure
ladder — which operations are currently visible in `tools/list` for this
connection. And it's instructive *because* it's the exception: that state is
deliberately disposable. `lane.ts:171-175` designs for a dropped
`tools/list_changed` notification by making a second "open" idempotent and
byte-identical to the first — losing the in-memory lane state costs a
re-list, never a wrong answer, because it's presentation state, not business
state. Nothing about *what an operation means* or *whether a job is done*
is allowed to live only in server memory. That discipline — safety- and
completion-relevant state lives in the ledger; the serving process is a
disposable, horizontally-scalable front end over it — is the actual
generalizable primitive this whole document exercises three times.

**The unifying move: a "pending" thing is a ledger row, not an open
connection or a blocked thread.** Once that's true:

- Any stateless server instance can *write* a completion into the ledger
  (a webhook receiver handling one POST).
- Any stateless server instance can *read* a completion out of the ledger
  (a status-tool call, from any agent, any time later).
- "Answering" a pending job — with a webhook payload, a human's decision, or
  a repaired message — is always the same shape: **one more stateless
  mutation that writes into the same durable row**, callable from whatever
  surface happens to be available when the answer is ready, with no
  requirement that anything stayed alive in between.

That last point is what kills the daemon idea from earlier drafts of this
document (§8 resolves it) and what makes the queue-systems slice (§10)
almost free: neither mid-call human approval nor most queue integrations
actually need a new *runtime shape*. They need one more `pendingState` and
one more operation that writes to the ledger — the same two moves §5–§7
already make for webhooks.

## 3. Three problems, one mechanism

| | Trigger | New `pendingState` | Who can answer, and when | Answered via |
|---|---|---|---|---|
| **Webhook completion** (§9–§11) | Third-party POST | *(none new — resolves an existing `terminalState`)* | The provider, whenever its job finishes | Receiver route writes ledger row |
| **Human approval mid-job** (§8) | `confirmation.humanApproval` gate hit | `awaiting_human_input` | Any surface (CLI, MCP client, a Slack bot) — no session, no attach required | `anvil job answer <id>` — one more stateless mutation |
| **DLQ triage** (§12) | A message lands in a dead-letter queue | *(the DLQ message itself is the pending row — no new ledger shape needed, it's a queue, not `AsyncContract`)* | An agent (or human) reading the DLQ, whenever it gets around to it | `publish_to_reprocess_queue` — a normal, safety-classified mutation |

Reading down the "Answered via" column is the point: every row ends at "a
stateless mutation, callable independently of whatever was live when the
question was asked." That's not a coincidence produced by writing this
table — it's why the table has three rows and one mechanism.

## 4. Non-goals (say these out loud before starting)

- **Not a hosted event-gateway product.** No general routing, fan-out, or
  multi-tenant ingestion service (contrast: Hookdeck). One receiver route
  per deployed Cloud Run service, scoped to that service's own operations.
- **Not MCP elicitation/sampling.** Confirmation-to-*start* stays the
  explicit `confirm` param (`packages/mcp-runtime/src/server.ts:141-191`).
  Confirmation-*mid-job* is §8's `awaiting_human_input` state — a stateless
  answer, not a held-open elicitation request. Neither needs a live
  server-to-client callback channel.
- **Not resource subscriptions.** `packages/generators/src/resources.ts`
  resources are static per build; nothing here changes that.
- **Not a new trust tier.** A webhook, a human's answer, and a queue-publish
  are all inbound writes from outside the safety boundary. Every one of
  them gets the same asymmetric-trust treatment (§13) — verified before
  trusted, `review`-gated before automatic.
- **Not raw broker consumption.** §10 draws a hard line: pull/push queue
  APIs reachable over plain HTTP (SQS, Pub/Sub, a Kafka REST proxy,
  RabbitMQ's management API) are in scope and near-free on top of this
  design. A persistent consumer holding a live connection to a broker's
  *native* wire protocol (raw Kafka, JMS, AMQP with no HTTP front) is a
  genuinely different, stateful runtime shape and is explicitly deferred —
  it is the one case in this entire document that doesn't reduce to §2's
  mechanism, precisely because there's no way to make holding a broker
  connection open stateless.
- **Not a general enterprise-integration story.** This design targets
  HTTP-reachable completion (signed webhook, or a queue provider with an
  HTTP pull/push surface). It is not a design for whatever completion shape
  Anvil's actual largest real estates (FLEXCUBE, OBDX) use — that's
  unverified either way (§9's closing note) and out of scope regardless.

## 5. Benefits, concretely — who this is for

**The agent calling the tools.** One mental model regardless of which row
of §3 is in play: call a tool, get a handle, poll or get told "waiting on
X." Never learns whether completion came from an upstream poll, a webhook,
a human, or a repaired queue message. Fewer wasted turns when an answer is
already sitting in the ledger. A resumable handle instead of a dead end when
blocked on something outside its control.

**The human operating Anvil.** `confirmation.humanApproval`
(`packages/air/src/schema.ts:432,994`) stops being purely advisory — today
it only ever renders into generated docs as a warning string
(`packages/generators/src/skill.ts:428`, `packages/generators/src/plugins.ts:220-228`).
§8 gives it a real, and cheap, channel. A job survives a closed laptop or a
dropped SSH session because its state lives in the ledger, not in a blocked
local process. An audit trail — who/what completed a job, when — falls out
of the mechanism instead of needing to be built separately.

**The developer building on Anvil's output.** CLI and MCP behave
identically for completion, because both read the same ledger-backed status
handler. One integration point instead of N bespoke receivers/pollers/
consumers. A build-time guarantee (certification, §14) instead of a runtime
surprise.

## 6. The unified agent model

```
                        AGENT'S MENTAL MODEL (unchanged)
                        ────────────────────────────────

        ┌──────────┐   submit    ┌───────────────┐  poll   ┌──────────────┐
        │  agent   │ ───────────▶│ submit_op tool │        │ status tool  │
        │          │◀─────────── │ (returns       │        │ (same tool,  │
        │          │  job_id     │  job.id)        │        │  same shape) │
        └────┬─────┘             └───────────────┘         └──────┬───────┘
             │                                                     ▲
             │  "poll status_op with job_id until terminal state"  │
             └─────────────────────────────────────────────────────┘
                     exact sentence asyncContractSentence() renders today
```

Three different things can now answer the same `status tool` call:

```
                    WHAT THE STATUS TOOL DOES NOW (new)
                    ────────────────────────────────────

  agent calls status_op(job_id)
            │
            ▼
  ┌─────────────────────────┐   found, resolved     ┌────────────────────┐
  │ 1. check ledger for      │───────────────────────▶│ return cached      │
  │    job_id                │  (webhook wrote it,    │ result / state     │
  │                           │   OR a human answered, │ immediately         │
  │                           │   OR still pending)     │                    │
  └───────────┬──────────────┘                        └────────────────────┘
              │ not found / no answer yet
              ▼
  ┌─────────────────────────┐
  │ 2. call upstream status  │   (today's only path — unchanged)
  │    operation, as today   │
  └─────────────────────────┘
```

A webhook, a human's `anvil job answer`, or a queue-publish confirmation are
three different *writers* into the same ledger row the poll path already
reads on retry.

## 7. Component architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│   Third-party API (Stripe, GitHub, …)     A human (CLI / Slack / …)     │
└───────────────┬────────────────────────────────────┬────────────────────┘
                 │ webhook POST (signed)               │ anvil job answer <id>
                 ▼                                      ▼
   ┌────────────────────────────────────────────────────────────────┐
   │  Deployed Cloud Run service (@anvil/generators output)          │
   │                                                                    │
   │  /webhooks/<service>/<opId>          job-answer MCP tool / CLI cmd │
   │  ┌────────────────────────┐         ┌─────────────────────────┐  │
   │  │ 1. verify signature     │         │ 1. authz the answerer    │  │
   │  │ 2. extract job id        │         │ 2. validate answer shape  │  │
   │  │ 3. ledger.complete(...)  │         │ 3. ledger.complete(...)   │  │
   │  └────────────┬─────────────┘         └────────────┬─────────────┘  │
   │                │                                     │               │
   │                └───────────────┬─────────────────────┘               │
   │                                 ▼                                    │
   │                    ┌─────────────────────────┐                      │
   │                    │  IdempotencyLedger        │                      │
   │                    │  (Firestore — the SAME     │                      │
   │                    │   one idempotency.ts        │                      │
   │                    │   already ships)             │                      │
   │                    └────────────┬─────────────┘                      │
   │                                 │                                    │
   │                                 ▼                                    │
   │                    ┌─────────────────────────┐                      │
   │                    │  MCP tool: status_op      │                      │
   │                    │  (§6 hybrid check)         │                      │
   │                    └────────────┬─────────────┘                      │
   └─────────────────────────────────┼──────────────────────────────────┘
                                      ▼
                                MCP client (agent)
```

Every box in this diagram is a stateless HTTP handler over the same durable
ledger. Nothing here is a new hosting model, and nothing here is a
persistent process — that's §2's point made concrete.

## 8. Human approval, without a daemon

An earlier draft of this document proposed a persistent daemon (a
long-lived process behind a local socket, holding job state in memory) so a
CLI invocation could answer a mid-call question, reasoning that MCP
elicitation can't project onto a one-shot CLI process. That reasoning about
the CLI was right; the proposed fix was heavier than it needed to be. §2's
principle applies directly: durability was never about keeping a process
alive — it's about writing to the ledger. Once that's the model, a daemon
buys almost nothing this design doesn't already have.

**Scope correction, made explicit up front:** an earlier draft of this
section implied the executor itself could pause a mutation *mid-flight* —
partway through a single upstream call — and resume it later once a human
answers. That's not real: `packages/runtime/src/executor.ts` makes one
upstream request and returns; there is no checkpoint inside that request to
pause at, and nothing in this document designs one. Writing a ledger row
and later overwriting it with a decision does not resume an unfinished HTTP
call — it can only be read back by something that polls it. So this
mechanism is scoped down to the case where that's exactly what's needed:
**the upstream itself is already async and already tracks its own
pending-approval state** — a loan application sitting in "pending
underwriter review" on the vendor's own system, not a paused Anvil
executor. `awaiting_human_input` names that upstream state; it doesn't
invent execution-pausing machinery Anvil doesn't have.

**The mechanism — three moves, no new process, and no new execution
primitive:**

1. `AsyncContract.pendingStates` (`packages/air/src/async-contract.ts`)
   gains a recognized value, `awaiting_human_input`, for operations that
   already carry an `AsyncContract` (§9) — i.e., operations already
   `longRunning`, whose upstream already returns before completion. The
   submit call returns as it always does; the *status* side reports
   `awaiting_human_input` when the upstream's own state says so (via poll
   response or webhook payload, same as any other pending/terminal state).
   Nothing pauses — the upstream was already async before a human entered
   the picture.
2. A new, ordinary, safety-classified mutation —
   `anvil job answer <job_id> --decision approve|reject [--note ...]` —
   is generated only when the spec exposes a real decision-taking
   operation on the vendor's API (an "approve this application"-shaped
   endpoint). `anvil job answer` is a thin, authenticated wrapper that
   calls *that* operation with the job's handle, through the exact same
   AIR operation-call path every other mutation uses. It authenticates the
   caller and validates the decision shape, but it is not resuming
   anything Anvil paused — it's placing a normal call the upstream already
   knows how to receive. The ledger records that the answer was submitted,
   for audit and duplicate-submission dedup, not to reconstruct in-flight
   state that was never Anvil's to hold.
3. The status tool (§6's hybrid handler) already checks the ledger first.
   `awaiting_human_input` is just one more state it can report — the agent
   sees "pending: awaiting_human_input" the same way it sees any other
   pending state, and re-polls (now against the upstream's real
   post-decision state) until a terminal state lands.

**What this means got cut, honestly:** this mechanism no longer covers "a
single synchronous mutation pauses partway through for approval, then
finishes." That case would need real checkpoint/continuation machinery —
saving partial execution state and a way to resume it — which this
document doesn't design and which is a materially bigger feature than
anything else here. If that case matters, it's a separate design, not an
extension of this one.

**What this gets you, versus the daemon draft, at a fraction of the
build:** detach/reattach (the job outlives any process, because nothing was
holding it open), multi-surface answering (whoever runs `anvil job answer`
— original terminal, a different machine, a bot — answers it, because
authorization is checked per-call, not per-session), and durability across
crashes/disconnects (it was never in memory).

**What it doesn't get you, honestly:** true low-latency push notification
to a human ("ping me the instant a question arrives") and connection/session
amortization across many jobs. Both are real daemon benefits this design
gives up. If either becomes a real requirement, a daemon is still a
legitimate follow-on — but it would be an optimization on top of this
ledger-based mechanism (a thin process that watches the ledger and pushes
notifications), not a replacement for it, and it's still explicitly out of
scope here.

## 9. AIR shape (webhooks)

Extend `packages/air/src/async-contract.ts` rather than inventing a sibling
file — completion is one concept with multiple possible sources, not
several concepts.

```ts
// packages/air/src/async-contract.ts (extend)

export interface WebhookContract {
  /** The inbound operation compiled from the spec's callbacks:/webhooks: entry. */
  webhookOperationId: string;
  /** Dotted path into the webhook payload carrying the job handle. */
  webhookJobIdField: string;
  /** Dotted path into the webhook payload carrying terminal/pending state, if any. */
  webhookStateField?: string;
  /** How the receiver verifies the sender before trusting the payload. Required — no "none". */
  signatureVerification: WebhookSignatureVerification;
}

/**
 * Four real shapes, grounded in §11's vendor deep dive — a single "hmac
 * over the raw body" scheme would silently misclassify most of them.
 */
export type WebhookSignatureVerification =
  | {
      /** Raw-body HMAC, digest carried in one header. Fits GitHub, Shopify. */
      scheme: "hmac_sha256_header";
      headerName: string;
      encoding: "hex" | "base64";
      /** Optional literal prefix to strip before comparing, e.g. GitHub's "sha256=". */
      valuePrefix?: string;
      secretRef: string;
    }
  | {
      /** Non-standard vendor logic a generic HMAC scheme can't express —
       *  composite/timestamped headers (Stripe), signed-material-other-
       *  than-the-body (Twilio). See §11. */
      scheme: "provider_sdk";
      provider: "stripe" | "twilio" | "github" | "shopify";
      secretRef: string;
    }
  | {
      /** Verification requires an outbound call to the provider's own
       *  verify endpoint (PayPal-shaped). Has its own egress implication —
       *  see §13's note on `RuntimeConfig.allowedHosts`. */
      scheme: "remote_verify";
      provider: "paypal";
      verifyEndpointRef: string;
      credentialRef: string;
    }
  | {
      /** Signed JWT bearer in a header, verified against the issuer's
       *  public keys — GCP Pub/Sub push subscriptions use this shape
       *  (§10), not HMAC at all. */
      scheme: "oidc_jwt";
      headerName: string;
      expectedIssuer: string;
      expectedAudienceRef: string;
    };

export interface AsyncContract {
  /**
   * Absent for webhook-only APIs — some providers (§1's motivating case)
   * expose no poll endpoint at all, only a push. §9's resolver requires at
   * least one of `statusOperationId` or `webhook` to be present; requiring
   * a status operation unconditionally would make a genuinely webhook-only
   * API unrepresentable, which a prior draft of this section did.
   */
  statusOperationId?: string;
  jobIdField: string;
  /** Required only alongside `statusOperationId` — there's no param to fill when there's no poll call. */
  statusJobIdParam?: string;
  stateField?: string;
  terminalStates: string[];
  /** Now includes "awaiting_human_input" as a recognized value (§8). */
  pendingStates: string[];
  pollIntervalSeconds?: number;
  /** Optional. Absent = pure poll, byte-identical to today. */
  webhook?: WebhookContract;
}
```

`resolveAsyncContract` gains a matching issue for the case neither is present:

```ts
export type AsyncContractIssue =
  | /* existing values */
  | "no_completion_source"; // neither statusOperationId nor webhook is present
```

**What the generated status tool is when there's no `statusOperationId`:** not a
thinner version of the hybrid handler — a genuinely different tool. §6's
diagram assumes step 2 ("call upstream status operation") always has
somewhere to go; a webhook-only contract has no such endpoint to compile a
tool from at all. In that case the generated tool is **synthetic** —
`sourceRef`-less, never calling out, backed only by the ledger. Its only
two outcomes are "pending" (no ledger entry yet, or a non-terminal one) and
the cached webhook result. This is still a normal generated MCP tool from
the agent's side — same `asyncContractSentence()` wording, same polling
loop — but §14's hybrid handler collapses to its step 1 only when
`statusOperationId` is absent; there is no step 2 to fall back to, by
construction, not by omission.

Design rule carried over from the existing file's own doctrine: **half a
contract is worse than none.** A `webhook` block with no verifiable
signature scheme must be rejected by `resolveAsyncContract`, not silently
downgraded to poll-only. Matching issues:

```ts
export type AsyncContractIssue =
  | /* existing values unchanged */
  | "webhook_operation_missing"
  | "webhook_job_id_field_absent"
  | "webhook_signature_unverifiable"; // secretRef/verifyEndpointRef doesn't resolve
```

`resolveAsyncContract` gets one new branch: if `contract.webhook` is
present, resolve `webhookOperationId` against the operation map the same way
`statusOperationId` is resolved today, and run `pathProvablyAbsent` against
the webhook operation's *input* schema for `webhookJobIdField`.

**Archetype correction, carried from the prior revision:** a webhook-
receiving operation is tagged via `InteractionArchetype`
(`packages/air/src/enums.ts:249-256`) — not `SourceRef.kind`, which is the
source *spec format*, not an operation-shape tag. Add `"webhook_receiver"`
next to the existing `"long_running"` value:

```ts
export const InteractionArchetype = z.enum([
  "transaction", "search", "query_passthrough", "long_running", "bulk",
  "file_transfer",
  "webhook_receiver", // receiver-only, never a directly-callable MCP tool
]);
```

`packages/compiler/src/classify.ts` and `packages/generators/src/catalog.ts`
both need the rule this value exists to express: compiled and validated
like any operation, but excluded from the callable tool surface — wired
through `AsyncContract.webhook` and the receiver route (§14) only.

## 10. Compiler: parsing `callbacks:` / `webhooks:`

New file: `packages/compiler/src/protocols/webhooks.ts`, same per-protocol
module shape as `wsdl.ts` / `graphql.ts`. Scope for v1: OpenAPI 3.1
top-level `webhooks:` map only; per-operation `callbacks:` is a documented
follow-up, not a v1 blocker.

- Each `webhooks:` entry compiles to a normal `Operation`, archetyped
  `webhook_receiver`, through the same classification pipeline as any other
  operation (`classify.ts`).
- `normalize.ts` links a compiled `webhooks:` operation back to whichever
  `longRunning` operation names it when the spec's own `callbacks:`
  reference makes the link explicit — that's compile-time-derivable, not a
  guess. When the spec only has bare `webhooks:` with no explicit link, do
  **not** guess the association — leave `AsyncContract.webhook` unset and
  require a manifest patch (`packages/compiler/src/manifest.ts`), same
  asymmetric-trust posture as everywhere else in this doc, and **the same
  posture Stripe's own idempotency modeling already required** (§11):
  Stripe's real `Idempotency-Key` header convention isn't expressible in
  its OpenAPI spec either, and the existing manifest already supplies it by
  hand for exactly that reason.

## 11. Upstream systems, concretely: webhooks

Grounded against this repo's own backtest evidence (`docs/backtesting/*.md`)
wherever Anvil has already compiled the vendor's real spec; flagged **to
verify** where the claim is about webhook behavior specifically, which the
existing curated backtests didn't need to touch.

**Stripe — `provider_sdk`.** `docs/backtesting/stripe.md`: real spec is
`stripe/openapi`'s `spec3.json` (414 paths; 22 curated). Checked directly:
neither the curated ops list nor the manifest mentions `webhooks`/
`callbacks` — Stripe's spec doesn't declare its webhook events via the
OpenAPI keywords §10 targets, so the manifest-supplied link is the only
path, consistent with Stripe's `Idempotency-Key` needing the same treatment.
**To verify:** Stripe signs with a composite `Stripe-Signature` header
(`t=<timestamp>,v1=<hex hmac>` over `"{timestamp}.{raw_body}"`) plus a
timestamp-tolerance replay check — a bare raw-body HMAC scheme can't
express this, which is why `provider_sdk` exists as its own variant.

**GitHub — `hmac_sha256_header`.** `docs/backtesting/github.md`: real spec
from `github/rest-api-description` (790 paths; 25 curated). Whether the full
spec declares a top-level `webhooks:` map needs confirming against the
fetched file before Phase 1 (§16) — if true, GitHub is the cleanest
available auto-link test case. **To verify:** GitHub signs with
`X-Hub-Signature-256: sha256=<hex hmac>` — a plain raw-body HMAC-SHA256, no
timestamp, no composite encoding: `headerName: "X-Hub-Signature-256"`,
`encoding: "hex"`, `valuePrefix: "sha256="`.

**Twilio — `provider_sdk`.** `docs/backtesting/twilio.md`: full spec (197
operations) compiled in 1.7s, no crash — good scale evidence. **To
verify:** `X-Twilio-Signature` signs `HMAC-SHA1(auth_token, full_url +
sorted_POST_params)`, base64-encoded — different hash *and* different
signed material than GitHub. Confirms the union in §9 needs to stay
discriminated, not a single configurable HMAC shape.

**PayPal, Shopify — not yet in Anvil's corpus, named because they justify
§9's remaining variants.** Shopify (`X-Shopify-Hmac-Sha256`, base64
HMAC-SHA256 of raw body) is a second confirming `hmac_sha256_header` case.
PayPal verifies via a certificate chain or, more commonly, by calling its
own `/v1/notifications/verify-webhook-signature` — the `remote_verify`
scheme, the one with an outbound-call/`allowedHosts` implication (§13).

**What this section does not cover.** `findings-log.md`'s largest real
estate (FLEXCUBE: 29 services, 144 operations; OBDX) is banking, not
consumer/platform SaaS. Nothing in `docs/backtesting/banking.md`,
`ENTERPRISE_SYSTEMS.md`, or `findings-log.md` mentions MQ, JMS, Kafka, ESB,
webhooks, or async completion behavior for either estate — a prior revision
of this document asserted FLEXCUBE/OBDX complete asynchronously via a
message queue "behind an ESB," and that claim was general banking-domain
inference, not evidence from this repo. It's corrected here: whether either
estate needs anything in this document is **unverified and worth checking
directly** (do any of their operations classify `longRunning`? what does
their spec say about it?) before treating either as a driver for this work.

## 12. Queue systems, concretely: the stateless-compatible slice

This is the section that changes once §2's principle is taken seriously.
"Connect to a message queue" sounds like it requires a new, stateful
runtime shape — a persistent consumer holding a broker connection open. For
most real queue providers, it doesn't, because most of them already expose
a plain HTTP surface Anvil's *existing* OpenAPI compiler already knows how
to handle — no new parser, no new runtime target, no new architecture.

- **AWS SQS** is natively pull-based over plain REST/JSON
  (`ReceiveMessage`, `SendMessage`, `DeleteMessage`) — no persistent
  connection at all. A `peek_next_dlq_message` tool is just a `ReceiveMessage`
  read operation; `publish_to_reprocess_queue` is a `SendMessage` mutation.
  SQS **FIFO** queues carry a native `MessageDeduplicationId` parameter,
  which maps directly onto AIR's existing `key_supported` idempotency mode
  — the provider's own dedup mechanism becomes Anvil's idempotency carrier
  for that queue type specifically (§13 corrects an earlier overgeneralization
  of this to standard SQS and to other providers).
  **Auth caveat, not yet closed:** direct SQS calls require AWS Signature
  Version 4 request signing, and AIR's `AuthType` union
  (`packages/air/src/enums.ts:171-182`) and `packages/runtime/src/auth.ts`
  have no SigV4 scheme today — compiling SQS's REST shape alone doesn't
  produce an invokable tool, the generated runtime would send an unsigned
  request and AWS would reject it. Either SigV4 needs to become real
  `AuthType`/runtime work (its own scoped addition, not assumed free here),
  or this integration path is restricted to SQS reachable through an
  already-authenticated HTTP gateway (e.g., API Gateway in front of the
  queue) rather than calling AWS's own endpoint directly.
- **GCP Pub/Sub** supports both directions cleanly:
  - *Pull* (`projects.subscriptions.pull`) is the same stateless-HTTP shape
    as SQS.
  - *Push* delivers a message as an HTTP POST to a configured endpoint —
    which is architecturally identical to §7's webhook receiver. The only
    new piece is the verification scheme: Pub/Sub push requests carry a
    signed JWT bearer token (not HMAC), which is exactly §9's new
    `oidc_jwt` variant. A queue-push subscription is a webhook with a
    different signature scheme, not a new component.
- **Kafka** has no native HTTP pull API, but production deployments that
  need one almost always front it with something that provides one —
  Confluent's REST Proxy or an equivalent Kafka HTTP bridge — which is
  itself an OpenAPI-shaped service Anvil's compiler already handles like
  any other REST API. Compiling *that* is in scope at zero new
  architecture cost; compiling raw Kafka's native wire protocol is not
  (§4's non-goal).
- **RabbitMQ**'s HTTP Management API exposes a `get` (pull) endpoint for
  small-scale polling — real, if not what RabbitMQ recommends for
  high-throughput production use — and is the same stateless-HTTP shape as
  the above.

**The practical consequence:** for every provider in this list, "queue
integration" is not a new Anvil capability — it's *compiling that
provider's REST API the same way Anvil already compiles Stripe or GitHub*,
plus (for push-style delivery) reusing §7's receiver with one more
signature scheme. The genuinely new, harder, deferred case is exactly the
one named in §4: a broker with no HTTP front at all, where the only way in
is a persistent native-protocol consumer. That's real, it's the
`PRODUCT_BOUNDARY.md` §2 "Tomorrow" line for Kafka schemas / AsyncAPI, and
it deserves its own design — this document deliberately doesn't force it
into the ledger mechanism, because a live broker connection can't be made
stateless by definition.

## 13. DLQ triage, done right

A pattern reviewed during this design's development proposed a
bidirectional "read-repair-write" agent loop over a dead-letter queue: pull
a failed message, have an agent investigate and fix it, push the correction
to a reprocess queue. The instinct to split into a narrow reader tool and a
schema-validated writer tool was sound. What it was missing is everything
§2–§9 already built for a different reason:

- **No idempotency story — and this doesn't hold for every provider
  equally.** If the write to the reprocess queue is retried, does the
  correction get applied twice? §12's dedup-id point answers this fully
  only for **SQS FIFO** queues, whose `MessageDeduplicationId` is a real,
  caller-supplied carrier. It does not generalize to the rest of the
  class: standard (non-FIFO) SQS has no equivalent, and GCP Pub/Sub's
  publish API exposes no caller-supplied deduplication key at all — a
  retried publish to either can duplicate the correction. So the honest
  classification is per-provider, not per-category: an SQS-FIFO
  `publish_to_reprocess_queue` can be classified `key_supported` on real
  evidence; a standard-SQS or Pub/Sub equivalent must stay
  `unproven`/`review_required` until the integration supplies its own
  durable dedup policy (e.g., an idempotency key embedded in the message
  body and checked downstream) — the same conservative default AIR already
  applies to any mutation with no proven carrier.
- **No confirmation tier for consequential corrections.** A schema-valid
  loan-application correction or a billing-discrepancy fix is exactly the
  shape `confirmation.humanApproval` exists for. Compiled through Anvil,
  that mutation gets a real risk classification and — via §8's mechanism —
  a real, cheap channel to require a human's sign-off before it's
  resubmitted, instead of relying on the agent's own judgment as the only
  safety layer.
- **The "investigate and repair" step stays out of Anvil's scope, on
  purpose.** `docs/PRODUCT_BOUNDARY.md`: *"Anvil compiles AIR; it is not a
  platform."* Anvil's job stops at compiling `peek_next_dlq_message` and
  `publish_to_reprocess_queue` into safety-classified operations — deciding
  *what correction to apply* is agent/application logic built on top, the
  same boundary that already holds for "when should this Stripe refund
  fire." Anvil earning trust here means the generated write tool refuses an
  unproven-idempotent or ungated-risk correction by construction, the same
  way it already refuses a required-idempotency mutation with no key today
  — not that Anvil writes the repair logic itself.

No new file-level work beyond §10/§12's compiler and §9's AIR shape — this
section is a worked example of applying both to a named use case, not a
fourth mechanism.

## 14. Runtime: the receiver and the hybrid status handler

**Receiver** — `packages/runtime/src/webhook-receiver.ts` (new), serves
both third-party webhooks (§11) and queue-push deliveries (§12 — same
route shape, `oidc_jwt` verification instead of HMAC):

```ts
export async function handleWebhook(params: {
  operation: Operation;          // the compiled webhook operation
  contract: WebhookContract;
  rawBody: Buffer;
  headers: Record<string, string>;
  ledger: IdempotencyLedger;     // the SAME ledger instance the executor uses
}): Promise<{ status: 200 | 401 | 400 }>
```

1. Verify signature per `contract.signatureVerification` — reject (`401`)
   before touching the ledger or parsing further. No scheme skips this.
2. Parse `rawBody` against the webhook operation's input schema; extract
   `webhookJobIdField` and (if present) `webhookStateField`.
3. **Resolve the upstream job id to a ledger row before completing
   anything.** An earlier draft of this section assumed the ledger could be
   completed directly by the extracted job id — it can't. The ledger
   (`packages/runtime/src/idempotency.ts:137+`) is addressed by the
   *caller's* idempotency key (supplied, or fingerprint-derived from
   operation id + input), which is a different value space than the
   *upstream's* job id in the general case. Calling `complete(job_id, ...)`
   against a ledger keyed by idempotency key either misses or, worse,
   collides with an unrelated reservation. The submit-side fix: when the
   submit operation's handler reserves its ledger row, it now also writes a
   small **job-handle index** entry — `jobId -> idempotencyKey` — at the
   same time, since `jobIdField` is read from that same response. The
   receiver's first step is `idempotencyKey = jobIndex.lookup(jobId)`; only
   then does it call `ledger.complete(idempotencyKey, ...)`. This index is
   new surface on `IdempotencyLedger` (or a small sibling store next to
   it) — not something the existing `reserve`/`complete` pair provides for
   free, however natural that sounded.
4. Write the resolved completion into `ledger` via the existing
   `reserve`/complete shape — a webhook or queue-push delivery is the same
   "write once, replay on duplicate" operation the ledger already models
   for retries, so provider-retried *delivery* dedup (the same webhook POST
   arriving twice) still falls out for free once step 3 has found the right
   row. What doesn't come free is finding that row in the first place — that's
   exactly what step 3 adds.
5. Always return `200` once durably written (or on duplicate delivery) —
   never let a downstream failure cause the provider to keep retrying a
   delivery that's already recorded.

**Job-answer handler** — `packages/runtime/src/job-answer.ts` (new, §8):
authenticates the caller against the operation's `AuthRequirement`,
validates the decision shape, writes into the same ledger row via the same
`reserve`/complete shape. Structurally identical to the webhook receiver,
just triggered by a CLI/MCP call instead of an inbound POST.

**Hybrid status handler** — the generated MCP tool for `statusOperationId`
(`packages/generators/src/mcp.ts`, served by `packages/mcp-runtime/src/server.ts`)
changes from "call upstream" to "check ledger, else call upstream," per §6.
Handler-generation change only — the tool's declared input/output schema is
untouched.

## 15. Safety gating (asymmetric trust — do not skip this)

Per `reference/safety-invariants.md`: *loosening* is the direction that
demands the strongest evidence bar, regardless of mechanism. Every new
writer into the ledger in this document is new trust surface:

- `resolveAsyncContract` refuses a `webhook` block whose verification
  reference doesn't resolve to a real, configured credential/endpoint —
  same posture as `status_operation_not_approved` today.
- In `packages/refinement/src/approval.ts`, `asyncContract.webhook` and any
  `job answer` authorization patch join the same patch-key list the
  idempotency carrier fields already sit on — `review`-gated,
  unconditionally, never `auto`.
- The generated receiver is **fail-closed by construction**: no
  `signatureVerification` present ⇒ the compiler cannot produce a route for
  that operation at all. Mirrors `RuntimeConfig.allowedHosts`
  empty-means-deny-all (`config.ts:16`).
- `remote_verify` (PayPal-shaped) makes an *outbound* call during inbound
  verification — that destination must itself be on
  `RuntimeConfig.allowedHosts`, or verification fails closed like any other
  egress to an unlisted host.
- §12's queue-publish operations get no special exemption from idempotency/
  confirmation classification just because the "provider" is a queue
  instead of a REST API — §13's whole point is that they don't need one.
- §8's `anvil job answer` needs its own `AuthRequirement`, checked per call
  — "who may answer this specific job's question" is policy the operation
  declares, not an assumption that whoever can reach the CLI is authorized.

## 16. Certification

New check in `packages/certification/src/checks.ts`, extending the pattern
`packages/certification/src/async-certification.test.ts` already
establishes: a bundle fails certification if any operation's
`AsyncContract.webhook` is present but its verification credential/endpoint
isn't satisfiable from the deploy target's configuration, or if a
`webhook_receiver`-archetyped operation has no corresponding route wiring —
catching a spec/deploy mismatch statically, before the receiver ever gets an
unverifiable request in production.

## 17. File-level task breakdown

| Package | File | Change |
|---|---|---|
| `@anvil/air` | `src/enums.ts` | Add `"webhook_receiver"` to `InteractionArchetype` |
| `@anvil/air` | `src/async-contract.ts` | `WebhookContract`, four-variant `WebhookSignatureVerification`, optional `statusOperationId`/`statusJobIdParam` with a `no_completion_source` issue when neither a status op nor a webhook is present, `awaiting_human_input` as a recognized `pendingState`, webhook branch in `resolveAsyncContract` |
| `@anvil/air` | `src/async-contract.test.ts` | New cases per scheme, the human-approval pending state, and the webhook-only (`statusOperationId` absent) path |
| `@anvil/compiler` | `src/protocols/webhooks.ts` (new) | Parse OpenAPI `webhooks:`, compile to `Operation` archetyped `webhook_receiver` |
| `@anvil/compiler` | `src/classify.ts` | `webhook_receiver` ops classify but never enter the callable surface |
| `@anvil/compiler` | `src/normalize.ts` | Link `callbacks:`-referenced webhook ops into the owning operation's `AsyncContract.webhook` |
| `@anvil/compiler` | `src/manifest.ts` | Manifest patch shape for manual webhook linking (Stripe/Twilio-shaped specs) |
| `@anvil/runtime` | `src/idempotency.ts` | New job-handle index (`jobId -> idempotencyKey`), written at reservation time by any submit operation with a `jobIdField`, read by the webhook receiver before calling `complete` (§14 fix) |
| `@anvil/runtime` | `src/webhook-receiver.ts` (new) | Signature verify (per-scheme dispatch, incl. `oidc_jwt` for queue push) → parse → job-index lookup → ledger write |
| `@anvil/runtime` | `src/job-answer.ts` (new) | §8's authenticated answer-write path — calls the upstream decision operation, does not resume any paused execution |
| `@anvil/runtime` | `src/auth.ts` | SigV4 request-signing scheme, if direct-SQS access (§12) is pursued rather than scoping SQS to an authenticated gateway |
| `@anvil/air` | `src/enums.ts` | New `AuthType` value for SigV4, same conditional as above |
| `@anvil/generators` | `src/catalog.ts` | Exclude `webhook_receiver`-archetyped operations from the callable surface |
| `@anvil/generators` | `src/mcp.ts` | Hybrid status handler: ledger-check-then-upstream when `statusOperationId` is present; synthetic ledger-only handler when it's absent (§9). Generate `job answer` tool for operations with a real upstream decision endpoint. |
| `@anvil/generators` | `src/deploy.ts` | New `/webhooks/<service>/<opId>` route on the generated Cloud Run entrypoint |
| `@anvil/mcp-runtime` | `src/server.ts` | Serve the hybrid/synthetic handler and job-answer tool; webhook ops never appear in `tools/list` |
| `@anvil/refinement` | `src/approval.ts` | `webhook`- and job-answer-authorization-touching patches always `review` |
| `@anvil/certification` | `src/checks.ts` | Static checks: signature scheme resolvable at deploy target (incl. `remote_verify`'s `allowedHosts` requirement), and no `AsyncContract` with neither a status operation nor a webhook |
| `@anvil/cli` | `src/commands/inspect.ts` | Surface `asyncContract.webhook`/pending-state issues in `anvil inspect` |
| `@anvil/cli` | `src/commands/job.ts` (new) | `anvil job answer <id>` |

## 18. Phased plan

1. **Phase 0 — AIR shape.** §9, plus `awaiting_human_input` as a recognized
   `pendingState` and `InteractionArchetype`'s new value. No compiler, no
   runtime. Reviewable in isolation.
2. **Phase 1 — Webhook compiler parsing.** §10. First step: confirm against
   a real fetched spec whether GitHub's `rest-api-description` declares a
   top-level `webhooks:` map (§11) — the best candidate for the auto-link
   path; Stripe/Twilio are confirmed manifest-only regardless.
3. **Phase 2 — Runtime receiver + job-answer handler.** §14, both new
   files, plus the job-handle index in `idempotency.ts` the receiver
   depends on to resolve a job id to a ledger row — land the index first,
   it has no dependency on the receiver and is unit-testable alone. Both
   handlers are otherwise pure functions of (payload/decision, contract,
   ledger) → ledger call.
4. **Phase 3 — Generated routes + hybrid status handler + `anvil job
   answer`.** §14's generator/server/CLI changes, wired end-to-end.
5. **Phase 4 — Safety gating + certification.** §15, §16. Do not ship
   Phase 3 to any real deployment before this lands.
6. **Phase 5 — Queue systems.** §12. Compile one pull-based provider (SQS
   or Pub/Sub pull) as a proof that "queue integration" really is "compile
   its REST API" with zero new architecture; then wire Pub/Sub push through
   the existing receiver with the new `oidc_jwt` scheme.
7. **Phase 6 — Docs/skill generation + `anvil inspect`.** Agent-facing
   sentence stays `asyncContractSentence()`'s existing wording throughout
   Phases 0–5 — confirm no change is needed (§6's whole point is that it
   shouldn't be), and add operator visibility.

Each phase lands as its own PR with its own drift-guard tests where it
touches generated output — this codebase's existing convention for catching
the "skill/CLI/MCP drifted apart" failure mode described at the top of
`CLAUDE.md`.

## 19. Open questions

- **Verify GitHub's full spec structure directly** (§11, §18 Phase 1) —
  currently general knowledge of `github/rest-api-description`, not checked
  against a fetched artifact in this repo.
- **Verify whether FLEXCUBE/OBDX need any of this at all** (§11's closing
  note) — no evidence either way currently exists in this repo; don't
  prioritize enterprise-estate motivation for this work until checked.
- Per-operation `callbacks:` (vs. top-level `webhooks:`) — same underlying
  shape, more irregular structure. Second pass once top-level `webhooks:`
  is proven.
- Multiple webhook/queue deliveries with *different* terminal states for
  the same job — the ledger write needs a last-write-wins-if-more-terminal
  rule, not naive overwrite; decide before Phase 2 lands, not during.
- Local dev / `anvil run` story for a webhook-carrying operation with no
  public HTTPS endpoint (tunnel requirement) — worth a short follow-up note
  in the CLI's `run.ts` docs once Phase 3 exists.
- **Raw broker consumption** (native Kafka/JMS/AMQP, no HTTP front) — real,
  named in `PRODUCT_BOUNDARY.md` as a "Tomorrow" parser/target, and
  deliberately not designed here (§4, §12's closing paragraph) because it's
  the one case that can't be made stateless. Its own document, if pursued.
- **Decide SigV4 vs. gateway-scoping for SQS before Phase 5** (§12) — either
  becomes real `AuthType`/runtime work (new file-level tasks, §17) or the
  SQS integration path gets explicitly restricted to an already-authenticated
  HTTP gateway in front of the queue. Picking neither leaves §12's SQS claim
  unimplementable as written; this needs a decision, not a default.
- **Design the job-handle index's exact shape** (§14) — this document
  specifies the requirement (`jobId -> idempotencyKey`, written at
  reservation time, read before `complete`) but not the storage shape
  (a field on the existing ledger entry vs. a separate keyed store, TTL
  alignment with the ledger's own `DEFAULT_LEDGER_RESULT_TTL_SECONDS`).
  Resolve before Phase 2's `idempotency.ts` work starts.
- **A daemon as an optimization, not a foundation** (§8's closing
  paragraph) — if low-latency human-notification or connection/session
  amortization become real requirements, a thin process that watches the
  ledger and pushes notifications is a legitimate follow-on. It would sit
  on top of this design, not replace it, and isn't scoped here.
