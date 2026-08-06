import { EvidenceKind } from "@anvil/air";
import { z } from "zod";
import {
  zDeficiencyCode,
  zEvidencePolicyDoc,
  zJsonValue,
  zProcedureDoc,
  zSemanticTarget,
  zSeverity,
} from "../case/schema.js";
import { rejectHarness, zodIssueMessages } from "./errors.js";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 hex digest");
const GitObjectId = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, "must be a full Git object id");
const RelativeRepositoryPath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      path === "." ||
      (!path.startsWith("/") &&
        !path.startsWith("\\") &&
        !/^[A-Za-z]:[\\/]/.test(path) &&
        !path.split(/[\\/]+/).includes("..")),
    "must be a repository-relative path without '..' traversal",
  );

export const REFINEMENT_TASK_SCHEMA_VERSION = 1 as const;
export const HARNESS_SUBMISSION_SCHEMA_VERSION = 1 as const;

/** Portable, deterministic task exported by Anvil for any coding harness. */
export const zRefinementTask = z
  .object({
    schemaVersion: z.literal(REFINEMENT_TASK_SCHEMA_VERSION),
    taskId: z.string().regex(/^rt_[a-f0-9]{24}$/, "must be a deterministic task id"),
    taskHash: Sha256,
    service: z.object({ id: z.string().min(1), version: z.string().min(1) }).strict(),
    sourceContractHash: Sha256,
    repository: z
      .object({
        revision: GitObjectId,
        inspectScopes: z.array(RelativeRepositoryPath),
      })
      .strict(),
    skill: z
      .object({
        name: z.string().min(1),
        version: z.number().int().positive(),
        contractHash: Sha256,
      })
      .strict(),
    deficiency: z
      .object({
        code: zDeficiencyCode,
        severity: zSeverity,
        target: zSemanticTarget,
        message: z.string().min(1),
        facts: z.record(z.string(), zJsonValue),
      })
      .strict(),
    /** Read-only snapshot for investigation; import rebuilds authoritative context from AIR. */
    context: z.record(z.string(), zJsonValue),
    policy: zEvidencePolicyDoc,
    procedure: zProcedureDoc,
    mustNot: z.array(z.string().min(1)),
    expectedSubmission: z.record(z.string(), z.unknown()),
  })
  .strict();
export type RefinementTask = z.infer<typeof zRefinementTask>;

const zRepositoryEvidenceInput = z
  .object({
    id: z.string().min(1),
    kind: z.literal("repository"),
    source: EvidenceKind,
    path: RelativeRepositoryPath,
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    note: z.string().optional(),
  })
  .strict()
  .refine(
    (coordinate) =>
      coordinate.endLine === undefined ||
      (coordinate.startLine !== undefined && coordinate.endLine >= coordinate.startLine),
    { message: "endLine requires startLine and must be greater than or equal to it" },
  );

const zExternalEvidenceInput = z
  .object({
    id: z.string().min(1),
    kind: z.literal("external"),
    source: EvidenceKind,
    uri: z.string().min(1),
    excerpt: z.string().min(1),
    note: z.string().optional(),
  })
  .strict();

export const zHarnessEvidenceInput = z.discriminatedUnion("kind", [
  zRepositoryEvidenceInput,
  zExternalEvidenceInput,
]);
export type HarnessEvidenceInput = z.infer<typeof zHarnessEvidenceInput>;

export const zHarnessClaimInput = z
  .object({
    predicate: z.string().min(1),
    value: zJsonValue,
    evidenceId: z.string().min(1),
    confidence: z.number().min(0).max(1).optional(),
    note: z.string().optional(),
  })
  .strict();
export type HarnessClaimInput = z.infer<typeof zHarnessClaimInput>;

const zHarnessOutcome = z.enum([
  "proposal_generated",
  "supported",
  "conflicted",
  "insufficient_evidence",
  "blocked_by_missing_source",
]);

