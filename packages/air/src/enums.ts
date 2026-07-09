import { z } from "zod";

/**
 * Canonical enums and taxonomies shared by every Anvil stage and artifact.
 * These are the vocabulary of AIR: if a value is not listed here, the compiler
 * does not understand it, and the safety validator will flag it.
 */

/** What an operation does to upstream state. */
export const EffectKind = z.enum(["read", "mutation"]);
export type EffectKind = z.infer<typeof EffectKind>;

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
