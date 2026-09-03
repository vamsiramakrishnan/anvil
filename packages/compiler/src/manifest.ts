import {
  type AsyncContract,
  type AuthProvider,
  AuthType,
  authCoherenceIssues,
  type Capability,
  type Diagnostic,
  MAX_RETRY_ATTEMPTS,
  type Operation,
  type RetryCondition,
  SQL_DIALECTS,
  STREAM_MAX_EVENTS_CEILING,
  STREAM_MAX_SECONDS_CEILING,
  snakeCase,
  type WebhookContract,
  type WebhookSignatureVerification,
  type Workflow,
} from "@anvil/air";
import { analyzeTemplate, lexicalFamily } from "@anvil/grammar";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { classifyAuth, classifyConfirmation, classifyEffect, classifyRetry } from "./classify.js";
import { projectRoutingNames, singularize } from "./naming.js";
import { analyzeSqlTemplate, supportedSqlDialects } from "./sql-grammar.js";

const ManifestAuthProvider = z.object({
  token_endpoint: z.string().url().optional(),
  grant: z.enum(["token_exchange", "client_credentials", "jwt_bearer"]).optional(),
  client_auth: z.enum(["client_secret_basic", "client_secret_post", "private_key_jwt"]).optional(),
  resource: z.string().optional(),
  subject_token_type: z.enum(["access_token", "jwt", "id_token"]).optional(),
  requested_token_type: z.enum(["access_token", "jwt", "id_token"]).optional(),
  api_key: z.object({ in: z.enum(["header", "query"]), name: z.string() }).optional(),
  /**
   * Authorization-code mechanics (RFC 6749 §4.1, PKCE per RFC 7636). Declaring
   * these is what lets `anvil auth login` run the interactive step and the
   * runtime replay/refresh the token it produces — see AuthProvider in
   * @anvil/air for the coherence rules (authorization_endpoint requires
   * token_endpoint; both are refused on any other auth type).
   */
  authorization_endpoint: z.string().url().optional(),
  pkce: z.boolean().optional(),
  redirect_uri: z.string().url().optional(),
});
type ManifestAuthProvider = z.infer<typeof ManifestAuthProvider>;

const ManifestOperationAuth = z.object({
  type: AuthType.optional(),
  credential_profile: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z](?:[a-z0-9_]{0,62}[a-z0-9])?$/)
    .optional(),
  principal: z.enum(["anonymous", "service", "end_user", "delegated", "impersonation"]).optional(),
  /** Expected token issuer. This is deliberately distinct from provider.token_endpoint. */
  issuer: z.string().url().optional(),
  audience: z.string().optional(),
  /** Exact on-wire credential carrier after any token acquisition/exchange. */
  carrier: z
    .object({
      in: z.enum(["header", "query"]),
      name: z.string().min(1),
      scheme: z.string().min(1).optional(),
    })
    .optional(),
  secret_source: z.enum(["none", "env", "secret_manager", "workload_identity", "vault"]).optional(),
  tenant: z.string().optional(),
  actor: z.string().optional(),
  subject: z.string().optional(),
  /**
   * Client-certificate material for `mtls`, by environment-variable NAME
   * only — never a value. Coherence (@anvil/air's authMechanicsIssues)
   * refuses this on any other type and refuses `mtls` without it.
   */
  tls: z
    .object({
      client_cert_ref: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
      client_key_ref: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
      ca_ref: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]*$/)
        .optional(),
    })
    .optional(),
  provider: ManifestAuthProvider.optional(),
});

export function manifestAuthProviderToAir(provider: ManifestAuthProvider): AuthProvider {
  return {
    ...(provider.token_endpoint ? { tokenEndpoint: provider.token_endpoint } : {}),
    ...(provider.grant ? { grant: provider.grant } : {}),
    ...(provider.client_auth ? { clientAuth: provider.client_auth } : {}),
    ...(provider.resource ? { resource: provider.resource } : {}),
    ...(provider.subject_token_type ? { subjectTokenType: provider.subject_token_type } : {}),
    ...(provider.requested_token_type ? { requestedTokenType: provider.requested_token_type } : {}),
    ...(provider.api_key ? { apiKey: provider.api_key } : {}),
    ...(provider.authorization_endpoint
      ? { authorizationEndpoint: provider.authorization_endpoint }
      : {}),
    ...(provider.pkce !== undefined ? { pkce: provider.pkce } : {}),
    ...(provider.redirect_uri ? { redirectUri: provider.redirect_uri } : {}),
  };
}

export function airAuthProviderToManifest(provider: AuthProvider): ManifestAuthProvider {
  return {
    ...(provider.tokenEndpoint ? { token_endpoint: provider.tokenEndpoint } : {}),
    ...(provider.grant ? { grant: provider.grant } : {}),
    ...(provider.clientAuth ? { client_auth: provider.clientAuth } : {}),
    ...(provider.resource ? { resource: provider.resource } : {}),
    ...(provider.subjectTokenType ? { subject_token_type: provider.subjectTokenType } : {}),
    ...(provider.requestedTokenType ? { requested_token_type: provider.requestedTokenType } : {}),
    ...(provider.apiKey ? { api_key: provider.apiKey } : {}),
    ...(provider.authorizationEndpoint
      ? { authorization_endpoint: provider.authorizationEndpoint }
      : {}),
    ...(provider.pkce !== undefined ? { pkce: provider.pkce } : {}),
    ...(provider.redirectUri ? { redirect_uri: provider.redirectUri } : {}),
  };
}

/**
 * Manifest mirror of `WebhookSignatureVerification` (`@anvil/air`'s
 * `async-contract.ts`) — same four real vendor shapes, snake_cased for the
 * manifest's own spelling convention. This is the ONE field in
 * `AsyncContract.webhook` no OpenAPI spec can express (§11 of the async
 * design doc: Stripe, GitHub, Twilio, Shopify, PayPal all verify webhook
 * senders through out-of-band, vendor-specific mechanics), so unlike every
 * other manifest key it has no compiler-derived counterpart to override — it
 * is the whole reason `async_contract.webhook` exists as a manifest patch at
 * all, on the same asymmetric-trust footing as Stripe's `Idempotency-Key`
 * (`docs/backtesting/reproduce/manifests/stripe.anvil.yaml`).
 */
const ManifestWebhookSignatureVerification = z.discriminatedUnion("scheme", [
  z.object({
    scheme: z.literal("hmac_sha256_header"),
    header_name: z.string(),
    encoding: z.enum(["hex", "base64"]),
    value_prefix: z.string().optional(),
    secret_ref: z.string(),
  }),
  z.object({
    scheme: z.literal("provider_sdk"),
    provider: z.enum(["stripe", "twilio", "github", "shopify"]),
    secret_ref: z.string(),
  }),
  z.object({
    scheme: z.literal("remote_verify"),
    provider: z.literal("paypal"),
    verify_endpoint_ref: z.string(),
    credential_ref: z.string(),
  }),
  z.object({
    scheme: z.literal("oidc_jwt"),
    header_name: z.string(),
    expected_issuer: z.string(),
    expected_audience_ref: z.string(),
  }),
]);
type ManifestWebhookSignatureVerification = z.infer<typeof ManifestWebhookSignatureVerification>;

export function manifestWebhookVerificationToAir(
  v: ManifestWebhookSignatureVerification,
): WebhookSignatureVerification {
  switch (v.scheme) {
    case "hmac_sha256_header":
      return {
        scheme: "hmac_sha256_header",
        headerName: v.header_name,
        encoding: v.encoding,
        ...(v.value_prefix !== undefined ? { valuePrefix: v.value_prefix } : {}),
        secretRef: v.secret_ref,
      };
    case "provider_sdk":
      return { scheme: "provider_sdk", provider: v.provider, secretRef: v.secret_ref };
    case "remote_verify":
      return {
        scheme: "remote_verify",
        provider: v.provider,
        verifyEndpointRef: v.verify_endpoint_ref,
        credentialRef: v.credential_ref,
      };
    case "oidc_jwt":
      return {
        scheme: "oidc_jwt",
        headerName: v.header_name,
        expectedIssuer: v.expected_issuer,
        expectedAudienceRef: v.expected_audience_ref,
      };
  }
}

