/**
 * `anvil job answer <job_id> --decision approve|reject [--note ...]` (design
 * doc `docs/design/async-events-and-callbacks.md` §8, §14).
 *
 * **What this is not, stated up front because an earlier draft of §8 got it
 * wrong**: this is NOT resuming a paused Anvil execution. `execute()`
 * (`executor.ts`) makes one upstream request and returns; there is no
 * checkpoint inside that request to pause at, and nothing in this codebase
 * invents one. `awaiting_human_input` names an upstream state — a loan
 * application sitting in "pending underwriter review" on the vendor's own
 * system — not a paused Anvil call. This mechanism only applies where that's
 * exactly true: the upstream is already async (already carries an
 * `AsyncContract`) and already tracks its own pending-approval state.
 *
 * **What this is**: a thin, authenticated wrapper around a REAL upstream
 * decision-taking operation — an "approve this application"-shaped endpoint
 * that the spec already exposes, compiled into AIR like any other mutation.
 * `handleJobAnswer` does exactly three things, in order:
 *
 *   1. Validates the decision shape (`approve`/`reject`, a non-empty job id).
 *   2. Authenticates/authorizes the caller against the operation's own
 *      `AuthRequirement` — BEFORE touching the upstream. "Who may answer
 *      this specific job's question" is policy the operation declares
 *      (design doc §15), not an assumption that whoever can reach the CLI is
 *      authorized.
 *   3. Calls the upstream decision operation through `execute()` — the
 *      EXACT SAME AIR operation-call path every other mutation in this
 *      runtime uses. No second execution primitive, no bespoke HTTP call.
 *
 * Ledger recording for audit/dedup falls out of step 3 for free rather than
 * being reimplemented here: `execute()` already reserves and completes an
 * idempotency-ledger entry for any mutation whose `Idempotency.mode`
 * requires one, using the exact same `reserve`/`complete` shape
 * `webhook-receiver.ts` uses explicitly. A duplicate `anvil job answer`
 * invocation for the same decision (same idempotency key) therefore already
 * replays instead of double-submitting, with no parallel bookkeeping to keep
 * in sync — "structurally identical to the webhook receiver" (§14) is
 * satisfied by sharing the one mechanism, not by building a second one next
 * to it.
 */
import type { AuthRequirement, Operation } from "@anvil/air";
import { type ExecuteContext, type ExecuteResult, execute } from "./executor.js";
import type { InboundIdentity } from "./inbound-identity.js";

/** The only two decisions this mechanism ever submits — matches `anvil job answer --decision`. */
export type JobAnswerDecision = "approve" | "reject";

export interface HandleJobAnswerParams {
  /**
   * The upstream decision operation, compiled into AIR from a real
   * "approve/reject this thing"-shaped endpoint on the spec — NOT a
   * synthetic or generated-by-Anvil operation. Must already be `approved`
   * for the same reason `resolveAsyncContract` requires an approved status
   * operation: calling through an unapproved operation would be the
   * generated-artifact safety contract quietly not applying to this path.
   */
  operation: Operation;
  /**
   * The validated inbound caller identity for this specific invocation, when
   * the serving surface (CLI session, MCP request) authenticated one.
   * `undefined` when the surface presented no verified identity at all —
   * e.g. an unauthenticated local CLI session. Reuses `InboundIdentity`
   * rather than a second identity shape: this is the same "who is calling,
   * right now" concept the OBO/delegated-credential bridge already threads
   * through the runtime.
   */
  caller?: InboundIdentity;
  /** The human's decision, from `--decision approve|reject`. */
  decision: JobAnswerDecision;
  /** Optional free-text rationale, from `--note`. */
  note?: string;
  /** The job handle this answer applies to (the value `AsyncContract.jobIdField` produced on the original submit call). */
  jobId: string;
  /**
   * How `{ decision, note, jobId }` maps onto the upstream operation's real
   * input shape. Every "approve this application" endpoint has its own
   * params — a decision field that might expect `"approved"`/`"denied"`
   * rather than `"approve"`/`"reject"`, a differently-named note field, a
   * path or body param carrying the job handle. AIR does not model a
   * dedicated decision-operation contract (only `AsyncContract` for the
   * poll/webhook side), so the caller that knows this operation's shape
   * supplies the mapping explicitly rather than this function guessing at a
   * naming convention that will not hold for every vendor.
   */
  buildOperationInput: (args: {
    decision: JobAnswerDecision;
    note?: string;
    jobId: string;
  }) => Record<string, unknown>;
  /** Execution context for the real upstream call — transport, credentials, ledger, policy: identical to any other mutation. */
  executeContext: ExecuteContext;
  /** Optional caller-supplied idempotency key for the decision call, threaded straight to `execute()`. */
  idempotencyKey?: string;
  /** Set when the caller has already confirmed a non-idempotent decision call (mirrors `ExecuteInput.confirm`). */
  confirm?: boolean;
}

