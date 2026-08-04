# Async completion, unified — webhooks as a second way to answer a poll

Status: design (researched 2026-08-03, updated 2026-08-04 with corpus-grounded
upstream deep dives and a stakeholder-benefits analysis; primary sources cited
inline). Nothing here is implemented; the staged plan is at the end. Written
to be handed to an implementing agent directly — every section names the real
files it touches, and every vendor claim is checked against this repo's own
backtest evidence rather than asserted from general knowledge.

## 1. Why

Anvil already has one working async primitive: `packages/air/src/async-contract.ts`.
An operation that returns before its work finishes carries an `AsyncContract`
— which operation to poll, where the job handle lives, which states mean
stop. `resolveAsyncContract` validates it; `asyncContractSentence` renders it
for the agent. It works, and the agent-facing shape of it is exactly right:
one tool, a handle, a poll loop, a stopping condition.

What's missing is *only* this: some APIs don't make you poll — they push a
webhook when the job finishes (Stripe, GitHub deployments, most payment and
CI providers). Today Anvil has no ingestion path for that at all — confirmed
by grep, zero hits for `callbacks`/`webhooks` anywhere under
`packages/compiler/src`. An operation compiled from such a spec either loses
the completion signal entirely or gets miscompiled as pure-poll against an
API that never intended polling.

The fix is **not** a second, parallel primitive that teaches agents a new
concept ("webhooks exist, here's how to register one"). It's making the
*existing* poll contract resilient to two different backends. The agent
still calls the same status tool, reads the same `stateField`, watches for
the same `terminalStates`. Underneath, the generated status handler checks
one more place before it calls upstream: a durable ledger that a webhook
receiver may have already written to. If the webhook beat the poll, the
answer comes back instantly. If not, it polls exactly as it does today.
The agent never learns the difference exists — which is the actual "no
old-world API baggage" deliverable: the baggage disappears into the runtime
that already carries the idempotency ledger for an unrelated reason.

**This isn't a novel move for Anvil — it's the same doctrine that already
shipped once, for a different per-vendor dialect problem.** `findings-log.md`'s
public-corpus gauntlet record: pagination inference started at 0 of 938
search operations despite trivially name-inferable params, and conservative,
evidenced, per-vendor name matching (`classifyPagination`) lifted that to
572/938 (60%) — Stripe's `starting_after`→cursor matched 89% of the time,
Twilio's `PageToken`→cursor 96%, Jira's `startAt`→offset, GitHub's `page`→page.
The lesson that transfers directly here: providers don't share one wire
convention, a compiler that assumes they do silently fails most of them, and
the fix is *conservative per-provider inference with a named fallback*, never
a guess presented as certainty. §10 below applies exactly this doctrine to
webhook signature schemes, which vary by provider even more than pagination
params do.

## 2. Non-goals (say these out loud before starting)

- **Not a hosted event-gateway product.** No general routing, fan-out, or
  multi-tenant ingestion service (contrast: Hookdeck). One receiver route
  per deployed Cloud Run service, scoped to that service's own operations.
- **Not MCP elicitation/sampling.** Confirmation stays the explicit `confirm`
  param (`packages/mcp-runtime/src/server.ts:141-191`) because it has to
  project identically onto the CLI today — and today's generated CLI
  (`packages/cli/src/tool-cli.ts`) is a one-shot process (spawn, run one
  command, exit), with no session to hold a mid-call question open. That's
  a property of *the CLI Anvil currently generates*, not a law of nature: a
  daemon-backed CLI (a persistent process a thin CLI talks to over a local
  socket, the same shape `anvil serve mcp` already uses for the MCP surface
  — `packages/cli/src/commands/serve.ts:28-65`) could hold a job open across
  invocations and let elicitation-shaped human input land through any
  attached surface. That is real, but it is a separate, larger design
  (job/session model, process lifecycle, socket protocol) and explicitly
  out of scope here — tracked as an open question in §16, not designed in
  this document.
- **Not resource subscriptions.** `packages/generators/src/resources.ts`
  resources are static per build; nothing here changes that.
- **Not a new trust tier.** A webhook is an inbound, unauthenticated-until-
  verified network write from the open internet. It gets the *same*
  asymmetric-trust treatment as every other capability that can loosen
  something (§12) — signature verification is mandatory, not a v2 nicety.