/**
 * Manifest mirror of `WebhookContract`. `operation` must be the compiled
 * webhook operation's exact AIR id (the same coordinate
 * `resolveAsyncContract` looks up with — `operationsById.get(...)`, not the
 * fuzzy `operationMatchesKey` resolution the rest of this file uses — because
 * `resolveAsyncContract` runs downstream of manifest application with only
 * the id to go on). `job_id_field` and `state_field` are still accepted here
 * even where `normalize.ts`'s `callbacks:` auto-detection already derived a
 * candidate (`asyncContract.webhook` evidence claim): that candidate is
 * evidence for a human to read, never a value the compiler writes on its own,
 * so the manifest always states the final field paths explicitly.
 */
const ManifestWebhookContract = z.object({
  operation: z.string(),
  job_id_field: z.string(),
  state_field: z.string().optional(),
  signature_verification: ManifestWebhookSignatureVerification,
});
type ManifestWebhookContract = z.infer<typeof ManifestWebhookContract>;

export function manifestWebhookContractToAir(m: ManifestWebhookContract): WebhookContract {
  return {
    webhookOperationId: m.operation,
    webhookJobIdField: m.job_id_field,
    ...(m.state_field !== undefined ? { webhookStateField: m.state_field } : {}),
    signatureVerification: manifestWebhookVerificationToAir(m.signature_verification),
  };
}

/**
 * Manifest mirror of `AsyncContract`, for the same reason `idempotency` is:
 * a real vendor spec routinely cannot express how a call completes (no
 * declared `202`/status route, and never a `callbacks:`/`webhooks:` link —
 * §11's Stripe/GitHub/Twilio evidence), so a human states the whole contract
 * by hand. Every field mirrors `AsyncContract`/`WebhookContract` exactly;
 * `webhook` is the piece `normalize.ts` can partially derive from an explicit
 * `callbacks:` link (recorded as evidence, never written to the operation —
 * see `normalize.ts#attachWebhookLinks`) but can NEVER complete alone, because
 * `signature_verification` has no spec-native source for any real vendor.
 */
const ManifestAsyncContract = z.object({
  status_operation: z.string().optional(),
  status_job_id_param: z.string().optional(),
  job_id_field: z.string().optional(),
  state_field: z.string().optional(),
  terminal_states: z.array(z.string()).optional(),
  pending_states: z.array(z.string()).optional(),
  poll_interval_seconds: z.number().int().positive().optional(),
  webhook: ManifestWebhookContract.optional(),
});
export type ManifestAsyncContract = z.infer<typeof ManifestAsyncContract>;

/**
 * The supplemental Anvil manifest (spec §4). Specs are incomplete; this is how
 * humans or classifiers enrich the model. Enrichment is explicit, diffable, and
 * overrides inference. Matching is by operationId, canonicalName, or AIR id.
 */
export const OperationManifest = z.object({
  side_effect: z.enum(["read", "mutation"]).optional(),
  risk: z.enum(["none", "low", "medium", "high", "financial", "destructive"]).optional(),
  reversible: z.boolean().optional(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  /**
   * Agent-phrased routing examples for the skill surface ("refund a customer",
   * "give money back"). Workflows could always declare these; operations
   * gained them so an operator can author routing phrases directly — and so
   * `anvil benchmark` has tasks to route without waiting on the enrich loop.
   */
  intent_examples: z.array(z.string()).optional(),
  idempotency: z
    .object({
      strategy: z
        .enum(["natural", "required_request_key", "key_supported", "client_id", "none"])
        .optional(),
      key_location: z.enum(["header", "query", "body", "path"]).optional(),
      /** Exact HTTP header name when key_location is header. */
      header: z.string().optional(),
      /** Exact source parameter name when key_location is query or path. */
      parameter: z.string().optional(),
      /**
       * Exact JSON body field. A leading slash is a JSON Pointer for a nested
       * field (for example /input/idempotencyKey).
       */
      field: z.string().optional(),
    })
    .optional(),
  confirmation: z
    .object({
      required: z.boolean().optional(),
      risk: z.enum(["none", "low", "medium", "high", "financial", "destructive"]).optional(),
      reason: z.string().optional(),
      /**
       * Require explicit HUMAN sign-off, not just a model-supplied `confirm`.
       * Implies `required`. Harness hooks escalate these to the human dialog;
       * the runtime still gates on `confirm`.
       */
      human_approval: z.boolean().optional(),
    })
    .optional(),
  /** Override the descriptive action verb (list/get/create/send/…). */
  action: z
    .enum([
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
    ])
    .optional(),
  /**
   * Re-home the AGENT-FACING routing name — canonical name, CLI command, MCP
   * tool. This is the remediation for a name a router cannot follow (the
   * `weak_operation_name` deficiency): `do_transition` → `transition_issue`,
   * `get_object` → `get_customer`. Distinct from `action`, which reclassifies
   * the *effect* and is constrained to the effect-verb enum — `verb` here is a
   * free string, because a real fix ("transition") often is not an effect verb.
   * Every surface re-projects together via one `projectRoutingNames`, so the
   * CLI / MCP / code names cannot drift, and the stable operation `id` is kept
   * as identity. Set either axis; the other is read from the current name.
   */
  name: z
    .object({
      resource: z.string().optional(),
      verb: z.string().optional(),
    })
    .optional(),
  /** Whose authority the call runs under, and how it is credentialed. */
  auth: ManifestOperationAuth.optional(),
  retries: z
    .object({
      enabled: z.boolean().optional(),
      only_on: z.array(z.string()).optional(),
      max_attempts: z.number().int().min(1).max(MAX_RETRY_ATTEMPTS).optional(),
    })
    .optional(),
  /**
   * Grammar policy for a query-passthrough operation. Declaring one is the
   * reviewable act that unblocks a passthrough surface: the runtime parses the
   * `query_param` value and refuses anything the policy cannot prove safe. Like
   * every loosening, it is a human decision — declaring it moves the operation
   * off `blocked` to `review_required`, never straight to `approved`.
   */
  query_policy: z
    .object({
      query_param: z.string(),
      dialect: z.enum(SQL_DIALECTS).default("ansi"),
      allowed_statements: z
        .array(
          z.enum(["select", "insert", "update", "delete", "merge", "call", "explain", "other"]),
        )
        .optional(),
      single_statement_only: z.boolean().optional(),
      forbid_comments: z.boolean().optional(),
      max_rows: z.number().int().min(1).optional(),
      allowed_tables: z.array(z.string()).optional(),
      /**
       * The operator's natural-language posture that justified this policy —
       * the intent the harness translated into the concrete bounds above (e.g.
       * "analysts get read-only access to customer tables, never PII"). Anvil
       * RECORDS this verbatim as review-gate provenance and never interprets or
       * enforces it: it is the rationale a human reviewer reads next to the
       * machine-checked grounding, not part of the enforced contract.
       */
      posture: z.string().optional(),
    })
    .optional(),
  /**
   * Catalog-derived schema knowledge for a query surface — the quality payload
   * the coding harness supplies from a data catalog (Dataplex / Unity Catalog /
   * INFORMATION_SCHEMA). Anvil grounds it (a policy's allowed_tables must exist
   * here) and renders it into the skill's schema card; the runtime never reads
   * it. Anvil never fetches a catalog itself — this is the ingest channel for
   * the intelligence the harness gathered.
   */
  query_schema: z
    .object({
      tables: z
        .array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            columns: z
              .array(
                z.object({
                  name: z.string(),
                  type: z.string().optional(),
                  description: z.string().optional(),
                  sensitivity: z.enum(["public", "internal", "sensitive", "pii"]).optional(),
                }),
              )
              .optional(),
          }),
        )
        .optional(),
      example_queries: z.array(z.object({ intent: z.string(), sql: z.string() })).optional(),
      glossary: z.array(z.object({ term: z.string(), definition: z.string() })).optional(),
    })
    .optional(),
  /**
   * Hand-supplied completion contract (poll and/or webhook) — see
   * `ManifestAsyncContract`'s own doc. Applied on top of whatever
   * `normalize.ts` already derived from the spec, never replacing it silently
   * (see `applyOperationManifest`).
   */
  async_contract: ManifestAsyncContract.optional(),
  /**
   * Declare how a paginated read is paged, when the spec did not make it
   * inferable (`classifyPagination`) and the refinement loop has not proposed
   * it. Style is required; the parameter names are validated against the
   * operation's real inputs, because a pagination contract bound to a phantom
   * parameter would teach every surface to pass an argument the wire ignores.
   */
  pagination: z
    .object({
      style: z.enum(["cursor", "page", "offset", "link"]),
      cursor_param: z.string().optional(),
      next_field: z.string().optional(),
      items_field: z.string().optional(),
      page_size_param: z.string().optional(),
      max_page_size: z.number().int().positive().optional(),
      default_page_size: z.number().int().positive().optional(),
    })
    .optional(),
  /**
   * Resize a subscription's observation window. Only the ceilings are
   * manifest-writable: the transport, the delivery semantics, and the
   * existence of a bound are compiler-owned facts, so a manifest can widen or
   * narrow the window of an operation that already streams but can never
   * create a stream, change its wire, or remove the bound that makes the call
   * terminate. The absolute ceilings are AIR's own (`StreamContractSchema`),
   * so a manifest cannot author what a hand-edited document would be refused.
   */
  stream: z
    .object({
      max_events: z.number().int().min(1).max(STREAM_MAX_EVENTS_CEILING).optional(),
      max_seconds: z.number().int().min(1).max(STREAM_MAX_SECONDS_CEILING).optional(),
    })
    .optional(),
  state: z.enum(["generated", "review_required", "approved", "deprecated", "blocked"]).optional(),
});
export type OperationManifest = z.infer<typeof OperationManifest>;

