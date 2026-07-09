import type { ErrorCode } from "@anvil/air";

/**
 * The structured error envelope (spec §10). Anvil never leaks raw upstream
 * chaos as the primary interface: every failure becomes exactly this shape.
 */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    safe_to_retry: boolean;
    operation: string;
    trace_id: string;
    upstream?: {
      status?: number;
      request_id?: string;
    };
    /** For confirmation_required / idempotency_required: what the caller must supply. */
    required_flags?: string[];
    /** Structured, non-secret detail (e.g. missing fields for validation_error). */
    details?: unknown;
  };
}

export interface AnvilErrorInit {
  code: ErrorCode;
  message: string;
  operation: string;
  traceId: string;
  retryable?: boolean;
  safeToRetry?: boolean;
  upstream?: { status?: number; requestId?: string };
  requiredFlags?: string[];
  details?: unknown;
}

/** A typed, envelope-ready error. Thrown internally, returned as an envelope. */
export class AnvilError extends Error {
  readonly code: ErrorCode;
  readonly operation: string;
  readonly traceId: string;
  readonly retryable: boolean;
  readonly safeToRetry: boolean;
  readonly upstream?: { status?: number; requestId?: string };
  readonly requiredFlags?: string[];
  readonly details?: unknown;

  constructor(init: AnvilErrorInit) {
    super(init.message);
    this.name = "AnvilError";
    this.code = init.code;
    this.operation = init.operation;
    this.traceId = init.traceId;
    this.retryable = init.retryable ?? false;
    this.safeToRetry = init.safeToRetry ?? false;
    this.upstream = init.upstream;
    this.requiredFlags = init.requiredFlags;
    this.details = init.details;
  }

  toEnvelope(): ErrorEnvelope {
    const e: ErrorEnvelope["error"] = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      safe_to_retry: this.safeToRetry,
      operation: this.operation,
      trace_id: this.traceId,
    };
    if (this.upstream) {
      e.upstream = {};
      if (this.upstream.status !== undefined) e.upstream.status = this.upstream.status;
      if (this.upstream.requestId !== undefined) e.upstream.request_id = this.upstream.requestId;
    }
    if (this.requiredFlags) e.required_flags = this.requiredFlags;
    if (this.details !== undefined) e.details = this.details;
    return { error: e };
  }
}

/** Map an upstream HTTP status onto the Anvil error taxonomy. */
export function httpStatusToErrorCode(status: number): ErrorCode {
  switch (status) {
    case 400:
    case 422:
      return "validation_error";
    case 401:
      return "auth_required";
    case 403:
      return "permission_denied";
    case 404:
    case 410:
      return "not_found";
    case 408:
      return "upstream_timeout";
    case 409:
      return "conflict";
    case 429:
      return "rate_limited";
    case 502:
    case 503:
      return "upstream_unavailable";
    case 504:
      return "upstream_timeout";
    default:
      if (status >= 500) return "unknown_upstream_error";
      if (status >= 400) return "validation_error";
      return "unknown_upstream_error";
  }
}

/** Whether an error code is inherently retryable (before idempotency gating). */
export function isRetryableCode(code: ErrorCode): boolean {
  return code === "rate_limited" || code === "upstream_timeout" || code === "upstream_unavailable";
}
