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

/* -------------------------------------------------------------------------- */
/* Principals (fleet runtime)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * WHO is calling, resolved once per MCP session and threaded through every
 * call the session makes. Deliberately narrower than `InboundIdentity`
 * (OBO/delegated-credential exchange): a `Principal` names a local scope
 * grant, checked against `Operation.auth.scopes` BEFORE any upstream call —
 * it never leaves the process and never becomes outbound credential material.
 *
 * `id` is recorded on every `ExecutionRecord` (`principalId`) for audit —
 * the token that resolved it never is.
 */
export interface Principal {
  id: string;
  /** Scopes granted to this principal. `"*"` grants every scope. */
  scopes: string[];
}

/**
 * The default principal when a serving surface configures none: every scope,
 * so a single-bundle deployment that never opts into principal resolution
 * behaves byte-identically to before this existed (spec: fleet runtime §2).
 */
export const ANONYMOUS_PRINCIPAL: Principal = { id: "anonymous", scopes: ["*"] };

/** Whether `principal` covers every scope `required` names. `"*"` covers anything. */
export function principalHasScopes(principal: Principal, required: readonly string[]): boolean {
  if (required.length === 0) return true;
  if (principal.scopes.includes("*")) return true;
  const granted = new Set(principal.scopes);
  return required.every((scope) => granted.has(scope));
}

/** The scopes `required` that `principal` lacks — empty when fully covered. */
export function missingScopes(principal: Principal, required: readonly string[]): string[] {
  if (principal.scopes.includes("*")) return [];
  const granted = new Set(principal.scopes);
  return required.filter((scope) => !granted.has(scope));
}

/**
 * A directory of configured principals, keyed by the credential a serving
 * surface presented (a streamable-http bearer token, or the `ANVIL_PRINCIPAL`
 * env value for a stdio session). Built once at boot from operator
 * configuration — never from agent-provided input.
 */
export interface PrincipalDirectoryEntry {
  id: string;
  scopes: string[];
}
export type PrincipalDirectory = Record<string, PrincipalDirectoryEntry>;

/**
 * Parse a principal directory from its wire form: `token:id:scope1,scope2;...`
 * pairs, or a JSON object `{ "<token>": { "id": "...", "scopes": [...] } }`.
 * Both are accepted so an operator can configure one bearer/principal pair
 * inline (`ANVIL_PRINCIPALS=tok_abc:alice:orders.read,orders.write`) without
 * reaching for JSON, while a fleet with many principals uses the JSON form.
 * Malformed input yields an empty directory rather than throwing — a
 * misconfigured directory must fail CLOSED (no bearer resolves), never open.
 */
export function parsePrincipalDirectory(raw: string | undefined): PrincipalDirectory {
  if (!raw || raw.trim() === "") return {};
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, { id?: unknown; scopes?: unknown }>;
      const out: PrincipalDirectory = {};
      for (const [token, entry] of Object.entries(parsed)) {
        if (typeof entry?.id !== "string") continue;
        const scopes = Array.isArray(entry.scopes)
          ? entry.scopes.filter((s): s is string => typeof s === "string")
          : [];
        out[token] = { id: entry.id, scopes };
      }
      return out;
    } catch {
      return {};
    }
  }
  const out: PrincipalDirectory = {};
  for (const pair of trimmed.split(";")) {
    const [token, id, scopeList] = pair.split(":");
    if (!token || !id) continue;
    const scopes = (scopeList ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    out[token] = { id, scopes };
  }
  return out;
}

/**
 * Resolve the calling principal for a streamable-http MCP session from its
 * bearer token. An unconfigured directory, or a token the directory does not
 * name, resolves to `undefined` (never a guess) — callers decide the fallback
 * (see `resolvePrincipal`).
 */
export function resolvePrincipalForBearer(
  directory: PrincipalDirectory,
  bearerToken: string | undefined,
): Principal | undefined {
  if (!bearerToken) return undefined;
  const entry = directory[bearerToken];
  return entry ? { id: entry.id, scopes: entry.scopes } : undefined;
}

/**
 * Resolve the calling principal for a stdio MCP session from `ANVIL_PRINCIPAL`
 * (a directory key, exactly like a bearer token) — one caller per process
 * lifetime, resolved once at boot.
 */
export function resolvePrincipalForEnv(
  directory: PrincipalDirectory,
  env: NodeJS.ProcessEnv = process.env,
): Principal | undefined {
  return resolvePrincipalForBearer(directory, env.ANVIL_PRINCIPAL);
}

/**
 * The one rule every serving surface follows: a configured, resolvable
 * caller wins; anything else — no directory configured, no credential
 * presented, a credential the directory does not name — is the anonymous,
 * every-scope principal. This is what keeps single-bundle serving
 * byte-identical by default (spec: fleet runtime §2): a bundle that never
 * configures `ANVIL_PRINCIPALS` never sees a scope denial it did not have
 * before.
 */
export function resolvePrincipal(resolved: Principal | undefined): Principal {
  return resolved ?? ANONYMOUS_PRINCIPAL;
}