/** Project the carrier-specific manifest spelling onto AIR's single key field. */
export function manifestIdempotencyKey(
  idempotency: NonNullable<OperationManifest["idempotency"]>,
): string | undefined {
  switch (idempotency.key_location) {
    case "header":
      return idempotency.header;
    case "query":
    case "path":
      return idempotency.parameter;
    case "body":
      return idempotency.field;
    default:
      return idempotency.header ?? idempotency.parameter ?? idempotency.field;
  }
}

/**
 * A workflow authored in the manifest. Anvil never *guesses* multi-step
 * business logic; this is how a human/harness declares it. Each step names an
 * operation (by operationId / canonicalName / AIR id).
 */
export const WorkflowManifest = z.object({
  display_name: z.string().optional(),
  description: z.string().optional(),
  /** Capability id/name to attach to. Defaults to the first step's capability. */
  capability: z.string().optional(),
  intent_examples: z.array(z.string()).optional(),
  human_approval: z.boolean().optional(),
  rollback: z.string().optional(),
  state: z.enum(["generated", "review_required", "approved", "deprecated", "blocked"]).optional(),
  /**
   * Operation references this workflow REPLACES on the MCP tool surface — the
   * subtractive half of composition (see `Workflow.supersedes` in `@anvil/air`).
   * Each entry must resolve to an operation this workflow already names as a
   * step; `buildWorkflows` blocks the workflow otherwise rather than emitting a
   * suppression it cannot justify.
   */
  supersedes: z.array(z.string()).optional(),
  steps: z
    .array(
      z.object({
        operation: z.string(),
        description: z.string().optional(),
        optional: z.boolean().optional(),
        bindings: z.record(z.string(), z.string()).optional(),
      }),
    )
    .default([]),
});
export type WorkflowManifest = z.infer<typeof WorkflowManifest>;

/**
 * One entry under `capabilities`, doing either or both of two jobs.
 *
 * REVIEW (the original job): keys are exact AIR capability ids; `state` records
 * the human decision about a grouping deterministic discovery already produced.
 * Review must bind to the grouping that discovery actually produced, never a
 * fuzzy label that could drift.
 *
 * AUTHOR (`operations` present): declare a capability discovery could not
 * produce — the consumer for a traffic-observed grouping
 * (`anvil capability propose --from-records`) or any harness-proposed one. The
 * entry's key becomes the new capability's id; members resolve by AIR id,
 * canonicalName, or the source operationId, exactly like every other manifest
 * operation reference. Authoring is NOT approval: an authored capability lands
 * in AIR with `source: "manifest"` and `lifecycle: "proposed"`, and goes
 * through the same review gates — including the disclosure budget — as any
 * discovered grouping. Add `state: approved` to the same entry to review it in
 * the same compile, through exactly the same gate. Authoring a capability also
 * grants nothing to its member operations, which keep their own approval
 * lifecycle untouched.
 */
export const CapabilityReviewManifest = z
  .object({
    state: z.enum(["approved", "rejected"]).optional(),
    note: z.string().optional(),
    /** Deliberate override for approval above the hard tool-disclosure budget. */
    allow_large: z.boolean().optional(),
    /** Authoring: agent-facing name for the authored capability. */
    display_name: z.string().optional(),
    /** Authoring: what the task-shaped unit accomplishes. */
    description: z.string().optional(),
    /** Authoring: intent phrases an agent might use to find this capability. */
    intent_examples: z.array(z.string()).optional(),
    /**
     * Authoring marker: the member operation references. Present = this entry
     * authors a new capability. An empty list is refused — a capability that
     * exposes nothing is not a capability, and silently creating one would look
     * like a successful review of nothing.
     */
    operations: z
      .array(z.string())
      .min(1, "an authored capability must name at least one member operation")
      .optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.operations === undefined) {
      if (entry.state === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["state"],
          message:
            "a capability entry must review a discovered grouping (state) or author a new one (operations)",
        });
      }
      for (const field of ["display_name", "description", "intent_examples"] as const) {
        if (entry[field] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `${field} is authoring input and requires the entry to author a grouping (operations); a review cannot rename what discovery produced`,
          });
        }
      }
    }
    if (entry.operations !== undefined && entry.state === "rejected") {
      ctx.addIssue({
        code: "custom",
        path: ["state"],
        message:
          "authoring a capability and rejecting it in the same entry is a contradiction; remove the entry instead",
      });
    }
    if (entry.state !== "approved" && entry.allow_large !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["allow_large"],
        message: "allow_large is valid only for an approved capability review",
      });
    }
    if (entry.allow_large === true && !entry.note?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["note"],
        message: "a non-empty review note is required when allow_large is true",
      });
    }
  });
export type CapabilityReviewManifest = z.infer<typeof CapabilityReviewManifest>;

/**
 * A parameterized, read-only, capped query template that safely wraps an
 * unconstrained query-language operation. Templates declare fixed query text
 * with {param} placeholders and typed param definitions. Each template compiles
 * into a new derived operation with archetype "search" and state "review_required".
 *
 * Substitution at runtime is literal characters only — Anvil does not know the
 * target query language's quoting rules, so a param value containing quotes can
 * still terminate a string literal inside the template. Authors should constrain
 * each param's schema (pattern, enum, maxLength) to the shape the query slot
 * actually needs; the reviewer approving the derived operation is signing off on
 * those constraints as much as on the template text.
 */
