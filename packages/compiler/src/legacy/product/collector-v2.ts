import { hashCanonical } from "@anvil/air";
import { z } from "zod";
import {
  EvidenceSourceKind,
  LegacyArtifactRole,
  LegacyClaimDimension,
  LegacyClaimValue,
  LegacyDeploymentCoordinate,
  LegacyEvidenceBasis,
  LegacyIdentifier,
  LegacyInvocation,
  LegacyRelativePath,
  LegacySha256,
} from "../core/index.js";
import {
  type LegacyCollectionContext,
  LegacyCollectionRequirement,
  type LegacyCollectionRequirement as LegacyCollectionRequirementType,
} from "./collection-plan.js";

const boundedText = (max = 2048) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value === value.trim(), "must not have surrounding whitespace");

export const LegacyCollectorRuntimeBoundaryV2 = z
  .object({
    mode: z.literal("pure_offline"),
    networkAccess: z.literal(false),
    processExecution: z.literal(false),
    classloading: z.literal(false),
    bytecodeExecution: z.literal(false),
    externalEntityResolution: z.literal(false),
    environmentAccess: z.literal(false),
    filesystemAccessOutsideMembers: z.literal(false),
    emitsRawContent: z.literal(false),
  })
  .strict();
export type LegacyCollectorRuntimeBoundaryV2 = z.infer<typeof LegacyCollectorRuntimeBoundaryV2>;

export const PURE_OFFLINE_COLLECTOR_BOUNDARY_V2: LegacyCollectorRuntimeBoundaryV2 = Object.freeze({
  mode: "pure_offline",
  networkAccess: false,
  processExecution: false,
  classloading: false,
  bytecodeExecution: false,
  externalEntityResolution: false,
  environmentAccess: false,
  filesystemAccessOutsideMembers: false,
  emitsRawContent: false,
});

