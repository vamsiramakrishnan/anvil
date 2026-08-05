# Implementation plan: async completion (webhooks, human approval, queues)

Status: ready to execute. Companion to `docs/design/async-events-and-callbacks.md`
(the design doc — read it in full before starting; this file is the "how and
in what order," not the "why"). The design doc has already been through one
external review round on PR #29 (chatgpt-codex-connector found five real
gaps — a missing job-handle index, an overclaimed mid-mutation resume, an
unrepresentable webhook-only case, an overgeneralized queue-idempotency
claim, and an unmodeled SigV4 requirement); all five are fixed as of commit
`bd91e5d` on branch `claude/async-events-callbacks-anvil-10acoz`. Treat the
current text of the design doc as ground truth — don't re-litigate it,
extend it.

## Before you start

1. Read `docs/design/async-events-and-callbacks.md` sections 1–19 in full.
2. Read `CLAUDE.md` and `AGENTS.md` at the repo root for the drift-guard
   testing convention referenced throughout this plan.
3. Two decisions the design doc left open are resolved *here* so this plan
   is executable without another round-trip — see §A and §B below. Follow
   them unless you have a specific reason not to; if you deviate, say so in
   the PR description.

### Decision A — job-handle index storage shape (blocks Phase 2)

Add it as **fields on the existing ledger entry**, not a separate store.
Concretely, in `packages/runtime/src/idempotency.ts`:

- Add an optional `secondaryKeys?: string[]` (or a single `jobId?: string`
  if one upstream job id per entry is always true in practice — confirm
  against the vendors in the design doc's §11/§12 before committing to
  single- vs. multi-value) to `LedgerEntry`.
- Add one new `IdempotencyLedger` method:
  `findBySecondaryKey(secondaryKey: string): Promise<LedgerEntry | undefined>`.
- The submit-operation executor calls a new `ledger.complete(key, result, { secondaryKey: jobId })`
  overload (or a follow-up `ledger.indexSecondaryKey(key, jobId)` call
  immediately after `complete`) once the upstream response is in hand and
  `jobIdField` has been extracted from it — **not** at `reserve()` time (the
  job id doesn't exist yet then; see the design doc's §14, corrected).
- TTL: the index entry lives and dies with its parent ledger entry — don't
  invent a second TTL. If the backing store can't do a compound key/secondary
  index natively (e.g. the in-memory dev ledger), a plain `Map<jobId, key>`
  alongside the existing store is fine; for Firestore, a second collection
  keyed by `jobId` with the idempotency key as its only field works with the
  same `DEFAULT_LEDGER_RESULT_TTL_SECONDS`.

Rationale for choosing this over a wholly separate service: it's the
smallest change that satisfies the review finding, keeps one durability
story instead of two, and follows the same "extend, don't duplicate"
pattern `resolveIdempotencyCarrier` already established for idempotency
logic in this codebase.

### Decision B — SQS auth: gateway-scoped for v1, SigV4 deferred

Phase 5 (queue systems) ships **only** against SQS/Pub/Sub reachable through
an already-authenticated HTTP gateway (API Gateway, or Pub/Sub's own IAM-
fronted REST surface, which already works with AIR's existing `AuthType`
values). Do **not** build SigV4 signing as part of this plan — it's a
correctly-scoped follow-up (new `AuthType` value + `packages/runtime/src/auth.ts`
signing path + its own tests), not a prerequisite this feature needs to
carry. If a later requirement needs direct unauthenticated-gateway SQS
access, that's a separate, small, well-defined PR on top of this one — name
it explicitly rather than smuggling it into Phase 5.

## Phase sequencing

```
Phase 0 (AIR shape)
   │
   ├──▶ Phase 1 (compiler: webhooks:)  ──┐
   │                                       │
   └──▶ Phase 2 (runtime: ledger index,   │
                 receiver, job-answer)  ──┤
                                            ▼
                                   Phase 3 (generators + mcp-runtime + CLI)
                                            │
                                            ▼
                                   Phase 4 (safety gating + certification)
                                            │
                              ┌─────────────┴─────────────┐
                              ▼                             ▼
                     Phase 5 (queue systems)        Phase 6 (docs/inspect)
```

