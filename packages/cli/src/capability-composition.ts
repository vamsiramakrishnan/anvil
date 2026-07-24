import {
  type AirDocument,
  type AuthRequirement,
  contractHash,
  EvidenceKind,
  effectiveAuthCarrier,
  hashCanonical,
  type JsonSchema,
  type Operation,
  SOURCE_RELIABILITY,
} from "@anvil/air";
import type { GatewayImportIdentity } from "@anvil/compiler";
import { z } from "zod";

export const COMPOSITION_REPORT_SCHEMA_VERSION = 1;
export const COMPOSITION_REVIEW_SCHEMA_VERSION = 1;

const MAX_SOURCES = 500;
const MAX_OPERATIONS = 10_000;
const MAX_DATA_POINTS = 200_000;
const MAX_CANDIDATES = 50_000;
const MAX_SCHEMA_TRAVERSAL_DEPTH = 64;
const MAX_SCHEMA_TRAVERSAL_NODES = 50_000;
const MIN_REVIEW_EVIDENCE_CONFIDENCE = 0.5;

const Sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const NonEmpty = z.string().trim().min(1);
const RelativeEvidencePath = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !/^[A-Za-z]:/.test(value) &&
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "sourceRef must be a normalized relative file path below the review manifest directory",
  );

const AuthorityEvidenceBase = z.object({
  memberId: NonEmpty,
  sourceKind: EvidenceKind,
  sourceRef: RelativeEvidencePath,
  sourceRevision: NonEmpty.optional(),
  artifactDigest: Sha256Digest,
  confidence: z.number().min(0).max(1),
  note: NonEmpty.optional(),
});

export const CompositionAuthorityEvidence = z.discriminatedUnion("factor", [
  AuthorityEvidenceBase.extend({
    factor: z.literal("system_of_record"),
    value: z.boolean(),
  }),
  AuthorityEvidenceBase.extend({
    factor: z.literal("owner"),
    value: NonEmpty,
  }),
  AuthorityEvidenceBase.extend({
    factor: z.literal("lineage"),
    value: NonEmpty,
  }),
  AuthorityEvidenceBase.extend({
    factor: z.literal("freshness"),
    value: z.enum(["current", "stale", "unknown"]),
  }),
  AuthorityEvidenceBase.extend({
    factor: z.literal("write_authority"),
    value: z.enum(["authoritative_write", "read_only", "none", "unknown"]),
  }),
]);
export type CompositionAuthorityEvidence = z.infer<typeof CompositionAuthorityEvidence>;

export const CompositionRelationEvidence = z.object({
  memberIds: z.array(NonEmpty).min(2),
  sourceKind: EvidenceKind,
  sourceRef: RelativeEvidencePath,
  sourceRevision: NonEmpty.optional(),
  artifactDigest: Sha256Digest,
  confidence: z.number().min(0).max(1),
  note: NonEmpty.optional(),
});
export type CompositionRelationEvidence = z.infer<typeof CompositionRelationEvidence>;

export interface VerifiedCompositionEvidenceArtifact {
  sourceRef: string;
  artifactDigest: string;
  sizeBytes: number;
  verification: "local_file_sha256";
}

export function compositionEvidenceKey(input: {
  sourceRef: string;
  artifactDigest: string;
}): string {
  return `${input.sourceRef}\u0000${input.artifactDigest}`;
}

export const CompositionReviewEntry = z.object({
  candidateId: NonEmpty,
  candidateDigest: Sha256Digest,
  eligibleSources: z.array(NonEmpty).min(2),
  eligibleMembers: z.array(NonEmpty).min(2),
  semanticRelation: z
    .enum(["pending", "same_fact", "projection", "not_equivalent"])
    .default("pending"),
  relationEvidence: z.array(CompositionRelationEvidence).default([]),
  readAuthority: z
    .object({
      decision: z.enum(["pending", "select", "unproven"]).default("pending"),
      selectedMember: NonEmpty.optional(),
    })
    .default({ decision: "pending" }),
  authorityEvidence: z.array(CompositionAuthorityEvidence).default([]),
  acknowledgedContradictions: z.array(NonEmpty).default([]),
  note: z.string().optional(),
});
export type CompositionReviewEntry = z.infer<typeof CompositionReviewEntry>;

export const CompositionReviewManifest = z.object({
  schemaVersion: z.literal(COMPOSITION_REVIEW_SCHEMA_VERSION),
  reportType: z.literal("anvil.cross-source-composition-review"),
  inputDigest: Sha256Digest,
  candidateDigest: Sha256Digest,
  candidates: z.array(CompositionReviewEntry),
});
export type CompositionReviewManifest = z.infer<typeof CompositionReviewManifest>;

export interface CompositionSource {
  id: string;
  serviceId: string;
  serviceVersion: string;
  contractDigest: string;
  declaredOwner?: string;
  declaredEnvironment?: string;
  lineage: {
    kind: string;
    uri?: string;
    snapshotId?: string;
    sourceHash?: string;
    origin?: { kind: string; uri: string };
    entrypoint?: string;
  };
  provenance:
    | {
        kind: "plain_air";
        trust: "verified_generated_bundle";
      }
    | {
        kind: "gateway_receipt";
        trust: "verified" | "missing" | "invalid" | "stale";
        receiptDigest?: string;
        importId?: string;
        identity?: GatewayImportIdentity;
        failureReasons: string[];
        blockerCount: number;
      };
}
export type CompositionSourceProvenance = CompositionSource["provenance"];

type DataClassification =
  | "public"
  | "internal"
  | "confidential"
  | "restricted"
  | "unclassified"
  | "invalid";

interface DataPoint {
  id: string;
  sourceId: string;
  operationId: string;
  pointer: string;
  required: boolean;
  semanticId?: string;
  schemaFingerprint: string;
  schema: {
    type: string;
    format?: string;
  };
  dataSemantics: {
    classification: DataClassification;
    unit?: string;
    currency?: string;
    jurisdiction?: string;
    masking?: string;
  };
  evidenceBasis: "explicit_data_point_id" | "exact_schema_coordinate";
  groupKey: string;
}

interface OperationSignature {
  sourceId: string;
  operationId: string;
  canonicalName: string;
  sourceRef: Operation["sourceRef"];
  operation: Operation;
  source: CompositionSource;
  points: DataPoint[];
  signatures: string[];
  outputDigest: string;
}

export interface CompositionContradiction {
  id: string;
  kind: string;
  severity: "review_required" | "blocked";
  message: string;
  values?: string[];
}

interface CandidateCore {
  id: string;
  digest: string;
  kind:
    | "data_point_duplicate"
    | "structural_leaf_overlap"
    | "output_duplicate"
    | "output_projection";
  title: string;
  eligibleSources: string[];
  eligibleMembers: string[];
  structuralConfidence: number;
  confidenceBasis: string;
  evidence: Array<{
    kind: "air_output_schema";
    sourceId: string;
    operationId: string;
    memberId: string;
    coordinate: string;
    basis: "explicit_data_point_id" | "exact_schema_coordinate" | "exact_output_subset";
  }>;
  members: unknown[];
  constraints: ReturnType<typeof intersectConstraints>;
  contradictions: CompositionContradiction[];
  projection?: {
    from: { sourceId: string; operationId: string };
    to: { sourceId: string; operationId: string };
    fieldCount: number;
    proof: "exact_output_signature_subset";
    limitation: string;
    minimizedDisclosure: Array<{
      memberId: string;
      pointer: string;
      classification: DataClassification;
    }>;
  };
}

interface AuthoritySourceAssessment {
  memberId: string;
  confidence: number;
  factors: CompositionAuthorityEvidence[];
  factorCoverage: string[];
}

interface ReviewedCandidate extends CandidateCore {
  disposition: "unresolved" | "candidate" | "reviewed";
  review: {
    semanticRelation: CompositionReviewEntry["semanticRelation"];
    semanticStatus: "unresolved" | "candidate" | "reviewed";
    readAuthorityDecision: CompositionReviewEntry["readAuthority"]["decision"];
    readAuthorityStatus: "unresolved" | "candidate" | "reviewed";
    note?: string;
    acknowledgedContradictions: string[];
    issues: string[];
  };
  authority: {
    inferencePolicy: "explicit_evidence_and_review_only";
    evidenceConfidencePolicy: "declared_times_source_reliability";
    scorePolicy: "display_only_never_selects";
    requiredReadFactors: ["system_of_record", "lineage", "freshness_current"];
    sourceReliability: typeof SOURCE_RELIABILITY;
    selectedMember?: string;
    assessments: AuthoritySourceAssessment[];
    confidenceWeights: Record<CompositionAuthorityEvidence["factor"], number>;
  };
}

