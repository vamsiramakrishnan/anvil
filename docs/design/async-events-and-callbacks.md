# Async completion, unified — webhooks as a second way to answer a poll

Status: design (researched 2026-08-03, primary sources cited inline). Nothing
here is implemented; the staged plan is at the end. Written to be handed to
an implementing agent directly — every section names the real files it
touches.

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

## 2. Non-goals (say these out loud before starting)

- **Not a hosted event-gateway product.** No general routing, fan-out, or
  multi-tenant ingestion service (contrast: Hookdeck). One receiver route
  per deployed Cloud Run service, scoped to that service's own operations.
- **Not MCP elicitation/sampling.** Confirmation stays the explicit `confirm`
  param (`packages/mcp-runtime/src/server.ts:141-191`) because it has to
  project identically onto the CLI, which cannot answer a mid-call prompt.
  Elicitation is out of scope here entirely.
- **Not resource subscriptions.** `packages/generators/src/resources.ts`
  resources are static per build; nothing here changes that.
- **Not a new trust tier.** A webhook is an inbound, unauthenticated-until-
  verified network write from the open internet. It gets the *same*
  asymmetric-trust treatment as every other capability that can loosen
  something (§7) — signature verification is mandatory, not a v2 nicety.

## 3. The unified agent model

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

## 4. Component architecture

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
   │  │    (AuthRequirement)    │    │                 │
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
   │  │  §6 hybrid check)         │    │  │  idempotency.ts already  │
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

## 5. Sequence: webhook wins the race

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

## 6. Sequence: webhook never arrives (or spec has no webhook) — unchanged today

```
agent          submit_op                                                              status_op    upstream
  │────submit─────▶│                                                                       │            │
  │◀──job_id───────│                                                                       │            │
  │──────────────────────── poll status_op(job_id) ────────────────────────────────────────▶│            │
  │                                                                        ledger miss ──────│──poll────▶│
  │◀───────────────────────────────── pending, poll again later ───────────────────────────│◀───pending─│
  │  (repeat until upstream reports a terminal state — exactly today's behavior)             │            │
```

## 7. AIR shape

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

export type WebhookSignatureVerification =
  | { scheme: "hmac_sha256_header"; headerName: string; secretRef: string }
  | { scheme: "provider_sdk"; provider: "stripe" | "github"; secretRef: string };

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
  | "webhook_signature_unverifiable"; // secretRef doesn't resolve to a real credential
