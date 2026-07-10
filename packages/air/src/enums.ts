import { z } from "zod";

/**
 * Canonical enums and taxonomies shared by every Anvil stage and artifact.
 * These are the vocabulary of AIR: if a value is not listed here, the compiler
 * does not understand it, and the safety validator will flag it.
 */

/**
 * What an operation does to upstream state. This binary is the **safety core** —
 * the retry engine, confirmation gate, and idempotency ledger all pivot on it,
 * so it stays deliberately coarse and conservative (unknown ⇒ mutation).
 */
export const EffectKind = z.enum(["read", "mutation"]);
export type EffectKind = z.infer<typeof EffectKind>;

/**
 * The richer, *descriptive* action verb layered over `EffectKind`. Real systems
 * are messier than read/write, and agents route better on intent than on HTTP
 * verbs. This never overrides the safety core — it refines discovery, naming,
 * and tool metadata. Read-family: list/get/search/export/simulate/validate/poll.
 * Mutation-family: create/update/replace/delete/send/execute/approve/cancel/reserve.
 */
export const OperationAction = z.enum([
  "list",
  "get",
  "search",
  "export",
  "simulate",
  "validate",
  "poll",
  "create",
  "update",
  "replace",
  "delete",
  "send",
  "execute",
  "approve",
  "cancel",
  "reserve",
  "other",
]);
export type OperationAction = z.infer<typeof OperationAction>;

/** Read-family actions — those that (descriptively) have no side effect. */
export const READ_ACTIONS: readonly OperationAction[] = [
  "list",
  "get",
  "search",
  "export",
  "simulate",
  "validate",
  "poll",
];

/** Blast radius of an operation. Drives confirmation defaults. */
export const RiskLevel = z.enum(["none", "low", "medium", "high", "financial", "destructive"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

/**
 * Idempotency classification (spec §12). Determines whether a mutation may be
 * retried automatically.
 *   natural       — repeat is a no-op by construction (e.g. PUT by stable id)
 *   key_supported — an idempotency key is accepted but optional
 *   client_id     — caller supplies a deterministic resource id
 *   required      — an idempotency key MUST be present before execution
 *   none          — not idempotent; never auto-retry, always confirm
 */
export const IdempotencyMode = z.enum([
  "natural",
  "key_supported",
  "client_id",
  "required",
  "none",
]);
export type IdempotencyMode = z.infer<typeof IdempotencyMode>;

/** Where an idempotency key is carried. */
export const IdempotencyMechanism = z.enum(["header", "query", "body", "path", "none"]);
export type IdempotencyMechanism = z.infer<typeof IdempotencyMechanism>;

/** How an idempotency key is produced when not supplied verbatim. */
export const KeyDerivation = z.enum(["request_fingerprint", "client_supplied", "none"]);
export type KeyDerivation = z.infer<typeof KeyDerivation>;

/** Retry posture. `safe` retries transient failures; `none` never auto-retries. */
export const RetryMode = z.enum(["safe", "none"]);
export type RetryMode = z.infer<typeof RetryMode>;

/**
 * *Why* a retry posture holds — a descriptive basis over the `safe|none` gate.
 * Makes the retry decision auditable without changing the hot-path binary.
 *   read_safe            — a read; safe to repeat
 *   natural_idempotent   — repeat is a no-op by construction (PUT/DELETE by id)
 *   idempotency_key      — safe only because a key dedups the write
 *   ledger_guarded       — a durable ledger prevents duplicate execution
 *   transport_only       — only pre-send transport errors may be retried
 *   unproven             — idempotency could not be proven; never auto-retry
 */
export const RetryBasis = z.enum([
  "read_safe",
  "natural_idempotent",
  "idempotency_key",
  "ledger_guarded",
  "transport_only",
  "unproven",
]);
export type RetryBasis = z.infer<typeof RetryBasis>;

/**
 * Whose authority a call executes under — the decisive question for agent tools
 * (is it acting as the service, the end user, or on someone's behalf?).
 */
export const AuthPrincipal = z.enum([
  "anonymous",
  "service",
  "end_user",
  "delegated",
  "impersonation",
]);
export type AuthPrincipal = z.infer<typeof AuthPrincipal>;

/** Where the credential material is sourced at runtime (never the secret itself). */
export const SecretSource = z.enum(["none", "env", "secret_manager", "workload_identity", "vault"]);
export type SecretSource = z.infer<typeof SecretSource>;

export const BackoffStrategy = z.enum(["exponential_jitter", "exponential", "fixed", "none"]);
export type BackoffStrategy = z.infer<typeof BackoffStrategy>;

/**
 * Normalized transient failure conditions (spec §11). HTTP numeric statuses
 * are normalized to `http_<code>` so retry policy is transport-agnostic.
 */
export const RetryCondition = z.enum([
  "timeout",
  "connection_reset",
  "dns_failure",
  "http_408",
  "http_429",
  "http_500",
  "http_502",
  "http_503",
  "http_504",
  "grpc_unavailable",
  "grpc_deadline_exceeded",
  "soap_transport_fault",
]);
export type RetryCondition = z.infer<typeof RetryCondition>;

/** Operation approval lifecycle (spec §17). Only `approved` is exposed by default. */
export const OperationState = z.enum([
  "generated",
  "review_required",
  "approved",
  "deprecated",
  "blocked",
]);
export type OperationState = z.infer<typeof OperationState>;

/**
 * Explicit review lifecycle of a **capability grouping** — orthogonal to the
 * derived member `state`. `state` summarizes what the member operations are;
 * `lifecycle` records what a reviewer decided about the grouping itself.
 * Discovery always yields `proposed`; only an `approved` capability may be
 * compiled into a capability bundle (`anvil build`).
 */
export const CapabilityLifecycle = z.enum(["proposed", "approved", "rejected", "deprecated"]);
export type CapabilityLifecycle = z.infer<typeof CapabilityLifecycle>;

/** Supported authentication schemes (spec §13). */
export const AuthType = z.enum([
  "none",
  "api_key",
  "basic",
  "oauth2_client_credentials",
  "oauth2_authorization_code",
  "oauth2_on_behalf_of",
  "jwt_bearer",
  "mtls",
  "custom_header",
  "workload_identity",
]);
export type AuthType = z.infer<typeof AuthType>;

/** The Anvil error taxonomy (spec §10). Every failure maps to exactly one code. */
export const ErrorCode = z.enum([
  "validation_error",
  "auth_required",
  "permission_denied",
  "not_found",
  "conflict",
  "rate_limited",
  "upstream_timeout",
  "upstream_unavailable",
  "unsafe_retry_blocked",
  "confirmation_required",
  "idempotency_required",
  "idempotency_ledger_unavailable",
  "schema_mismatch",
  "unsupported_operation",
  "policy_denied",
  "unknown_upstream_error",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** HTTP verbs, as they appear in source specs. */
export const HttpMethod = z.enum([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
]);
export type HttpMethod = z.infer<typeof HttpMethod>;

/** Where a request parameter lives. */
export const ParamLocation = z.enum(["path", "query", "header", "cookie", "body"]);
export type ParamLocation = z.infer<typeof ParamLocation>;

/** Source spec kinds Anvil can parse (only `openapi` is wired in the MVP). */
export const SourceKind = z.enum(["openapi", "swagger", "wsdl", "protobuf", "graphql"]);
export type SourceKind = z.infer<typeof SourceKind>;

/** Diagnostic severity emitted by the validator. */
export const DiagnosticLevel = z.enum(["error", "warning", "info"]);
export type DiagnosticLevel = z.infer<typeof DiagnosticLevel>;
