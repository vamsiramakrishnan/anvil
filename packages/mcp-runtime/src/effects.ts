import { randomUUID } from "node:crypto";
import {
  type EffectReport,
  type EffectToolResolver,
  effectContractMeta,
  type Operation,
  operationForwardsIdempotencyKey,
  operationSafetyInputKeys,
  resolveEffectArguments,
  resolveEffectReport,
  resolveStagedReport,
} from "@anvil/air";
import {
  AnvilError,
  type ErrorEnvelope,
  type ExecuteContext,
  type ExecuteResult,
  execute,
} from "@anvil/runtime";
import { dryRunResult, responseResult } from "./output-schema.js";
import { resultText } from "./truncation.js";

/**
 * The effect contract on the MCP serving path (ADR-0030). A caller may send,
 * in a `tools/call` request's `_meta`:
 *
 * - `idempotency_key` — the key to send upstream (Branchyard sends its
 *   effect-ledger entry id). Forwarded through the operation's declared
 *   carrier when it has one; recorded on the audit line either way.
 * - `stage: true` — perform the operation's draft form instead, and return the
 *   draft's handle and the call that promotes it.
 *
 * Every operation call's result then carries `_meta.effect` (an
 * `EffectReport`): its class, the resolved undo, its deadline, the key that
 * went upstream, and the lookup a reconciler can call.
 */
export interface EffectCallRequest {
  idempotencyKey?: string;
  stage: boolean;
}

/** The `_meta` keys a fleet forwards to the bundle that serves a tool. */
export const EFFECT_REQUEST_META_KEYS = ["idempotency_key", "stage"] as const;

/** Read the caller's effect controls from a request's `_meta`. */
export function readEffectRequest(
  op: Operation,
  meta: unknown,
): { ok: true; request: EffectCallRequest } | { ok: false; envelope: ErrorEnvelope } {
  const record =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : {};
  const key = record.idempotency_key;
  const stage = record.stage;
  const problem =
    key !== undefined && (typeof key !== "string" || key.length === 0)
      ? "_meta.idempotency_key must be a non-empty string."
      : stage !== undefined && typeof stage !== "boolean"
        ? "_meta.stage must be a boolean."
        : undefined;
  if (problem) {
    return {
      ok: false,
      envelope: effectRefusal(op, "validation_error", problem, { code: "effect/invalid_meta" }),
    };
  }
  return {
    ok: true,
    request: { ...(typeof key === "string" ? { idempotencyKey: key } : {}), stage: stage === true },
  };
}

/**
 * The declared effect contract in a tool's `tools/list` `_meta`, so a caller
 * can see an operation's class and resolve its lookup when a call's answer is
 * lost. Only for operations that declare one: a tool without a declaration
 * lists exactly as it did before (its class is the conservative default).
 */
export function effectToolMeta(op: Operation): Record<string, unknown> {
  const contract = effectContractMeta(op);
  return contract
    ? { "anvil/effect_class": contract.class, "anvil/effect_contract": contract }
    : {};
}

/** The report for one executed call; none for a dry run, which did nothing. */
export function callEffectReport(
  op: Operation,
  request: Record<string, unknown>,
  result: ExecuteResult,
  toolFor: EffectToolResolver,
): EffectReport | undefined {
  if (result.outcome === "dry_run") return undefined;
  return resolveEffectReport({
    op,
    request,
    response: result.outcome === "success" ? result.data : undefined,
    idempotencyKey: result.idempotencyKey,
    answeredAt: Date.now(),
    toolFor,
    succeeded: result.outcome === "success",
  });
}

/** A structured refusal envelope from this layer (never reached an upstream). */
function effectRefusal(
  op: Operation,
  code: "validation_error" | "unsupported_operation",
  message: string,
  details: Record<string, unknown>,
): ErrorEnvelope {
  return new AnvilError({
    code,
    message,
    operation: op.id,
    traceId: `trace_${randomUUID()}`,
    retryable: false,
    details,
  }).toEnvelope();
}

/**
 * Put the caller's `_meta.idempotency_key` into the operation's own
 * idempotency input, where the executor takes it and sends it through the
 * declared carrier. An operation without a carrier is left alone (the key is
 * still the call's ledger id). A different key already in the arguments is a
 * contradiction, refused before anything runs.
 */