export interface CompositionAuditReport {
  schemaVersion: 1;
  reportType: "anvil.cross-source-composition-audit";
  inputDigest: string;
  candidateDigest: string;
  reviewDigest?: string;
  evidenceArtifacts: VerifiedCompositionEvidenceArtifact[];
  reportHash: string;
  sources: CompositionSource[];
  summary: {
    sourceCount: number;
    operationCount: number;
    outputDataPointCount: number;
    candidateCount: number;
    dispositions: Record<"unresolved" | "candidate" | "reviewed", number>;
    reviewedPlanCount: number;
  };
  candidates: ReviewedCandidate[];
  compositionPlans: Array<{
    schemaVersion: 1;
    candidateId: string;
    candidateDigest: string;
    reviewDigest: string;
    selectedMember: string;
    selectedSource: string;
    semanticRelation: "same_fact" | "projection";
    memberOperations: Array<{ sourceId: string; operationId: string }>;
    minimizedDisclosure?: Array<{
      memberId: string;
      pointer: string;
      classification: DataClassification;
    }>;
    constraints: ReturnType<typeof intersectConstraints>;
    buildReady: false;
    status: "reviewed_plan_only";
  }>;
  boundary: {
    mode: "offline_input_read_only_audit";
    generatedMcp: false;
    autoApproved: false;
    buildReady: false;
    reason: string;
    nextGate: string;
  };
}

export interface CompositionAnalysisInput {
  air: AirDocument;
  provenance?: CompositionSourceProvenance;
}

export class CompositionInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CompositionInputError";
  }
}

class SchemaTraversalBudget {
  private nodes = 0;

  constructor(private readonly context: string) {}

  visit(depth: number): void {
    if (depth > MAX_SCHEMA_TRAVERSAL_DEPTH) {
      throw new CompositionInputError(
        "composition/schema_depth_limit",
        `${this.context} exceeds the maximum schema traversal depth of ${MAX_SCHEMA_TRAVERSAL_DEPTH}. Narrow or normalize the schema before composition analysis.`,
      );
    }
    this.nodes += 1;
    if (this.nodes > MAX_SCHEMA_TRAVERSAL_NODES) {
      throw new CompositionInputError(
        "composition/schema_node_limit",
        `${this.context} exceeds the maximum schema traversal budget of ${MAX_SCHEMA_TRAVERSAL_NODES} nodes. Select a narrower contract before composition analysis.`,
      );
    }
  }
}

/**
 * Contract hashing happens before candidate extraction. Bound every in-memory
 * schema iteratively first so an adversarial programmatic AIR cannot exhaust
 * the JavaScript call stack before the guarded recursive walkers run.
 */
function assertBoundedAirSchemas(air: AirDocument): void {
  const roots: Array<{ value: unknown; depth: number; context: string }> = [];
  for (const [name, schema] of Object.entries(air.schemas)) {
    roots.push({
      value: schema,
      depth: 0,
      context: `Service '${air.service.id}' schema '${name}'`,
    });
  }
  for (const operation of air.operations) {
    if (operation.input.schema) {
      roots.push({
        value: operation.input.schema,
        depth: 0,
        context: `Operation '${air.service.id}:${operation.id}' input schema`,
      });
    }
    if (operation.output.schema) {
      roots.push({
        value: operation.output.schema,
        depth: 0,
        context: `Operation '${air.service.id}:${operation.id}' output schema`,
      });
    }
  }

  const seen = new WeakSet<object>();
  let nodes = 0;
  while (roots.length > 0) {
    const current = roots.pop();
    if (!current) continue;
    if (current.depth > MAX_SCHEMA_TRAVERSAL_DEPTH) {
      throw new CompositionInputError(
        "composition/schema_depth_limit",
        `${current.context} exceeds the maximum schema traversal depth of ${MAX_SCHEMA_TRAVERSAL_DEPTH}. Narrow or normalize the schema before composition analysis.`,
      );
    }
    if (current.value === null || typeof current.value !== "object") {
      continue;
    }
    const object = current.value as object;
    if (seen.has(object)) continue;
    seen.add(object);
    nodes += 1;
    if (nodes > MAX_SCHEMA_TRAVERSAL_NODES) {
      throw new CompositionInputError(
        "composition/schema_node_limit",
        `Service '${air.service.id}' exceeds the maximum aggregate schema traversal budget of ${MAX_SCHEMA_TRAVERSAL_NODES} nodes. Select a narrower contract before composition analysis.`,
      );
    }
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) {
      roots.push({
        value: child,
        depth: current.depth + 1,
        context: current.context,
      });
    }
  }
}

function digest(value: unknown): string {
  return `sha256:${hashCanonical(value)}`;
}

function sourceIdentity(
  air: AirDocument,
  provenance: CompositionSourceProvenance = {
    kind: "plain_air",
    trust: "verified_generated_bundle",
  },
): CompositionSource {
  const contractDigest = `sha256:${contractHash(air)}`;
  const suffix = hashCanonical({
    contractDigest,
    provenance:
      provenance.kind === "gateway_receipt"
        ? {
            receiptDigest: provenance.receiptDigest,
            importId: provenance.importId,
            identity: provenance.identity,
            trust: provenance.trust,
          }
        : provenance,
  }).slice(0, 16);
  return {
    id: `${air.service.id}@${air.service.version}#${suffix}`,
    serviceId: air.service.id,
    serviceVersion: air.service.version,
    contractDigest,
    ...(air.service.owner ? { declaredOwner: air.service.owner } : {}),
    ...(air.service.environment ? { declaredEnvironment: air.service.environment } : {}),
    lineage: {
      kind: air.service.source.kind,
      ...(air.service.source.uri ? { uri: air.service.source.uri } : {}),
      ...(air.service.source.snapshotId ? { snapshotId: air.service.source.snapshotId } : {}),
      ...(air.service.source.sourceHash ? { sourceHash: air.service.source.sourceHash } : {}),
      ...(air.service.source.origin ? { origin: air.service.source.origin } : {}),
      ...(air.service.source.entrypoint ? { entrypoint: air.service.source.entrypoint } : {}),
    },
    provenance,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function localSchemaName(ref: unknown): string | undefined {
  if (typeof ref !== "string") return undefined;
  const match = /^#\/components\/schemas\/([^/]+)$/.exec(ref);
  return match?.[1];
}

function strippedSchema(schema: JsonSchema, context = "Output schema normalization"): JsonSchema {
  const budget = new SchemaTraversalBudget(context);
  const strip = (value: unknown, depth: number): unknown => {
    budget.visit(depth);
    if (Array.isArray(value)) return value.map((item) => strip(item, depth + 1));
    if (!isRecord(value)) return value;
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (
        new Set([
          "title",
          "description",
          "example",
          "examples",
          "externalDocs",
          "x-anvil-data-point",
          "x-anvil-data-classification",
          "x-anvil-unit",
          "x-anvil-currency",
          "x-anvil-jurisdiction",
          "x-anvil-masking",
        ]).has(key)
      ) {
        continue;
      }
      copy[key] = strip(value[key], depth + 1);
    }
    return copy;
  };
  return strip(schema, 0) as JsonSchema;
}

function schemaType(schema: JsonSchema): string {
  const declared = schema.type;
  if (typeof declared === "string") return declared;
  if (Array.isArray(declared)) {
    return declared
      .filter((value): value is string => typeof value === "string")
      .sort()
      .join("|");
  }
  if (isRecord(schema.properties)) return "object";
  if (schema.items !== undefined) return "array";
  return "unspecified";
}

function outputSchema(air: AirDocument, operation: Operation): JsonSchema | undefined {
  if (operation.output.schema && Object.keys(operation.output.schema).length > 0) {
    return operation.output.schema;
  }
  const ref = operation.output.schemaRef;
  if (!ref) return undefined;
  const direct = air.schemas[ref];
  if (direct) return direct;
  const local = localSchemaName(ref);
  return local ? air.schemas[local] : undefined;
}

function outputSchemaDigest(air: AirDocument, schema: JsonSchema, context: string): string {
  const refs = new Set<string>();
  const queue: Array<{ schema: JsonSchema; depth: number }> = [{ schema, depth: 0 }];
  const budget = new SchemaTraversalBudget(`${context} reference closure`);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const visit = (value: unknown, depth: number): void => {
      budget.visit(depth);
      if (Array.isArray(value)) {
        value.forEach((item) => {
          visit(item, depth + 1);
        });
        return;
      }
      if (!isRecord(value)) return;
      const name = localSchemaName(value.$ref);
      if (name && !refs.has(name) && air.schemas[name]) {
        refs.add(name);
        queue.push({ schema: air.schemas[name], depth: depth + 1 });
      }
      Object.values(value).forEach((item) => {
        visit(item, depth + 1);
      });
    };
    visit(current.schema, current.depth);
  }
  const schemas: Record<string, JsonSchema> = {};
  for (const name of [...refs].sort()) {
    schemas[name] = strippedSchema(
      air.schemas[name] as JsonSchema,
      `${context} referenced schema '${name}' normalization`,
    );
  }
  return digest({
    root: strippedSchema(schema, `${context} root normalization`),
    schemas,
  });
}