Phases 1 and 2 both depend only on Phase 0 and are independent of each
other — if you have two sessions available, run them in parallel and merge
both before Phase 3. Phases 5 and 6 both depend on Phase 4 and are
independent of each other. Everything else is strictly sequential.

**One PR per phase**, each with its own drift-guard tests wherever it
touches generated output — this is the existing repo convention (see the
top of `CLAUDE.md`), not new process for this feature.

---

## Phase 0 — AIR shape

**Goal:** every type this whole feature needs exists and validates
correctly, with zero compiler/runtime/generator changes yet.

**Files:**
- `packages/air/src/enums.ts` — modify
- `packages/air/src/async-contract.ts` — modify
- `packages/air/src/async-contract.test.ts` — modify

**Tasks:**
1. Add `"webhook_receiver"` to `InteractionArchetype` (`enums.ts`), next to
   `"long_running"`.
2. In `async-contract.ts`, add `WebhookContract` and the four-variant
   `WebhookSignatureVerification` union (`hmac_sha256_header`,
   `provider_sdk`, `remote_verify`, `oidc_jwt`) — copy the shapes verbatim
   from the design doc's §9, they're already reviewed.
3. Change `AsyncContract.statusOperationId` and `.statusJobIdParam` from
   required to optional (`?:`). Add `webhook?: WebhookContract` (already
   present from the prior draft — confirm it's still there).
4. Add new `AsyncContractIssue` values: `"webhook_operation_missing"`,
   `"webhook_job_id_field_absent"`, `"webhook_signature_unverifiable"`,
   `"no_completion_source"`.
5. In `resolveAsyncContract`:
   - New first check: if both `statusOperationId` and `webhook` are absent,
     return `{ ok: false, issue: "no_completion_source", ... }`.
   - New branch: if `webhook` is present, resolve `webhookOperationId`
     against the operation map the same way `statusOperationId` is resolved
     today (mirror the existing block, don't fork the logic into a new
     helper unless the mirrored version is genuinely awkward to share).
   - Run `pathProvablyAbsent` against the webhook operation's *input*
     schema for `webhookJobIdField`, mirroring the existing
     `job_id_field_absent` check.
   - Only run the existing `statusOperationId`-resolution block when
     `statusOperationId` is actually present (it's now optional).
6. Update `asyncContractSentence()`: confirm it still renders correctly
   when `statusOperationId` is absent (webhook-only case) — the sentence
   should describe waiting for the webhook, not reference a poll operation
   that doesn't exist. Add a distinct sentence branch if needed.

**Tests to add** (`async-contract.test.ts`):
- Webhook-only contract (no `statusOperationId`) resolves `ok: true`.
- Contract with neither `statusOperationId` nor `webhook` → `no_completion_source`.
- Each new `WebhookSignatureVerification` variant round-trips through
  schema validation.
- `webhook_operation_missing` / `webhook_job_id_field_absent` /
  `webhook_signature_unverifiable` each trigger correctly.
- Existing pure-poll contracts (no `webhook`) still resolve byte-identically
  to before — this is the regression proof that the change is additive.

**Definition of done:** `pnpm --filter @anvil/air test` green. No other
package touched.

**Suggested PR title:** `air: optional status operation + WebhookContract for AsyncContract`

---

## Phase 1 — Compiler: parse `webhooks:`

**Goal:** an OpenAPI 3.1 spec with a top-level `webhooks:` map compiles into
`webhook_receiver`-archetyped operations.

**Files:**
- `packages/compiler/src/protocols/webhooks.ts` — new
- `packages/compiler/src/classify.ts` — modify
- `packages/compiler/src/normalize.ts` — modify
- `packages/compiler/src/manifest.ts` — modify
- `packages/compiler/src/compiler.test.ts` — modify (or a new
  `webhooks.test.ts` alongside `wsdl.ts`'s own test file, matching whichever
  convention `protocols/graphql.ts` uses)

**First task, before writing code:** fetch `github/rest-api-description`'s
`descriptions/api.github.com/api.github.com.json` (or the equivalent
dereferenced file) and check whether it declares a top-level `webhooks:`
map. This was flagged unverified in the design doc's §11/§16/§19. If it
does, use a trimmed real excerpt as a test fixture — same approach
`docs/backtesting/reproduce/` already uses for Stripe/GitHub/Twilio. If it
doesn't, use a hand-authored minimal fixture instead and note in the PR
description that GitHub wasn't usable as the real-world case after all.

**Tasks:**
1. `protocols/webhooks.ts`: parse OpenAPI 3.1 `webhooks:` (top-level map of
   name → PathItem, same shape as `paths:`). Compile each entry to a normal
   `Operation` via the same `Effect`/input/output inference every other
   protocol module uses — don't special-case the schema inference, only the
   archetype tagging.
2. `classify.ts`: operations sourced from `webhooks:` get
   `interactionArchetype: "webhook_receiver"` set, unconditionally (not
   inferred/guessed — it's structurally certain from where the operation
   came from).
3. `normalize.ts`: when a `longRunning` operation's spec entry has an
   OpenAPI `callbacks:` reference naming a `webhooks:` operation, populate
   that operation's `AsyncContract.webhook.webhookOperationId` automatically
   — this is compile-time-derivable, not a guess, per the design doc's §10.
   When there's no explicit `callbacks:` link (the common case per the
   Stripe/GitHub/Twilio evidence in §11), leave `AsyncContract.webhook`
   unset; do not attempt fuzzy name-matching.
4. `manifest.ts`: add the manifest patch shape for manually supplying
   `asyncContract.webhook` (mirrors how `strategy: required_request_key` is
   already supplied by hand for Stripe's `Idempotency-Key` in
   `docs/backtesting/reproduce/manifests/stripe.anvil.yaml` — same
   asymmetric-trust posture, same file to model the new patch keys after).

**Tests to add:**
- A fixture spec with `webhooks:` compiles; the resulting operations are
  archetyped `webhook_receiver` and excluded from whatever "callable
  operations" list `compiler.test.ts` already asserts on.
- A fixture with `callbacks:` linking a `longRunning` op to a `webhooks:`
  entry auto-populates `AsyncContract.webhook`.
- A fixture with bare `webhooks:` and no `callbacks:` link leaves
  `AsyncContract.webhook` unset (proving §10's "don't guess" rule holds).
- A manifest patch can supply `asyncContract.webhook` by hand and it
  compiles correctly.

**Definition of done:** `pnpm --filter @anvil/compiler test` green.
Compiling the real or fixture GitHub-shaped spec produces at least one
`webhook_receiver` operation.

**Suggested PR title:** `compiler: parse OpenAPI webhooks: into webhook_receiver operations`

---

## Phase 2 — Runtime: ledger job-handle index, webhook receiver, job-answer handler

**Prerequisite:** Decision A above is understood and agreed with (or your
deviation is documented).

**Files:**
- `packages/runtime/src/idempotency.ts` — modify (job-handle index)
- `packages/runtime/src/idempotency.test.ts` (or wherever its tests live) — modify
- `packages/runtime/src/webhook-receiver.ts` — new
- `packages/runtime/src/webhook-receiver.test.ts` — new
- `packages/runtime/src/job-answer.ts` — new
- `packages/runtime/src/job-answer.test.ts` — new

**Tasks:**
1. `idempotency.ts`: implement Decision A — the secondary-key field(s) on
   `LedgerEntry`, the `findBySecondaryKey` method, and the write path that
   fires at `complete()` time for a submit operation whose `AsyncContract`
   has a `jobIdField`. Update both the in-memory dev ledger and the
   Firestore-backed implementation (`firestore-ledger.ts` or wherever that
   lives — grep for the existing `IdempotencyLedger` implementations before
   assuming there's only one).
2. `webhook-receiver.ts`: implement `handleWebhook()` exactly as specified
   in the design doc's §14 (five steps, already fixed post-review): verify
   signature (dispatch on `WebhookSignatureVerification.scheme`) → reject
   `401` on failure → parse body against the webhook operation's input
   schema → resolve `idempotencyKey = jobIndex.lookup(jobId)` → write
   completion via `ledger.complete(idempotencyKey, ...)` → always `200`
   once durably written or on duplicate.
   - Implement all four signature schemes. `hmac_sha256_header` first (it's
     the simplest and the best-evidenced per §11 — GitHub, Shopify).
     `provider_sdk` needs per-provider logic for Stripe (composite
     timestamped header, replay-tolerance window) and Twilio (HMAC-SHA1 over
     URL+params, not the body) — these are genuinely different computations,
     don't try to unify them. `oidc_jwt` verifies a JWT bearer against an
     issuer's public keys (Pub/Sub push) — a JWKS-fetch-and-verify path;
     reuse whatever JWT library is already a dependency before adding a new
     one. `remote_verify` (PayPal) makes an outbound call to the provider's
     verify endpoint — gate that outbound call through the existing
     `allowedHosts` mechanism from the start, not as an afterthought.
3. `job-answer.ts`: implement the handler from the design doc's §8/§14 —
   authenticate the caller against the operation's `AuthRequirement`,
   validate the decision shape, then call the real upstream decision
   operation (not "resume" anything — §8 was corrected post-review to make
   this explicit). Record the answer in the ledger for audit/dedup.

**Tests to add:**
- `idempotency.test.ts`: reserve → complete-with-secondary-key →
  `findBySecondaryKey` round-trips; a lookup for an unknown job id returns
  `undefined` cleanly (not a thrown error the receiver has to catch).
- `webhook-receiver.test.ts`, as pure functions of
  (payload, headers, contract, a fake/in-memory ledger) → no deployed
  server needed:
  - Each signature scheme: valid signature → proceeds; invalid → `401`
    before the ledger is touched (assert the ledger mock was never called).
  - Duplicate delivery (same job id, second call) → `200`, no double-apply.
  - Missing job-index entry (webhook arrives with a job id the index
    doesn't know) → don't throw; document what actually happens (likely: a
    `400` or a durably-recorded "orphaned completion" the status tool can
    still find later if the submit's `complete()` write is merely delayed,
    not lost — decide this explicitly in the test, don't leave it
    implicit).
- `job-answer.test.ts`: valid decision + authorized caller → calls the
  upstream decision operation with the right arguments; unauthorized caller
  → rejected before any upstream call.

**Definition of done:** `pnpm --filter @anvil/runtime test` green. Every
test in this phase runs without a real deployed server or real network
credentials (per the design doc's own claim that these are "unit-testable
without a deployed server" — prove it).

**Suggested PR title:** `runtime: webhook receiver, job-answer handler, ledger job-handle index`

---

## Phase 3 — Generators + mcp-runtime + CLI wiring

**Files:**
- `packages/generators/src/catalog.ts` — modify
- `packages/generators/src/mcp.ts` — modify
- `packages/generators/src/deploy.ts` — modify
- `packages/mcp-runtime/src/server.ts` — modify
- `packages/cli/src/commands/job.ts` — new
- `packages/cli/src/commands/inspect.ts` — modify (or defer the `inspect`
  half to Phase 6 if it's cleaner to land status-tool wiring separately
  from operator-visibility polish — your call, note it in the PR either way)

**Tasks:**
1. `catalog.ts`: exclude `webhook_receiver`-archetyped operations from
   `compiledOperations`'s callable surface (mirrors how unapproved
   operations are already filtered — same function, one more predicate).
2. `mcp.ts`: the generated handler for `statusOperationId`'s tool becomes:
   - **Hybrid** (existing behavior, extended): check ledger first, fall
     back to calling the upstream status operation — only when
     `statusOperationId` is present.
   - **Synthetic** (new): when `statusOperationId` is absent (webhook-only
     contract, per Phase 0), generate a tool with no `sourceRef` — its
     handler only ever checks the ledger, there is no upstream fallback
     branch to generate, by construction not by omission (design doc §9).
   - Generate the `job answer` tool for any operation whose `AsyncContract`
     resolves an `awaiting_human_input` pending state with a real upstream
     decision operation behind it (per §8, post-fix).
3. `deploy.ts`: add the `/webhooks/<service>/<opId>` route to the generated
   Cloud Run entrypoint, wired to `webhook-receiver.ts`'s `handleWebhook`.
4. `mcp-runtime/server.ts`: serve the hybrid/synthetic status handler and
   the job-answer tool; confirm `webhook_receiver` operations still never
   appear in `tools/list` (this should already follow from Phase 3.1's
   `catalog.ts` change, but assert it explicitly in a test — this is
   exactly the kind of thing a drift-guard test exists to catch).
5. `cli/commands/job.ts`: `anvil job answer <job_id> --decision approve|reject [--note ...]`,
   generated/wired the same way every other CLI command in this package is.

**Tests to add — drift-guard tests are mandatory here, per CLAUDE.md's own
stated convention** (exact `.toBe()` comparison of freshly generated output
against a checked-in copy) for:
- The generated MCP server's tool list for a bundle containing a
  webhook-backed operation (proves `webhook_receiver` ops are absent, the
  status tool and job-answer tool are present with the right shapes).
- The generated Cloud Run deploy artifact (proves the `/webhooks/...` route
  is present and correctly parameterized).
- An end-to-end test (can live in `harness` or `mcp-runtime` — whichever
  already has the infrastructure for "compile a fixture spec, boot the
  generated server, drive it") that: compiles a fixture spec with a
  webhook-backed `longRunning` operation → approves it → deploys/boots it
  locally → calls submit → POSTs a fake signed webhook at the receiver →
  polls the status tool → gets the terminal state instantly (proves the
  whole ledger-race mechanism from the design doc's §6 actually works, not
  just each piece in isolation).

**Definition of done:** `pnpm --filter @anvil/generators --filter @anvil/mcp-runtime --filter @anvil/cli test` green, including the new drift-guard and end-to-end tests.

**Suggested PR title:** `generators+runtime: wire webhook route, hybrid/synthetic status handler, job answer CLI`

---

## Phase 4 — Safety gating + certification (hard gate)

**Do not let Phase 3's work reach a real deployment before this phase
lands.** This is the same discipline the design doc's §15 states
explicitly — a receiver with no approval-gating and no certification check
is exactly the "loosening with no equivalent gate" defect
`reference/safety-invariants.md` calls out as disqualifying, not a
stylistic nicety to add later.

**Files:**
- `packages/refinement/src/approval.ts` — modify
- `packages/certification/src/checks.ts` — modify
- corresponding test files for both

**Tasks:**
1. `approval.ts`: add `asyncContract.webhook` and any job-answer
   authorization-touching manifest patch keys to the same patch-key list
   idempotency-carrier fields already sit on — `classifyApproval` must
   return `review` for these, unconditionally, checked on the patch keys
   themselves (not which skill/mechanism produced them), matching the
   existing pattern exactly.
2. `checks.ts`: add certification checks:
   - Every `AsyncContract.webhook`'s `signatureVerification` reference
     (`secretRef` / `verifyEndpointRef` + `credentialRef`) resolves against
     the deploy target's actual credential configuration — fail the
     certification otherwise.
   - No operation resolves to `AsyncContractIssue: "no_completion_source"`
     in an approved bundle.
   - `remote_verify`'s outbound verify-endpoint host is present in the
     deploy target's `RuntimeConfig.allowedHosts` — fail otherwise.

**Tests to add:**
- A manifest patch touching `asyncContract.webhook` lands `review`, never
  `auto`, regardless of evidence strength (mirror the existing idempotency-
  carrier test for the same guarantee).
- A bundle with an unresolvable `secretRef` fails certification with a
  specific, actionable diagnostic (not a generic failure).
- A bundle with a `remote_verify` host missing from `allowedHosts` fails
  certification.

**Definition of done:** `pnpm --filter @anvil/refinement --filter @anvil/certification test` green. Manually confirm (or write an integration test proving) that a bundle assembled straight from Phase 3's output, with no operator action, cannot be certified — the operator must explicitly configure credentials and hosts first.

**Suggested PR title:** `refinement+certification: gate webhook contracts behind review and static checks`

---

## Phase 5 — Queue systems (SQS / Pub/Sub, gateway-scoped per Decision B)

**Prerequisite:** Phase 4 merged. Decision B above accepted (or your
deviation documented).

**Files:** none new at the architecture level — this phase is proof-by-
construction that "queue integration is compiling that provider's REST API,"
so the deliverable is fixture specs + manifests + tests, not new source
files, except:
- `packages/compiler/src/protocols/webhooks.ts` may need a small extension
  if Pub/Sub's push-subscription shape doesn't cleanly fit the OpenAPI
  `webhooks:` model already built — check before assuming it's free.

**Tasks:**
1. Pick one pull-based provider (SQS via an authenticated gateway, or
   Pub/Sub's `projects.subscriptions.pull` under its own IAM-fronted REST
   surface) and compile its real API surface (`ReceiveMessage`/`SendMessage`
   or Pub/Sub's pull/publish) as ordinary AIR operations — no special
   handling needed if Decision B's gateway-scoping holds, which is exactly
   the point being proven.
2. Wire GCP Pub/Sub **push** delivery through the existing
   `webhook-receiver.ts` from Phase 2, using the `oidc_jwt` scheme already
   built there. This should require zero new receiver code — if it does,
   that's a signal Phase 2's abstraction wasn't general enough and is worth
   fixing before adding provider #2.
3. For SQS FIFO specifically, confirm `MessageDeduplicationId` classifies
   as `key_supported` idempotency automatically via the compiler's existing
   idempotency-carrier inference — don't hand-write a special case if the
   general machinery already gets it right.

**Tests to add:**
- A compiled SQS-FIFO `SendMessage`-shaped operation classifies
  `key_supported`; a compiled standard-SQS or Pub/Sub-publish-shaped
  operation does **not** (stays `unproven`/`review_required`) — this is the
  direct regression test for the review finding that was fixed in the
  design doc's §13.
- A Pub/Sub push delivery through the receiver resolves a ledger row
  exactly like a Stripe/GitHub webhook does, with no receiver code
  differences beyond the signature scheme.

**Definition of done:** the two idempotency-classification tests above pass,
and the Pub/Sub-push-via-existing-receiver test passes with a diff-stat
close to zero in `webhook-receiver.ts` itself (proving reuse, not
duplication).

**Suggested PR title:** `compiler: SQS/Pub-Sub as ordinary REST operations, Pub/Sub push via existing receiver`

---

## Phase 6 — Docs, skill generation, `anvil inspect`

**Files:**
- `packages/generators/src/skill.ts` — confirm, likely no change needed
- `packages/cli/src/commands/inspect.ts` — modify (if not already done in
  Phase 3)

**Tasks:**
1. Confirm `asyncContractSentence()`'s output is unchanged for every
   pre-existing pure-poll contract (this should already be proven by Phase
   0's regression tests — this task is re-confirming it holds true after
   the generator changes in Phase 3, not re-testing the same thing twice).
2. `anvil inspect`: surface `asyncContract.webhook` presence/issues,
   `no_completion_source` warnings, and pending-state visibility
   (`awaiting_human_input`) for operators.

**Tests to add:**
- `inspect` output snapshot/drift-guard test for a bundle with a
  webhook-backed operation and one with a plain pure-poll operation, side
  by side — proves an operator can tell the two apart from the CLI.

**Definition of done:** `pnpm --filter @anvil/cli test` green.

**Suggested PR title:** `cli: surface async completion source and pending-approval state in anvil inspect`

---

## Open items this plan deliberately does not resolve

Carried over from the design doc's §19, unchanged — do not treat silence on
these as permission to improvise an answer inside one of the phases above:

- Per-operation `callbacks:` (vs. top-level `webhooks:`) — second pass after
  Phase 1 ships.
- Multiple deliveries with different terminal states for the same job — the
  ledger write needs a last-write-wins-if-more-terminal rule; decide before
  Phase 2's tests are written, not after.
- Local dev / `anvil run` story for a webhook-carrying operation with no
  public HTTPS endpoint — a documentation follow-up once Phase 3 exists, not
  a blocker for any phase here.
- Raw broker consumption (native Kafka/JMS/AMQP) and real SigV4 support —
  explicitly out of scope for this plan (see Decision B); their own future
  plans if pursued.
- **Legacy applications with no completion signal at all** (design doc
  §20) — WebLogic/WebSphere/JBoss/.NET-class 3-tier apps with no API,
  only screens. Entirely out of scope for every phase above: getting such
  a system to produce *any* signal is façade work (WSDL/JMX discovery,
  screen automation, or CDC), not something this plan builds. The one
  thing worth keeping in mind while building Phase 2's receiver: if that
  façade work ever happens, a CDC-to-webhook bridge should be able to
  reuse the receiver as just one more `WebhookSignatureVerification`
  scheme — don't design the receiver in a way that quietly forecloses
  that reuse.