export const LegacyCollectorDescriptorV2 = z
  .object({
    apiVersion: z.literal("anvil.dev/legacy-collector/v2"),
    id: LegacyIdentifier,
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    displayName: boundedText(256),
    runtimeBoundary: LegacyCollectorRuntimeBoundaryV2,
    accepts: z
      .object({
        sourceKinds: z.array(EvidenceSourceKind).min(1).max(EvidenceSourceKind.options.length),
        artifactRoles: z.array(LegacyArtifactRole).min(1).max(LegacyArtifactRole.options.length),
        extensions: z.array(z.string().regex(/^\.[a-z0-9][a-z0-9._-]*$/)).max(128),
        mediaTypes: z.array(boundedText(255)).max(128),
      })
      .strict(),
    capabilities: z
      .array(LegacyCollectionRequirement)
      .min(1)
      .max(LegacyCollectionRequirement.options.length),
    limits: z
      .object({
        maxMemberBytes: z
          .number()
          .int()
          .positive()
          .max(4 * 1024 * 1024 * 1024),
        maxMembers: z.number().int().positive().max(1_000_000),
        maxOutputFacts: z.number().int().positive().max(10_000_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((descriptor, ctx) => {
    for (const [field, values] of [
      ["sourceKinds", descriptor.accepts.sourceKinds],
      ["artifactRoles", descriptor.accepts.artifactRoles],
      ["extensions", descriptor.accepts.extensions],
      ["mediaTypes", descriptor.accepts.mediaTypes],
      ["capabilities", descriptor.capabilities],
    ] as const) {
      if (new Set(values).size !== values.length) {
        ctx.addIssue({
          code: "custom",
          path: field === "capabilities" ? [field] : ["accepts", field],
          message: "must not contain duplicates",
        });
      }
    }
  });
export type LegacyCollectorDescriptorV2 = z.infer<typeof LegacyCollectorDescriptorV2>;

const CollectorMemberMetadataCoreV2 = z
  .object({
    sourceId: LegacyIdentifier,
    path: LegacyRelativePath,
    digest: LegacySha256,
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    role: LegacyArtifactRole,
    sourceKind: EvidenceSourceKind,
    mediaType: boundedText(255).optional(),
  })
  .strict();

export const LegacyCollectorMemberMetadataV2 = CollectorMemberMetadataCoreV2.extend({
  memberId: z.string().regex(/^lcm_[0-9a-f]{64}$/),
})
  .strict()
  .superRefine((member, ctx) => {
    const { memberId: _memberId, ...core } = member;
    if (member.memberId !== `lcm_${hashCanonical(core)}`) {
      ctx.addIssue({
        code: "custom",
        path: ["memberId"],
        message: "must match member provenance and digest",
      });
    }
  });
export type LegacyCollectorMemberMetadataV2 = z.infer<typeof LegacyCollectorMemberMetadataV2>;

export function createLegacyCollectorMemberMetadataV2(
  input: z.input<typeof CollectorMemberMetadataCoreV2>,
): LegacyCollectorMemberMetadataV2 {
  const core = CollectorMemberMetadataCoreV2.parse(input);
  return LegacyCollectorMemberMetadataV2.parse({
    ...core,
    memberId: `lcm_${hashCanonical(core)}`,
  });
}

/** Bytes are caller-owned immutable input and must never be retained or emitted. */
export interface LegacyCollectorMemberV2 extends LegacyCollectorMemberMetadataV2 {
  readonly content: Uint8Array;
}

export const LegacyCollectorDetectionV2 = z
  .object({
    collectorId: LegacyIdentifier,
    memberId: z.string().regex(/^lcm_[0-9a-f]{64}$/),
    artifactFamily: LegacyIdentifier,
    confidence: z.enum(["exact", "probable"]),
    reason: boundedText(1024),
  })
  .strict();
export type LegacyCollectorDetectionV2 = z.infer<typeof LegacyCollectorDetectionV2>;

export const LegacyCollectorEvidenceReferenceV2 = z
  .object({
    memberId: z.string().regex(/^lcm_[0-9a-f]{64}$/),
    basis: LegacyEvidenceBasis,
    pointer: boundedText(2048).optional(),
    span: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
      })
      .strict()
      .refine((span) => span.end >= span.start, "span end must be at or after start")
      .optional(),
  })
  .strict();
export type LegacyCollectorEvidenceReferenceV2 = z.infer<typeof LegacyCollectorEvidenceReferenceV2>;

const CollectorClaimV2 = z
  .object({
    dimension: LegacyClaimDimension,
    value: LegacyClaimValue,
    basis: LegacyEvidenceBasis,
    evidence: z.array(LegacyCollectorEvidenceReferenceV2).min(1).max(512),
  })
  .strict();

const CollectorFactCoreV2 = z
  .object({
    schemaVersion: z.literal(2),
    collectorId: LegacyIdentifier,
    coordinate: LegacyDeploymentCoordinate,
    invocation: LegacyInvocation,
    evidence: z.array(LegacyCollectorEvidenceReferenceV2).min(1).max(512),
    claims: z.array(CollectorClaimV2).max(256),
  })
  .strict()
  .superRefine((fact, ctx) => {
    const owned = new Set(fact.evidence.map((item) => hashCanonical(item)));
    fact.claims.forEach((claim, claimIndex) => {
      claim.evidence.forEach((reference, referenceIndex) => {
        if (!owned.has(hashCanonical(reference))) {
          ctx.addIssue({
            code: "custom",
            path: ["claims", claimIndex, "evidence", referenceIndex],
            message: "claim evidence must also be listed on the fact",
          });
        }
      });
    });
  });

export const LegacyCollectorFactV2 = CollectorFactCoreV2.extend({
  factId: z.string().regex(/^lcf_[0-9a-f]{64}$/),
  contentHash: LegacySha256,
})
  .strict()
  .superRefine((fact, ctx) => {
    const { factId: _factId, contentHash: _contentHash, ...core } = fact;
    const hex = hashCanonical(core);
    if (fact.factId !== `lcf_${hex}` || fact.contentHash !== `sha256:${hex}`) {
      ctx.addIssue({ code: "custom", message: "fact identity must match fact content" });
    }
  });
export type LegacyCollectorFactV2 = z.infer<typeof LegacyCollectorFactV2>;

export function createLegacyCollectorFactV2(
  input: z.input<typeof CollectorFactCoreV2>,
): LegacyCollectorFactV2 {
  const core = CollectorFactCoreV2.parse(input);
  const hex = hashCanonical(core);
  return LegacyCollectorFactV2.parse({
    ...core,
    factId: `lcf_${hex}`,
    contentHash: `sha256:${hex}`,
  });
}

const CollectorProblemCoreV2 = z
  .object({
    schemaVersion: z.literal(2),
    collectorId: LegacyIdentifier,
    stage: z.enum(["detect", "plan", "collect", "link", "project"]),
    category: z.enum(["safety_refusal", "unsupported", "incomplete", "malformed", "internal"]),
    severity: z.enum(["error", "warning", "info"]),
    code: z.string().regex(/^legacy\/[a-z0-9][a-z0-9_/-]*$/),
    message: boundedText(),
    remediation: boundedText().optional(),
    memberId: z
      .string()
      .regex(/^lcm_[0-9a-f]{64}$/)
      .optional(),
    evidenceIds: z.array(z.string().regex(/^le_[0-9a-f]{64}$/)).max(512),
    retryable: z.literal(false),
  })
  .strict();

export const LegacyCollectorProblemV2 = CollectorProblemCoreV2.extend({
  problemId: z.string().regex(/^lpr_[0-9a-f]{64}$/),
  contentHash: LegacySha256,
})
  .strict()
  .superRefine((problem, ctx) => {
    const { problemId: _problemId, contentHash: _contentHash, ...core } = problem;
    const hex = hashCanonical(core);
    if (problem.problemId !== `lpr_${hex}` || problem.contentHash !== `sha256:${hex}`) {
      ctx.addIssue({ code: "custom", message: "problem identity must match problem content" });
    }
  });
export type LegacyCollectorProblemV2 = z.infer<typeof LegacyCollectorProblemV2>;

export function createLegacyCollectorProblemV2(
  input: z.input<typeof CollectorProblemCoreV2>,
): LegacyCollectorProblemV2 {
  const core = CollectorProblemCoreV2.parse(input);
  const hex = hashCanonical(core);
  return LegacyCollectorProblemV2.parse({
    ...core,
    problemId: `lpr_${hex}`,
    contentHash: `sha256:${hex}`,
  });
}

export const LegacyCollectorAcquisitionRequestV2 = z
  .object({
    requirement: LegacyCollectionRequirement,
    reason: boundedText(),
    acceptableSourceKinds: z.array(EvidenceSourceKind).min(1),
    artifactPatterns: z.array(boundedText(512)).min(1).max(64),
    required: z.boolean(),
  })
  .strict();
export type LegacyCollectorAcquisitionRequestV2 = z.infer<
  typeof LegacyCollectorAcquisitionRequestV2
>;

export type LegacyCollectorEmissionV2 =
  | { readonly kind: "fact"; readonly fact: LegacyCollectorFactV2 }
  | { readonly kind: "problem"; readonly problem: LegacyCollectorProblemV2 };

export interface LegacyCollectorContextV2 {
  readonly collectionContext: LegacyCollectionContext;
  readonly requiredCapabilities: readonly LegacyCollectionRequirementType[];
  readonly runtimeBoundary: LegacyCollectorRuntimeBoundaryV2;
}

/**
 * V2 collector SPI. Implementations are deterministic transforms over supplied
 * bytes. They may not read the environment, filesystem, network, load classes,
 * execute bytecode, or persist raw input through their output types.
 */
export interface LegacyCollectorV2 {
  readonly descriptor: LegacyCollectorDescriptorV2;

  detect(
    member: LegacyCollectorMemberV2,
    context: LegacyCollectorContextV2,
  ): readonly LegacyCollectorDetectionV2[];

  plan(
    detections: readonly LegacyCollectorDetectionV2[],
    context: LegacyCollectorContextV2,
  ): readonly LegacyCollectorAcquisitionRequestV2[];

  collect(
    members: AsyncIterable<LegacyCollectorMemberV2>,
    context: LegacyCollectorContextV2,
  ): AsyncIterable<LegacyCollectorEmissionV2>;
}