- **Not a general enterprise-integration story.** See §10's closing note —
  this design targets webhook-shaped completion (public HTTPS, signed POST),
  which is a consumer/platform-SaaS pattern. It is explicitly not a design
  for the message-queue/ESB-fronted completion shape Anvil's actual
  largest-scale real estates (FLEXCUBE, OBDX) use instead.

## 3. Benefits, concretely — who this is for

Three different audiences get different payoffs from the same mechanism.
Naming them up front so the phases in §15 can be prioritized against a real
audience rather than "webhooks are good practice."

**The agent calling the tools.**
- One mental model regardless of backend: it calls a tool, gets a handle,
  polls or gets blocked — never learns whether completion arrived via
  upstream poll or a webhook that beat it there. Same tool, same
  `stateField`, same `terminalStates` every time; `asyncContractSentence()`
  doesn't change one word (§4).
- Fewer wasted turns: a webhook-backed op that resolves before the first
  poll returns instantly instead of costing several poll round-trips.
- A resumable stopping point instead of a dead end when a job is gated on
  something the agent can't affect — it gets a handle to resume against,
  not a conversation it has to restart.

**The human operating Anvil.**
- `confirmation.humanApproval` (`packages/air/src/schema.ts:432,994`) stops
  being purely advisory. Today it only ever renders into generated docs as a
  warning string (`packages/generators/src/skill.ts:428`,
  `packages/generators/src/plugins.ts:220-228`); the actual enforcement is
  external, e.g. a harness's `PreToolUse` hook escalating to `ask`
  (`docs/design/hooks-and-plugins.md`). This design's ledger — durably
  recording who/what completed a job and when — is the same substrate a
  future daemon (§2, §16) would use to give `humanApproval` a real channel,
  without inventing a second durability story.
- Detach/reattach on long-running work: a job survives a closed laptop or a
  dropped SSH session because completion state lives in the ledger, not in
  a blocked local process.
- An audit trail as a byproduct, not a separate feature: webhook completions
  land in the same idempotency ledger Anvil already ships
  (`packages/runtime/src/idempotency.ts`), so "what completed this job, and
  when" falls out of the mechanism itself.

**The developer building on Anvil's output.**
- CLI and MCP behave identically for completion — no per-surface special
  casing in their own harness, because both read the same ledger-backed
  status handler (§4, §9).
- One integration point instead of N bespoke webhook receivers: wrapping
  five vendor APIs through Anvil means one receiver pattern and one ledger,
  not five hand-rolled dedup strategies, because Anvil classified each
  spec's completion shape at compile time (§9).
- A build-time guarantee instead of a runtime surprise: certification (§13)
  can fail a bundle whose webhook signature scheme doesn't resolve against
  the deploy target's credentials before it ever ships.

## 4. The unified agent model

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

The agent never sees what changes below. Two backends can answer the same
`status tool` call:

```
                    WHAT THE STATUS TOOL DOES NOW (new)
                    ────────────────────────────────────

  agent calls status_op(job_id)
            │
            ▼
  ┌─────────────────────────┐   found, completed   ┌────────────────────┐
  │ 1. check ledger for      │──────────────────────▶│ return cached      │
  │    job_id                │                        │ result immediately │
  └───────────┬──────────────┘                        └────────────────────┘
              │ not found / still in_progress
              ▼
  ┌─────────────────────────┐
  │ 2. call upstream status  │   (today's only path — unchanged)
  │    operation, as today   │
  └─────────────────────────┘
```

A webhook, when the spec has one, is just a second writer into the same
ledger row the poll path already reads on retry.

## 5. Component architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                      Third-party API (Stripe, GitHub, …)                │
└───────────────┬───────────────────────────────────┬─────────────────────┘
                 │ webhook POST                      │ (agent polls this
                 │ (signed)                          │  directly, unchanged)
                 ▼                                    │
   ┌───────────────────────────────┐                 │
   │  Deployed Cloud Run service     │                 │
   │  (@anvil/generators output)     │                 │
   │                                  │                 │
   │  /webhooks/<service>/<opId>     │                 │
   │  ┌────────────────────────┐    │                 │
   │  │ 1. verify signature     │    │                 │
   │  │    (per-provider, §10)  │    │                 │
   │  ├────────────────────────┤    │                 │
   │  │ 2. extract job id        │    │                 │
   │  │    (WebhookContract)     │    │                 │
   │  ├────────────────────────┤    │                 │
   │  │ 3. ledger.reserve+       │    │                 │
   │  │    complete(job_id,      │    │                 │
   │  │    payload)  ───────────┼────┼─────┐           │
   │  └────────────────────────┘    │      │           │
   │                                  │      ▼           │
   │  ┌────────────────────────┐    │  ┌─────────────────────────┐
   │  │ MCP tool: status_op      │◀───┼──│ IdempotencyLedger        │
   │  │ (generated handler,      │    │  │ (Firestore — same one    │
   │  │  §4 hybrid check)         │    │  │  idempotency.ts already  │
   │  └────────────┬─────────────┘    │  │  ships)                  │
   └───────────────┼──────────────────┘  └─────────────────────────┘
                    │
                    ▼
              MCP client (agent)