```

`resolveAsyncContract` gets one new branch: if `contract.webhook` is present,
resolve `webhookOperationId` against the operation map the same way
`statusOperationId` is resolved today (lines 133–162 of the current file),
and run `pathProvablyAbsent` against the webhook operation's *input* schema
for `webhookJobIdField` (mirroring the existing `job_id_field_absent` check
at line 179, just against the inbound payload schema instead of the
poll-status response schema).

## 8. Compiler: parsing `callbacks:` / `webhooks:`

New file: `packages/compiler/src/protocols/webhooks.ts`, following the same
per-protocol module shape as `packages/compiler/src/protocols/wsdl.ts` /
`graphql.ts`. Scope for v1: OpenAPI 3.1 top-level `webhooks:` map only
(simpler and more common than per-operation `callbacks:` objects); leave
`callbacks:` as a documented follow-up rather than blocking v1 on the more
irregular shape.

- Each `webhooks:` entry compiles to a normal `Operation` (not a special
  type) — same `Effect`, `input`/`output` schema inference, same
  classification pipeline every other operation goes through
  (`packages/compiler/src/classify.ts`). Its `effect.kind` is `"read"` in
  the sense that receiving a webhook performs no outbound action of its own
  — the mutation already happened upstream; this operation only *observes*
  it. Tag it distinctly (`sourceRef.kind: "webhook"` or similar) so
  `classify.ts` and later, `resources.ts`/`catalog.ts`, know not to expose
  it as a directly-callable MCP tool — it is receiver-only, wired through
  `AsyncContract.webhook`, never `tools/call`-invokable.
- `normalize.ts` links a compiled `webhooks:` operation back to whichever
  `longRunning` operation names it, populating `AsyncContract.webhook`
  automatically when the spec's own `callbacks:` reference makes the link
  explicit (OpenAPI's `callbacks` keyword literally exists to say "this
  operation's result arrives at this other URL shape" — when present, this
  is a compile-time-derivable link, not a guess). When the spec only has
  bare `webhooks:` with no explicit link to an operation, do **not** guess
  the association — leave `AsyncContract.webhook` unset and let a manifest
  patch (`packages/compiler/src/manifest.ts`) supply it explicitly, same
  asymmetric-trust posture as everywhere else in this doc.

## 9. Runtime: the receiver and the hybrid status handler

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
   the mandatory gate from §2; there is no scheme that skips it.
2. Parse `rawBody` against the webhook operation's input schema (already
   validated to exist by `resolveAsyncContract`, §7); extract
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
"check ledger, else call upstream," per the diagram in §3. This is a
handler-generation change, not a protocol change — the tool's declared
input/output schema is untouched.

## 10. Safety gating (asymmetric trust — do not skip this)

Per `reference/safety-invariants.md`'s rule: *loosening* is the direction
that demands the strongest evidence bar, regardless of mechanism. A webhook
completion is new trust surface — an unauthenticated party on the internet
can cause a `status_op` call to return "terminal: succeeded" the instant
Anvil accepts their POST. Concretely:

- `resolveAsyncContract` must refuse a `webhook` block whose
  `signatureVerification.secretRef` doesn't resolve to a real, configured
  credential — same posture as `status_operation_not_approved` today
  (§7's new issues).
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

## 11. Certification

New check in `packages/certification/src/checks.ts`, same shape as the
existing async-contract checks (`packages/certification/src/async-certification.test.ts`
already establishes the pattern to extend): a bundle fails certification if
any operation's `AsyncContract.webhook` is present but
`signatureVerification.secretRef` isn't satisfiable from the deploy target's
credential configuration — catching a spec/deploy mismatch statically,
before the receiver ever gets an unverifiable request in production.

## 12. File-level task breakdown

| Package | File | Change |
|---|---|---|
| `@anvil/air` | `src/async-contract.ts` | Add `WebhookContract`, `WebhookSignatureVerification`, new `AsyncContractIssue` values, webhook branch in `resolveAsyncContract` |
| `@anvil/air` | `src/async-contract.test.ts` | New cases: webhook resolves, each new issue triggers correctly |
| `@anvil/compiler` | `src/protocols/webhooks.ts` (new) | Parse OpenAPI `webhooks:`, compile to `Operation` with `sourceRef.kind: "webhook"` |
| `@anvil/compiler` | `src/normalize.ts` | Link `callbacks:`-referenced webhook ops into the owning operation's `AsyncContract.webhook` |
| `@anvil/compiler` | `src/manifest.ts` | Manifest patch shape for manually supplying a `webhook` block |
| `@anvil/runtime` | `src/webhook-receiver.ts` (new) | Signature verify → parse → ledger write |
| `@anvil/runtime` | `src/idempotency.ts` | No interface change; confirm `reserve`/complete shape covers webhook-sourced completion (likely already does) |
| `@anvil/generators` | `src/mcp.ts` | Hybrid status handler: ledger-check-then-upstream |
| `@anvil/generators` | `src/deploy.ts` | New `/webhooks/<service>/<opId>` route wired into the generated Cloud Run entrypoint |
| `@anvil/mcp-runtime` | `src/server.ts` | Serve the hybrid handler; webhook ops never appear in `tools/list` |
| `@anvil/refinement` | `src/approval.ts` | `webhook`-touching patches always `review` |
| `@anvil/certification` | `src/checks.ts` | Static check: webhook signature scheme resolvable at deploy target |
| `@anvil/cli` | `src/commands/inspect.ts` | Surface `asyncContract.webhook` (or its absence/issue) in `anvil inspect` output |

## 13. Phased plan

1. **Phase 0 — AIR shape.** §7 only. Land `WebhookContract` + resolver
   branch + tests. No compiler, no runtime. Reviewable in isolation because
   nothing downstream depends on it yet.
2. **Phase 1 — Compiler parsing.** §8. `webhooks:` → `Operation`, manifest
   patch path for manual linking. Certify that a webhook-carrying spec
   compiles without needing the runtime pieces yet (contract resolves,
   `webhook_operation_missing`/`webhook_job_id_field_absent` fire on bad
   input).
3. **Phase 2 — Runtime receiver.** §9's `handleWebhook`, ledger wiring,
   signature verification. Unit-testable without a deployed server (pure
   function of body/headers/contract → ledger call).
4. **Phase 3 — Generated route + hybrid handler.** §9's generator/server
   changes, wired end-to-end. This is where `deploy.ts`'s Cloud Run
   entrypoint actually gains the new route.
5. **Phase 4 — Safety gating + certification.** §10, §11. Do not ship
   Phase 3 to any real deployment before this lands — a receiver with no
   approval-gating and no certification check is exactly the "loosening
   with no equivalent gate" defect `safety-invariants.md` calls out as
   disqualifying.
6. **Phase 5 — Docs/skill generation + `anvil inspect`.** Agent-facing
   sentence stays `asyncContractSentence()`'s existing wording — confirm no
   change is needed there (the point of §3 is that it shouldn't be), and add
   `anvil inspect` visibility for operators.

Each phase should land as its own PR with its own drift-guard tests where it
touches generated output (`mcp.ts`, `deploy.ts`) — this codebase's existing
convention for catching exactly the "skill/CLI/MCP drifted apart" failure
mode described at the top of `CLAUDE.md`.

## 14. Open questions to resolve before Phase 1

- Per-operation `callbacks:` (vs. top-level `webhooks:`) — same underlying
  shape, more irregular OpenAPI structure. Worth a second pass once
  top-level `webhooks:` is proven, not blocking v1.
- Multiple webhook deliveries with *different* terminal states for the same
  job (e.g. a "processing" webhook followed by a "succeeded" one) — the
  ledger write in §9 step 3 needs a last-write-wins-if-more-terminal rule,
  not naive overwrite; needs a concrete decision before Phase 2 lands, not
  during.
- Local dev / `anvil run` story for a webhook-carrying operation with no
  public HTTPS endpoint (tunnel requirement) — out of scope for this doc,
  worth a short follow-up note in the CLI's `run.ts` docs once Phase 3 exists.
