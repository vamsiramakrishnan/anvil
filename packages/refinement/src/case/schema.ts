import { Claim, EvidenceKind } from "@anvil/air";
import { z } from "zod";
import { DEFICIENCY_CATALOG, type DeficiencyCode } from "../deficiency.js";

/**
 * **The single schema source of truth for a case.** Every case document and every
 * phase output is defined here as a Zod schema; the TypeScript types (`z.infer`),
 * the runtime parsing (`.parse`), and the JSON Schema handed to the executor
 * (`z.toJSONSchema`) are all *derived* from these — never hand-written, never cast.
 *
 * Untrusted executor output (claims, proposal, evidence) is parsed through these
 * schemas, so an invalid evidence source kind, a confidence outside [0, 1], a
 * malformed semantic target, an unknown deficiency code, or a non-JSON patch value
 * is rejected at the boundary rather than trusted downstream.
 */

/* -------------------------------- primitives ------------------------------ */

/** A JSON value — the only thing a patch may carry (rejects functions, undefined, …). */
export const zJsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(zJsonValue),
    z.record(z.string(), zJsonValue),
  ]),
);
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export const zEvidenceStrength = z.enum(["single", "corroborated", "authoritative"]);
export const zSeverity = z.enum(["info", "low", "medium", "high", "blocking"]);
export const zCasePhase = z.enum(["research", "extract", "synthesize", "critique", "test"]);
export const zInvestigationStatus = z.enum([
  "proposal_generated",
  "supported",
  "conflicted",
  "insufficient_evidence",
  "blocked_by_missing_source",
]);
export const zSkillConstraint = z.enum([
  "do_not_invent_business_rules",
  "do_not_change_field_type",
  "do_not_change_requiredness",
  "preserve_domain_terms",
  "do_not_loosen_safety",
]);
export const zValidationCheckId = z.enum([
  "patch_within_boundary",
  "no_semantic_schema_change",
  "claims_from_allowed_sources",
  "evidence_meets_minimum_strength",
  "evidence_supports_value",
  "evidence_meets_verification",
  "description_nonempty",
  "description_not_tautological",
  "examples_validate_against_schema",
  "error_message_nonempty",
]);
export const zEvalFamily = z.enum([
  "operation_routing",
  "argument_mapping",
  "field_interpretation",
  "error_recovery",
  "unsafe_operation_refusal",
]);

/** Deficiency codes, validated against the catalog so an unknown code is rejected. */
export const zDeficiencyCode = z.enum(
  Object.keys(DEFICIENCY_CATALOG) as [DeficiencyCode, ...DeficiencyCode[]],
);

/**
 * Where a piece of evidence lives — a discriminated union so a coordinate with
 * neither `path` nor `uri` (or both) can never be constructed. `local_repository`
 * is a filesystem coordinate Anvil can read and verify itself; `external_artifact`
 * is an opaque pointer whose excerpt is caller-supplied and unverifiable.
 */
export const zEvidenceCoordinate = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local_repository"),
    source: EvidenceKind,
    path: z.string().min(1),
    startLine: z.number().optional(),
    endLine: z.number().optional(),
    note: z.string().optional(),
  }),
  z.object({
    kind: z.literal("external_artifact"),
    source: EvidenceKind,
    uri: z.string().min(1),
    excerpt: z.string().optional(),
    note: z.string().optional(),
  }),
]);

/**
 * Whether an artifact is trusted, and why — the **single source of truth** for an
 * artifact's verification state (there is deliberately no separate `verified` boolean
 * that could disagree with it). `verified` means a source verifier confirmed the exact
 * bytes; `unverified` records why it could not.
 */
export const zEvidenceVerification = z.discriminatedUnion("status", [
  z.object({ status: z.literal("verified"), verifier: z.literal("local_repository") }),
  z.object({ status: z.literal("unverified"), reason: z.string() }),
]);

