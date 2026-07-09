import { z } from "zod";
import {
  AuthPrincipal,
  AuthType,
  BackoffStrategy,
  DiagnosticLevel,
  EffectKind,
  ErrorCode,
  HttpMethod,
  IdempotencyMechanism,
  IdempotencyMode,
  KeyDerivation,
  OperationAction,
  OperationState,
  ParamLocation,
  RetryBasis,
  RetryCondition,
  RetryMode,
  RiskLevel,
  SecretSource,
  SourceKind,
} from "./enums.js";

/**
 * A JSON Schema fragment, carried through AIR verbatim. Anvil does not
 * re-model schemas; it preserves the source's JSON Schema and layers agent
 * semantics on top.
 */
export const JsonSchema: z.ZodType<Record<string, unknown>> = z.record(z.string(), z.unknown());
export type JsonSchema = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* Evidence (harness loop)                                                    */
/* -------------------------------------------------------------------------- */

/** Where a piece of knowledge about an operation came from (spec §"AIR + Evidence"). */
export const EvidenceKind = z.enum([
  "spec", // the source API specification
  "source_impl", // server implementation in a repo
  "doc_example", // examples in docs/wiki
  "test_fixture", // existing test fixtures/contract tests
  "incident", // tickets/incidents describing real behavior
  "postman", // a Postman collection
  "recorded_traffic", // sanitized recorded traffic
  "generated_mock", // an Anvil-generated mock
  "inferred", // heuristic/classifier inference
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

/** How one claim relates to another (referenced by claim id). */
export const ClaimRelation = z.enum(["supports", "contradicts", "supersedes"]);
export type ClaimRelation = z.infer<typeof ClaimRelation>;

/** Per-claim review disposition. Rejected/superseded claims drop out of the aggregate. */
export const ReviewStatus = z.enum(["unreviewed", "accepted", "rejected", "superseded"]);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

/**
 * A **claim-scoped** piece of provenance: a single assertion about one semantic,
 * with where it came from and how much to trust it. This replaces the old flat
 * `EvidenceItem` + stored aggregate confidence — a confidence number now belongs
 * to a specific claim, not vaguely to an operation. Multiple claims about the
 * same `(subject, predicate)` may agree, conflict, or supersede one another; the
 * aggregate is *derived* from them (see `evidenceConfidence`), never stored.
 */
export const Claim = z.object({
  /** Stable id so other claims can reference this one (supports/contradicts/supersedes). */
  id: z.string().optional(),
  /** What the claim is about — the semantic target (operation id, capability id, …). */
  subject: z.string(),
  /** Which semantic is asserted, e.g. "exists", "idempotency.mode", "name.quality". */
  predicate: z.string(),
  /** The asserted value (a mode string, boolean, number, or text). */
  value: z.unknown().optional(),
  /** Origin kind of the evidence backing this claim. */
  source: EvidenceKind,
  /** Pointer to the origin (URL, file path, commit, ticket id, tool call). */
  sourceRef: z.string().optional(),
  /** Origin revision (commit sha, doc version) when known. */
  sourceRevision: z.string().optional(),
  /** How the value was extracted (declared, heuristic, regex, manifest, …). */
  method: z.string().optional(),
  /** Confidence in THIS claim's value, 0..1. */
  confidence: z.number().min(0).max(1),
  /** Reliability of the source, 0..1 (falls back to a per-kind default when unset). */
  reliability: z.number().min(0).max(1).optional(),
  /** ISO timestamp of extraction, when recorded. */
  timestamp: z.string().optional(),
  /** Relationship to another claim, by id. */
  relation: z.object({ type: ClaimRelation, target: z.string() }).optional(),
  /** Review disposition; rejected/superseded claims are excluded from the aggregate.
   *  Absent means unreviewed (still active). */
  review: ReviewStatus.optional(),
  note: z.string().optional(),
});
export type Claim = z.infer<typeof Claim>;

/**
 * The evidence attached to a semantic node: a set of claims. There is no stored
 * aggregate confidence — it is derived on demand from the active claims so it can
 * never drift from its inputs (see `evidenceConfidence`).
 */
export const Evidence = z.object({
  claims: z.array(Claim).default([]),
});
export type Evidence = z.infer<typeof Evidence>;

/** A claim counts toward the aggregate unless it was rejected or superseded. */
export function claimIsActive(c: Claim): boolean {
  return c.review !== "rejected" && c.review !== "superseded";
}

/**
 * Derive aggregate confidence from claim-level inputs — a pure function, so the
 * number is always explainable from the claims and can never be independently
 * stored or drift. Combines active claims via noisy-OR (corroboration raises
 * confidence; no single weak claim dominates), bounded to [0, 0.99].
 */
export function evidenceConfidence(evidence: Evidence): number {
  const active = evidence.claims.filter(claimIsActive);
  if (active.length === 0) return 0;
  const product = active.reduce((acc, c) => acc * (1 - c.confidence), 1);
  return Math.min(0.99, 1 - product);
}

/* -------------------------------------------------------------------------- */
/* Building blocks                                                            */
/* -------------------------------------------------------------------------- */

/** Provenance: every operation knows where it came from (spec §5.1). */
export const SourceRef = z.object({
  kind: SourceKind,
  /** REST path template, e.g. /payments/{payment_id}/refunds */
  path: z.string().optional(),
  method: HttpMethod.optional(),
  /** The source's own operation id, if any. */
  operationId: z.string().optional(),
  /** JSON pointer / SDL coordinate / WSDL operation name, when applicable. */
  pointer: z.string().optional(),
  uri: z.string().optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

/** A single request parameter with its agent-facing bindings. */
export const Param = z.object({
  name: z.string(),
  in: ParamLocation,
  required: z.boolean().default(false),
  schema: JsonSchema.default(() => ({ type: "string" })),
  description: z.string().optional(),
  example: z.unknown().optional(),
  /** Whether this value was inferred rather than declared in the spec. */
  inferred: z.boolean().default(false),
  /** CLI flag, e.g. --payment-id (derived from name). */
  cliFlag: z.string().optional(),
});
export type Param = z.infer<typeof Param>;

/**
 * A single top-level field of a request body, when the body is a flat object of
 * scalars and can be surfaced as individual CLI flags / MCP properties. This is
 * a *projection* of the body, not the body itself — the body schema is always
 * preserved verbatim on `RequestBody.schema`.
 */
export const BodyField = z.object({
  name: z.string(),
  required: z.boolean().default(false),
  schema: JsonSchema.default(() => ({ type: "string" })),
  description: z.string().optional(),
});
export type BodyField = z.infer<typeof BodyField>;

/**
 * The request body, preserved as a body. Earlier Anvil flattened bodies into
 * `in: body` params, which lost nesting, arrays-of-objects, and oneOf/anyOf.
 * Now the full body schema is kept verbatim (`schema`), and the agent surface is
 * a separate *projection*:
 *   - `fields` — a flat object of scalars, surfaced as one flag/property each.
 *   - `whole`  — anything richer (nested objects, arrays, unions); surfaced as a
 *                single `body` field carrying the full schema, so nothing is lost.
 * The CLI/MCP/skill all render from this one description — the surface shape
 * never mutates the canonical model.
 */
export const RequestBody = z.object({
  contentType: z.string().default("application/json"),
  required: z.boolean().default(false),
  /** The body's JSON Schema, preserved verbatim from the source. */
  schema: JsonSchema.default(() => ({})),
  projection: z.enum(["fields", "whole"]).default("whole"),
  /** Top-level fields when `projection === "fields"`; empty for `whole`. */
  fields: z.array(BodyField).default([]),
});
export type RequestBody = z.infer<typeof RequestBody>;

export const Effect = z.object({
  kind: EffectKind,
  /** Descriptive action verb (list/get/create/send/…); refines, never overrides, `kind`. */
  action: OperationAction.default("other"),
  resource: z.string().optional(),
  risk: RiskLevel.default("low"),
  /** Whether the effect can be undone. Irreversible mutations always confirm. */
  reversible: z.boolean().default(true),
});
export type Effect = z.infer<typeof Effect>;

export const Idempotency = z.object({
  mode: IdempotencyMode,
  mechanism: IdempotencyMechanism.default("none"),
  /** Header/query/field name that carries the key. */
  key: z.string().optional(),
  keyDerivation: KeyDerivation.default("none"),
});
export type Idempotency = z.infer<typeof Idempotency>;

export const RetryPolicy = z.object({
  mode: RetryMode,
  /** Descriptive justification for the posture (auditable; does not gate). */
  basis: RetryBasis.default("unproven"),
  maxAttempts: z.number().int().min(1).default(1),
  backoff: BackoffStrategy.default("none"),
  baseDelayMs: z.number().int().min(0).default(200),
  maxDelayMs: z.number().int().min(0).default(20_000),
  retryOn: z.array(RetryCondition).default([]),
});
export type RetryPolicy = z.infer<typeof RetryPolicy>;

export const Confirmation = z.object({
  required: z.boolean().default(false),
  risk: RiskLevel.optional(),
  reason: z.string().optional(),
});
export type Confirmation = z.infer<typeof Confirmation>;

export const AuthRequirement = z.object({
  type: AuthType,
  scopes: z.array(z.string()).default([]),
  /** Whose authority the call runs under — the decisive question for agents. */
  principal: AuthPrincipal.default("service"),
  /** Intended token audience / resource, when known. */
  audience: z.string().optional(),
  /** Where the runtime sources the credential (never the secret itself). */
  secretSource: SecretSource.default("env"),
  /** Delegation / impersonation chain for on-behalf-of calls. */
  delegation: z
    .object({
      /** The acting party (e.g. the service account or agent). */
      actor: z.string().optional(),
      /** The party whose authority is borrowed (e.g. the end user). */
      subject: z.string().optional(),
    })
    .optional(),
  /** Tenant/isolation boundary the call is scoped to, when multi-tenant. */
  tenant: z.string().optional(),
});
export type AuthRequirement = z.infer<typeof AuthRequirement>;

export const ErrorSpec = z.object({
  code: ErrorCode,
  upstream: z
    .object({
      httpStatus: z.number().int().optional(),
    })
    .optional(),
  message: z.string().optional(),
  retryable: z.boolean().optional(),
  safeToRetry: z.boolean().optional(),
});
export type ErrorSpec = z.infer<typeof ErrorSpec>;

export const Pagination = z.object({
  style: z.enum(["cursor", "page", "offset", "link"]),
  cursorParam: z.string().optional(),
  nextField: z.string().optional(),
  itemsField: z.string().optional(),
});
export type Pagination = z.infer<typeof Pagination>;

/* -------------------------------------------------------------------------- */
/* Operation                                                                  */
/* -------------------------------------------------------------------------- */

export const Operation = z.object({
  /** Stable, dotted operation id, e.g. payments.refund.create. */
  id: z.string(),
  /** snake_case verb-noun name used for MCP tools and code. */
  canonicalName: z.string(),
  displayName: z.string(),
  description: z.string().default(""),
  tags: z.array(z.string()).default([]),
  sourceRef: SourceRef,
  effect: Effect,
  input: z.object({
    /** Non-body parameters only (path / query / header / cookie). */
    params: z.array(Param).default([]),
    /** The request body, preserved as a body (not flattened into params). */
    body: RequestBody.optional(),
    /** Assembled JSON Schema for the whole input, if computed. */
    schema: JsonSchema.optional(),
  }),
  output: z
    .object({
      schemaRef: z.string().optional(),
      schema: JsonSchema.optional(),
      description: z.string().optional(),
    })
    .default({}),
  errors: z.array(ErrorSpec).default([]),
  idempotency: Idempotency,
  retries: RetryPolicy,
  confirmation: Confirmation,
  auth: AuthRequirement,
  pagination: Pagination.optional(),
  streaming: z.boolean().default(false),
  longRunning: z.boolean().default(false),
  deprecated: z.boolean().default(false),
  /** Agent-facing bindings — one operation, three aligned surfaces. */
  cli: z.object({ command: z.string(), aliases: z.array(z.string()).default([]) }),
  mcp: z.object({ toolName: z.string() }),
  skill: z.object({ intentExamples: z.array(z.string()).default([]) }),
  /** Approval lifecycle state. Only `approved` is exposed by default. */
  state: OperationState.default("generated"),
  /** Human/validator notes explaining a non-approved state. */
  reviewNotes: z.array(z.string()).default([]),
  evidence: Evidence.default({ claims: [] }),
  /** The primary capability this operation belongs to (see `Capability`). */
  capabilityId: z.string().optional(),
});
export type Operation = z.infer<typeof Operation>;

/* -------------------------------------------------------------------------- */
/* Capabilities + workflows (the primary abstraction)                         */
/* -------------------------------------------------------------------------- */

/**
 * How a capability was arrived at — so review sees whether the grouping is
 * grounded in the spec (tags) or merely inferred (resource heuristic).
 */
export const CapabilitySource = z.enum(["tag", "resource", "manifest", "service"]);
export type CapabilitySource = z.infer<typeof CapabilitySource>;

/**
 * A business capability — the abstraction agents actually reason about
 * ("Refunds", "Payments"), not a URL. A capability owns operations and
 * workflows; generators project it into a searchable surface. This is the shift
 * from `POST /payments/refund` to `payments refunds`.
 */
export const Capability = z.object({
  /** Stable, dotted id, e.g. payments.refunds. */
  id: z.string(),
  displayName: z.string(),
  description: z.string().default(""),
  /** How this grouping was determined (provenance for review). */
  source: CapabilitySource.default("resource"),
  /** Resource nouns this capability spans (e.g. ["refund"]). */
  resources: z.array(z.string()).default([]),
  /** Member operation ids (a capability is a view over operations). */
  operationIds: z.array(z.string()).default([]),
  /** Workflow ids owned by this capability. */
  workflowIds: z.array(z.string()).default([]),
  /** Intent phrases an agent might use to find this capability. */
  intentExamples: z.array(z.string()).default([]),
  state: OperationState.default("generated"),
  evidence: Evidence.default({ claims: [] }),
});
export type Capability = z.infer<typeof Capability>;

/** One step of a workflow: an operation invocation with optional guidance. */
export const WorkflowStep = z.object({
  /** The operation this step invokes. */
  operationId: z.string(),
  /** What this step accomplishes, agent-facing. */
  description: z.string().default(""),
  /** Whether the step may be skipped depending on prior results. */
  optional: z.boolean().default(false),
  /**
   * Hints mapping prior step outputs to this step's inputs, e.g.
   * `{ payment_id: "$.steps.findPayment.id" }`. Free-form; advisory for agents.
   */
  bindings: z.record(z.string(), z.string()).default({}),
});
export type WorkflowStep = z.infer<typeof WorkflowStep>;

/**
 * A first-class workflow: the ordered operations that accomplish a business
 * task ("Refund customer"). Workflows are **authored or enriched**, never
 * guessed — Anvil does not fabricate multi-step business logic it cannot prove
 * (auto-inference is a staged seam). A generated CLI exposes them as
 * `<service> workflows <name>`.
 */
export const Workflow = z.object({
  /** Stable, dotted id, e.g. payments.refunds.refund_customer. */
  id: z.string(),
  /** The capability this workflow belongs to. */
  capabilityId: z.string(),
  displayName: z.string(),
  description: z.string().default(""),
  intentExamples: z.array(z.string()).default([]),
  steps: z.array(WorkflowStep).default([]),
  /** Whether the whole workflow needs a human in the loop before running. */
  humanApproval: z.boolean().default(false),
  /** How to undo a partially-completed run, if known. */
  rollbackStrategy: z.string().optional(),
  state: OperationState.default("generated"),
  evidence: Evidence.default({ claims: [] }),
});
export type Workflow = z.infer<typeof Workflow>;

/* -------------------------------------------------------------------------- */
/* Service + document                                                         */
/* -------------------------------------------------------------------------- */

export const Server = z.object({
  url: z.string(),
  description: z.string().optional(),
  environment: z.string().optional(),
});
export type Server = z.infer<typeof Server>;

export const Service = z.object({
  id: z.string(),
  version: z.string(),
  displayName: z.string().optional(),
  owner: z.string().optional(),
  environment: z.string().optional(),
  source: z.object({ kind: SourceKind, uri: z.string().optional() }),
  auth: AuthRequirement.default({
    type: "none",
    scopes: [],
    principal: "anonymous",
    secretSource: "none",
  }),
  servers: z.array(Server).default([]),
});
export type Service = z.infer<typeof Service>;

export const Diagnostic = z.object({
  level: DiagnosticLevel,
  code: z.string(),
  message: z.string(),
  operationId: z.string().optional(),
  path: z.string().optional(),
});
export type Diagnostic = z.infer<typeof Diagnostic>;

/** The complete AIR document — every generator compiles from exactly this. */
export const AirDocument = z.object({
  anvilVersion: z.string().default("0.1.0"),
  service: Service,
  operations: z.array(Operation).default([]),
  /** Business capabilities — the primary abstraction, grouping operations. */
  capabilities: z.array(Capability).default([]),
  /** First-class workflows (authored/enriched, not guessed). */
  workflows: z.array(Workflow).default([]),
  /** Reusable JSON Schema components referenced by operations. */
  schemas: z.record(z.string(), JsonSchema).default({}),
  diagnostics: z.array(Diagnostic).default([]),
});
export type AirDocument = z.infer<typeof AirDocument>;