/** Harness-authored response. It carries coordinates and claims, never trusted evidence bytes. */
export const zHarnessSubmission = z
  .object({
    schemaVersion: z.literal(HARNESS_SUBMISSION_SCHEMA_VERSION),
    taskId: z.string().min(1),
    taskHash: Sha256,
    executor: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
      })
      .strict(),
    status: zHarnessOutcome,
    summary: z.string().min(1),
    evidence: z.array(zHarnessEvidenceInput),
    claims: z.array(zHarnessClaimInput),
    patch: z
      .object({ set: z.record(z.string(), zJsonValue) })
      .strict()
      .optional(),
    submittedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((submission, ctx) => {
    const ids = submission.evidence.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message: "evidence ids must be unique",
      });
    }
    const known = new Set(ids);
    for (const [index, claim] of submission.claims.entries()) {
      if (!known.has(claim.evidenceId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["claims", index, "evidenceId"],
          message: `does not resolve to evidence '${claim.evidenceId}'`,
        });
      }
    }
    const hasPatch = submission.patch !== undefined && Object.keys(submission.patch.set).length > 0;
    if (submission.status === "proposal_generated") {
      if (!hasPatch) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["patch"],
          message: "proposal_generated requires a non-empty patch",
        });
      }
      if (submission.claims.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["claims"],
          message: "proposal_generated requires at least one evidence-backed claim",
        });
      }
    } else if (submission.patch !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["patch"],
        message: `${submission.status} is an honest decline and must not carry a patch`,
      });
    }
  });
export type HarnessSubmission = z.infer<typeof zHarnessSubmission>;

/** Evidence bytes Anvil independently resolved from a pinned repository revision. */
export const zHarnessEvidenceArtifact = z
  .object({
    id: z.string().min(1),
    inputId: z.string().min(1),
    uri: z.string().min(1),
    source: EvidenceKind,
    revision: GitObjectId.optional(),
    gitBlob: GitObjectId.optional(),
    blobSha256: Sha256,
    contentHash: Sha256,
    excerpt: z.string(),
    path: RelativeRepositoryPath.optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    verification: z.discriminatedUnion("status", [
      z.object({ status: z.literal("verified"), verifier: z.literal("git_repository") }).strict(),
      z.object({ status: z.literal("unverified"), reason: z.string().min(1) }).strict(),
    ]),
  })
  .strict();
export type HarnessEvidenceArtifact = z.infer<typeof zHarnessEvidenceArtifact>;

/** Audit record embedded in an imported pack and therefore covered by its receipt hash. */
export const zHarnessImportRecord = z
  .object({
    task: zRefinementTask,
    submission: zHarnessSubmission,
    submissionHash: Sha256,
    artifacts: z.array(zHarnessEvidenceArtifact),
  })
  .strict();
export type HarnessImportRecord = z.infer<typeof zHarnessImportRecord>;

export function parseRefinementTask(value: unknown): RefinementTask {
  const result = zRefinementTask.safeParse(value);
  if (!result.success) {
    rejectHarness(
      "refinement/invalid_task",
      "task",
      "The refinement task does not match the supported protocol schema.",
      zodIssueMessages(result.error),
    );
  }
  return result.data;
}

export function parseHarnessSubmission(value: unknown): HarnessSubmission {
  const result = zHarnessSubmission.safeParse(value);
  if (!result.success) {
    rejectHarness(
      "refinement/invalid_submission",
      "binding",
      "The harness submission does not match the supported protocol schema.",
      zodIssueMessages(result.error),
    );
  }
  return result.data;
}

/** JSON Schema a harness can consume without importing this TypeScript package. */
export function expectedHarnessSubmissionSchema(writableFields: readonly string[]) {
  const set = z
    .object(Object.fromEntries(writableFields.map((field) => [field, zJsonValue.optional()])))
    .refine((value) => Object.keys(value).length > 0, "patch.set must not be empty");
  const portable = z
    .object({
      ...zHarnessSubmission.shape,
      patch: z.object({ set }).strict().optional(),
    })
    .strict();
  return z.toJSONSchema(portable, { unrepresentable: "any" }) as Record<string, unknown>;
}