/** The semantic target — a discriminated union, so a malformed target fails to parse. */
export const zSemanticTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("service") }),
  z.object({ kind: z.literal("capability"), capabilityId: z.string() }),
  z.object({ kind: z.literal("operation"), operationId: z.string() }),
  z.object({ kind: z.literal("field"), operationId: z.string(), path: z.string() }),
  z.object({ kind: z.literal("enum"), operationId: z.string(), path: z.string() }),
  z.object({ kind: z.literal("error"), operationId: z.string(), code: z.string() }),
  z.object({ kind: z.literal("workflow"), workflowId: z.string() }),
]);

/** A target-relative semantic patch. `set` values must be JSON. */
export const zSemanticPatch = z.object({
  target: zSemanticTarget,
  set: z.record(z.string(), zJsonValue),
});

/* ------------------------------ workspace + run --------------------------- */

export const zCaseWorkspace = z.object({
  repositoryRoot: z.string(),
  repositoryRevision: z.string().optional(),
  inspectScopes: z.array(z.string()),
});

export const zRunIdentity = z.object({
  runId: z.string(),
  caseKey: z.string(),
  airHash: z.string(),
  sourceRevision: z.string().optional(),
  skillVersion: z.number(),
  policyHash: z.string(),
  executor: z.string(),
  createdAt: z.string(),
});

/* ------------------------------- case inputs ------------------------------ */

export const zCaseTask = z.object({
  caseKey: z.string(),
  skill: z.string(),
  skillVersion: z.number(),
  deficiency: zDeficiencyCode,
  severity: zSeverity,
  question: z.string(),
  produce: z.array(z.string()),
  phases: z.array(zCasePhase),
});

export const zCaseFieldFacts = z.object({
  path: z.string(),
  name: z.string(),
  required: z.boolean(),
  type: z.string().optional(),
  enumValues: z.array(zJsonValue).optional(),
  existingDescription: z.string().optional(),
  example: zJsonValue.optional(),
});

export const zCaseTargetDoc = z.object({
  target: zSemanticTarget,
  key: z.string(),
  describe: z.string(),
  operationId: z.string().optional(),
  operationName: z.string().optional(),
  operationEffect: z.string().optional(),
  /** The operation's current description, snapshotted so `supported` can prove it. */
  operationDescription: z.string().optional(),
  field: zCaseFieldFacts.optional(),
  siblingFields: z
    .array(z.object({ name: z.string(), description: z.string().optional() }))
    .optional(),
  errorCode: z.string().optional(),
  /** The error's current human-facing message, snapshotted so `supported` can prove it. */
  errorMessage: z.string().optional(),
  /** The error's current retryability, snapshotted so `supported` can prove it. */
  errorRetryable: z.boolean().optional(),
  priorEvidence: z.array(Claim),
});

export const zEvidencePolicyDoc = z.object({
  allowedSources: z.array(EvidenceKind),
  minimumStrength: zEvidenceStrength,
  writablePredicates: z.array(z.string()),
  supportingPredicates: z.array(z.string()),
  writableFields: z.array(z.string()),
  constraints: z.array(zSkillConstraint),
  mustNot: z.array(z.string()),
  /** The skill-wide default trust bar a claim's evidence must clear. */
  minimumVerification: z.enum(["verified", "allow_unverified"]),
  /** A narrow, optional per-output-field override of `minimumVerification`. */
  fieldVerification: z.record(z.string(), z.enum(["verified", "allow_unverified"])).optional(),
});

export const zAllowedToolsDoc = z.object({
  workspace: zCaseWorkspace,
  helpers: z.array(z.string()),
  deny: z.array(z.string()),
});

/** The rails + deny-list section of the canonical doc (workspace is its own section). */
export const zCaseToolsDoc = z.object({
  helpers: z.array(z.string()),
  deny: z.array(z.string()),
});

/** The resolved investigation procedure, as data (the question is pre-resolved). */
export const zProcedureDoc = z.object({
  skill: z.string(),
  question: z.string(),
  searchHints: z.array(z.string()),
  steps: z.array(z.object({ phase: zCasePhase, instruction: z.string() })),
});

/* ---------------------------- canonical document -------------------------- */

/**
 * The **one canonical case document** (`case.json`) — the single source of truth for
 * a case's inputs. `CASE.md` and `expected-output.schema.json` are generated FROM it
 * and never stored independently, so a view can never drift from the model.
 */
