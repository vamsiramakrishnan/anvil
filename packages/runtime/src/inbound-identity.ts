/**
 * The inbound → outbound identity bridge. When the generated server validates a
 * caller's bearer token (Gemini Enterprise's end-user token, verified by
 * @anvil/mcp-runtime `verifyInboundToken`), a delegated/OBO outbound call needs
 * that SAME token as the `subject_token` of an RFC 8693 exchange. Inbound and
 * outbound live in different packages and the executor's credential resolver is
 * per-profile, not per-request — so we thread the validated identity through an
 * AsyncLocalStorage bridge rather than widening every call signature.
 *
 * This type is defined in @anvil/runtime (not mcp-runtime) so the resolver can
 * consume it with no cross-package cycle; mcp-runtime already depends on runtime.
 *
 * SECURITY: the raw subject token is reachable on the outbound path ONLY to be
 * forwarded to the configured token endpoint for exchange — never to the upstream
 * directly, never written to an ExecutionRecord, never logged.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** The validated inbound caller identity, carried per-request for OBO exchange. */
export interface InboundIdentity {
  /** The raw bearer the caller presented — the RFC 8693 `subject_token`. */
  subjectToken: string;
  /** The subject-token type, chosen from the inbound token's shape. */
  subjectTokenType: "access_token" | "jwt" | "id_token";
  /** `sub` claim, when present — used to key the exchanged-token cache. */
  sub?: string;
  /** `email` claim, when present. */
  email?: string;
  /** Space-delimited `scope`/`scp` claim, when present. */
  scope?: string;
  /** The remaining verified claims, for policy hooks. */
  claims?: Record<string, unknown>;
}

const inboundStore = new AsyncLocalStorage<InboundIdentity>();

/**
 * Run `fn` with `identity` as the ambient inbound caller. The generated server
 * wraps its MCP dispatch in this right after inbound verification, so every
 * resolver call made while handling that request sees the caller's token.
 */
export function withInboundIdentity<T>(identity: InboundIdentity, fn: () => T): T {
  return inboundStore.run(identity, fn);
}

/** The ambient inbound identity for the current request, if one was set. */
export function currentInboundIdentity(): InboundIdentity | undefined {
  return inboundStore.getStore();
}