```

Nothing here is a new hosting model. `/webhooks/<service>/<opId>` is one more
route on the same Cloud Run request/response service `packages/generators/src/deploy.ts`
already targets — it is not a long-lived listener, and it inherits the same
bounded-timeout discipline already enforced there (`GENERATED_CLOUD_RUN_TIMEOUT_SECONDS`,
`deploy.ts:34`). The ledger is `packages/runtime/src/idempotency.ts`'s
`IdempotencyLedger`, already durable, already keyed, already TTL'd
(`DEFAULT_LEDGER_RESULT_TTL_SECONDS`, `config.ts:35`) — reused, not
reinvented.

## 6. Sequence: webhook wins the race

```
agent          submit_op        third-party API      webhook receiver     ledger      status_op
  │────submit─────▶│                    │                     │              │            │
  │                │───trigger action──▶│                     │              │            │
  │◀──job_id───────│                    │                     │              │            │
  │                                     │──── webhook(job_id, result) ──────▶│              │
  │                                     │                     │───complete──▶│              │
  │                                                                                          │
  │──────────────────────── poll status_op(job_id) ───────────────────────────────────────▶│
  │                                                                     ledger hit ──────────│
  │◀─────────────────────────────── terminal state, instantly ───────────────────────────────│
```

## 7. Sequence: webhook never arrives (or spec has no webhook) — unchanged today

```
agent          submit_op                                                              status_op    upstream
  │────submit─────▶│                                                                       │            │
  │◀──job_id───────│                                                                       │            │
  │──────────────────────── poll status_op(job_id) ────────────────────────────────────────▶│            │
  │                                                                        ledger miss ──────│──poll────▶│
  │◀───────────────────────────────── pending, poll again later ───────────────────────────│◀───pending─│
  │  (repeat until upstream reports a terminal state — exactly today's behavior)             │            │
```

## 8. AIR shape

Extend `packages/air/src/async-contract.ts` rather than inventing a sibling
file — completion is one concept with two possible sources, not two
concepts.

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
 * Three real shapes, not one — grounded in §10's vendor deep dive, not
 * invented generically. A single "hmac over the raw body" scheme would
 * silently misclassify two of the three vendors Anvil has already
 * backtested against real specs.
 */
export type WebhookSignatureVerification =
  | {
      /** Raw-body HMAC, digest carried in one header. Fits GitHub, Shopify. */
      scheme: "hmac_sha256_header";
      headerName: string;
      /** How the header value is encoded, since providers disagree. */
      encoding: "hex" | "base64";
      /** Optional literal prefix to strip before comparing, e.g. GitHub's "sha256=". */
      valuePrefix?: string;
      secretRef: string;
    }
  | {
      /**
       * Non-standard, vendor-specific verification logic that a generic HMAC
       * scheme can't express — composite/timestamped headers (Stripe),
       * signed-material-other-than-the-body (Twilio). See §10.
       */
      scheme: "provider_sdk";
      provider: "stripe" | "twilio" | "github" | "shopify";
      secretRef: string;
    }
  | {
      /**
       * Verification requires an outbound call to the provider's own verify
       * endpoint (PayPal-shaped) rather than a local computation. This is the
       * one scheme with its own egress implication — see §12's note on
       * `RuntimeConfig.allowedHosts`.
       */
      scheme: "remote_verify";
      provider: "paypal";
      verifyEndpointRef: string;
      credentialRef: string;
    };

export interface AsyncContract {
  statusOperationId: string;
  jobIdField: string;
  statusJobIdParam: string;
  stateField?: string;
  terminalStates: string[];
  pendingStates: string[];
  pollIntervalSeconds?: number;
  /** New, optional. Absent = pure poll, byte-identical to today. */
  webhook?: WebhookContract;
}
```

Design rule carried over from the existing file's own doctrine (see its
header comment): **half a contract is worse than none.** A `webhook` block
with no verifiable signature scheme must be rejected by
`resolveAsyncContract`, not silently downgraded to poll-only — a contract
that *looks* wired but silently never fires is the exact failure mode
`resolveAsyncContract` already exists to prevent for the poll case
(`job_id_field_absent`, `overlapping_states`, etc.). Add matching issues:

