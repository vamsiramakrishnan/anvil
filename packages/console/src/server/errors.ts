import { CapabilityReviewError } from "@anvil/compiler";
import { GroupAdmissionRefusal, HarnessProtocolError } from "@anvil/refinement";
import type { ErrorEnvelope } from "../contract.js";

/**
 * Every non-2xx the console emits, as one class carrying an HTTP status and
 * the contract's error envelope. The console's own vocabulary is `console/*`;
 * a library refusal keeps the code the library (and therefore the CLI) already
 * gave it — `capability_*` from the compiler's review gate, `refinement/*`
 * from the harness protocol and the benchmark-scored admission — so a script
 * or a reviewer sees the same string here as on the command line. Nothing
 * here invents a code the library did not emit, and no stack trace ever
 * reaches the wire: `toEnvelope` renders message and issues only.
 */
export class ConsoleError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues?: string[];
  readonly delta?: ErrorEnvelope["error"]["delta"];

  constructor(
    code: string,
    status: number,
    message: string,
    extra: { issues?: string[]; delta?: ErrorEnvelope["error"]["delta"] } = {},
  ) {
    super(message);
    this.name = "ConsoleError";
    this.code = code;
    this.status = status;
    if (extra.issues !== undefined) this.issues = extra.issues;
    if (extra.delta !== undefined) this.delta = extra.delta;
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.issues !== undefined ? { issues: this.issues } : {}),
        ...(this.delta !== undefined ? { delta: this.delta } : {}),
      },
    };
  }
}

/** The one 403 the security gate emits; the message never says which check failed first. */
export function forbidden(): ConsoleError {
  return new ConsoleError(
    "console/forbidden",
    403,
    "Mutations require the per-process console token and a same-origin request.",
  );
}

export function notFound(message: string): ConsoleError {
  return new ConsoleError("console/not_found", 404, message);
}

export function invalidRequest(message: string, issues: string[]): ConsoleError {
  return new ConsoleError("console/invalid_request", 400, message, { issues });
}

export function pathOutsideRoot(path: string): ConsoleError {
  return new ConsoleError(
    "console/path_outside_root",
    400,
    `'${path}' resolves outside the workspace root; the console only reads and writes inside it.`,
  );
}

/**
 * Map what a library throws to the envelope the contract promises. The
 * compiler's review gate and the harness protocol carry their own codes; an
 * ordinary `Error` (an unknown operation id, an incomplete bundle, a receipt
 * that already exists) is a refusal the CLI would print verbatim, so it
 * becomes `console/refused` with that same message.
 */
export function toConsoleError(error: unknown): ConsoleError {
  if (error instanceof ConsoleError) return error;
  if (error instanceof CapabilityReviewError) {
    const status = error.code === "capability_not_found" ? 404 : 409;
    return new ConsoleError(error.code, status, error.message, {
      ...(error.diagnostic ? { issues: [error.diagnostic.message] } : {}),
    });
  }
  if (error instanceof HarnessProtocolError) {
    return new ConsoleError(error.rejection.code, 422, error.rejection.message, {
      issues: error.rejection.issues,
      ...(error instanceof GroupAdmissionRefusal ? { delta: error.delta } : {}),
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ConsoleError("console/refused", 409, message);
}