export function applyIdempotencyKey(
  op: Operation,
  input: Record<string, unknown>,
  key: string | undefined,
): { ok: true } | { ok: false; envelope: ErrorEnvelope } {
  if (key === undefined || !operationForwardsIdempotencyKey(op)) return { ok: true };
  const field = operationSafetyInputKeys(op).idempotencyKey;
  const existing = input[field];
  if (existing !== undefined && existing !== key) {
    return {
      ok: false,
      envelope: effectRefusal(
        op,
        "validation_error",
        `The call names two idempotency keys: '${field}' in its arguments and _meta.idempotency_key. Send one.`,
        { code: "effect/idempotency_key_conflict", field },
      ),
    };
  }
  input[field] = key;
  return { ok: true };
}

/** A tool result with the effect report attached under `_meta.effect`. */
export function withEffectMeta<T extends object>(result: T, report: EffectReport): T {
  const existing = (result as { _meta?: Record<string, unknown> })._meta;
  return { ...result, _meta: { ...(existing ?? {}), effect: report } };
}

/** A tool result: content, and either structured content or `isError`. */
type ServedResult = { content: Array<{ type: "text"; text: string }>; [key: string]: unknown };

/** What a staged call needs from the server that serves it. */
export interface StageDeps {
  /** The operations this server serves, by id. */
  opsById: ReadonlyMap<string, Operation>;
  toolFor: EffectToolResolver;
  contextFor: (op: Operation) => ExecuteContext;
  /** Render a refusal or failure as the server renders every error. */
  fail: (envelope: ErrorEnvelope, op: Operation) => ServedResult;
  /** Cut a result's text to the server's budget for `op`. */
  truncate: (text: string, op: Operation) => string;
}

/**
 * `stage: true`: perform `op`'s draft form under the draft operation's own
 * gates (approval, grant, confirmation), and answer with the draft's response
 * and `_meta.effect.staged` — its handle, and the calls that promote it (the
 * real effect) and discard it. An operation with no draft form is refused:
 * staging never falls through to the real effect.
 */
export async function stageDraftCall(
  call: {
    op: Operation;
    input: Record<string, unknown>;
    dryRun: boolean;
    ledgerId: string | undefined;
    signal: AbortSignal;
  },
  deps: StageDeps,
): Promise<ServedResult> {
  const { op, input } = call;
  const draft = op.effect.draft;
  if (!draft) {
    return deps.fail(
      effectRefusal(
        op,
        "unsupported_operation",
        `Operation '${op.id}' has no draft form, so it cannot be staged; nothing was called.`,
        { code: "effect/no_draft_form" },
      ),
      op,
    );
  }
  const draftOp = draft.operation === op.id ? op : deps.opsById.get(draft.operation);
  if (!draftOp || !deps.toolFor(draftOp.id)) {
    return deps.fail(
      effectRefusal(
        op,
        "unsupported_operation",
        `Operation '${op.id}' stages through '${draft.operation}', which this server does not serve; nothing was called.`,
        { code: "effect/draft_unavailable", draft_operation: draft.operation },
      ),
      op,
    );
  }
  const mapped = resolveEffectArguments(draft.arguments, { request: input });
  if (!mapped.ok) {
    return deps.fail(
      effectRefusal(
        op,
        "validation_error",
        `The draft of '${op.id}' needs '${mapped.argument}' (${mapped.source}), which this call does not supply.`,
        { code: "effect/draft_argument_missing", argument: mapped.argument },
      ),
      op,
    );
  }
  const draftInput = mapped.arguments;
  // The caller's confirmation of the staged intent carries to the draft.
  if (draftOp.confirmation.required && input[operationSafetyInputKeys(op).confirm] === true) {
    draftInput[operationSafetyInputKeys(draftOp).confirm] = true;
  }
  const keyed = applyIdempotencyKey(draftOp, draftInput, call.ledgerId);
  if (!keyed.ok) return deps.fail(keyed.envelope, op);
  const result = await execute(
    draftOp,
    { input: draftInput, dryRun: call.dryRun },
    {
      ...deps.contextFor(draftOp),
      signal: call.signal,
      stagedFor: op.id,
      ...(call.ledgerId !== undefined ? { ledgerId: call.ledgerId } : {}),
    },
  );
  if (result.outcome === "dry_run") {
    return dryRunResult(deps.truncate(JSON.stringify(result.plan, null, 2), draftOp), result.plan);
  }
  if (result.outcome === "error") return deps.fail(result.envelope, draftOp);
  const data = result.data ?? null;
  const effect = resolveStagedReport({
    op,
    request: input,
    draftResponse: data,
    idempotencyKey: result.idempotencyKey,
    toolFor: deps.toolFor,
  });
  return withEffectMeta(
    responseResult(deps.truncate(resultText(data), draftOp), data, undefined),
    effect,
  );
}
