import { z } from "zod";
import {
  AuthType,
  BackoffStrategy,
  DiagnosticLevel,
  EffectKind,
  ErrorCode,
  HttpMethod,
  IdempotencyMechanism,
  IdempotencyMode,
  KeyDerivation,
  OperationState,
  ParamLocation,
  RetryCondition,
  RetryMode,
  RiskLevel,
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

export const EvidenceItem = z.object({
  kind: EvidenceKind,
  /** Free-form pointer to the origin (URL, file path, commit, ticket id). */
  ref: z.string().optional(),
  note: z.string().optional(),
  /** 0..1 confidence contributed by this item. */
  confidence: z.number().min(0).max(1).optional(),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

/**
 * The evidence graph node for an operation. The harness loop accumulates items
 * and rolls them into a single confidence score; low confidence forces review.
 */
export const Evidence = z.object({
  items: z.array(EvidenceItem).default([]),
  /** Aggregate confidence in the semantics attached to this operation. */
  confidence: z.number().min(0).max(1).default(0),
});
export type Evidence = z.infer<typeof Evidence>;

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
  evidence: Evidence.default({ items: [], confidence: 0 }),
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
  evidence: Evidence.default({ items: [], confidence: 0 }),
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
  evidence: Evidence.default({ items: [], confidence: 0 }),
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
  auth: AuthRequirement.default({ type: "none", scopes: [] }),
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
