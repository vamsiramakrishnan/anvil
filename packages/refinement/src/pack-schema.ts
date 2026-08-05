import { Claim } from "@anvil/air";
import { z } from "zod";
import {
  zDeficiencyCode,
  zEvalFamily,
  zSemanticPatch,
  zSemanticTarget,
  zSeverity,
  zValidationCheckId,
} from "./case/schema.js";
import type { RefinementPack, RefinementReviewReceipt } from "./pack.js";
import { zHarnessImportRecord } from "./protocol/schema.js";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 hex digest");
const zServiceIdentity = z.object({ id: z.string().min(1), version: z.string().min(1) }).strict();

const zDeficiency = z
  .object({
    code: zDeficiencyCode,
    category: z.enum(["documentation", "usability", "safety", "coverage"]),
    target: zSemanticTarget,
    severity: zSeverity,
    message: z.string(),
    facts: z.record(z.string(), z.unknown()),
    suggestedSkill: z.string(),
  })
  .strict();

const zRefinementPlan = z
  .object({
    service: zServiceIdentity,
    deficiencies: z.array(zDeficiency),
    affectedOperations: z.number().int().min(0),
    bySeverity: z.object({
      info: z.number().int().min(0),
      low: z.number().int().min(0),
      medium: z.number().int().min(0),
      high: z.number().int().min(0),
      blocking: z.number().int().min(0),
    }),
    byCategory: z.object({
      documentation: z.number().int().min(0),
      usability: z.number().int().min(0),
      safety: z.number().int().min(0),
      coverage: z.number().int().min(0),
    }),
    byCode: z.partialRecord(zDeficiencyCode, z.number().int().min(0)),
    bySkill: z.record(z.string(), z.number().int().min(0)),
    blocking: z.array(zDeficiency),
  })
  .strict();

const zRefinement = z
  .object({
    id: z.string().min(1),
    skill: z.string().min(1),
    deficiency: zDeficiencyCode,
    target: zSemanticTarget,
    evidence: z.array(Claim),
    proposal: zSemanticPatch,
    affectedArtifacts: z.array(
      z
        .object({
          kind: z.enum(["json_schema", "cli_help", "mcp_tool", "skill_reference", "mock", "eval"]),
          ref: z.string().min(1),
        })
        .strict(),
    ),
    validation: z.array(
      z.object({ check: zValidationCheckId, ok: z.boolean(), reason: z.string() }).strict(),
    ),
    evalDelta: z.array(
      z
        .object({
          family: zEvalFamily,
          before: z.number(),
          after: z.number(),
          verdict: z.enum(["improved", "neutral", "regressed"]),
        })
        .strict(),
    ),
    approval: z.object({ tier: z.enum(["auto", "review", "reject"]), reason: z.string() }).strict(),
    status: z.enum([
      "proposed",
      "validated",
      "improved",
      "neutral",
      "regressed",
      "approved",
      "rejected",
    ]),
  })
  .strict();

export const zRefinementPack = z
  .object({
    schemaVersion: z.literal(1),
    service: zServiceIdentity,
    sourceContractHash: Sha256,
    plan: zRefinementPlan,
    refinements: z.array(zRefinement),
    summary: z
      .object({
        proposed: z.number().int().min(0),
        approved: z.number().int().min(0),
        review: z.number().int().min(0),
        rejected: z.number().int().min(0),
        regressed: z.number().int().min(0),
        skipped: z.number().int().min(0),
      })
      .strict(),
    harnessImports: z.array(zHarnessImportRecord).optional(),
  })
  .strict();

export const zRefinementReviewReceipt = z
  .object({
    schemaVersion: z.literal(1),
    service: zServiceIdentity,
    // Exact semantic comparisons in verifyReviewReceipt own these mismatch errors;
    // keeping them string-shaped here preserves actionable "different pack/proposal"
    // diagnostics for tampering instead of collapsing every mismatch into "bad hex".
    sourceContractHash: z.string().min(1),
    packHash: z.string().min(1),
    refinementId: z.string().min(1),
    proposalHash: z.string().min(1),
    decision: z.enum(["approved", "rejected"]),
    reviewer: z.string().min(1),
    reason: z.string().min(1),
    reviewedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

function parseOrExplain<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid ${label}: ${issues}`);
}

/** Parse a serialized pack before it can reach hashing, review, or application. */
export function parseRefinementPack(value: unknown): RefinementPack {
  return parseOrExplain(zRefinementPack, value, "refinement pack");
}

/** Parse a serialized receipt before it can influence application. */
export function parseRefinementReviewReceipt(value: unknown): RefinementReviewReceipt {
  return parseOrExplain(zRefinementReviewReceipt, value, "refinement review receipt");
}
