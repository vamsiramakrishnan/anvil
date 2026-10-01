import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, openSync } from "node:fs";
import type { GrantDecision, GrantEntry } from "./grants.js";
import type { ExecutionRecord } from "./observability.js";
import type { Principal } from "./policy.js";

/**
 * The gateway's audit log (docs/branchyard.md, ADR-0029): one JSON line per
 * call, appended to the file `ANVIL_AUDIT_FILE` names. Branchyard records
 * each line on its branch as a `connector_call` event.
 *
 * The input never appears: it is redacted (credential-looking keys replaced)
 * and then hashed, so two identical calls can be correlated without the log
 * holding what was sent. Upstream bodies, tokens, and connect links never
 * reach a line either.
 */
export type AuditDecision = "allowed" | "denied" | "confirmation_required";

export interface AuditLine {
  time: string;
  sub: string;
  by_tenant: string | null;
  by_branch: string | null;
  by_turn: string | null;
  connector: string | null;
  account: string | null;
  operation: string;
  decision: AuditDecision;
  /** The grant entry that allowed the call (or the one that stopped it), with its index. */
  grant: (GrantEntry & { index: number }) | null;
  upstream_status: number | null;
  latency_ms: number;
  input_sha256: string;
  /** The refusal or failure code when the call did not succeed; null otherwise. */
  error_code: string | null;
  /** The grant-rule sub-code (`policy/grant_denied`, ...), when a grant decided the call. */
  rule: string | null;
  dry_run: boolean;
  trace_id: string;
}

export type AuditSink = (line: AuditLine) => void;

const SENSITIVE_KEY =
  /pass(word|phrase)?|secret|token|authori[sz]ation|api[_-]?key|cookie|credential|private[_-]?key|session/i;

/** A copy of `value` with every credential-looking key's value replaced by `***`. */
export function redactInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactInput(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? "***" : redactInput(item);
    }
    return out;
  }
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** `sha256:<hex>` of the redacted input's canonical JSON (keys sorted). */
export function redactedInputHash(input: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonical(redactInput(input ?? {})))
    .digest("hex")}`;
}

/**
 * An append-only JSONL sink. The file is created 0600 when absent; each line
 * is one `appendFileSync`, so lines from one process never interleave.
 * A write failure is reported through `onError` (default: stderr) and never
 * fails the call it describes.
 */
export function fileAuditSink(
  path: string,
  onError: (message: string) => void = (message) => console.error(message),
): AuditSink {
  if (!existsSync(path)) {
    closeSync(openSync(path, "a", 0o600));
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
  }
  return (line) => {
    try {
      appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
    } catch (error) {
      onError(`anvil: audit write failed: ${(error as Error).message}`);
    }
  };
}

/** What `execute()` knows about one finished call. */
export interface AuditedCall {
  principal: Principal;
  connector: string | undefined;
  input: unknown;
  grant: GrantDecision | undefined;
  record: ExecutionRecord;
  error: { code: string; details?: unknown } | undefined;
  upstreamStatus: number | undefined;
}

/**
 * Write one call's line. The decision reads the grant gate first: a grant
 * refusal is `denied` or `confirmation_required`; any other policy refusal is
 * `denied`; a missing caller confirmation is `confirmation_required`;
 * everything that passed the gates is `allowed`, whatever the upstream then
 * answered. A sink that throws never fails the call it describes.
 */
export function auditCall(sink: AuditSink, call: AuditedCall): void {
  const { principal, grant, record, error } = call;
  let decision: AuditDecision = "allowed";
  if (grant && !grant.allowed) decision = grant.decision;
  else if (error?.code === "policy_denied") decision = "denied";
  else if (error?.code === "confirmation_required") decision = "confirmation_required";
  const detailCode = (error?.details as { code?: unknown } | undefined)?.code;
  const entry = grant?.entry;
  try {
    sink({
      time: new Date().toISOString(),
      sub: principal.id,
      by_tenant: principal.attribution?.tenant ?? null,
      by_branch: principal.attribution?.branch ?? null,
      by_turn: principal.attribution?.turn ?? null,
      connector: call.connector ?? null,
      account: grant?.allowed ? grant.account : (entry?.account ?? null),
      operation: record.operationId,
      decision,
      grant:
        entry !== undefined && grant?.index !== undefined ? { index: grant.index, ...entry } : null,
      upstream_status: call.upstreamStatus ?? null,
      latency_ms: record.latencyMs,
      input_sha256: redactedInputHash(call.input),
      error_code: error?.code ?? null,
      rule:
        typeof detailCode === "string" && detailCode.startsWith("policy/grant") ? detailCode : null,
      dry_run: record.outcome === "dry_run",
      trace_id: record.traceId,
    });
  } catch {
    // An audit sink never fails the call it describes.
  }
}