export const QueryTemplateManifest = z
  .object({
    operation: z.string(),
    template: z.string(),
    target_param: z.string(),
    params: z.record(
      z.string(),
      z.object({
        schema: z.record(z.string(), z.unknown()),
        description: z.string().optional(),
      }),
    ),
    read_only: z.literal(true),
    max_rows: z.number().int().min(1).optional(),
    /** SQL dialect for grammar-aware substitution and (later) the query guard. */
    dialect: z.enum(SQL_DIALECTS).default("ansi"),
  })
  .superRefine((template, ctx) => {
    // Extract placeholders from the template string (e.g., {param_name})
    const placeholderMatch = template.template.match(/\{[^}]+\}/g) || [];
    const placeholders = new Set(placeholderMatch.map((p) => p.slice(1, -1)));

    // Check that every placeholder has a corresponding params entry
    for (const placeholder of placeholders) {
      if (!(placeholder in template.params)) {
        ctx.addIssue({
          code: "custom",
          path: ["template"],
          message: `Template contains placeholder '{${placeholder}}' but no matching entry in params.`,
        });
      }
    }

    // Check that every params entry is used in the template
    for (const paramName of Object.keys(template.params)) {
      if (!placeholders.has(paramName)) {
        ctx.addIssue({
          code: "custom",
          path: ["params"],
          message: `Parameter '${paramName}' is declared but never used in the template.`,
        });
      }
    }

    // Grammar gate: every placeholder must sit in a LITERAL position, and the
    // template must be a single read statement. This is authoring-time, so it
    // uses a REAL parser (node-sql-parser via analyzeSqlTemplate) for an exact
    // verdict — a placeholder in an identifier position (`FROM {table}`), a
    // multi-statement template, or anything that does not parse is rejected here
    // and can never reach the runtime renderer. The lean tokenizer-based
    // `analyzeTemplate` is a portable fallback for dialects the parser does not
    // cover, so the gate degrades safe rather than open.
    const dialect = template.dialect ?? "ansi";
    const parsed = supportedSqlDialects().includes(dialect)
      ? analyzeSqlTemplate(template.template, dialect)
      : undefined;
    // Use the real parser when it produced a verdict; fall back to the lean
    // tokenizer analyzer for an unsupported dialect OR when the parser is
    // unavailable (a browser bundle with no Node require). Either way the gate
    // degrades safe — never open.
    const parserVerdict = parsed && !(parsed.ok === false && parsed.code === "parser_unavailable");
    if (parsed && parserVerdict) {
      if (!parsed.ok) {
        ctx.addIssue({
          code: "custom",
          path: ["template"],
          message: `Template is not grammar-safe: ${parsed.message}`,
        });
      } else if (parsed.statementType !== "select") {
        ctx.addIssue({
          code: "custom",
          path: ["template"],
          message: `Query templates must be read-only SELECT statements; got '${parsed.statementType}'.`,
        });
      }
    } else {
      // The lean fallback tokenizes under a lexical family, not the warehouse
      // name — collapse it so a browser-bundle `bigquery` template still lexes.
      const analysis = analyzeTemplate(template.template, lexicalFamily(dialect));
      if (!analysis.ok) {
        ctx.addIssue({
          code: "custom",
          path: ["template"],
          message: `Template is not grammar-safe: ${analysis.message}`,
        });
      }
    }
  });
export type QueryTemplateManifest = z.infer<typeof QueryTemplateManifest>;

export const AnvilManifest = z.object({
  service: z
    .object({
      name: z.string().optional(),
      display_name: z.string().optional(),
      owner: z.string().optional(),
      environment: z.string().optional(),
    })
    .optional(),
  auth: ManifestOperationAuth.extend({
    // `oauth2` is retained only as a legacy, scope-only declaration. It is too
    // ambiguous to select client credentials versus end-user/OBO authority.
    type: z.union([AuthType, z.literal("oauth2")]).optional(),
    scopes: z.array(z.string()).optional(),
  }).optional(),
  /**
   * Declare the estate's path grammar outright, overriding the compiler's
   * evidence-based classification (`service.source.pathGrammar`). The intended
   * use is settling a `path_grammar_ambiguous` compile warning; a declaration
   * that contradicts a definite measured verdict still applies — the operator
   * may know the API better than the counts — but is recorded as a
   * `path_grammar_override_contradicts_evidence` warning rather than applied
   * silently. `ambiguous` is deliberately not declarable: an override must
   * settle the question, not un-settle it.
   */
  path_grammar: z
    .enum(["resource_grammar", "rpc_plain", "rpc_dotted", "adapter_lowered"])
    .optional(),
  operations: z.record(z.string(), OperationManifest).default({}),
  workflows: z.record(z.string(), WorkflowManifest).default({}),
  capabilities: z.record(z.string(), CapabilityReviewManifest).default({}),
  query_templates: z.record(z.string(), QueryTemplateManifest).default({}),
});
export type AnvilManifest = z.infer<typeof AnvilManifest>;

export function parseManifest(text: string): AnvilManifest {
  return AnvilManifest.parse(parseYaml(text));
}

const STRATEGY_TO_MODE = {
  natural: "natural",
  required_request_key: "required",
  key_supported: "key_supported",
  client_id: "client_id",
  none: "none",
} as const;

function normalizeCondition(entry: string): RetryCondition | null {
  const map: Record<string, RetryCondition> = {
    timeout: "timeout",
    connection_reset: "connection_reset",
    dns_failure: "dns_failure",
    unavailable: "grpc_unavailable",
    deadline_exceeded: "grpc_deadline_exceeded",
    soap_transport_fault: "soap_transport_fault",
  };
  const lower = entry.toLowerCase();
  if (map[lower]) return map[lower] as RetryCondition;
  if (/^\d{3}$/.test(entry)) return `http_${entry}` as RetryCondition;
  if (lower.startsWith("http_")) return lower as RetryCondition;
  return null;
}

/**
 * Which manifest keys match an operation: its AIR id, canonical name, or the
 * source's own operationId. Exported so the overlay layer resolves an operation
 * target with exactly the same rule the manifest uses (one matcher, no drift).
 */
export function operationMatchesKey(op: Operation, key: string): boolean {
  return op.id === key || op.canonicalName === key || op.sourceRef.operationId === key;
}
const matches = operationMatchesKey;

