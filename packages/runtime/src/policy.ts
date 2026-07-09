import type { Operation } from "@anvil/air";
import { AnvilError } from "./errors.js";
import type { HttpRequest, HttpResponse } from "./transport.js";

/**
 * Policy hook context. Hooks are LOCAL enforcement points, not agent
 * suggestions (spec §14): they can mutate the request, record a decision, or
 * deny by throwing `denyPolicy(...)`.
 */
export interface PolicyContext {
  operation: Operation;
  input: Record<string, unknown>;
  traceId: string;
  authProfile?: string;
  request?: HttpRequest;
  response?: HttpResponse;
  /** Append a decision to the execution record. */
  decide(decision: string): void;
}

export type PolicyHook = (ctx: PolicyContext) => void | Promise<void>;

/** The six hook points from spec §14. Every one is optional. */
export interface PolicyHooks {
  preValidate?: PolicyHook;
  preAuth?: PolicyHook;
  preExecute?: PolicyHook;
  postExecute?: PolicyHook;
  postResponse?: PolicyHook;
  postError?: PolicyHook;
}

/** Deny the current operation from within a policy hook. */
export function denyPolicy(ctx: PolicyContext, message: string): never {
  throw new AnvilError({
    code: "policy_denied",
    message,
    operation: ctx.operation.id,
    traceId: ctx.traceId,
  });
}