function boundedAnnotation(schema: JsonSchema, key: string): string | undefined {
  const value = schema[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : undefined;
}

function dataClassification(schema: JsonSchema): DataClassification {
  const value = schema["x-anvil-data-classification"];
  if (value === undefined) return "unclassified";
  if (
    value === "public" ||
    value === "internal" ||
    value === "confidential" ||
    value === "restricted"
  ) {
    return value;
  }
  return "invalid";
}

function memberId(sourceId: string, operationId: string, pointer: string): string {
  return `member-${hashCanonical({ sourceId, operationId, pointer }).slice(0, 20)}`;
}

function pointSignature(point: DataPoint): string {
  return `${point.groupKey}|${point.required ? "required" : "optional"}|${point.schemaFingerprint}`;
}

function dataPointsFor(
  air: AirDocument,
  source: CompositionSource,
  operation: Operation,
): DataPoint[] {
  const root = outputSchema(air, operation);
  if (!root) return [];
  const points: DataPoint[] = [];
  const seen = new Set<string>();
  const context = `Operation '${source.id}:${operation.id}' output`;
  const budget = new SchemaTraversalBudget(context);

  const walk = (
    schema: JsonSchema,
    pointer: string,
    required: boolean,
    refs: ReadonlySet<string>,
    depth: number,
  ): void => {
    budget.visit(depth);
    const refName = localSchemaName(schema.$ref);
    if (refName) {
      if (refs.has(refName)) return;
      const target = air.schemas[refName];
      if (!target) return;
      walk(target, pointer, required, new Set([...refs, refName]), depth + 1);
      return;
    }

    // A oneOf/anyOf response does not prove that every variant field is
    // available, so this minimal slice refuses to flatten it into a candidate.
    if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) return;
    if (Array.isArray(schema.allOf)) {
      schema.allOf.forEach((variant) => {
        if (isRecord(variant)) walk(variant, pointer, required, refs, depth + 1);
      });
      if (!isRecord(schema.properties) || Object.keys(schema.properties).length === 0) return;
    }

    const properties = isRecord(schema.properties) ? schema.properties : undefined;
    if (properties && Object.keys(properties).length > 0) {
      const requiredProperties = new Set(
        Array.isArray(schema.required)
          ? schema.required.filter((value): value is string => typeof value === "string")
          : [],
      );
      for (const name of Object.keys(properties).sort()) {
        const child = properties[name];
        if (!isRecord(child)) continue;
        const escaped = name.replaceAll("~", "~0").replaceAll("/", "~1");
        walk(
          child,
          `${pointer}/${escaped}`,
          required && requiredProperties.has(name),
          refs,
          depth + 1,
        );
      }
      return;
    }

    if (schemaType(schema) === "array" && isRecord(schema.items)) {
      walk(schema.items, `${pointer}/*`, required, refs, depth + 1);
      return;
    }
    if (pointer.length === 0) return;

    const semantic = boundedAnnotation(schema, "x-anvil-data-point");
    const schemaFingerprint = digest(
      strippedSchema(schema, `${context} leaf '${pointer}' normalization`),
    );
    const groupKey = semantic
      ? `declared:${semantic}`
      : `coordinate:${pointer}:${required ? "required" : "optional"}:${schemaFingerprint}`;
    const id = memberId(source.id, operation.id, pointer);
    if (seen.has(id)) return;
    seen.add(id);
    points.push({
      id,
      sourceId: source.id,
      operationId: operation.id,
      pointer,
      required,
      ...(semantic ? { semanticId: semantic } : {}),
      schemaFingerprint,
      schema: {
        type: schemaType(schema),
        ...(typeof schema.format === "string" ? { format: schema.format } : {}),
      },
      dataSemantics: {
        classification: dataClassification(schema),
        ...(boundedAnnotation(schema, "x-anvil-unit")
          ? { unit: boundedAnnotation(schema, "x-anvil-unit") }
          : {}),
        ...(boundedAnnotation(schema, "x-anvil-currency")
          ? { currency: boundedAnnotation(schema, "x-anvil-currency") }
          : {}),
        ...(boundedAnnotation(schema, "x-anvil-jurisdiction")
          ? { jurisdiction: boundedAnnotation(schema, "x-anvil-jurisdiction") }
          : {}),
        ...(boundedAnnotation(schema, "x-anvil-masking")
          ? { masking: boundedAnnotation(schema, "x-anvil-masking") }
          : {}),
      },
      evidenceBasis: semantic ? "explicit_data_point_id" : "exact_schema_coordinate",
      groupKey,
    });
  };

  walk(root, "", true, new Set(), 0);
  return points.sort((left, right) =>
    `${left.pointer}\u0000${left.schemaFingerprint}`.localeCompare(
      `${right.pointer}\u0000${right.schemaFingerprint}`,
    ),
  );
}