export const zCaseDocument = z.object({
  version: z.literal(1),
  identity: zRunIdentity,
  task: zCaseTask,
  target: zCaseTargetDoc,
  workspace: zCaseWorkspace,
  skill: z.object({ name: z.string(), version: z.number() }),
  policy: zEvidencePolicyDoc,
  tools: zCaseToolsDoc,
  procedure: zProcedureDoc,
  expectedOutput: z.record(z.string(), z.unknown()),
});

/* ------------------------------ phase outputs ----------------------------- */

export const zEvidenceArtifact = z.object({
  id: z.string(),
  uri: z.string(),
  source: EvidenceKind,
  revision: z.string().optional(),
  contentHash: z.string(),
  excerpt: z.string(),
  acquiredAt: z.string(),
  relevance: z.string().optional(),
  path: z.string().optional(),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
  verification: zEvidenceVerification,
});
export const zEvidenceReport = z.object({ artifacts: z.array(zEvidenceArtifact) });

export const zClaimSet = z.object({ claims: z.array(Claim) });

export const zCaseProposal = z.object({
  skill: z.string(),
  skillVersion: z.number().default(1),
  deficiency: zDeficiencyCode,
  target: zSemanticTarget,
  claims: z.array(Claim),
  patch: zSemanticPatch,
});

export const zClauseVerdict = z.object({
  clause: z.string(),
  supported: z.boolean(),
  sourceRef: z.string().optional(),
  reason: z.string(),
});
export const zValidationOutcome = z.object({
  check: zValidationCheckId,
  ok: z.boolean(),
  reason: z.string(),
});
export const zValidationReport = z.object({
  clauses: z.array(zClauseVerdict),
  checks: z.array(zValidationOutcome),
  status: z.enum(["validated", "rejected"]),
});

export const zProposedCheck = z.object({ family: zEvalFamily, asserts: z.string() });
export const zTestPlan = z.object({ checks: z.array(zProposedCheck) });

/* --------------------------- inferred output types ------------------------ */

export type SchemaEvidenceArtifact = z.infer<typeof zEvidenceArtifact>;
export type SchemaEvidenceReport = z.infer<typeof zEvidenceReport>;
export type SchemaClaimSet = z.infer<typeof zClaimSet>;
export type SchemaCaseProposal = z.infer<typeof zCaseProposal>;
export type SchemaValidationReport = z.infer<typeof zValidationReport>;
export type SchemaTestPlan = z.infer<typeof zTestPlan>;

/* --------------------------- expected-output schema ----------------------- */

/**
 * The case-specific proposal schema: a Zod schema pinned to THIS case's constants
 * (skill, version, deficiency, target, patch target, writable fields), converted to
 * JSON Schema. `additionalProperties: false` falls out of `z.toJSONSchema`, so the
 * executor sees exactly the contract the deterministic core will hold it to.
 */
export interface ExpectedOutputInfo {
  skill: string;
  skillVersion: number;
  deficiency: string;
  target: z.infer<typeof zSemanticTarget>;
  writableFields: string[];
}

export function expectedProposalSchema(info: ExpectedOutputInfo): z.ZodType {
  const targetLiteral = z
    .literal(JSON.stringify(info.target))
    .describe("must equal the case target exactly");
  const setKeys =
    info.writableFields.length > 0
      ? z.object(Object.fromEntries(info.writableFields.map((f) => [f, zJsonValue.optional()])))
      : z.object({});
  return z.object({
    skill: z.literal(info.skill),
    skillVersion: z.literal(info.skillVersion),
    deficiency: z.literal(info.deficiency),
    // Encoded as a JSON string literal so the "must match the case target" constant
    // survives the JSON-Schema projection; the runtime binding check enforces equality.
    _targetShape: targetLiteral.optional(),
    target: zSemanticTarget,
    claims: z.array(Claim).min(1),
    patch: z.object({ target: zSemanticTarget, set: setKeys }),
  });
}

/** The JSON Schema for a case's `output/proposal.json`, with constants baked in. */
export function expectedOutputJsonSchema(info: ExpectedOutputInfo): Record<string, unknown> {
  return z.toJSONSchema(expectedProposalSchema(info), { unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
}
