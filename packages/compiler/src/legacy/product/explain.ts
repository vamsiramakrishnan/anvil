import { hashCanonical } from "@anvil/air";
import { z } from "zod";
import {
  LegacyArtifactRecord,
  LegacyCapabilityCandidate,
  LegacyCapabilityObservation,
  LegacyClaimDimension,
  LegacyClaimValue,
  LegacyEvidenceBasis,
  LegacyEvidenceRecord,
  LegacySha256,
} from "../core/index.js";
import type { LegacyInventoryResult } from "../inventory.js";
import { legacyLogicalCapabilityId, legacyOccurrenceId } from "./identity.js";
import { type LegacyProductInput, verifyLegacyProductInput } from "./input.js";

export const LegacyEvidenceTrace = z
  .object({
    evidence: LegacyEvidenceRecord,
    artifact: LegacyArtifactRecord,
  })
  .strict()
  .superRefine((trace, ctx) => {
    if (trace.evidence.artifactId !== trace.artifact.artifactId) {
      ctx.addIssue({ code: "custom", message: "evidence trace references the wrong artifact" });
    }
  });
export type LegacyEvidenceTrace = z.infer<typeof LegacyEvidenceTrace>;

export const LegacyExplainedAssertion = z
  .object({
    value: LegacyClaimValue,
    bases: z.array(LegacyEvidenceBasis).min(1),
    observationIds: z.array(z.string().regex(/^lo_[0-9a-f]{64}$/)).min(1),
    evidence: z.array(LegacyEvidenceTrace).min(1),
  })
  .strict();
export type LegacyExplainedAssertion = z.infer<typeof LegacyExplainedAssertion>;

export const LegacyExplainedClaim = z
  .object({
    dimension: LegacyClaimDimension,
    state: z.enum(["single", "conflicting"]),
    assertions: z.array(LegacyExplainedAssertion).min(1),
  })
  .strict();
export type LegacyExplainedClaim = z.infer<typeof LegacyExplainedClaim>;

const ExplanationCore = z
  .object({
    schemaVersion: z.literal(1),
    inventoryId: z.string().regex(/^li_[0-9a-f]{64}$/),
    candidate: LegacyCapabilityCandidate,
    candidateHash: LegacySha256,
    occurrenceId: z.string().regex(/^lco_[0-9a-f]{64}$/),
    logicalCapabilityId: z.string().regex(/^lcl_[0-9a-f]{64}$/),
    observations: z.array(LegacyCapabilityObservation).min(1),
    claims: z.array(LegacyExplainedClaim),
    evidence: z.array(LegacyEvidenceTrace).min(1),
    unclaimedEvidence: z.array(LegacyEvidenceTrace),
    unknownDimensions: z.array(LegacyClaimDimension),
  })
  .strict();

export const LegacyCandidateExplanation = ExplanationCore.extend({
  explanationId: z.string().regex(/^lce_[0-9a-f]{64}$/),
  contentHash: LegacySha256,
})
  .strict()
  .superRefine((explanation, ctx) => {
    const { explanationId: _explanationId, contentHash: _contentHash, ...core } = explanation;
    const expected = explanationAddress(core);
    if (
      explanation.explanationId !== expected.explanationId ||
      explanation.contentHash !== expected.contentHash
    ) {
      ctx.addIssue({ code: "custom", message: "explanation identity must match its content" });
    }
    if (explanation.candidateHash !== `sha256:${hashCanonical(explanation.candidate)}`) {
      ctx.addIssue({
        code: "custom",
        path: ["candidateHash"],
        message: "must match the embedded candidate",
      });
    }
  });
export type LegacyCandidateExplanation = z.infer<typeof LegacyCandidateExplanation>;

function explanationAddress(core: z.infer<typeof ExplanationCore>): {
  explanationId: string;
  contentHash: `sha256:${string}`;
} {
  const hex = hashCanonical(core);
  return { explanationId: `lce_${hex}`, contentHash: `sha256:${hex}` };
}

/**
 * Explain one candidate using exact inventory records. No narrative is
 * generated: unknown dimensions stay explicitly unknown and every assertion
 * carries its complete evidence coordinate and artifact provenance.
 */
export function explainLegacyCandidate(
  input: LegacyProductInput | LegacyInventoryResult,
  candidateId: string,
): LegacyCandidateExplanation {
  const { snapshot, candidates } = verifyLegacyProductInput(input);
  const candidate = candidates.find((item) => item.candidateId === candidateId);
  if (!candidate) throw new Error(`legacy candidate '${candidateId}' was not found`);
  const evidenceById = new Map(snapshot.evidence.map((record) => [record.evidenceId, record]));
  const artifactById = new Map(snapshot.artifacts.map((record) => [record.artifactId, record]));
  const trace = (evidenceId: string): LegacyEvidenceTrace => {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) throw new Error(`candidate cites missing evidence '${evidenceId}'`);
    const artifact = artifactById.get(evidence.artifactId);
    if (!artifact) throw new Error(`evidence cites missing artifact '${evidence.artifactId}'`);
    return LegacyEvidenceTrace.parse({ evidence, artifact });
  };
  const claims = candidate.claims.map((claim) =>
    LegacyExplainedClaim.parse({
      dimension: claim.dimension,
      state: claim.state,
      assertions: claim.assertions.map((assertion) => ({
        value: assertion.value,
        bases: [...assertion.bases].sort(),
        observationIds: [...assertion.observationIds].sort(),
        evidence: assertion.evidence.map((item) => trace(item.evidenceId)),
      })),
    }),
  );
  const claimedEvidence = new Set(
    candidate.claims.flatMap((claim) =>
      claim.assertions.flatMap((assertion) =>
        assertion.evidence.map((evidence) => evidence.evidenceId),
      ),
    ),
  );
  const presentDimensions = new Set(candidate.claims.map((claim) => claim.dimension));
  const core: z.infer<typeof ExplanationCore> = {
    schemaVersion: 1,
    inventoryId: snapshot.inventoryId,
    candidate,
    candidateHash: `sha256:${hashCanonical(candidate)}`,
    occurrenceId: legacyOccurrenceId(candidate),
    logicalCapabilityId: legacyLogicalCapabilityId(snapshot.estate, candidate),
    observations: candidate.observationIds.map((observationId) => {
      const observation = snapshot.observations.find(
        (item) => item.observationId === observationId,
      );
      if (!observation) throw new Error(`candidate cites missing observation '${observationId}'`);
      return observation;
    }),
    claims,
    evidence: candidate.evidenceIds.map(trace),
    unclaimedEvidence: candidate.evidenceIds.filter((id) => !claimedEvidence.has(id)).map(trace),
    unknownDimensions: LegacyClaimDimension.options.filter(
      (dimension) => !presentDimensions.has(dimension),
    ),
  };
  return LegacyCandidateExplanation.parse({ ...core, ...explanationAddress(core) });
}
