import { hashCanonical } from "@anvil/air";
import { z } from "zod";
import {
  EvidenceSourceKind,
  LegacyArtifactRole,
  LegacyEstate,
  LegacyIdentifier,
  LegacyRelativePath,
  LegacySha256,
} from "../core/index.js";

const boundedText = (max = 512) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value === value.trim(), "must not have surrounding whitespace")
    .refine(
      (value) =>
        [...value].every((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint > 31 && codePoint !== 127;
        }),
      "must not contain control characters",
    );

export const LegacyCollectionRequirement = z.enum([
  "deployment_identity",
  "invocation_binding",
  "message_direction",
  "input_schema",
  "output_schema",
  "error_semantics",
  "transaction_semantics",
  "authorization_context",
  "completion_semantics",
  "ownership",
]);
export type LegacyCollectionRequirement = z.infer<typeof LegacyCollectionRequirement>;

export const LegacyCollectionContext = z
  .object({
    environment: LegacyIdentifier,
    application: LegacyIdentifier,
    platform: LegacyIdentifier.optional(),
    module: LegacyIdentifier.optional(),
    component: LegacyIdentifier.optional(),
    domain: LegacyIdentifier.optional(),
    cluster: LegacyIdentifier.optional(),
    cell: LegacyIdentifier.optional(),
    node: LegacyIdentifier.optional(),
    server: LegacyIdentifier.optional(),
    queueManager: LegacyIdentifier.optional(),
    broker: LegacyIdentifier.optional(),
    iisSite: LegacyIdentifier.optional(),
  })
  .strict();
export type LegacyCollectionContext = z.infer<typeof LegacyCollectionContext>;

export const LegacyCollectionSource = z
  .object({
    id: LegacyIdentifier,
    kind: EvidenceSourceKind,
    systemId: LegacyIdentifier,
    root: LegacyRelativePath,
    revision: boundedText(512).optional(),
    expectedRoles: z.array(LegacyArtifactRole).min(1).max(LegacyArtifactRole.options.length),
    context: LegacyCollectionContext,
  })
  .strict()
  .superRefine((source, ctx) => {
    if (
      (source.kind === "source_repository" || source.kind === "artifact_repository") &&
      source.revision === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["revision"],
        message: "repository evidence must be pinned to an immutable revision",
      });
    }
    if (new Set(source.expectedRoles).size !== source.expectedRoles.length) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedRoles"],
        message: "must not contain duplicate artifact roles",
      });
    }
  });
export type LegacyCollectionSource = z.infer<typeof LegacyCollectionSource>;

/** Fixed literals are intentional: unsafe acquisition modes are not options. */
export const LegacyCollectionPolicy = z
  .object({
    networkAccess: z.literal("deny"),
    processExecution: z.literal("deny"),
    classloading: z.literal("deny"),
    bytecodeExecution: z.literal("deny"),
    xmlExternalEntities: z.literal("deny"),
    secrets: z.literal("refuse"),
    archiveExpansion: z.literal("hardened"),
    unknownArtifacts: z.literal("report"),
    unsupportedEvidence: z.literal("fail"),
    ambiguousEvidence: z.literal("fail"),
  })
  .strict();
export type LegacyCollectionPolicy = z.infer<typeof LegacyCollectionPolicy>;

const CollectionPlanCore = z
  .object({
    schemaVersion: z.literal(1),
    estate: LegacyEstate,
    sources: z.array(LegacyCollectionSource).min(1).max(10_000),
    requirements: z
      .array(LegacyCollectionRequirement)
      .min(1)
      .max(LegacyCollectionRequirement.options.length),
    policy: LegacyCollectionPolicy,
  })
  .strict()
  .superRefine((plan, ctx) => {
    const sourceIds = new Set<string>();
    plan.sources.forEach((source, index) => {
      if (sourceIds.has(source.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["sources", index, "id"],
          message: `duplicate collection source '${source.id}'`,
        });
      }
      sourceIds.add(source.id);
    });
    if (new Set(plan.requirements).size !== plan.requirements.length) {
      ctx.addIssue({
        code: "custom",
        path: ["requirements"],
        message: "must not contain duplicate requirements",
      });
    }
  });

export const LegacyCollectionPlanInput = CollectionPlanCore;
export type LegacyCollectionPlanInput = z.input<typeof LegacyCollectionPlanInput>;

export const LegacyCollectionPlan = CollectionPlanCore.extend({
  planId: z.string().regex(/^lcp_[0-9a-f]{64}$/),
  contentHash: LegacySha256,
})
  .strict()
  .superRefine((plan, ctx) => {
    const { planId: _planId, contentHash: _contentHash, ...core } = plan;
    const expected = addressCollectionPlan(core);
    if (plan.planId !== expected.planId) {
      ctx.addIssue({ code: "custom", path: ["planId"], message: "must match plan content" });
    }
    if (plan.contentHash !== expected.contentHash) {
      ctx.addIssue({
        code: "custom",
        path: ["contentHash"],
        message: "must match plan content",
      });
    }
  });
export type LegacyCollectionPlan = z.infer<typeof LegacyCollectionPlan>;

function normalizeCore(input: LegacyCollectionPlanInput): z.infer<typeof CollectionPlanCore> {
  const parsed = CollectionPlanCore.parse(input);
  return {
    ...parsed,
    sources: parsed.sources
      .map((source) => ({
        ...source,
        expectedRoles: [...source.expectedRoles].sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    requirements: [...parsed.requirements].sort(),
  };
}

function addressCollectionPlan(core: z.infer<typeof CollectionPlanCore>): {
  planId: string;
  contentHash: `sha256:${string}`;
} {
  const hex = hashCanonical(core);
  return { planId: `lcp_${hex}`, contentHash: `sha256:${hex}` };
}

export function createLegacyCollectionPlan(input: LegacyCollectionPlanInput): LegacyCollectionPlan {
  const core = normalizeCore(input);
  return LegacyCollectionPlan.parse({ ...core, ...addressCollectionPlan(core) });
}

export function verifyLegacyCollectionPlan(input: unknown): LegacyCollectionPlan {
  const parsed = LegacyCollectionPlan.parse(input);
  const { planId: _planId, contentHash: _contentHash, ...core } = parsed;
  return createLegacyCollectionPlan(core);
}

export const FAIL_CLOSED_LEGACY_COLLECTION_POLICY: LegacyCollectionPolicy = Object.freeze({
  networkAccess: "deny",
  processExecution: "deny",
  classloading: "deny",
  bytecodeExecution: "deny",
  xmlExternalEntities: "deny",
  secrets: "refuse",
  archiveExpansion: "hardened",
  unknownArtifacts: "report",
  unsupportedEvidence: "fail",
  ambiguousEvidence: "fail",
});