```ts
export type AsyncContractIssue =
  | /* existing values unchanged */
  | "webhook_operation_missing"
  | "webhook_job_id_field_absent"
  | "webhook_signature_unverifiable"; // secretRef/verifyEndpointRef doesn't resolve
```

`resolveAsyncContract` gets one new branch: if `contract.webhook` is present,
resolve `webhookOperationId` against the operation map the same way
`statusOperationId` is resolved today (lines 133–162 of the current file),
and run `pathProvablyAbsent` against the webhook operation's *input* schema
for `webhookJobIdField` (mirroring the existing `job_id_field_absent` check
at line 179, just against the inbound payload schema instead of the
poll-status response schema).

**Correction from the first draft of this doc:** a webhook-receiving
operation is *not* tagged via `SourceRef.kind` (`packages/air/src/enums.ts:225-236`)
— that enum is the source *spec format* (`openapi`, `wsdl`, `graphql`, …),
not an operation-shape tag, and `"webhook"` isn't a valid spec format. The
correct extension point is `InteractionArchetype`
(`packages/air/src/enums.ts:249-256`), which already exists for exactly this
purpose — "the shape of how an agent interacts with an operation, orthogonal
to its effect/risk classification" — and already has a `long_running` value
sitting right next to where a new `webhook_receiver` value belongs:

```ts
export const InteractionArchetype = z.enum([
  "transaction",
  "search",
  "query_passthrough",
  "long_running",
  "bulk",
  "file_transfer",
  "webhook_receiver", // new: receiver-only, never a directly-callable MCP tool
]);
```

`packages/compiler/src/classify.ts` and `packages/generators/src/catalog.ts`
both need the one-line rule this value exists to express: an operation
archetyped `webhook_receiver` is compiled, classified, and validated like any
other operation, but never emitted into `compiledOperations`'s callable
surface — it's wired through `AsyncContract.webhook` and the receiver route
(§11) only.

## 9. Compiler: parsing `callbacks:` / `webhooks:`

New file: `packages/compiler/src/protocols/webhooks.ts`, following the same
per-protocol module shape as `packages/compiler/src/protocols/wsdl.ts` /
`graphql.ts`. Scope for v1: OpenAPI 3.1 top-level `webhooks:` map only
(simpler and more common than per-operation `callbacks:` objects); leave
`callbacks:` as a documented follow-up rather than blocking v1 on the more
irregular shape.

- Each `webhooks:` entry compiles to a normal `Operation` (not a special
  type) — same `Effect`, `input`/`output` schema inference, same
  classification pipeline every other operation goes through
  (`packages/compiler/src/classify.ts`), archetyped `webhook_receiver`
  (§8's correction) so downstream stages know not to expose it as a
  directly-callable MCP tool. Its `effect.kind` is `"read"` in the sense
  that receiving a webhook performs no outbound action of its own — the
  mutation already happened upstream; this operation only *observes* it.
- `normalize.ts` links a compiled `webhooks:` operation back to whichever
  `longRunning` operation names it, populating `AsyncContract.webhook`
  automatically when the spec's own `callbacks:` reference makes the link
  explicit (OpenAPI's `callbacks` keyword literally exists to say "this
  operation's result arrives at this other URL shape" — when present, this
  is a compile-time-derivable link, not a guess). When the spec only has
  bare `webhooks:` with no explicit link to an operation, do **not** guess
  the association — leave `AsyncContract.webhook` unset and let a manifest
  patch (`packages/compiler/src/manifest.ts`) supply it explicitly, same
  asymmetric-trust posture as everywhere else in this doc, and **the same
  posture Stripe's own idempotency modeling already required** — see §10:
  Stripe's real `Idempotency-Key` header convention isn't expressible in its
  OpenAPI spec at all, and `docs/backtesting/reproduce/manifests/stripe.anvil.yaml`
  already supplies it by hand for exactly that reason. Webhook linking for a
  Stripe-shaped spec will need the identical manual-manifest treatment, not
  a compiler gap to fix later — it's spec-shape reality, evidenced twice now.

## 10. Upstream systems, concretely

This section grounds §8's three-variant `WebhookSignatureVerification` union
against real vendors, using this repo's own backtest evidence
(`docs/backtesting/*.md`) wherever Anvil has already compiled the vendor's
real spec — not general knowledge asserted from memory. Where a claim rests
on the vendor's *webhook* behavior specifically (which the existing curated
backtests didn't need to touch, since they cover CRUD subsets, not the
webhooks portion of these specs), that's flagged as **to verify** rather than
stated as fact — the same "half a contract is worse than none" discipline
§8 applies to the schema applies here to the design doc itself.

