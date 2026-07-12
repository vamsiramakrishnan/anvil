import { z } from "zod";
import { DEFICIENCY_CATALOG, type DeficiencyCode, SEVERITIES } from "../deficiency.js";

/**
 * The artifact-review report — the versioned output of `anvil review`. The model
 * is a *witness*, not an authority: it may only cite codes that exist in the
 * deficiency catalog, and every finding must carry evidence (file + verbatim
 * excerpt) that the deterministic layer re-verifies against the bundle. Parse,
 * don't validate: an unknown code or a finding without evidence fails to parse,
 * it is never patched up.
 */

/** Bump when the report's shape changes incompatibly. */
export const REVIEW_SCHEMA_VERSION = 1;

/** The artifact class a finding is about. `cross` = surfaces disagree with each other. */
export const ReviewArtifact = z.enum(["mcp", "cli", "skill", "cross"]);
export type ReviewArtifact = z.infer<typeof ReviewArtifact>;

/** Deficiency codes validated against the catalog, so a made-up code is rejected. */
const DeficiencyCodeSchema = z.enum(
  Object.keys(DEFICIENCY_CATALOG) as [DeficiencyCode, ...DeficiencyCode[]],
);

/**
 * The grounding for one finding. `excerpt` must be a verbatim quote from `file`
 * (bundle-relative path); the review pipeline mechanically re-checks it and
 * discards findings whose excerpt does not appear in the named file. The
 * minimum length keeps an excerpt from being trivially groundable ("a").
 */
export const ReviewEvidence = z
  .object({
    /** Bundle-relative path, exactly as presented in the review context. */
    file: z.string().min(1),
    /** Verbatim quote of the offending text (whitespace-normalized on verify). */
    excerpt: z.string().min(8).max(2000),
    /** Optional JSON path / section coordinate inside the file. */
    path: z.string().optional(),
  })
  .strict();
export type ReviewEvidence = z.infer<typeof ReviewEvidence>;

export const ReviewFinding = z
  .object({
    id: z.string().min(1),
    artifact: ReviewArtifact,
    /** The AIR operation the finding is about, when it is operation-scoped. */
    opId: z.string().optional(),
    code: DeficiencyCodeSchema,
    severity: z.enum(SEVERITIES),
    evidence: ReviewEvidence,
    /** What is wrong, stated as a checkable claim (not a vibe). */
    claim: z.string().min(1),
    suggestion: z.string().optional(),
  })
  .strict();
export type ReviewFinding = z.infer<typeof ReviewFinding>;

/**
 * The raw JSON the reviewer model writes to `output/review.json`. Everything
 * else in the report (summary, discards, identity, timing) is computed by the
 * deterministic layer — counts are never trusted from the model.
 */
export const ReviewModelOutput = z
  .object({
    findings: z.array(ReviewFinding),
    reviewerNotes: z.string().optional(),
  })
  .strict();
export type ReviewModelOutput = z.infer<typeof ReviewModelOutput>;

/** A finding dropped by mechanical post-validation, kept for observability. */
export const DiscardedFinding = z.object({
  id: z.string(),
  reason: z.string(),
});
export type DiscardedFinding = z.infer<typeof DiscardedFinding>;

export const ReviewSummary = z.object({
  bySeverity: z.partialRecord(z.enum(SEVERITIES), z.number().int().min(0)),
  byArtifact: z.partialRecord(ReviewArtifact, z.number().int().min(0)),
});
export type ReviewSummary = z.infer<typeof ReviewSummary>;

export const ReviewReport = z.object({
  schemaVersion: z.literal(REVIEW_SCHEMA_VERSION),
  bundle: z.object({
    dir: z.string(),
    serviceId: z.string(),
    serviceVersion: z.string(),
  }),
  /** The reviewer model as requested (the driver owns how it is selected). */
  model: z.string(),
  startedAt: z.string(),
  /** Findings that survived mechanical grounding, worst severity first. */
  findings: z.array(ReviewFinding),
  /** Findings dropped because their evidence did not verify against the bundle. */
  discarded: z.array(DiscardedFinding),
  summary: ReviewSummary,
  reviewerNotes: z.string().optional(),
});
export type ReviewReport = z.infer<typeof ReviewReport>;