function operationSignature(
  air: AirDocument,
  source: CompositionSource,
  operation: Operation,
): OperationSignature | undefined {
  const points = dataPointsFor(air, source, operation);
  if (points.length === 0) return undefined;
  const root = outputSchema(air, operation);
  if (!root) return undefined;
  const signatures = [...new Set(points.map(pointSignature))].sort();
  return {
    sourceId: source.id,
    operationId: operation.id,
    canonicalName: operation.canonicalName,
    sourceRef: operation.sourceRef,
    operation,
    source,
    points,
    signatures,
    outputDigest: outputSchemaDigest(air, root, `Operation '${source.id}:${operation.id}' output`),
  };
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function memberRef(signature: OperationSignature): {
  memberId: string;
  sourceId: string;
  operationId: string;
  canonicalName: string;
  sourceRef: Operation["sourceRef"];
  outputDigest: string;
  fieldCount: number;
} {
  return {
    memberId: memberId(signature.sourceId, signature.operationId, "output.schema"),
    sourceId: signature.sourceId,
    operationId: signature.operationId,
    canonicalName: signature.canonicalName,
    sourceRef: signature.sourceRef,
    outputDigest: signature.outputDigest,
    fieldCount: signature.signatures.length,
  };
}

function valuesOf<T>(operations: readonly Operation[], get: (operation: Operation) => T): string[] {
  return uniqueSorted(operations.map((operation) => JSON.stringify(get(operation))));
}

function riskRank(risk: Operation["effect"]["risk"]): number {
  return ["none", "low", "medium", "high", "financial", "destructive"].indexOf(risk);
}

function carrierKey(auth: AuthRequirement): string {
  const carrier = effectiveAuthCarrier(auth);
  return carrier ? JSON.stringify(carrier) : "<absent>";
}

function authGroup(auth: AuthRequirement): string {
  return JSON.stringify({
    type: auth.type,
    principal: auth.principal,
    issuer: auth.issuer ?? null,
    audience: auth.audience ?? null,
    carrier: effectiveAuthCarrier(auth) ?? null,
    credentialProfile: auth.credentialProfile ?? null,
    tenant: auth.tenant ?? null,
    secretSource: auth.secretSource,
    provider: auth.provider ?? null,
    delegation: auth.delegation ?? null,
    scopes: [...new Set(auth.scopes)].sort(),
  });
}

function setIntersection(groups: readonly string[][]): string[] {
  if (groups.length === 0) return [];
  let intersection = new Set(groups[0]);
  for (const group of groups.slice(1)) {
    const next = new Set(group);
    intersection = new Set([...intersection].filter((value) => next.has(value)));
  }
  return [...intersection].sort();
}

function intersectConstraints(signatures: readonly OperationSignature[]) {
  const operations = signatures.map((signature) => signature.operation);
  const identityGroups = new Map<
    string,
    {
      type: AuthRequirement["type"];
      principal: AuthRequirement["principal"];
      issuer?: string;
      audience?: string;
      carrier?: AuthRequirement["carrier"];
      credentialProfile?: string;
      tenant?: string;
      secretSource: AuthRequirement["secretSource"];
      provider?: AuthRequirement["provider"];
      delegation?: AuthRequirement["delegation"];
      scopes: string[];
      members: string[];
    }
  >();
  for (const signature of signatures) {
    const auth = signature.operation.auth;
    const key = authGroup(auth);
    const existing = identityGroups.get(key);
    const member = `${signature.sourceId}:${signature.operationId}`;
    if (existing) {
      existing.members.push(member);
    } else {
      identityGroups.set(key, {
        type: auth.type,
        principal: auth.principal,
        ...(auth.issuer ? { issuer: auth.issuer } : {}),
        ...(auth.audience ? { audience: auth.audience } : {}),
        ...(effectiveAuthCarrier(auth) ? { carrier: effectiveAuthCarrier(auth) } : {}),
        ...(auth.credentialProfile ? { credentialProfile: auth.credentialProfile } : {}),
        ...(auth.tenant ? { tenant: auth.tenant } : {}),
        secretSource: auth.secretSource,
        ...(auth.provider ? { provider: auth.provider } : {}),
        ...(auth.delegation ? { delegation: auth.delegation } : {}),
        scopes: uniqueSorted(auth.scopes),
        members: [member],
      });
    }
  }
  const maximumRisk =
    operations
      .map((operation) => operation.effect.risk)
      .sort((left, right) => riskRank(right) - riskRank(left))[0] ?? "none";
  const protectedAuth = operations.some((operation) => operation.auth.type !== "none");
  const identityIncomplete =
    protectedAuth &&
    operations.some((operation) => !operation.auth.issuer || !operation.auth.audience);
  const authCompatibility =
    identityGroups.size > 1
      ? ("incompatible" as const)
      : identityIncomplete
        ? ("unknown" as const)
        : ("compatible" as const);
  return {
    policy: "preserve_per_operation_and_intersect" as const,
    auth: {
      compatibility: authCompatibility,
      identityGroups: [...identityGroups.values()]
        .map((group) => ({ ...group, members: group.members.sort() }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      requiredScopesUnion: uniqueSorted(operations.flatMap((operation) => operation.auth.scopes)),
      note: "Per-operation identity groups remain separate. The union is an audit ceiling, not permission to mint one broader credential.",
    },
    safety: {
      memberStates: uniqueSorted(operations.map((operation) => operation.state)),
      allMembersApproved: operations.every((operation) => operation.state === "approved"),
      effect: operations.some((operation) => operation.effect.kind === "mutation")
        ? ("mutation" as const)
        : ("read" as const),
      maximumRisk,
      reversible: operations.every((operation) => operation.effect.reversible),
      confirmationRequired: operations.some((operation) => operation.confirmation.required),
      humanApprovalRequired: operations.some(
        (operation) => operation.confirmation.humanApproval === true,
      ),
      retry: {
        mode: operations.every((operation) => operation.retries.mode === "safe")
          ? ("safe" as const)
          : ("none" as const),
        maxAttempts:
          operations.length > 0
            ? Math.min(...operations.map((operation) => operation.retries.maxAttempts))
            : 1,
        retryOnIntersection: setIntersection(
          operations.map((operation) => operation.retries.retryOn),
        ),
      },
      idempotencyModes: uniqueSorted(operations.map((operation) => operation.idempotency.mode)),
      note: "These are conservative intersections for review only. They do not create, expose, approve, or execute a composed operation.",
    },
  };
}

function contradiction(
  candidateSeed: string,
  kind: string,
  severity: CompositionContradiction["severity"],
  message: string,
  values?: string[],
): CompositionContradiction {
  return {
    id: `${kind}-${hashCanonical({ candidateSeed, kind, values }).slice(0, 12)}`,
    kind,
    severity,
    message,
    ...(values && values.length > 0 ? { values } : {}),
  };
}

function constraintContradictions(
  seed: string,
  signatures: readonly OperationSignature[],
): CompositionContradiction[] {
  const operations = signatures.map((signature) => signature.operation);
  const findings: CompositionContradiction[] = [];
  const compare = (
    kind: string,
    severity: CompositionContradiction["severity"],
    message: string,
    get: (operation: Operation) => unknown,
  ): void => {
    const values = valuesOf(operations, get);
    if (values.length > 1) findings.push(contradiction(seed, kind, severity, message, values));
  };
  compare(
    "auth_type_difference",
    "blocked",
    "Member operations use different authentication types; their credentials cannot be collapsed.",
    (operation) => operation.auth.type,
  );
  compare(
    "auth_principal_difference",
    "blocked",
    "Member operations execute under different principals; delegated and service authority must remain distinct.",
    (operation) => operation.auth.principal,
  );
  compare(
    "auth_issuer_difference",
    "blocked",
    "Member operations have different or missing issuer evidence.",
    (operation) => operation.auth.issuer ?? "<absent>",
  );
  compare(
    "auth_audience_difference",
    "blocked",
    "Member operations have different or missing audience evidence.",
    (operation) => operation.auth.audience ?? "<absent>",
  );
  compare(
    "auth_carrier_difference",
    "blocked",
    "Member operations use different credential carriers.",
    (operation) => carrierKey(operation.auth),
  );
  compare(
    "auth_tenant_difference",
    "blocked",
    "Member operations have different tenant boundaries.",
    (operation) => operation.auth.tenant ?? "<absent>",
  );
  compare(
    "credential_profile_difference",
    "blocked",
    "Member operations use different upstream credential profiles.",
    (operation) => operation.auth.credentialProfile ?? "<absent>",
  );
  compare(
    "auth_secret_source_difference",
    "blocked",
    "Member operations source credentials through different trust mechanisms.",
    (operation) => operation.auth.secretSource,
  );
  compare(
    "auth_provider_difference",
    "blocked",
    "Member operations use different token-acquisition provider/grant mechanics.",
    (operation) => operation.auth.provider ?? "<absent>",
  );
  compare(
    "auth_delegation_difference",
    "blocked",
    "Member operations carry different delegation or impersonation chains.",
    (operation) => operation.auth.delegation ?? "<absent>",
  );
  compare(
    "auth_scope_difference",
    "blocked",
    "The output shapes overlap, but required OAuth scopes differ. The report preserves every scope set and does not broaden a token silently.",
    (operation) => uniqueSorted(operation.auth.scopes),
  );
  if (
    operations.some(
      (operation) =>
        operation.auth.type !== "none" && (!operation.auth.issuer || !operation.auth.audience),
    )
  ) {
    findings.push(
      contradiction(
        seed,
        "auth_identity_incomplete",
        "blocked",
        "Protected member auth is missing issuer or audience evidence. Equal absence is unknown, not compatible.",
      ),
    );
  }
  if (operations.some((operation) => operation.auth.type !== "none" && !operation.auth.tenant)) {
    findings.push(
      contradiction(
        seed,
        "auth_tenant_unproven",
        "review_required",
        "Protected member auth has no explicit tenant/isolation boundary. Equal absence is review debt, not proof of shared scope.",
      ),
    );
  }
  const untrustedGatewaySources = uniqueSorted(
    signatures
      .filter(
        (signature) =>
          signature.source.provenance.kind === "gateway_receipt" &&
          signature.source.provenance.trust !== "verified",
      )
      .map((signature) => signature.sourceId),
  );
  if (untrustedGatewaySources.length > 0) {
    findings.push(
      contradiction(
        seed,
        "gateway_lineage_unverified",
        "blocked",
        "At least one gateway member is missing, stale, or fails verified receipt lineage. It cannot participate in a reviewed authority plan.",
        untrustedGatewaySources,
      ),
    );
  }
  const gatewayBlockers = signatures
    .filter(
      (signature) =>
        signature.source.provenance.kind === "gateway_receipt" &&
        signature.source.provenance.blockerCount > 0,
    )
    .map(
      (signature) =>
        `${signature.sourceId}:${signature.source.provenance.kind === "gateway_receipt" ? signature.source.provenance.blockerCount : 0}`,
    );
  if (gatewayBlockers.length > 0) {
    findings.push(
      contradiction(
        seed,
        "gateway_import_blocked",
        "blocked",
        "At least one gateway receipt retains import blockers; composition cannot launder them.",
        uniqueSorted(gatewayBlockers),
      ),
    );
  }
  const gatewayIdentities = signatures
    .map((signature) =>
      signature.source.provenance.kind === "gateway_receipt"
        ? signature.source.provenance.identity
        : undefined,
    )
    .filter((identity): identity is GatewayImportIdentity => identity !== undefined);
  const gatewayEnvironments = uniqueSorted(
    gatewayIdentities.map((identity) => identity.environment),
  );
  if (gatewayEnvironments.length > 1) {
    findings.push(
      contradiction(
        seed,
        "gateway_environment_difference",
        "blocked",
        "Gateway members come from different receipt-bound environments. Prod/test coordinates cannot be mixed by similarity.",
        gatewayEnvironments,
      ),
    );
  }
  const gatewayRevisions = uniqueSorted(
    gatewayIdentities.map(
      (identity) => `${identity.apiId}:${identity.apiVersion ?? ""}:${identity.revision}`,
    ),
  );
  if (
    gatewayIdentities.length > 1 &&
    new Set(gatewayIdentities.map((identity) => identity.apiId)).size === 1 &&
    gatewayRevisions.length > 1
  ) {
    findings.push(
      contradiction(
        seed,
        "gateway_revision_difference",
        "blocked",
        "The same gateway API appears at different receipt-bound version/revision coordinates.",
        gatewayRevisions,
      ),
    );
  }
  if (operations.some((operation) => operation.state !== "approved")) {
    findings.push(
      contradiction(
        seed,
        "member_not_approved",
        "blocked",
        "At least one member operation is not approved. Composition review cannot approve it.",
        uniqueSorted(operations.map((operation) => operation.state)),
      ),
    );
  }
  if (operations.some((operation) => operation.effect.kind === "mutation")) {
    findings.push(
      contradiction(
        seed,
        "mutation_member",
        "blocked",
        "At least one member is a mutation. A structural output match cannot weaken its confirmation, idempotency, or retry gates.",
      ),
    );
  }
  return findings.sort((left, right) => left.id.localeCompare(right.id));
}

function dataSemanticContradictions(
  seed: string,
  points: readonly DataPoint[],
): CompositionContradiction[] {
  const findings: CompositionContradiction[] = [];
  const groups = new Map<string, DataPoint[]>();
  for (const point of points) {
    const group = groups.get(point.groupKey) ?? [];
    group.push(point);
    groups.set(point.groupKey, group);
  }
  for (const [groupKey, members] of groups) {
    const classifications = uniqueSorted(
      members.map((point) => point.dataSemantics.classification),
    );
    if (classifications.includes("invalid")) {
      findings.push(
        contradiction(
          seed,
          "invalid_data_classification",
          "blocked",
          `Data point ${groupKey} declares an unsupported x-anvil-data-classification value.`,
          classifications,
        ),
      );
    } else if (classifications.includes("unclassified")) {
      findings.push(
        contradiction(
          seed,
          "missing_data_classification",
          "review_required",
          `Data point ${groupKey} has no explicit x-anvil-data-classification. No PII class was inferred from its name.`,
          classifications,
        ),
      );
    } else if (classifications.length > 1) {
      findings.push(
        contradiction(
          seed,
          "data_classification_difference",
          "blocked",
          `Data point ${groupKey} has conflicting explicit classifications.`,
          classifications,
        ),
      );
    }
    for (const factor of ["unit", "currency", "jurisdiction", "masking"] as const) {
      const values = uniqueSorted(
        members.map((point) => point.dataSemantics[factor] ?? "<absent>"),
      );
      if (values.includes("<absent>")) {
        findings.push(
          contradiction(
            seed,
            `missing_data_${factor}`,
            "review_required",
            `Data point ${groupKey} lacks explicit ${factor} metadata; equivalence and disclosure remain review debt.`,
            values,
          ),
        );
      } else if (values.length > 1) {
        findings.push(
          contradiction(
            seed,
            `data_${factor}_difference`,
            "blocked",
            `Data point ${groupKey} has conflicting explicit ${factor} metadata.`,
            values,
          ),
        );
      }
    }
  }
  return findings.sort((left, right) => left.id.localeCompare(right.id));
}

function finalizeCandidate(input: Omit<CandidateCore, "id" | "digest">): CandidateCore {
  const seed = {
    kind: input.kind,
    members: input.members,
    projection: input.projection,
  };
  const id = `${input.kind.replaceAll("_", "-")}-${hashCanonical(seed).slice(0, 16)}`;
  const candidate = { ...input, id, digest: "" };
  return { ...candidate, digest: digest({ ...candidate, digest: undefined }) };
}

function dataPointCandidates(
  points: readonly DataPoint[],
  operations: ReadonlyMap<string, OperationSignature>,
): CandidateCore[] {
  const groups = new Map<string, DataPoint[]>();
  for (const point of points) {
    const group = groups.get(point.groupKey) ?? [];
    group.push(point);
    groups.set(point.groupKey, group);
  }
  const candidates: CandidateCore[] = [];
  for (const [groupKey, occurrences] of [...groups.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const sources = uniqueSorted(occurrences.map((point) => point.sourceId));
    if (sources.length < 2) continue;
    const signatures = uniqueOperationSignatures(occurrences, operations);
    const schemaFingerprints = uniqueSorted(
      occurrences.map(
        (point) => `${point.schemaFingerprint}|${point.required ? "required" : "optional"}`,
      ),
    );
    const seed = `data-point:${groupKey}`;
    const contradictions = [
      ...constraintContradictions(seed, signatures),
      ...dataSemanticContradictions(seed, occurrences),
    ];
    if (schemaFingerprints.length > 1) {
      contradictions.push(
        contradiction(
          seed,
          "schema_contract_difference",
          "blocked",
          "The same declared data-point id has incompatible schema or requiredness evidence.",
          schemaFingerprints,
        ),
      );
    }
    const explicitlyDeclared = occurrences.every(
      (point) => point.evidenceBasis === "explicit_data_point_id",
    );
    if (!explicitlyDeclared) {
      contradictions.push(
        contradiction(
          seed,
          "structural_similarity_only",
          "review_required",
          "Matching pointer/schema leaves are investigation evidence only. A frozen semantic-relation attestation targeted to these exact members is required before they can be treated as the same fact.",
        ),
      );
    }
    candidates.push(
      finalizeCandidate({
        kind: explicitlyDeclared ? "data_point_duplicate" : "structural_leaf_overlap",
        title: explicitlyDeclared
          ? `Declared data point '${occurrences[0]?.semanticId ?? groupKey}' appears across ${sources.length} sources`
          : `Exact output coordinate '${occurrences[0]?.pointer ?? groupKey}' appears across ${sources.length} sources`,
        eligibleSources: sources,
        eligibleMembers: uniqueSorted(occurrences.map((point) => point.id)),
        structuralConfidence: explicitlyDeclared ? 0.85 : 0.6,
        confidenceBasis: explicitlyDeclared
          ? "Every occurrence carries the same explicit x-anvil-data-point id; this supports identity investigation but not source authority."
          : "The JSON pointer, requiredness, and structural schema fingerprint are exact; naming/schema similarity alone cannot establish business identity or authority.",
        evidence: occurrences
          .map((point) => ({
            kind: "air_output_schema" as const,
            sourceId: point.sourceId,
            operationId: point.operationId,
            memberId: point.id,
            coordinate: `output.schema#${point.pointer}`,
            basis: point.evidenceBasis,
          }))
          .sort((left, right) =>
            `${left.sourceId}:${left.operationId}:${left.coordinate}`.localeCompare(
              `${right.sourceId}:${right.operationId}:${right.coordinate}`,
            ),
          ),
        members: occurrences
          .map((point) => ({
            memberId: point.id,
            sourceId: point.sourceId,
            operationId: point.operationId,
            pointer: point.pointer,
            required: point.required,
            ...(point.semanticId ? { semanticId: point.semanticId } : {}),
            schema: point.schema,
            dataSemantics: point.dataSemantics,
            schemaFingerprint: point.schemaFingerprint,
          }))
          .sort((left, right) =>
            `${left.sourceId}:${left.operationId}:${left.pointer}`.localeCompare(
              `${right.sourceId}:${right.operationId}:${right.pointer}`,
            ),
          ),
        constraints: intersectConstraints(signatures),
        contradictions: contradictions.sort((left, right) => left.id.localeCompare(right.id)),
      }),
    );
  }
  return candidates;
}

function uniqueOperationSignatures(
  points: readonly DataPoint[],
  operations: ReadonlyMap<string, OperationSignature>,
): OperationSignature[] {
  const keys = uniqueSorted(points.map((point) => `${point.sourceId}\u0000${point.operationId}`));
  return keys
    .map((key) => operations.get(key))
    .filter((value): value is OperationSignature => value !== undefined);
}

function outputDuplicateCandidates(signatures: readonly OperationSignature[]): CandidateCore[] {
  const groups = new Map<string, OperationSignature[]>();
  for (const signature of signatures) {
    const group = groups.get(signature.outputDigest) ?? [];
    group.push(signature);
    groups.set(signature.outputDigest, group);
  }
  const candidates: CandidateCore[] = [];
  for (const [, members] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sources = uniqueSorted(members.map((member) => member.sourceId));
    if (sources.length < 2) continue;
    const sorted = [...members].sort((left, right) =>
      `${left.sourceId}:${left.operationId}`.localeCompare(
        `${right.sourceId}:${right.operationId}`,
      ),
    );
    const seed = `output-duplicate:${sorted[0]?.outputDigest ?? ""}`;
    candidates.push(
      finalizeCandidate({
        kind: "output_duplicate",
        title: `Exact output shape appears in ${sorted.length} operations across ${sources.length} sources`,
        eligibleSources: sources,
        eligibleMembers: uniqueSorted(
          sorted.map((member) => memberId(member.sourceId, member.operationId, "output.schema")),
        ),
        structuralConfidence: 0.75,
        confidenceBasis:
          "The complete normalized output schema closure is identical, including container constraints such as additionalProperties, items, unions, and discriminators. Business equivalence and source authority remain separate questions.",
        evidence: sorted.map((member) => ({
          kind: "air_output_schema" as const,
          sourceId: member.sourceId,
          operationId: member.operationId,
          memberId: memberId(member.sourceId, member.operationId, "output.schema"),
          coordinate: "output.schema",
          basis: "exact_schema_coordinate" as const,
        })),
        members: sorted.map(memberRef),
        constraints: intersectConstraints(sorted),
        contradictions: [
          ...constraintContradictions(seed, sorted),
          ...dataSemanticContradictions(
            seed,
            sorted.flatMap((member) => member.points),
          ),
        ].sort((left, right) => left.id.localeCompare(right.id)),
      }),
    );
  }
  return candidates;
}

function isStrictSubset(subset: readonly string[], superset: ReadonlySet<string>): boolean {
  return subset.length < superset.size && subset.every((value) => superset.has(value));
}

function outputProjectionCandidates(signatures: readonly OperationSignature[]): CandidateCore[] {
  const byField = new Map<string, Set<number>>();
  signatures.forEach((signature, index) => {
    for (const field of signature.signatures) {
      const members = byField.get(field) ?? new Set<number>();
      members.add(index);
      byField.set(field, members);
    }
  });
  const candidates: CandidateCore[] = [];
  signatures.forEach((projected, projectedIndex) => {
    if (projected.signatures.length < 2) return;
    const first = projected.signatures[0];
    if (!first) return;
    const possible = byField.get(first) ?? new Set<number>();
    for (const sourceIndex of [...possible].sort((a, b) => a - b)) {
      if (sourceIndex === projectedIndex) continue;
      const source = signatures[sourceIndex];
      if (!source || source.sourceId === projected.sourceId) continue;
      const sourceSet = new Set(source.signatures);
      if (!isStrictSubset(projected.signatures, sourceSet)) continue;
      const pair = [source, projected];
      const projectedSet = new Set(projected.signatures);
      const minimizedPoints = [
        ...projected.points,
        ...source.points.filter((point) => projectedSet.has(pointSignature(point))),
      ];
      const seed = `output-projection:${source.sourceId}:${source.operationId}:${projected.sourceId}:${projected.operationId}`;
      candidates.push(
        finalizeCandidate({
          kind: "output_projection",
          title: `${projected.operationId} is an exact structural projection of ${source.operationId}`,
          eligibleSources: uniqueSorted(pair.map((member) => member.sourceId)),
          eligibleMembers: uniqueSorted(
            pair.map((member) => memberId(member.sourceId, member.operationId, "output.schema")),
          ),
          structuralConfidence: 0.7,
          confidenceBasis:
            "Every projected output signature is present in the larger output. This proves only schema derivability, not equivalent filtering, freshness, authorization, or business behavior.",
          evidence: pair.map((member) => ({
            kind: "air_output_schema" as const,
            sourceId: member.sourceId,
            operationId: member.operationId,
            memberId: memberId(member.sourceId, member.operationId, "output.schema"),
            coordinate: "output.schema",
            basis: "exact_output_subset" as const,
          })),
          members: [
            { role: "projection_source", ...memberRef(source) },
            { role: "projected_shape", ...memberRef(projected) },
          ],
          constraints: intersectConstraints(pair),
          contradictions: [
            ...constraintContradictions(seed, pair),
            ...dataSemanticContradictions(seed, minimizedPoints),
            contradiction(
              seed,
              "projection_runtime_semantics_unproven",
              "review_required",
              "Leaf-subset derivability does not prove filters, joins, units, freshness, row authorization, or runtime equivalence. Frozen semantic projection evidence is required.",
            ),
          ].sort((left, right) => left.id.localeCompare(right.id)),
          projection: {
            from: { sourceId: source.sourceId, operationId: source.operationId },
            to: {
              sourceId: projected.sourceId,
              operationId: projected.operationId,
            },
            fieldCount: projected.signatures.length,
            proof: "exact_output_signature_subset",
            limitation:
              "No executable transformation is generated. Filtering, joins, freshness, and row-level authorization remain unproven.",
            minimizedDisclosure: projected.points.map((point) => ({
              memberId: point.id,
              pointer: point.pointer,
              classification: point.dataSemantics.classification,
            })),
          },
        }),
      );
      if (candidates.length > MAX_CANDIDATES) {
        throw new CompositionInputError(
          "composition/candidate_limit",
          `Cross-source projection analysis exceeded ${MAX_CANDIDATES} candidates; select a narrower reviewed bundle set.`,
        );
      }
    }
  });
  return candidates;
}

const AUTHORITY_WEIGHTS: Record<CompositionAuthorityEvidence["factor"], number> = {
  system_of_record: 0.35,
  owner: 0.15,
  lineage: 0.25,
  freshness: 0.1,
  // Write authority is recorded as useful debt, but it cannot increase
  // confidence in a read-authority decision.
  write_authority: 0,
};

function effectiveEvidenceConfidence(input: {
  confidence: number;
  sourceKind: z.infer<typeof EvidenceKind>;
}): number {
  return input.confidence * SOURCE_RELIABILITY[input.sourceKind];
}

function strongEvidence(input: {
  confidence: number;
  sourceKind: z.infer<typeof EvidenceKind>;
}): boolean {
  return effectiveEvidenceConfidence(input) >= MIN_REVIEW_EVIDENCE_CONFIDENCE;
}

function factorContributes(evidence: CompositionAuthorityEvidence): boolean {
  switch (evidence.factor) {
    case "system_of_record":
      return evidence.value;
    case "freshness":
      return evidence.value === "current";
    case "write_authority":
      return false;
    case "owner":
    case "lineage":
      return true;
  }
}

function authorityAssessments(
  candidate: CandidateCore,
  evidence: readonly CompositionAuthorityEvidence[],
  verifiedEvidenceKeys: ReadonlySet<string>,
): {
  assessments: AuthoritySourceAssessment[];
  contradictions: string[];
} {
  const assessments: AuthoritySourceAssessment[] = [];
  const contradictions: string[] = [];
  for (const memberId of candidate.eligibleMembers) {
    const factors = evidence
      .filter((item) => item.memberId === memberId)
      .sort((left, right) =>
        `${left.factor}:${JSON.stringify(left.value)}:${left.sourceRef}`.localeCompare(
          `${right.factor}:${JSON.stringify(right.value)}:${right.sourceRef}`,
        ),
      );
    const factorCoverage = [
      ...new Set(factors.map((factor) => factor.factor)),
    ].sort() as CompositionAuthorityEvidence["factor"][];
    let confidence = 0;
    for (const factor of factorCoverage) {
      const matching = factors.filter((item) => item.factor === factor);
      const values = uniqueSorted(matching.map((item) => JSON.stringify(item.value)));
      if (values.length > 1) {
        contradictions.push(
          `Authority evidence for ${memberId} contradicts itself on ${factor}: ${values.join(", ")}.`,
        );
        continue;
      }
      const strongest = matching
        .filter(
          (item) =>
            verifiedEvidenceKeys.has(compositionEvidenceKey(item)) && factorContributes(item),
        )
        .sort(
          (left, right) => effectiveEvidenceConfidence(right) - effectiveEvidenceConfidence(left),
        )[0];
      if (strongest) {
        confidence += AUTHORITY_WEIGHTS[factor] * effectiveEvidenceConfidence(strongest);
      }
    }
    assessments.push({
      memberId,
      confidence: Number(Math.min(1, confidence).toFixed(4)),
      factors,
      factorCoverage,
    });
  }
  const systemsOfRecord = uniqueSorted(
    evidence
      .filter((item) => item.factor === "system_of_record" && item.value)
      .map((item) => item.memberId),
  );
  if (systemsOfRecord.length > 1) {
    contradictions.push(
      `Multiple exact members are explicitly claimed as system of record: ${systemsOfRecord.join(", ")}.`,
    );
  }
  return { assessments, contradictions: contradictions.sort() };
}

function reviewCandidate(
  candidate: CandidateCore,
  entry: CompositionReviewEntry | undefined,
  verifiedEvidenceKeys: ReadonlySet<string>,
): ReviewedCandidate {
  const evidence = entry?.authorityEvidence ?? [];
  const authority = authorityAssessments(candidate, evidence, verifiedEvidenceKeys);
  const issues = [...authority.contradictions];
  const unverifiedEvidence = [...(entry?.relationEvidence ?? []), ...evidence].filter(
    (item) => !verifiedEvidenceKeys.has(compositionEvidenceKey(item)),
  );
  if (unverifiedEvidence.length > 0) {
    issues.push(
      `${unverifiedEvidence.length} evidence reference(s) were not verified as bounded local files with matching SHA-256 digests.`,
    );
  }
  const active =
    entry !== undefined &&
    (entry.semanticRelation !== "pending" ||
      entry.readAuthority.decision !== "pending" ||
      entry.relationEvidence.length > 0 ||
      entry.authorityEvidence.length > 0 ||
      entry.acknowledgedContradictions.length > 0 ||
      Boolean(entry.note?.trim()));
  let disposition: ReviewedCandidate["disposition"] = active ? "candidate" : "unresolved";
  let semanticStatus: ReviewedCandidate["review"]["semanticStatus"] = active
    ? "candidate"
    : "unresolved";
  let readAuthorityStatus: ReviewedCandidate["review"]["readAuthorityStatus"] = active
    ? "candidate"
    : "unresolved";
  let selectedMember: string | undefined;

  const relation = entry?.semanticRelation ?? "pending";
  if (relation === "not_equivalent") {
    if (!entry?.note?.trim()) {
      issues.push("A not_equivalent decision requires a review note.");
    } else {
      semanticStatus = "reviewed";
      readAuthorityStatus = "reviewed";
      disposition = "reviewed";
    }
  } else if (relation === "same_fact" || relation === "projection") {
    if (relation === "projection" && candidate.kind !== "output_projection") {
      issues.push("semanticRelation=projection is valid only for an output_projection candidate.");
    }
    if (relation === "same_fact" && candidate.kind === "output_projection") {
      issues.push(
        "An output_projection candidate must be reviewed as projection or not_equivalent, not same_fact.",
      );
    }
    const exactMembers = JSON.stringify(candidate.eligibleMembers);
    const strongRelationEvidence = (entry?.relationEvidence ?? []).filter(
      (item) =>
        JSON.stringify(uniqueSorted(item.memberIds)) === exactMembers &&
        strongEvidence(item) &&
        verifiedEvidenceKeys.has(compositionEvidenceKey(item)),
    );
    if (strongRelationEvidence.length === 0) {
      issues.push(
        `A reviewed ${relation} decision requires frozen evidence targeting every exact member with effective confidence >= ${MIN_REVIEW_EVIDENCE_CONFIDENCE} (declared confidence × canonical source reliability).`,
      );
    }
    if (!entry?.note?.trim()) {
      issues.push(`A ${relation} decision requires a review note.`);
    }
    if (
      strongRelationEvidence.length > 0 &&
      entry?.note?.trim() &&
      !issues.some((issue) => issue.includes("semanticRelation="))
    ) {
      semanticStatus = "reviewed";
    }
  }

  if (entry?.readAuthority.decision === "unproven") {
    if (!entry.note?.trim()) {
      issues.push("readAuthority=unproven requires a review note.");
    } else {
      readAuthorityStatus = "reviewed";
      if (semanticStatus === "reviewed") disposition = "reviewed";
    }
  } else if (entry?.readAuthority.decision === "select") {
    const selected = entry.readAuthority.selectedMember;
    if (!selected) {
      issues.push("readAuthority=select requires selectedMember.");
    } else {
      const selectedEvidence = evidence.filter((item) => item.memberId === selected);
      const strong = (factor: CompositionAuthorityEvidence["factor"]): boolean =>
        selectedEvidence.some(
          (item) =>
            item.factor === factor &&
            strongEvidence(item) &&
            verifiedEvidenceKeys.has(compositionEvidenceKey(item)) &&
            factorContributes(item),
        );
      if (!strong("system_of_record")) {
        issues.push(
          `Selected member ${selected} lacks system_of_record=true evidence with effective confidence >= ${MIN_REVIEW_EVIDENCE_CONFIDENCE} (declared confidence × canonical source reliability).`,
        );
      }
      if (!strong("lineage")) {
        issues.push(
          `Selected member ${selected} lacks lineage evidence with effective confidence >= ${MIN_REVIEW_EVIDENCE_CONFIDENCE} (declared confidence × canonical source reliability).`,
        );
      }
      if (!strong("freshness")) {
        issues.push(
          `Selected member ${selected} lacks freshness=current evidence with effective confidence >= ${MIN_REVIEW_EVIDENCE_CONFIDENCE} (declared confidence × canonical source reliability).`,
        );
      }
    }
    if (semanticStatus !== "reviewed") {
      issues.push("Read authority cannot be selected until the semantic relation is reviewed.");
    }
    const blocked = candidate.contradictions.filter((finding) => finding.severity === "blocked");
    if (blocked.length > 0) {
      issues.push(
        `Blocked contradiction(s) cannot be waived: ${blocked.map((finding) => finding.id).join(", ")}.`,
      );
    }
    const unresolvedDataDebt = candidate.contradictions.filter((finding) =>
      [
        "missing_data_classification",
        "missing_data_unit",
        "missing_data_currency",
        "missing_data_jurisdiction",
        "missing_data_masking",
        "auth_tenant_unproven",
      ].includes(finding.kind),
    );
    if (unresolvedDataDebt.length > 0) {
      issues.push(
        `Data minimization evidence is incomplete and cannot be acknowledged away: ${unresolvedDataDebt.map((finding) => finding.id).join(", ")}.`,
      );
    }
    const acknowledged = new Set(entry.acknowledgedContradictions);
    const unacknowledged = candidate.contradictions.filter(
      (finding) =>
        finding.severity === "review_required" &&
        !unresolvedDataDebt.includes(finding) &&
        !acknowledged.has(finding.id),
    );
    if (unacknowledged.length > 0) {
      issues.push(
        `Review has not acknowledged ${unacknowledged.length} review-required finding(s): ${unacknowledged.map((finding) => finding.id).join(", ")}.`,
      );
    }
    if (issues.length === 0 && selected) {
      readAuthorityStatus = "reviewed";
      disposition = "reviewed";
      selectedMember = selected;
    }
  }

  return {
    ...candidate,
    disposition,
    review: {
      semanticRelation: relation,
      semanticStatus,
      readAuthorityDecision: entry?.readAuthority.decision ?? "pending",
      readAuthorityStatus,
      ...(entry?.note ? { note: entry.note } : {}),
      acknowledgedContradictions: uniqueSorted(entry?.acknowledgedContradictions ?? []),
      issues: uniqueSorted(issues),
    },
    authority: {
      inferencePolicy: "explicit_evidence_and_review_only",
      evidenceConfidencePolicy: "declared_times_source_reliability",
      scorePolicy: "display_only_never_selects",
      requiredReadFactors: ["system_of_record", "lineage", "freshness_current"],
      sourceReliability: SOURCE_RELIABILITY,
      ...(selectedMember ? { selectedMember } : {}),
      assessments: authority.assessments,
      confidenceWeights: AUTHORITY_WEIGHTS,
    },
  };
}

function validateReviewBinding(
  review: CompositionReviewManifest,
  inputDigest: string,
  candidateDigest: string,
  candidates: readonly CandidateCore[],
): Map<string, CompositionReviewEntry> {
  if (review.inputDigest !== inputDigest) {
    throw new CompositionInputError(
      "composition/review_input_drift",
      `Review inputDigest ${review.inputDigest} does not match current ${inputDigest}. Re-initialize review against the current AIR bundles.`,
    );
  }
  if (review.candidateDigest !== candidateDigest) {
    throw new CompositionInputError(
      "composition/review_candidate_drift",
      `Review candidateDigest ${review.candidateDigest} does not match current ${candidateDigest}. Re-run the audit and review the changed candidate set.`,
    );
  }
  const expected = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const entries = new Map<string, CompositionReviewEntry>();
  for (const entry of review.candidates) {
    if (entries.has(entry.candidateId)) {
      throw new CompositionInputError(
        "composition/duplicate_review_candidate",
        `Review contains duplicate candidate '${entry.candidateId}'.`,
      );
    }
    const candidate = expected.get(entry.candidateId);
    if (!candidate) {
      throw new CompositionInputError(
        "composition/unknown_review_candidate",
        `Review references unknown candidate '${entry.candidateId}'.`,
      );
    }
    if (entry.candidateDigest !== candidate.digest) {
      throw new CompositionInputError(
        "composition/review_candidate_binding_mismatch",
        `Review candidate '${entry.candidateId}' is bound to ${entry.candidateDigest}, not current ${candidate.digest}.`,
      );
    }
    if (
      JSON.stringify(uniqueSorted(entry.eligibleSources)) !==
      JSON.stringify(candidate.eligibleSources)
    ) {
      throw new CompositionInputError(
        "composition/review_source_binding_mismatch",
        `Review candidate '${entry.candidateId}' has drifted eligibleSources.`,
      );
    }
    if (
      JSON.stringify(uniqueSorted(entry.eligibleMembers)) !==
      JSON.stringify(candidate.eligibleMembers)
    ) {
      throw new CompositionInputError(
        "composition/review_member_binding_mismatch",
        `Review candidate '${entry.candidateId}' has drifted eligibleMembers.`,
      );
    }
    if (
      entry.readAuthority.selectedMember &&
      !candidate.eligibleMembers.includes(entry.readAuthority.selectedMember)
    ) {
      throw new CompositionInputError(
        "composition/invalid_selected_member",
        `Review candidate '${entry.candidateId}' selects exact member '${entry.readAuthority.selectedMember}', which is not eligible.`,
      );
    }
    for (const evidence of entry.authorityEvidence) {
      if (!candidate.eligibleMembers.includes(evidence.memberId)) {
        throw new CompositionInputError(
          "composition/invalid_evidence_member",
          `Authority evidence for candidate '${entry.candidateId}' names non-member '${evidence.memberId}'.`,
        );
      }
    }
    for (const evidence of entry.relationEvidence) {
      const foreign = evidence.memberIds.filter(
        (memberId) => !candidate.eligibleMembers.includes(memberId),
      );
      if (foreign.length > 0) {
        throw new CompositionInputError(
          "composition/invalid_relation_evidence_member",
          `Semantic-relation evidence for candidate '${entry.candidateId}' names non-member(s): ${foreign.join(", ")}.`,
        );
      }
    }
    entries.set(entry.candidateId, entry);
  }
  if (entries.size !== candidates.length) {
    const missing = candidates.map((candidate) => candidate.id).filter((id) => !entries.has(id));
    throw new CompositionInputError(
      "composition/incomplete_review_binding",
      `Review is missing ${missing.length} current candidate(s): ${missing.join(", ")}.`,
    );
  }
  return entries;
}

export function compositionReviewScaffold(
  inputDigest: string,
  candidateDigest: string,
  candidates: readonly CandidateCore[],
): CompositionReviewManifest {
  return {
    schemaVersion: COMPOSITION_REVIEW_SCHEMA_VERSION,
    reportType: "anvil.cross-source-composition-review",
    inputDigest,
    candidateDigest,
    candidates: candidates.map((candidate) => ({
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      eligibleSources: candidate.eligibleSources,
      eligibleMembers: candidate.eligibleMembers,
      semanticRelation: "pending",
      relationEvidence: [],
      readAuthority: { decision: "pending" },
      authorityEvidence: [],
      acknowledgedContradictions: [],
    })),
  };
}

function candidateOperationRefs(candidate: ReviewedCandidate): Array<{
  sourceId: string;
  operationId: string;
}> {
  const refs = new Map<string, { sourceId: string; operationId: string }>();
  for (const evidence of candidate.evidence) {
    refs.set(`${evidence.sourceId}\u0000${evidence.operationId}`, {
      sourceId: evidence.sourceId,
      operationId: evidence.operationId,
    });
  }
  return [...refs.values()].sort((left, right) =>
    `${left.sourceId}:${left.operationId}`.localeCompare(`${right.sourceId}:${right.operationId}`),
  );
}

export function analyzeComposition(
  inputs: readonly CompositionAnalysisInput[],
  review?: CompositionReviewManifest,
  verifiedEvidenceArtifacts: readonly VerifiedCompositionEvidenceArtifact[] = [],
): {
  report: CompositionAuditReport;
  scaffold: CompositionReviewManifest;
} {
  if (inputs.length < 2) {
    throw new CompositionInputError(
      "composition/two_sources_required",
      "Cross-source composition requires at least two AIR bundles.",
    );
  }
  if (inputs.length > MAX_SOURCES) {
    throw new CompositionInputError(
      "composition/source_limit",
      `Cross-source composition accepts at most ${MAX_SOURCES} AIR bundles per audit.`,
    );
  }

  inputs.forEach(({ air }) => {
    assertBoundedAirSchemas(air);
  });
  const records = inputs
    .map(({ air, provenance }) => ({
      air,
      source: sourceIdentity(air, provenance),
    }))
    .sort((left, right) => left.source.id.localeCompare(right.source.id));
  const duplicateSource = records.find(
    (record, index) => index > 0 && records[index - 1]?.source.id === record.source.id,
  );
  if (duplicateSource) {
    throw new CompositionInputError(
      "composition/duplicate_source",
      `The same AIR contract was supplied more than once: ${duplicateSource.source.id}.`,
    );
  }
  const operationCount = records.reduce((sum, record) => sum + record.air.operations.length, 0);
  if (operationCount > MAX_OPERATIONS) {
    throw new CompositionInputError(
      "composition/operation_limit",
      `Cross-source composition accepts at most ${MAX_OPERATIONS} operations per audit; select a narrower reviewed bundle set.`,
    );
  }

  const signatures: OperationSignature[] = [];
  for (const record of records) {
    for (const operation of [...record.air.operations].sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      const signature = operationSignature(record.air, record.source, operation);
      if (signature) signatures.push(signature);
    }
  }
  signatures.sort((left, right) =>
    `${left.sourceId}:${left.operationId}`.localeCompare(`${right.sourceId}:${right.operationId}`),
  );
  const points = signatures.flatMap((signature) => signature.points);
  if (points.length > MAX_DATA_POINTS) {
    throw new CompositionInputError(
      "composition/data_point_limit",
      `Cross-source composition found more than ${MAX_DATA_POINTS} output data points; select a narrower reviewed bundle set.`,
    );
  }
  const operationMap = new Map(
    signatures.map((signature) => [
      `${signature.sourceId}\u0000${signature.operationId}`,
      signature,
    ]),
  );
  const candidates = [
    ...dataPointCandidates(points, operationMap),
    ...outputDuplicateCandidates(signatures),
    ...outputProjectionCandidates(signatures),
  ].sort((left, right) => left.id.localeCompare(right.id));
  if (candidates.length > MAX_CANDIDATES) {
    throw new CompositionInputError(
      "composition/candidate_limit",
      `Cross-source composition found ${candidates.length} candidates, above the ${MAX_CANDIDATES} fail-closed limit.`,
    );
  }

  const sources = records.map((record) => record.source);
  const inputDigest = digest(
    sources.map((source) => ({
      id: source.id,
      contractDigest: source.contractDigest,
      lineage: source.lineage,
      provenance: source.provenance,
    })),
  );
  const candidateDigest = digest(candidates);
  const scaffold = compositionReviewScaffold(inputDigest, candidateDigest, candidates);
  const reviewEntries = review
    ? validateReviewBinding(review, inputDigest, candidateDigest, candidates)
    : new Map<string, CompositionReviewEntry>();
  const evidenceArtifacts = [
    ...new Map(
      verifiedEvidenceArtifacts.map((artifact) => [compositionEvidenceKey(artifact), artifact]),
    ).values(),
  ].sort((left, right) =>
    compositionEvidenceKey(left).localeCompare(compositionEvidenceKey(right)),
  );
  const verifiedEvidenceKeys = new Set(
    evidenceArtifacts.map((artifact) => compositionEvidenceKey(artifact)),
  );
  const reviewedCandidates = candidates.map((candidate) =>
    reviewCandidate(candidate, reviewEntries.get(candidate.id), verifiedEvidenceKeys),
  );
  const reviewDigest = review ? digest(review) : undefined;
  const compositionPlans =
    reviewDigest === undefined
      ? []
      : reviewedCandidates
          .filter(
            (candidate) =>
              candidate.disposition === "reviewed" &&
              (candidate.review.semanticRelation === "same_fact" ||
                candidate.review.semanticRelation === "projection") &&
              candidate.review.semanticStatus === "reviewed" &&
              candidate.review.readAuthorityDecision === "select" &&
              candidate.review.readAuthorityStatus === "reviewed" &&
              candidate.authority.selectedMember !== undefined,
          )
          .map((candidate) => {
            const selectedMember = candidate.authority.selectedMember as string;
            const selectedEvidence = candidate.evidence.find(
              (evidence) => evidence.memberId === selectedMember,
            );
            if (!selectedEvidence) {
              throw new CompositionInputError(
                "composition/selected_member_unbound",
                `Reviewed selected member '${selectedMember}' has no exact candidate evidence coordinate.`,
              );
            }
            return {
              schemaVersion: 1 as const,
              candidateId: candidate.id,
              candidateDigest: candidate.digest,
              reviewDigest,
              selectedMember,
              selectedSource: selectedEvidence.sourceId,
              semanticRelation: candidate.review.semanticRelation as "same_fact" | "projection",
              memberOperations: candidateOperationRefs(candidate),
              ...(candidate.projection
                ? { minimizedDisclosure: candidate.projection.minimizedDisclosure }
                : {}),
              constraints: candidate.constraints,
              buildReady: false as const,
              status: "reviewed_plan_only" as const,
            };
          });
  const dispositions = {
    unresolved: reviewedCandidates.filter((candidate) => candidate.disposition === "unresolved")
      .length,
    candidate: reviewedCandidates.filter((candidate) => candidate.disposition === "candidate")
      .length,
    reviewed: reviewedCandidates.filter((candidate) => candidate.disposition === "reviewed").length,
  };
  const reportWithoutHash: Omit<CompositionAuditReport, "reportHash"> = {
    schemaVersion: 1,
    reportType: "anvil.cross-source-composition-audit" as const,
    inputDigest,
    candidateDigest,
    ...(reviewDigest ? { reviewDigest } : {}),
    evidenceArtifacts,
    sources,
    summary: {
      sourceCount: sources.length,
      operationCount,
      outputDataPointCount: points.length,
      candidateCount: reviewedCandidates.length,
      dispositions,
      reviewedPlanCount: compositionPlans.length,
    },
    candidates: reviewedCandidates,
    compositionPlans,
    boundary: {
      mode: "offline_input_read_only_audit" as const,
      generatedMcp: false as const,
      autoApproved: false as const,
      buildReady: false as const,
      reason:
        "Anvil does not yet have a safe multi-source AIR/MCP materializer. This slice stops at a review-, evidence-, and contract-bound composition plan.",
      nextGate:
        "Materialize a composed AIR under explicit review while preserving every member identity/safety group; then use the existing capability show, approve, and build gates. This report itself is never build input or approval.",
    },
  };
  const report: CompositionAuditReport = {
    ...reportWithoutHash,
    reportHash: digest(reportWithoutHash),
  };
  return { report, scaffold };
}