export type JobAnswerOutcome =
  | { outcome: "invalid_decision"; reason: string }
  | { outcome: "unauthorized"; reason: string }
  | { outcome: "answered"; result: ExecuteResult };

export async function handleJobAnswer(params: HandleJobAnswerParams): Promise<JobAnswerOutcome> {
  // Step 1: validate the decision shape before anything else, including
  // authorization — an invalid request is invalid regardless of who sent it,
  // and failing here first never leaks whether a caller would otherwise have
  // been authorized.
  if (params.decision !== "approve" && params.decision !== "reject") {
    return {
      outcome: "invalid_decision",
      reason: `decision must be 'approve' or 'reject', got '${String(params.decision)}'`,
    };
  }
  if (!params.jobId || params.jobId.trim().length === 0) {
    return { outcome: "invalid_decision", reason: "a non-empty job id is required" };
  }
  if (params.operation.state !== "approved") {
    return {
      outcome: "invalid_decision",
      reason:
        `'${params.operation.id}' is not an approved operation (state: ${params.operation.state}); ` +
        "only approved operations may be called as a job-answer decision.",
    };
  }

  // Step 2: authorize the caller against the operation's OWN AuthRequirement
  // — strictly before any upstream call. This is the test-pinned ordering
  // guarantee ("unauthorized caller -> rejected BEFORE any upstream call").
  const authorization = authorizeCaller(params.operation.auth, params.caller);
  if (!authorization.authorized) {
    return { outcome: "unauthorized", reason: authorization.reason };
  }

  // Step 3: place the real call. Not a resume, not a second execution
  // primitive — the exact same `execute()` every other mutation goes
  // through, which is also what gives this call its ledger-backed
  // audit/dedup trail for free (see this file's top-of-file doc comment).
  const input = params.buildOperationInput({
    decision: params.decision,
    note: params.note,
    jobId: params.jobId,
  });
  const result = await execute(
    params.operation,
    { input, idempotencyKey: params.idempotencyKey, confirm: params.confirm },
    params.executeContext,
  );
  return { outcome: "answered", result };
}

/**
 * Whether `caller` satisfies `auth` — the authorization policy "who may
 * answer this specific job's question" (design doc §15) resolves to.
 *
 * `AuthRequirement` was designed primarily to describe how the RUNTIME
 * authenticates itself to the upstream (which credential, which principal it
 * runs under) — not as an inbound caller-authorization policy. This function
 * is a deliberate, narrow reuse of that same shape for the inbound direction
 * `anvil job answer` needs: a `service`/`anonymous` principal keeps today's
 * behavior (any caller who can reach this call is authorized — the serving
 * surface's own perimeter is the control), while `end_user`/`delegated`/
 * `impersonation` — the principals that name a real human or borrowed
 * identity — require a verified `InboundIdentity` and, when the operation
 * declares scopes, that the caller's own granted scopes cover every one of
 * them. This is the file's one genuine design judgment call where the design
 * doc names the requirement ("needs its own AuthRequirement, checked per
 * call") without fully specifying the check; documented here rather than
 * left implicit.
 */
function authorizeCaller(
  auth: AuthRequirement,
  caller: InboundIdentity | undefined,
): { authorized: true } | { authorized: false; reason: string } {
  if (auth.principal === "service" || auth.principal === "anonymous") {
    return { authorized: true };
  }
  if (!caller) {
    return {
      authorized: false,
      reason: `this decision requires an authenticated caller (principal: ${auth.principal}), but none was presented`,
    };
  }
  if (auth.scopes.length > 0) {
    const granted = new Set((caller.scope ?? "").split(/\s+/).filter(Boolean));
    const missing = auth.scopes.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      return {
        authorized: false,
        reason: `caller is missing required scope(s): ${missing.join(", ")}`,
      };
    }
  }
  return { authorized: true };
}
