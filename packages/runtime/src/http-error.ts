import { MAX_RETRY_DELAY_MS, type Operation } from "@anvil/air";
import { AnvilError, httpStatusToErrorCode, isRetryableCode } from "./errors.js";
import type { HttpResponse } from "./transport.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function observedDomainCode(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (typeof body.code === "string") return body.code;
  if (isRecord(body.error) && typeof body.error.code === "string") return body.error.code;
  if (Array.isArray(body.errors)) {
    const first = body.errors.find(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) && typeof entry.code === "string",
    );
    if (first && typeof first.code === "string") return first.code;
  }
  return undefined;
}

/** Match only declared semantics; raw upstream prose is never surfaced. */
function declaredErrorForResponse(op: Operation, status: number, body: unknown) {
  const domainCode = observedDomainCode(body);
  if (domainCode) {
    const exact = op.errors.find(
      (error) => error.upstream?.httpStatus === status && error.upstream.code === domainCode,
    );
    if (exact) return exact;
  }
  return op.errors.find(
    (error) => error.upstream?.httpStatus === status && error.upstream.code === undefined,
  );
}

/** Normalize one terminal non-2xx response into Anvil's reviewed error contract. */
export function httpResponseError(args: {
  operation: Operation;
  response: HttpResponse;
  traceId: string;
  retrySafe: boolean;
  retryAfterMs: number | null;
  stoppedByRetryAfter: boolean;
}): AnvilError {
  const { operation: op, response, traceId, retrySafe, retryAfterMs, stoppedByRetryAfter } = args;
  const upstreamBody = response.body ? parseBody(response.body) : undefined;
  const declared = declaredErrorForResponse(op, response.status, upstreamBody);
  const code = declared?.code ?? httpStatusToErrorCode(response.status);
  const retryable = declared?.retryable ?? isRetryableCode(code);
  const recoveryDetails = declared?.recovery
    ? {
        recovery_action: declared.recovery.action,
        ...(declared.recovery.fieldPath ? { field_path: declared.recovery.fieldPath } : {}),
      }
    : {};
  const observedCode = observedDomainCode(upstreamBody);

  return new AnvilError({
    code,
    message: stoppedByRetryAfter
      ? `Upstream returned ${response.status} for ${op.id} and asked to be left alone for ` +
        `${retryAfterMs} ms, beyond the ${MAX_RETRY_DELAY_MS} ms runtime retry ceiling. ` +
        "Anvil stopped retrying rather than return early; retry after the stated wait."
      : (declared?.message ?? `Upstream returned ${response.status} for ${op.id}.`),
    operation: op.id,
    traceId,
    upstream: {
      status: response.status,
      requestId: response.headers["x-request-id"],
      ...(declared?.upstream?.code && observedCode === declared.upstream.code
        ? { code: declared.upstream.code }
        : {}),
    },
    retryable,
    safeToRetry: retrySafe && (declared?.safeToRetry ?? retryable),
    details:
      retryAfterMs === null && Object.keys(recoveryDetails).length === 0
        ? undefined
        : {
            ...(retryAfterMs === null ? {} : { retry_after_ms: retryAfterMs }),
            ...recoveryDetails,
            ...(stoppedByRetryAfter
              ? {
                  retry_stopped: "retry_after_exceeds_ceiling",
                  max_delay_ms: MAX_RETRY_DELAY_MS,
                }
              : {}),
          },
  });
}