function providerAfterTypeChange(
  current: AuthProvider | undefined,
  type: Operation["auth"]["type"],
): AuthProvider | undefined {
  switch (type) {
    case "oauth2_client_credentials":
      return {
        ...(current?.tokenEndpoint ? { tokenEndpoint: current.tokenEndpoint } : {}),
        ...(current?.clientAuth ? { clientAuth: current.clientAuth } : {}),
        ...(current?.resource ? { resource: current.resource } : {}),
        grant: "client_credentials",
      };
    case "oauth2_on_behalf_of":
      return {
        ...(current?.tokenEndpoint ? { tokenEndpoint: current.tokenEndpoint } : {}),
        ...(current?.clientAuth ? { clientAuth: current.clientAuth } : {}),
        ...(current?.resource ? { resource: current.resource } : {}),
        ...(current?.subjectTokenType ? { subjectTokenType: current.subjectTokenType } : {}),
        ...(current?.requestedTokenType ? { requestedTokenType: current.requestedTokenType } : {}),
        grant: "token_exchange",
      };
    case "oauth2_authorization_code":
      return current?.tokenEndpoint
        ? {
            tokenEndpoint: current.tokenEndpoint,
            ...(current.authorizationEndpoint
              ? { authorizationEndpoint: current.authorizationEndpoint }
              : {}),
            ...(current.pkce !== undefined ? { pkce: current.pkce } : {}),
            ...(current.redirectUri ? { redirectUri: current.redirectUri } : {}),
          }
        : undefined;
    case "api_key":
      return current?.apiKey ? { apiKey: current.apiKey } : undefined;
    case "jwt_bearer":
      return current?.grant === "jwt_bearer"
        ? {
            ...(current.tokenEndpoint ? { tokenEndpoint: current.tokenEndpoint } : {}),
            ...(current.clientAuth ? { clientAuth: current.clientAuth } : {}),
            ...(current.resource ? { resource: current.resource } : {}),
            grant: "jwt_bearer",
          }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Apply one operation's manifest entry, returning a new enriched operation.
 * Manifest values win over inference; anything left unset is recomputed so the
 * result stays internally consistent (idempotency/retry/confirmation coherent).
 *
 * This is the single semantic-override *application* path. The overlay layer
 * (`contract/`) resolves any number of policy overlays into one effective
 * `OperationManifest` per operation and applies it through exactly this
 * function, so a manifest override and a gateway/investigation overlay never
 * diverge in how they mutate an operation.
 */
export function applyOperationManifest(original: Operation, m: OperationManifest): Operation {
  const op: Operation = structuredClone(original);

  if (m.side_effect && m.side_effect !== op.effect.kind) {
    const resource = op.effect.resource;
    const method = op.sourceRef.method;
    if (method) {
      const path = op.sourceRef.path ?? "";
      const segments = path.split("/").filter(Boolean);
      const endsWithParam =
        segments.length > 0 && (segments[segments.length - 1] as string).startsWith("{");
      const declaredIntentSignals = [op.sourceRef.operationId, op.displayName].filter(
        (value): value is string => Boolean(value),
      );
      const signal =
        `${op.sourceRef.operationId ?? ""} ${op.displayName} ${op.description} ${path}`.trim();
      const reclassified = classifyEffect(
        method,
        signal,
        endsWithParam,
        m.side_effect,
        declaredIntentSignals,
      );
      op.effect = { ...reclassified.effect, resource };
      op.idempotency = reclassified.idempotency;
    } else if (m.side_effect === "read") {
      // Imported/manual AIR may lack an HTTP method. Still move every safety
      // derivative to the conservative read baseline instead of retaining a
      // mutation action/risk/idempotency tuple under a flipped kind.
      op.effect = {
        ...op.effect,
        kind: "read",
        action: "list",
        risk: "none",
        reversible: true,
      };
      op.idempotency = { mode: "natural", mechanism: "none", keyDerivation: "none" };
    } else {
      op.effect = {
        ...op.effect,
        kind: "mutation",
        action: "other",
        risk: "medium",
        reversible: true,
      };
      op.idempotency = { mode: "none", mechanism: "none", keyDerivation: "none" };
    }
  }
  if (m.risk) op.effect.risk = m.risk;
  if (m.reversible !== undefined) op.effect.reversible = m.reversible;
  if (m.action) op.effect.action = m.action;
  if (m.display_name) op.displayName = m.display_name;
  if (m.description) op.description = m.description;
  if (m.intent_examples) op.skill.intentExamples = [...m.intent_examples];

  // Re-home the agent-facing routing names from one (service, resource, verb)
  // triple, so canonicalName / CLI command / MCP tool cannot drift apart. Only
  // these three change — the operation `id` stays as its stable identity (an
  // authored rename is not a new operation), and callers keep matching it. Any
  // re-projection can reintroduce a name collision the pre-overlay resolver
  // already settled, so `compile` re-runs `resolveNameCollisions` afterwards.
  if (m.name?.resource || m.name?.verb) {
    const serviceId = op.id.split(".")[0] ?? "";
    const resource = m.name.resource ?? op.effect.resource ?? serviceId;
    const verb = m.name.verb ?? (op.canonicalName.split("_")[0] as string) ?? "other";
    const projected = projectRoutingNames(serviceId, resource, verb);
    op.canonicalName = projected.canonicalName;
    op.cli.command = projected.cliCommand;
    op.mcp.toolName = projected.toolName;
    if (m.name.resource) op.effect.resource = singularize(resource);
    // The name is now operator-authored — clear the low-confidence naming signal
    // so `critiqueNames` no longer flags an operation the human just fixed.
    const nq = op.evidence.claims.find((c) => c.predicate === "name.quality");
    if (nq) {
      nq.value = op.canonicalName;
      nq.confidence = 0.95;
      nq.note = "name re-homed by manifest";
    }
  }

  if (m.auth) {
    const typeChanged = Boolean(m.auth.type && m.auth.type !== op.auth.type);
    if (m.auth.type) {
      op.auth.type = m.auth.type;
      const defaults = classifyAuth(m.auth.type);
      op.auth.principal = m.auth.principal ?? defaults.principal;
      op.auth.secretSource = m.auth.secret_source ?? defaults.secretSource;
      if (typeChanged) {
        op.auth.provider = providerAfterTypeChange(op.auth.provider, m.auth.type);
        op.auth.issuer = undefined;
        op.auth.carrier = undefined;
        op.auth.tls = undefined;
        if (m.auth.type === "none") {
          op.auth.audience = undefined;
          op.auth.delegation = undefined;
          op.auth.tenant = undefined;
        } else if (m.auth.type !== "oauth2_on_behalf_of") {
          op.auth.delegation = undefined;
        }
      }
    }
    if (m.auth.credential_profile) op.auth.credentialProfile = m.auth.credential_profile;
    if (m.auth.principal) op.auth.principal = m.auth.principal;
    if (m.auth.issuer) op.auth.issuer = m.auth.issuer;
    if (m.auth.audience) op.auth.audience = m.auth.audience;
    if (m.auth.carrier) op.auth.carrier = m.auth.carrier;
    if (m.auth.secret_source) op.auth.secretSource = m.auth.secret_source;
    if (m.auth.tenant) op.auth.tenant = m.auth.tenant;
    if (m.auth.actor || m.auth.subject) {
      op.auth.delegation = { actor: m.auth.actor, subject: m.auth.subject };
    }
    if (m.auth.tls) {
      op.auth.tls = {
        clientCertRef: m.auth.tls.client_cert_ref,
        clientKeyRef: m.auth.tls.client_key_ref,
        ...(m.auth.tls.ca_ref ? { caRef: m.auth.tls.ca_ref } : {}),
      };
    }
    if (m.auth.provider) {
      op.auth.provider = {
        ...op.auth.provider,
        ...manifestAuthProviderToAir(m.auth.provider),
      };
    }
  }

  if (m.idempotency?.strategy) {
    op.idempotency.mode = STRATEGY_TO_MODE[m.idempotency.strategy];
    if (m.idempotency.key_location) op.idempotency.mechanism = m.idempotency.key_location;
    const key = manifestIdempotencyKey(m.idempotency);
    if (key) op.idempotency.key = key;
    // Keep the public contract honest:
    // - required_request_key means the caller must choose and reuse the
    //   business-operation key surfaced by CLI/MCP/hooks;
    // - key_supported may safely fall back to a deterministic request
    //   fingerprint when the caller does not provide the optional key.
    //
    // Treating both modes as request_fingerprint made direct CLI execution
    // silently derive a key while every other generated surface called the
    // same field required.
    if (op.idempotency.mode === "required") {
      op.idempotency.keyDerivation = "client_supplied";
    } else if (op.idempotency.mode === "key_supported") {
      op.idempotency.keyDerivation = "request_fingerprint";
    }
  }

  // Recompute derived policy so idempotency/retry/confirmation stay coherent,
  // then let explicit manifest values override.
  op.retries = classifyRetry(op.effect, op.idempotency);
  op.confirmation = classifyConfirmation(op.effect, op.idempotency);

  if (m.retries) {
    if (m.retries.enabled === false) {
      op.retries = { ...op.retries, mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] };
    } else if (m.retries.enabled === true) {
      op.retries.mode = "safe";
      if (op.retries.backoff === "none") op.retries.backoff = "exponential_jitter";
    }
    if (m.retries.only_on) {
      const conds = m.retries.only_on
        .map(normalizeCondition)
        .filter((c): c is RetryCondition => c !== null);
      if (conds.length) op.retries.retryOn = conds;
    }
    if (m.retries.max_attempts) op.retries.maxAttempts = m.retries.max_attempts;
  }

  if (m.confirmation) {
    if (m.confirmation.required !== undefined) op.confirmation.required = m.confirmation.required;
    if (m.confirmation.risk) op.confirmation.risk = m.confirmation.risk;
    if (m.confirmation.reason) op.confirmation.reason = m.confirmation.reason;
    if (m.confirmation.human_approval !== undefined) {
      op.confirmation.humanApproval = m.confirmation.human_approval;
      // A human-approval gate is meaningless without a gate: escalating implies
      // the operation confirms. Tightening only, so this is always safe.
      if (m.confirmation.human_approval) {
        op.confirmation.required = true;
        if (!op.confirmation.reason) {
          op.confirmation.reason = "This operation requires explicit human approval.";
        }
      }
    }
  }

  // Query grammar policy: declaring one is the reviewable unblock of a
  // query-passthrough surface. The runtime enforces it; here we record it and,
  // when the operation was blocked purely as an unguarded passthrough, lift it
  // to review_required so a human still signs off before exposure.
  if (m.query_policy) {
    const qp = m.query_policy;
    op.queryPolicy = {
      queryParam: qp.query_param,
      dialect: qp.dialect ?? "ansi",
      allowedStatements: qp.allowed_statements ?? ["select"],
      singleStatementOnly: qp.single_statement_only ?? true,
      forbidComments: qp.forbid_comments ?? true,
      ...(qp.max_rows !== undefined ? { maxRows: qp.max_rows } : {}),
      ...(qp.allowed_tables !== undefined ? { allowedTables: qp.allowed_tables } : {}),
      ...(qp.posture !== undefined ? { posture: qp.posture } : {}),
    };
    const note = "Query grammar policy declared — runtime parses and refuses unsafe queries.";
    if (!op.reviewNotes.includes(note)) op.reviewNotes.push(note);
    // Record the operator's stated posture verbatim as review-gate provenance —
    // the rationale a human reads next to the machine-checked grounding. Anvil
    // records it, never interprets it, so it lands in review notes, not the
    // enforced policy checks.
    if (qp.posture !== undefined) {
      const provenance = `Policy authored under operator posture (recorded, not interpreted): "${qp.posture}"`;
      if (!op.reviewNotes.includes(provenance)) op.reviewNotes.push(provenance);
    }
    if (op.state === "blocked") op.state = "review_required";
  }

  // Catalog-derived schema knowledge (quality context, not runtime-enforced).
  // Grounding — the "refuse a sloppy answer" check — happens in validate(), so
  // it wins over the passthrough-exemption's state lift.
  if (m.query_schema) {
    op.querySchema = {
      tables: (m.query_schema.tables ?? []).map((t) => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        columns: (t.columns ?? []).map((c) => ({
          name: c.name,
          ...(c.type !== undefined ? { type: c.type } : {}),
          ...(c.description !== undefined ? { description: c.description } : {}),
          ...(c.sensitivity !== undefined ? { sensitivity: c.sensitivity } : {}),
        })),
      })),
      exampleQueries: m.query_schema.example_queries ?? [],
      glossary: m.query_schema.glossary ?? [],
    };
  }

  // Hand-supplied completion contract. Merges onto whatever `normalize.ts`
  // already attached (a poll-only `AsyncContract` from `classifyAsyncContract`,
  // or nothing at all for a webhook-only API with no declared status route) —
  // an explicit manifest field always wins, an omitted one falls back to
  // what is already there, and nothing is invented for a field neither side
  // supplies. `jobIdField` is the one field every `AsyncContract` needs
  // regardless of shape (`@anvil/air`'s doc): if neither the manifest nor a
  // prior pass has it, there is nothing safe to construct, so the patch is
  // refused with a review note rather than half-applied.
  if (m.async_contract) {
    const ac = m.async_contract;
    const jobIdField = ac.job_id_field ?? op.asyncContract?.jobIdField;
    if (jobIdField) {
      const webhook: WebhookContract | undefined = ac.webhook
        ? manifestWebhookContractToAir(ac.webhook)
        : op.asyncContract?.webhook;
      const contract: AsyncContract = {
        ...((ac.status_operation ?? op.asyncContract?.statusOperationId)
          ? { statusOperationId: ac.status_operation ?? op.asyncContract?.statusOperationId }
          : {}),
        jobIdField,
        ...((ac.status_job_id_param ?? op.asyncContract?.statusJobIdParam)
          ? { statusJobIdParam: ac.status_job_id_param ?? op.asyncContract?.statusJobIdParam }
          : {}),
        ...((ac.state_field ?? op.asyncContract?.stateField)
          ? { stateField: ac.state_field ?? op.asyncContract?.stateField }
          : {}),
        terminalStates: ac.terminal_states ?? op.asyncContract?.terminalStates ?? [],
        pendingStates: ac.pending_states ?? op.asyncContract?.pendingStates ?? [],
        ...(ac.poll_interval_seconds !== undefined
          ? { pollIntervalSeconds: ac.poll_interval_seconds }
          : op.asyncContract?.pollIntervalSeconds !== undefined
            ? { pollIntervalSeconds: op.asyncContract.pollIntervalSeconds }
            : {}),
        ...(webhook ? { webhook } : {}),
      };
      op.asyncContract = contract;
      const note = ac.webhook
        ? `Completion contract enriched by manifest: webhook '${ac.webhook.operation}' ` +
          `verified via '${ac.webhook.signature_verification.scheme}'.`
        : "Completion contract enriched by manifest.";
      if (!op.reviewNotes.includes(note)) op.reviewNotes.push(note);
    } else {
      const note =
        "async_contract manifest patch left unset: no job_id_field was supplied and the " +
        "operation has no prior AsyncContract to merge onto, so no completion contract " +
        "could be constructed without inventing a coordinate.";
      if (!op.reviewNotes.includes(note)) op.reviewNotes.push(note);
    }
  }

  // Pagination is a fact about how a READ hands back a large result. On a
  // mutation it is meaningless, and a carrier parameter that names no real
  // input would teach every surface to pass an argument the wire ignores —
  // both decline with the reason, in the async_contract pattern, rather than
  // half-applying.
  if (m.pagination) {
    const inputNames = new Set(op.input.params.map((p) => p.name));
    const phantom = [m.pagination.cursor_param, m.pagination.page_size_param].filter(
      (name): name is string => name !== undefined && !inputNames.has(name),
    );
    if (op.effect.kind !== "read") {
      const note =
        "pagination manifest patch left unset: the operation is a mutation, and pagination " +
        "is a contract about how a read hands back a large result.";
      if (!op.reviewNotes.includes(note)) op.reviewNotes.push(note);
    } else if (phantom.length > 0) {
      const note =
        `pagination manifest patch left unset: parameter(s) ${phantom.map((n) => `'${n}'`).join(", ")} ` +
        `do not exist on this operation, and a pagination contract bound to a phantom parameter ` +
        `would teach every surface to pass an argument the wire ignores.`;
      if (!op.reviewNotes.includes(note)) op.reviewNotes.push(note);
    } else {
      op.pagination = {
        style: m.pagination.style,
        ...(m.pagination.cursor_param !== undefined
          ? { cursorParam: m.pagination.cursor_param }
          : {}),
        ...(m.pagination.next_field !== undefined ? { nextField: m.pagination.next_field } : {}),
        ...(m.pagination.items_field !== undefined ? { itemsField: m.pagination.items_field } : {}),
        ...(m.pagination.page_size_param !== undefined
          ? { pageSizeParam: m.pagination.page_size_param }
          : {}),
        ...(m.pagination.max_page_size !== undefined
          ? { maxPageSize: m.pagination.max_page_size }
          : {}),
        ...(m.pagination.default_page_size !== undefined
          ? { defaultPageSize: m.pagination.default_page_size }
          : {}),
      };
      const note =
        `Pagination declared by manifest: ${m.pagination.style}` +
        (m.pagination.cursor_param ? ` via '${m.pagination.cursor_param}'` : "") +
        ".";
      if (!op.reviewNotes.includes(note)) op.reviewNotes.push(note);
    }
  }

  // Resize the observation window of an operation that already streams. The
  // window's existence is what makes a subscription a call, and the compiler
  // owns that fact — so a `stream` patch on an operation with no stream
  // contract is refused with the reason rather than inventing one, exactly as
  // an `async_contract` patch with nothing to anchor to is.
  if (m.stream) {
    if (op.stream) {
      op.stream = {
        ...op.stream,
        ...(m.stream.max_events !== undefined ? { maxEvents: m.stream.max_events } : {}),
        ...(m.stream.max_seconds !== undefined ? { maxSeconds: m.stream.max_seconds } : {}),
      };
      const note =
        `Observation window resized by manifest: up to ${op.stream.maxEvents} event(s) ` +
        `or ${op.stream.maxSeconds} second(s) per call.`;
      if (!op.reviewNotes.includes(note)) op.reviewNotes.push(note);
    } else {
      const note =
        "stream manifest patch left unset: the operation does not stream, and a manifest " +
        "can resize an observation window but never create one — the window is a fact the " +
        "compiler reads from the source, not a declaration.";
      if (!op.reviewNotes.includes(note)) op.reviewNotes.push(note);
    }
  }

  if (m.state) {
    // A manifest-set state is a reviewer's decision, and every surface that
    // shows the operation (inspect, the skill, the console's decision queue)
    // must be able to say so; an unexplained review_required is a decision
    // nobody can audit. `approved` needs no note: it leaves the queue.
    if (m.state !== op.state && m.state !== "approved") {
      const note = `State set to ${m.state} by the Anvil manifest (operations.${op.id}.state).`;
      if (!op.reviewNotes.includes(note)) op.reviewNotes.push(note);
    }
    op.state = m.state;
  }

  // mtls and custom_header are executable once their material is coherent
  // (auth.tls's client cert/key, or a custom_header carrier) — the coherence
  // check itself is what says so, so the compiler no longer force-blocks
  // either type outright. oauth2_authorization_code is different: the
  // runtime CAN now replay or refresh it, but end-user authority is a human
  // decision, not a material-completeness one, so it never leaves review —
  // see the branch below rather than another line here.
  const authIssues = authCoherenceIssues(op.auth);
  if (authIssues.length > 0) {
    op.state = "blocked";
    for (const issue of authIssues) {
      const note = `Auth contract blocked: ${issue}.`;
      if (!op.reviewNotes.includes(note)) op.reviewNotes.push(note);
    }
  } else if (op.auth.type === "oauth2_authorization_code") {
    // Unconditional, and after any `m.state` override above: no manifest may
    // move this straight to approved, however complete its PKCE/token
    // mechanics are. The broker is the named, reviewable unblock.
    op.state = "review_required";
    const note =
      "Authorization-code auth stays review_required: end-user authority is a human decision, " +
      "never a material-completeness one. Run `anvil auth login <bundle> --profile <profile>` " +
      "to complete the interactive PKCE step and store a refresh token, then approve explicitly.";
    if (!op.reviewNotes.includes(note)) op.reviewNotes.push(note);
  }
  // Deliberately no query_policy-style unblock-lift here: `m.state` and
  // `m.auth` can both be present in one merged manifest for UNRELATED
  // reasons (a gateway-identity-contradiction guard overlay sets `state:
  // blocked` in the very same resolved manifest a coherent auth patch rides
  // in on — packages/cli/src/estate-identity.test.ts's real regression). A
  // clean coherence result says only "this auth is not what's blocking it,"
  // never "nothing is."

  op.evidence.claims.push({
    subject: op.id,
    predicate: "enriched",
    value: true,
    source: "spec",
    sourceRef: "anvil-manifest",
    method: "manifest",
    note: "enriched by supplemental Anvil manifest",
    confidence: 0.95,
    review: "accepted",
  });

  return op;
}