### Stripe — `provider_sdk`, provider `"stripe"`

- **Already in Anvil's corpus.** `docs/backtesting/stripe.md`: the real spec
  is `stripe/openapi`'s `spec3.json` (414 real paths; Anvil curated 22 —
  customers, charges, payment intents, refunds, invoices, subscriptions).
  Checked directly against `docs/backtesting/reproduce/curated/stripe-ops.txt`
  and `.../manifests/stripe.anvil.yaml`: neither mentions `webhooks` or
  `callbacks` — Stripe's `spec3.json` does not declare its webhook events
  via the OpenAPI `webhooks:`/`callbacks:` keywords Anvil's compiler (§9)
  targets. Stripe instead documents webhook event *types* and payload
  shapes separately from the request/response spec. This means §9's
  auto-link path won't fire for Stripe — the manifest-supplied fallback is
  the only path, and that's not a gap, it's consistent with the one other
  thing Anvil already learned about Stripe's spec: its real
  `Idempotency-Key` header convention is *also* not expressible in
  `spec3.json` and is *also* manifest-supplied
  (`stripe.md`: "not expressible in the OpenAPI spec itself"). Same vendor,
  same lesson, twice.
- **Webhook signature shape (to verify against Stripe's live docs before
  Phase 2, not yet checked against a fetched artifact in this repo):**
  Stripe signs with a composite `Stripe-Signature` header —
  `t=<timestamp>,v1=<hex hmac>` — computed as `HMAC-SHA256(secret,
  "{timestamp}.{raw_body}")`, and correct verification also enforces a
  timestamp tolerance window (Stripe's own libraries default to 5 minutes)
  to reject replayed deliveries. A bare `hmac_sha256_header` scheme (header
  → secret → compare) cannot express this: the signed material isn't the
  raw body alone, and there's a timestamp check with no field in §8's
  first variant to carry it. This is exactly why `provider_sdk` exists as
  its own variant rather than trying to generalize `hmac_sha256_header`
  with more optional fields — Stripe's scheme is qualitatively different,
  not just differently-named.
- **Job id correlation:** the object id returned by the original mutation
  (e.g. a Payment Intent's `id`, `pi_...`) is the same id present at
  `data.object.id` in the corresponding webhook event — clean 1:1 handle
  correlation once the manifest links the two operations.

### GitHub — `hmac_sha256_header`

- **Already in Anvil's corpus.** `docs/backtesting/github.md`: real spec
  from `github/rest-api-description` (790 real paths; 25 curated —
  issues, pull requests, reviews, repo contents, search). Same caveat as
  Stripe: the curated 25-operation subset doesn't touch the webhooks
  portion of the spec, so whether `github/rest-api-description`'s full
  `api.github.com.json` declares a top-level `webhooks:` map needs
  confirming against the actual fetched file before Phase 1 claims
  GitHub as a clean auto-link example — **do this check first**, since if
  true, GitHub is the best available real-world test case for §9's
  auto-link path (the other two vendors in this section are confirmed
  manifest-only).
- **Webhook signature shape:** GitHub signs webhook deliveries with
  `X-Hub-Signature-256: sha256=<hex hmac>` — a straightforward
  `HMAC-SHA256` over the *raw* request body, no timestamp, no composite
  encoding. This is the clean case §8's `hmac_sha256_header` variant was
  designed around: `headerName: "X-Hub-Signature-256"`,
  `encoding: "hex"`, `valuePrefix: "sha256="`.
- **Job id correlation:** e.g. a `deployment_status` event's
  `deployment.id`, or a `workflow_run` event's `workflow_run.id`, matching
  the id returned by the triggering `POST` call.

### Twilio — `provider_sdk`, provider `"twilio"`

- **Already in Anvil's corpus, at real scale.** `docs/backtesting/twilio.md`:
  the full spec (`twilio/twilio-oai`'s `twilio_api_v2010.json`, 121 paths,
  197 operations) compiled end-to-end in 1.7s with no hang or crash — good
  existing evidence the compiler already handles specs at the size a
  webhooks-parsing pass would need to scale to.
- **Webhook signature shape (to verify against Twilio's live docs before
  Phase 2):** Twilio signs with `X-Twilio-Signature`, but — unlike GitHub —
  the signed material is **not the raw body**. It's `HMAC-SHA1(auth_token,
  full_request_url + sorted_POST_params_concatenated)`, base64-encoded.
  Different hash (SHA1, not SHA256), different signed material (URL +
  params, not body bytes). This is the sharpest evidence in this section
  for why `WebhookSignatureVerification` must stay a real discriminated
  union rather than one configurable HMAC shape: three vendors already in
  Anvil's corpus use three incompatible schemes (composite+timestamp,
  raw-body HMAC-SHA256, URL+params HMAC-SHA1).

### PayPal, Shopify — the two variants not yet in Anvil's corpus

Named here because they justify §8's third scheme, not because Anvil has
backtested them:

- **Shopify** (`X-Shopify-Hmac-Sha256`, base64 HMAC-SHA256 of the raw body)
  is a second confirming example of the plain `hmac_sha256_header` shape —
  worth adding to the corpus gauntlet the next time a Phase 1 implementer
  wants a second clean case beyond GitHub.
- **PayPal** verifies webhooks either by validating a certificate chain
  (`PAYPAL-CERT-URL`, `PAYPAL-TRANSMISSION-SIG/ID/TIME` headers) or, more
  commonly in practice, by calling PayPal's own
  `/v1/notifications/verify-webhook-signature` API with the received
  headers and body. That's the `remote_verify` scheme in §8 — the receiver
  makes an *outbound* call to verify an *inbound* one, which is why §12
  flags it as the one scheme with its own egress/`allowedHosts` implication
  the other two don't have.

### What this section does *not* cover — enterprise/ESB-fronted completion

`findings-log.md`'s largest real-scale validation is the FLEXCUBE estate (29
Oracle Universal Banking REST services, 144 operations) and the OBDX estate
— both banking systems, both real, both bigger than any of the four vendors
above. Nothing in that record suggests either estate exposes public,
HMAC-signed HTTPS webhooks in the Stripe/GitHub/Twilio shape; enterprise
banking integrations of that kind typically complete asynchronously via a
message queue (JMS/Kafka) or file-based batch behind an ESB the caller
doesn't have direct HTTPS access to. This design's webhook receiver (§11)
assumes a public HTTPS endpoint the provider can POST to — which is true for
consumer/platform SaaS and not a safe assumption for FLEXCUBE-shaped
estates. If MQ/ESB-fronted completion becomes a priority, it's a genuinely
different ingestion shape (a consumer process, not an HTTP route) and
deserves its own design rather than being forced through §11's receiver.

## 11. Runtime: the receiver and the hybrid status handler

**Receiver** — `packages/runtime/src/webhook-receiver.ts` (new):

```ts
export async function handleWebhook(params: {
  operation: Operation;          // the compiled webhook operation
  contract: WebhookContract;
  rawBody: Buffer;
  headers: Record<string, string>;
  ledger: IdempotencyLedger;     // the SAME ledger instance the executor uses
}): Promise<{ status: 200 | 401 | 400 }>
```

1. Verify signature per `contract.signatureVerification` — reject
   (`401`) before touching the ledger or parsing the body further. This is
   the mandatory gate from §2; there is no scheme that skips it. Dispatch on
   `scheme` per §8/§10: `hmac_sha256_header` computes and compares locally;
   `provider_sdk` calls a small per-provider verifier (Stripe/Twilio/GitHub/
   Shopify each need their own, per §10's shape differences); `remote_verify`
   makes the provider's own verify call, subject to the egress note in §12.
2. Parse `rawBody` against the webhook operation's input schema (already
   validated to exist by `resolveAsyncContract`, §8); extract
   `webhookJobIdField` and (if present) `webhookStateField`.
3. Write into `ledger` via the existing `reserve`/complete shape
   (`packages/runtime/src/idempotency.ts:137+` — `IdempotencyLedger`
   already models `reserved` / `replay` / `in_progress` / `conflict`; a
   webhook completion is the same "write once, replay on duplicate delivery"
   operation the ledger was built for, so provider retried-webhook dedup
   falls out for free instead of needing bespoke dedup logic).
4. Always return `200` once durably written (or on duplicate delivery) —
   never let a downstream failure cause the provider to keep retrying a
   webhook that was already recorded.

**Hybrid status handler** — the generated MCP tool for `statusOperationId`
(built in `packages/generators/src/mcp.ts`, served by
`packages/mcp-runtime/src/server.ts`) changes from "call upstream" to
"check ledger, else call upstream," per the diagram in §4. This is a
handler-generation change, not a protocol change — the tool's declared
input/output schema is untouched.

## 12. Safety gating (asymmetric trust — do not skip this)

Per `reference/safety-invariants.md`'s rule: *loosening* is the direction
that demands the strongest evidence bar, regardless of mechanism. A webhook
completion is new trust surface — an unauthenticated party on the internet
can cause a `status_op` call to return "terminal: succeeded" the instant
Anvil accepts their POST. Concretely:

- `resolveAsyncContract` must refuse a `webhook` block whose
  `signatureVerification.secretRef` (or, for `remote_verify`,
  `verifyEndpointRef`/`credentialRef`) doesn't resolve to a real, configured
  credential — same posture as `status_operation_not_approved` today
  (§8's new issues).
- In `packages/refinement/src/approval.ts`, add `asyncContract.webhook` to
  the same patch-key list `idempotency carrier` fields already sit on
  (`safety-invariants.md`'s citation of `approval.ts` gating on *patch keys
  themselves*, not which skill produced them) — any proposal that adds or
  changes a `webhook` block returns `review`, unconditionally, never `auto`.
- The generated receiver must be **fail-closed by construction**: no
  `signatureVerification` present ⇒ the compiler cannot produce a route for
  that operation at all (not "runs unauthenticated," genuinely absent).
  Mirrors `RuntimeConfig.allowedHosts` empty-means-deny-all discipline
  (`config.ts:16`) — the webhook analog of "unconfigured is refused, not
  permissive."
- `remote_verify` (PayPal-shaped, §10) is the one scheme that makes an
  *outbound* call during inbound verification — that call's destination
  must itself be on `RuntimeConfig.allowedHosts`, or verification fails
  closed exactly like any other egress the executor already refuses to an
  unlisted host. This is a real, scheme-specific consequence worth stating
  explicitly rather than leaving implicit: the two local-computation schemes
  have no such requirement, `remote_verify` does.

## 13. Certification

New check in `packages/certification/src/checks.ts`, same shape as the
existing async-contract checks (`packages/certification/src/async-certification.test.ts`
already establishes the pattern to extend): a bundle fails certification if
any operation's `AsyncContract.webhook` is present but its verification
credential/endpoint reference isn't satisfiable from the deploy target's
configuration — catching a spec/deploy mismatch statically, before the
receiver ever gets an unverifiable request in production.

## 14. File-level task breakdown

| Package | File | Change |
|---|---|---|
| `@anvil/air` | `src/enums.ts` | Add `"webhook_receiver"` to `InteractionArchetype` (§8 correction) |
| `@anvil/air` | `src/async-contract.ts` | Add `WebhookContract`, three-variant `WebhookSignatureVerification`, new `AsyncContractIssue` values, webhook branch in `resolveAsyncContract` |
| `@anvil/air` | `src/async-contract.test.ts` | New cases: webhook resolves per scheme, each new issue triggers correctly |
| `@anvil/compiler` | `src/protocols/webhooks.ts` (new) | Parse OpenAPI `webhooks:`, compile to `Operation` archetyped `webhook_receiver` |
| `@anvil/compiler` | `src/classify.ts` | `webhook_receiver` operations classify but never enter the callable surface |
| `@anvil/compiler` | `src/normalize.ts` | Link `callbacks:`-referenced webhook ops into the owning operation's `AsyncContract.webhook` |
| `@anvil/compiler` | `src/manifest.ts` | Manifest patch shape for manually supplying a `webhook` block (required path for Stripe/Twilio-shaped specs per §10) |
| `@anvil/runtime` | `src/webhook-receiver.ts` (new) | Signature verify (per-scheme dispatch) → parse → ledger write |
| `@anvil/runtime` | `src/idempotency.ts` | No interface change; confirm `reserve`/complete shape covers webhook-sourced completion (likely already does) |
| `@anvil/generators` | `src/catalog.ts` | Exclude `webhook_receiver`-archetyped operations from `compiledOperations`'s callable surface |
| `@anvil/generators` | `src/mcp.ts` | Hybrid status handler: ledger-check-then-upstream |
| `@anvil/generators` | `src/deploy.ts` | New `/webhooks/<service>/<opId>` route wired into the generated Cloud Run entrypoint |
| `@anvil/mcp-runtime` | `src/server.ts` | Serve the hybrid handler; webhook ops never appear in `tools/list` |
| `@anvil/refinement` | `src/approval.ts` | `webhook`-touching patches always `review` |
| `@anvil/certification` | `src/checks.ts` | Static check: webhook signature scheme resolvable at deploy target, incl. `remote_verify`'s `allowedHosts` requirement |
| `@anvil/cli` | `src/commands/inspect.ts` | Surface `asyncContract.webhook` (or its absence/issue) in `anvil inspect` output |

## 15. Phased plan

1. **Phase 0 — AIR shape.** §8 only. Land `InteractionArchetype`'s new
   value, `WebhookContract` + resolver branch + tests. No compiler, no
   runtime. Reviewable in isolation because nothing downstream depends on
   it yet.
2. **Phase 1 — Compiler parsing.** §9. `webhooks:` → `Operation`, manifest
   patch path for manual linking. **First step: confirm against a real
   fetched spec (§10) whether GitHub's `rest-api-description` declares a
   top-level `webhooks:` map** — if so, it's the auto-link path's proving
   ground; Stripe and Twilio are confirmed manifest-only regardless.
   Certify that a webhook-carrying spec compiles without needing the
   runtime pieces yet (contract resolves, `webhook_operation_missing`/
   `webhook_job_id_field_absent` fire on bad input).
3. **Phase 2 — Runtime receiver.** §11's `handleWebhook`, ledger wiring,
   per-scheme signature verification (start with `hmac_sha256_header` —
   GitHub/Shopify-shaped, the simplest and best-evidenced — before tackling
   `provider_sdk`'s Stripe/Twilio-specific logic). Unit-testable without a
   deployed server (pure function of body/headers/contract → ledger call).
4. **Phase 3 — Generated route + hybrid handler.** §11's generator/server
   changes, wired end-to-end. This is where `deploy.ts`'s Cloud Run
   entrypoint actually gains the new route.
5. **Phase 4 — Safety gating + certification.** §12, §13. Do not ship
   Phase 3 to any real deployment before this lands — a receiver with no
   approval-gating and no certification check is exactly the "loosening
   with no equivalent gate" defect `safety-invariants.md` calls out as
   disqualifying.
6. **Phase 5 — Docs/skill generation + `anvil inspect`.** Agent-facing
   sentence stays `asyncContractSentence()`'s existing wording — confirm no
   change is needed there (the point of §4 is that it shouldn't be), and add
   `anvil inspect` visibility for operators.

Each phase should land as its own PR with its own drift-guard tests where it
touches generated output (`mcp.ts`, `deploy.ts`) — this codebase's existing
convention for catching exactly the "skill/CLI/MCP drifted apart" failure
mode described at the top of `CLAUDE.md`.

## 16. Open questions to resolve before Phase 1

- **Verify GitHub's full spec structure directly** (§10, §15 Phase 1) —
  this doc treats it as the best candidate for §9's auto-link path but that
  rests on general knowledge of `github/rest-api-description`, not a check
  against a fetched artifact in this repo. Confirm before relying on it.
- Per-operation `callbacks:` (vs. top-level `webhooks:`) — same underlying
  shape, more irregular OpenAPI structure. Worth a second pass once
  top-level `webhooks:` is proven, not blocking v1.
- Multiple webhook deliveries with *different* terminal states for the same
  job (e.g. a "processing" webhook followed by a "succeeded" one) — the
  ledger write in §11 step 3 needs a last-write-wins-if-more-terminal rule,
  not naive overwrite; needs a concrete decision before Phase 2 lands, not
  during.
- Local dev / `anvil run` story for a webhook-carrying operation with no
  public HTTPS endpoint (tunnel requirement) — out of scope for this doc,
  worth a short follow-up note in the CLI's `run.ts` docs once Phase 3 exists.
- **A daemon-backed CLI session (§2, §3)** would let `humanApproval` get a
  real solicitation channel (not just today's advisory doc string) using
  the same ledger substrate this design builds — `awaiting_human_input` as
  one more `pendingState`, answered by whichever surface is attached to the
  job. Genuinely related, deliberately not designed here: it needs its own
  design doc covering process lifecycle, session/job model, and socket
  protocol, none of which this document scopes.