/**
 * Apply a manifest to a set of operations, returning the enriched operations.
 * Thin wrapper over {@link applyOperationManifest}: the first manifest entry that
 * matches an operation wins, and non-matching operations pass through untouched.
 */
export function enrich(operations: Operation[], manifest: AnvilManifest): Operation[] {
  return operations.map((original) => {
    const entry = Object.entries(manifest.operations).find(([key]) => matches(original, key));
    if (!entry) return original;
    return applyOperationManifest(original, entry[1]);
  });
}

/**
 * Build first-class workflows from the manifest, resolving each step's operation
 * reference to an AIR operation id and attaching the workflow to a capability.
 * A workflow is only as trustworthy as the operations it names. Unknown steps
 * cannot be represented as executable AIR references, so resolved steps remain
 * available for audit but the workflow is forced `blocked`. A mutation step is
 * likewise unusable until that operation is approved; it blocks the workflow
 * instead of leaving apparently runnable guidance that crosses the approval
 * boundary. Returns the workflows plus diagnostics, and mutates capabilities to
 * record ownership.
 */
export function buildWorkflows(
  manifest: AnvilManifest,
  operations: Operation[],
  capabilities: Capability[],
): { workflows: Workflow[]; diagnostics: Diagnostic[] } {
  const workflows: Workflow[] = [];
  const diagnostics: Diagnostic[] = [];
  const capById = new Map(capabilities.map((c) => [c.id, c]));

  for (const [name, wf] of Object.entries(manifest.workflows)) {
    const steps: Workflow["steps"] = [];
    const blockerNotes: string[] = [];
    for (const step of wf.steps) {
      const op = operations.find((o) => matches(o, step.operation));
      if (!op) {
        const note = `unknown operation "${step.operation}"`;
        blockerNotes.push(note);
        diagnostics.push({
          level: "error",
          code: "workflow_step_unresolved",
          message: `Workflow "${name}" references ${note}; the workflow is blocked until the reference is repaired.`,
        });
        continue;
      }
      steps.push({
        operationId: op.id,
        description: step.description ?? op.displayName,
        optional: step.optional ?? false,
        bindings: step.bindings ?? {},
      });
      if (op.effect.kind === "mutation" && op.state !== "approved") {
        const note = `mutation "${step.operation}" resolves to ${op.id} in state "${op.state}"`;
        blockerNotes.push(note);
        diagnostics.push({
          level: "warning",
          code: "workflow_mutation_unapproved",
          operationId: op.id,
          message: `Workflow "${name}" ${note}; the workflow is blocked until the mutation is approved.`,
        });
      }
    }

    // Resolve what this workflow supersedes, against the operations it actually
    // performs. Two failure modes, both blocking rather than silently dropped: a
    // reference that names no operation at all, and one that names a real
    // operation this workflow does not run. The second is the dangerous one — it
    // would remove a tool the composite cannot stand in for — so it is refused
    // here as well as in the AIR schema's own refinement, and the workflow is
    // blocked exactly the way an unresolved step blocks it.
    const stepOperationIds = new Set(steps.map((step) => step.operationId));
    const supersedes: string[] = [];
    for (const reference of wf.supersedes ?? []) {
      const target = operations.find((o) => matches(o, reference));
      if (!target) {
        const note = `supersedes unknown operation "${reference}"`;
        blockerNotes.push(note);
        diagnostics.push({
          level: "error",
          code: "workflow_supersedes_unresolved",
          message: `Workflow "${name}" ${note}; the workflow is blocked until the reference is repaired.`,
        });
        continue;
      }
      if (!stepOperationIds.has(target.id)) {
        const note = `supersedes "${reference}" (${target.id}), which is not one of its own steps`;
        blockerNotes.push(note);
        diagnostics.push({
          level: "error",
          code: "workflow_supersedes_not_a_step",
          operationId: target.id,
          message:
            `Workflow "${name}" ${note}; a workflow may only replace operations it performs. ` +
            "The workflow is blocked until the reference is removed or the step is added.",
        });
        continue;
      }
      if (supersedes.includes(target.id)) continue;
      supersedes.push(target.id);
    }

    // Resolve the owning capability: explicit, else the first step's capability.
    const firstOpCap = steps.length
      ? operations.find((o) => o.id === steps[0]?.operationId)?.capabilityId
      : undefined;
    const capabilityId = resolveCapabilityId(wf.capability, firstOpCap, capabilities);
    if (!capabilityId) {
      diagnostics.push({
        level: "warning",
        code: "workflow_capability_unresolved",
        message: `Workflow "${name}" could not be attached to a capability; skipped.`,
      });
      continue;
    }

    const id = `${capabilityId}.${snakeCase(name)}`;
    const blocked = blockerNotes.length > 0;
    workflows.push({
      id,
      capabilityId,
      displayName: wf.display_name ?? titleCase(name),
      description: wf.description ?? "",
      intentExamples: wf.intent_examples ?? [],
      steps,
      humanApproval: wf.human_approval ?? false,
      rollbackStrategy: wf.rollback,
      // Absent, not empty, when nothing is superseded: a workflow authored
      // before this field existed must serialize byte-identically.
      ...(supersedes.length > 0 ? { supersedes } : {}),
      state: blocked ? "blocked" : (wf.state ?? "generated"),
      evidence: {
        claims: [
          {
            subject: id,
            predicate: "authored",
            value: true,
            source: "spec",
            sourceRef: "anvil-manifest",
            method: "manifest",
            note: "authored workflow",
            confidence: 0.95,
            review: "accepted",
          },
          ...(blocked
            ? [
                {
                  subject: id,
                  predicate: "workflow.executable",
                  value: false,
                  source: "inferred" as const,
                  sourceRef: "anvil-manifest",
                  method: "workflow_dependency_gate",
                  note: `Blocked: ${blockerNotes.join("; ")}.`,
                  confidence: 1,
                  review: "accepted" as const,
                },
              ]
            : []),
        ],
      },
    });
    capById.get(capabilityId)?.workflowIds.push(id);
  }

  return { workflows, diagnostics };
}

/**
 * Build derived operations from query templates, resolving each template's base
 * operation and creating a new operation whose input params are the template's
 * typed params. A template on a mutation base op is a manifest validation error
 * and blocks derivation. Returns the derived operations plus diagnostics, and
 * mutates capabilities to record ownership.
 */
export function buildQueryTemplates(
  manifest: AnvilManifest,
  operations: Operation[],
  capabilities: Capability[],
): { operations: Operation[]; diagnostics: Diagnostic[] } {
  const derived: Operation[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const [name, template] of Object.entries(manifest.query_templates)) {
    // Resolve the base operation
    const baseOp = operations.find((o) => matches(o, template.operation));
    if (!baseOp) {
      diagnostics.push({
        level: "error",
        code: "query_template_operation_unresolved",
        message: `Query template "${name}" references unknown operation "${template.operation}"; the template is skipped.`,
      });
      continue;
    }

    // Reject templates on mutation operations
    if (baseOp.effect.kind === "mutation") {
      diagnostics.push({
        level: "error",
        code: "query_template_mutation_invalid",
        message: `Query template "${name}" targets mutation operation "${template.operation}"; templates are read-only and cannot wrap mutations.`,
        operationId: baseOp.id,
      });
      continue;
    }

    // Resolve the target param on the base operation to determine its location.
    // Derived operation params have in: set to match the base operation's targetParam location.
    // If targetParam is in "body", derived params are in "body"; otherwise use the target's location
    // (typically "query" for parameterized query templates).
    const targetParam = baseOp.input.params.find((p) => p.name === template.target_param);
    const derivedParamIn =
      targetParam && targetParam.in === "body"
        ? ("body" as const)
        : (targetParam?.in ?? ("query" as const));

    // Create derived operation with input params from the template
    const templateId = `${baseOp.id}.tpl.${snakeCase(name)}`;
    const templateCanonicalName = `${baseOp.canonicalName}_tpl_${snakeCase(name)}`;
    const projected = projectRoutingNames(
      templateId.split(".")[0] ?? "",
      baseOp.effect.resource ?? "template",
      templateCanonicalName,
    );

    const derivedOp: Operation = {
      id: templateId,
      canonicalName: templateCanonicalName,
      displayName: `${baseOp.displayName} (${name})`,
      description: `Safe parameterized query: ${template.template}`,
      tags: [...baseOp.tags],
      sourceRef: baseOp.sourceRef,
      effect: {
        kind: "read",
        action: "search",
        risk: "low",
        reversible: true,
      },
      input: {
        params: Object.entries(template.params).map(([paramName, paramSpec]) => ({
          name: paramName,
          in: derivedParamIn,
          required: true,
          schema: paramSpec.schema ?? { type: "string" },
          description: paramSpec.description,
          inferred: false,
        })),
      },
      output: baseOp.output,
      errors: baseOp.errors,
      idempotency: { mode: "natural", mechanism: "none", keyDerivation: "none" },
      retries: {
        mode: "safe",
        // A derived template op is a read by construction (mutation bases are
        // rejected above) — "unproven" here would be the very deficiency the
        // retry-basis detector flags.
        basis: "read_safe",
        maxAttempts: 3,
        backoff: "exponential_jitter",
        baseDelayMs: 200,
        maxDelayMs: 20000,
        retryOn: ["timeout", "grpc_unavailable"],
      },
      confirmation: { required: false },
      auth: baseOp.auth,
      archetype: "search",
      streaming: false,
      longRunning: false,
      deprecated: false,
      cli: { command: projected.cliCommand, aliases: [] },
      mcp: { toolName: projected.toolName },
      skill: { intentExamples: [] },
      state: "review_required",
      reviewNotes: ["Query template — requires explicit review before approval."],
      evidence: {
        claims: [
          {
            subject: templateId,
            predicate: "authored",
            value: true,
            source: "spec",
            sourceRef: "anvil-manifest",
            method: "manifest",
            note: "authored query template",
            confidence: 0.95,
            review: "accepted",
          },
        ],
      },
      capabilityId: baseOp.capabilityId,
      queryTemplate: {
        baseOperationId: baseOp.id,
        template: template.template,
        targetParam: template.target_param,
        dialect: template.dialect ?? "ansi",
      },
    };

    derived.push(derivedOp);

    // Record ownership in the base operation's capability
    if (baseOp.capabilityId) {
      const cap = capabilities.find((c) => c.id === baseOp.capabilityId);
      if (cap) {
        cap.operationIds.push(templateId);
      }
    }
  }

  return { operations: derived, diagnostics };
}

function resolveCapabilityId(
  explicit: string | undefined,
  fallback: string | undefined,
  capabilities: Capability[],
): string | undefined {
  if (explicit) {
    const hit = capabilities.find(
      (c) => c.id === explicit || c.id.endsWith(`.${explicit}`) || c.displayName === explicit,
    );
    if (hit) return hit.id;
  }
  return fallback;
}

const titleCase = (s: string): string =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
