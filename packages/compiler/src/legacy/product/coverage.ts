import { hashCanonical } from "@anvil/air";
import { z } from "zod";
import {
  type LegacyCapabilityCandidate,
  type LegacyClaimDimension,
  type LegacyCollectorDiagnostic,
  type LegacyInvocation,
  LegacySha256,
} from "../core/index.js";
import type { LegacyInventoryResult } from "../inventory.js";
import {
  type LegacyCollectionPlan,
  LegacyCollectionRequirement,
  type LegacyCollectionRequirement as LegacyCollectionRequirementType,
  verifyLegacyCollectionPlan,
} from "./collection-plan.js";
import { type LegacyProductInput, verifyLegacyProductInput } from "./input.js";

const EvidenceId = z.string().regex(/^le_[0-9a-f]{64}$/);

export const LegacyCoverageOutcome = z.enum([
  "supported",
  "partial",
  "unsupported",
  "safety-refusal",
]);
export type LegacyCoverageOutcome = z.infer<typeof LegacyCoverageOutcome>;

export const LegacyRequirementCoverage = z
  .object({
    requirement: LegacyCollectionRequirement,
    status: z.enum(["satisfied", "partial", "missing", "not_applicable"]),
    applicableCandidates: z.number().int().nonnegative(),
    satisfiedCandidates: z.number().int().nonnegative(),
    conflictingCandidates: z.number().int().nonnegative(),
    evidenceIds: z.array(EvidenceId).max(512),
    reason: z.string().min(1).max(2048),
  })
  .strict();
export type LegacyRequirementCoverage = z.infer<typeof LegacyRequirementCoverage>;

export const LegacyCollectorCoverage = z
  .object({
    collectorId: z.string().min(1),
    outcome: LegacyCoverageOutcome,
    inputMembers: z.number().int().nonnegative(),
    observations: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
    diagnosticCodes: z.array(z.string()).max(10_000),
  })
  .strict();
export type LegacyCollectorCoverage = z.infer<typeof LegacyCollectorCoverage>;

const CoverageCore = z
  .object({
    schemaVersion: z.literal(1),
    inventoryId: z.string().regex(/^li_[0-9a-f]{64}$/),
    inventoryContentHash: LegacySha256,
    planId: z
      .string()
      .regex(/^lcp_[0-9a-f]{64}$/)
      .optional(),
    outcome: LegacyCoverageOutcome,
    semanticComplete: z.boolean(),
    artifactCount: z.number().int().nonnegative(),
    evidenceCount: z.number().int().nonnegative(),
    observationCount: z.number().int().nonnegative(),
    candidateCount: z.number().int().nonnegative(),
    collectorCoverage: z.array(LegacyCollectorCoverage).max(10_000),
    requirements: z.array(LegacyRequirementCoverage).min(1),
    diagnosticCodes: z.array(z.string()).max(100_000),
  })
  .strict();

export const LegacyCoverageReport = CoverageCore.extend({
  reportId: z.string().regex(/^lcr_[0-9a-f]{64}$/),
  contentHash: LegacySha256,
})
  .strict()
  .superRefine((report, ctx) => {
    const { reportId: _reportId, contentHash: _contentHash, ...core } = report;
    const expected = coverageAddress(core);
    if (report.reportId !== expected.reportId || report.contentHash !== expected.contentHash) {
      ctx.addIssue({ code: "custom", message: "coverage identity must match report content" });
    }
    const complete =
      report.candidateCount > 0 &&
      report.requirements.every(
        (requirement) =>
          requirement.status === "satisfied" || requirement.status === "not_applicable",
      );
    if (report.semanticComplete !== complete) {
      ctx.addIssue({
        code: "custom",
        path: ["semanticComplete"],
        message: "must be derived from requirement coverage, never candidate yield alone",
      });
    }
  });
export type LegacyCoverageReport = z.infer<typeof LegacyCoverageReport>;

const DEFAULT_REQUIREMENTS: readonly LegacyCollectionRequirementType[] = [
  "deployment_identity",
  "invocation_binding",
];

const claimDimension: Partial<Record<LegacyCollectionRequirementType, LegacyClaimDimension>> = {
  input_schema: "input_schema",
  output_schema: "output_schema",
  error_semantics: "error_semantics",
  transaction_semantics: "transaction_boundary",
  ownership: "owner",
};

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** Refusals are categorized by stable diagnostic code, never message text. */
export function isLegacySafetyRefusal(diagnostic: LegacyCollectorDiagnostic): boolean {
  return /\/(?:unsafe(?:_|\/)|forbidden_|secret_|oversized_|archive_bomb|path_traversal)/.test(
    diagnostic.code,
  );
}

function claimCoverage(
  requirement: LegacyCollectionRequirementType,
  dimension: LegacyClaimDimension,
  candidates: readonly LegacyCapabilityCandidate[],
): LegacyRequirementCoverage {
  let satisfied = 0;
  let conflicting = 0;
  const evidenceIds: string[] = [];
  for (const candidate of candidates) {
    const claim = candidate.claims.find((item) => item.dimension === dimension);
    if (!claim) continue;
    evidenceIds.push(
      ...claim.assertions.flatMap((assertion) =>
        assertion.evidence.map((evidence) => evidence.evidenceId),
      ),
    );
    if (claim.state === "single") satisfied += 1;
    else conflicting += 1;
  }
  const status =
    candidates.length === 0 || satisfied + conflicting === 0
      ? "missing"
      : satisfied === candidates.length
        ? "satisfied"
        : "partial";
  return LegacyRequirementCoverage.parse({
    requirement,
    status,
    applicableCandidates: candidates.length,
    satisfiedCandidates: satisfied,
    conflictingCandidates: conflicting,
    evidenceIds: uniqueSorted(evidenceIds),
    reason:
      status === "satisfied"
        ? `Every candidate has one evidenced ${dimension} assertion.`
        : status === "partial"
          ? `Some candidates lack an unconflicted ${dimension} assertion.`
          : `No candidate has an evidenced ${dimension} assertion.`,
  });
}

function assessRequirement(
  requirement: LegacyCollectionRequirementType,
  candidates: readonly LegacyCapabilityCandidate[],
): LegacyRequirementCoverage {
  const dimension = claimDimension[requirement];
  if (dimension) return claimCoverage(requirement, dimension, candidates);

  if (requirement === "authorization_context" || requirement === "completion_semantics") {
    return LegacyRequirementCoverage.parse({
      requirement,
      status: "missing",
      applicableCandidates: candidates.length,
      satisfiedCandidates: 0,
      conflictingCandidates: 0,
      evidenceIds: [],
      reason:
        requirement === "authorization_context"
          ? "The current inventory model has no evidenced authorization-context dimension."
          : "Transport acknowledgement and technical interaction claims do not prove business completion.",
    });
  }

  if (requirement === "message_direction") {
    type MessageCandidate = LegacyCapabilityCandidate & {
      invocation: Extract<LegacyInvocation, { kind: "message" }>;
    };
    const messages = candidates.filter(
      (candidate): candidate is MessageCandidate => candidate.invocation.kind === "message",
    );
    const known = messages.filter((candidate) => candidate.invocation.direction !== "unknown");
    return LegacyRequirementCoverage.parse({
      requirement,
      status:
        candidates.length > 0 && messages.length === 0
          ? "not_applicable"
          : messages.length === 0
            ? "missing"
            : known.length === messages.length
              ? "satisfied"
              : known.length > 0
                ? "partial"
                : "missing",
      applicableCandidates: messages.length,
      satisfiedCandidates: known.length,
      conflictingCandidates: 0,
      evidenceIds: uniqueSorted(known.flatMap((candidate) => candidate.evidenceIds)),
      reason:
        candidates.length > 0 && messages.length === 0
          ? "No message invocation is present."
          : known.length === messages.length && messages.length > 0
            ? "Every message candidate has an evidenced direction."
            : "One or more message candidates have direction 'unknown'.",
    });
  }

  const satisfied =
    requirement === "deployment_identity"
      ? candidates
      : candidates.filter((candidate) => {
          switch (candidate.invocation.kind) {
            case "message":
              return candidate.invocation.destination.length > 0;
            case "remote_method":
              return candidate.invocation.interface.length > 0;
            case "resource_adapter":
              return (
                candidate.invocation.adapterRef.length > 0 &&
                candidate.invocation.connectionFactoryRef.length > 0
              );
            case "stored_procedure":
              return candidate.invocation.procedure.length > 0;
            case "batch_job":
              return candidate.invocation.job.length > 0;
            default:
              return false;
          }
        });
  const status =
    candidates.length === 0
      ? "missing"
      : satisfied.length === candidates.length
        ? "satisfied"
        : satisfied.length > 0
          ? "partial"
          : "missing";
  return LegacyRequirementCoverage.parse({
    requirement,
    status,
    applicableCandidates: candidates.length,
    satisfiedCandidates: satisfied.length,
    conflictingCandidates: 0,
    evidenceIds: uniqueSorted(satisfied.flatMap((candidate) => candidate.evidenceIds)),
    reason:
      status === "satisfied"
        ? requirement === "deployment_identity"
          ? "Every candidate has an exact deployment coordinate backed by inventory evidence."
          : "Every candidate has a typed invocation identity backed by inventory evidence."
        : `The required ${requirement.replaceAll("_", " ")} is absent for one or more candidates.`,
  });
}

function collectorOutcome(
  observations: number,
  diagnostics: readonly LegacyCollectorDiagnostic[],
): LegacyCoverageOutcome {
  if (observations === 0 && diagnostics.some(isLegacySafetyRefusal)) return "safety-refusal";
  if (observations === 0) return "unsupported";
  if (diagnostics.some((diagnostic) => diagnostic.level !== "info")) return "partial";
  return "supported";
}

function coverageAddress(core: z.infer<typeof CoverageCore>): {
  reportId: string;
  contentHash: `sha256:${string}`;
} {
  const hex = hashCanonical(core);
  return { reportId: `lcr_${hex}`, contentHash: `sha256:${hex}` };
}

export interface AssessLegacyCoverageOptions {
  plan?: LegacyCollectionPlan;
  requirements?: readonly LegacyCollectionRequirementType[];
}

/**
 * Assess observed transport coverage separately from required semantic
 * coverage. A non-zero candidate count is never treated as completeness.
 */
export function assessLegacyCoverage(
  input: LegacyProductInput | LegacyInventoryResult,
  options: AssessLegacyCoverageOptions = {},
): LegacyCoverageReport {
  const verified = verifyLegacyProductInput(input);
  const plan = options.plan ? verifyLegacyCollectionPlan(options.plan) : undefined;
  if (plan && plan.estate.id !== verified.snapshot.estate.id) {
    throw new Error("collection plan estate does not match inventory estate");
  }
  if (plan && options.requirements) {
    throw new Error("supply either a collection plan or explicit requirements, not both");
  }
  const requirements = uniqueSorted(
    plan?.requirements ?? options.requirements ?? DEFAULT_REQUIREMENTS,
  ).map((requirement) => LegacyCollectionRequirement.parse(requirement));
  if (requirements.length === 0) throw new Error("coverage requires at least one requirement");
  const requirementCoverage = requirements.map((requirement) =>
    assessRequirement(requirement, verified.candidates),
  );
  const diagnostics = verified.snapshot.diagnostics;
  const collectorByObservationId = new Map(
    verified.snapshot.observations.map((observation) => [
      observation.observationId,
      observation.collectorId,
    ]),
  );
  const collectorCoverage = verified.collectors.map((run) => {
    const collectorDiagnostics = diagnostics.filter(
      (diagnostic) => diagnostic.collectorId === run.collector,
    );
    const candidateCount = verified.candidates.filter((candidate) =>
      candidate.observationIds.some(
        (observationId) => collectorByObservationId.get(observationId) === run.collector,
      ),
    ).length;
    return LegacyCollectorCoverage.parse({
      collectorId: run.collector,
      outcome: collectorOutcome(run.observations, collectorDiagnostics),
      inputMembers: run.inputMembers,
      observations: run.observations,
      candidates: candidateCount,
      diagnosticCodes: uniqueSorted(collectorDiagnostics.map((diagnostic) => diagnostic.code)),
    });
  });
  const semanticComplete =
    verified.candidates.length > 0 &&
    requirementCoverage.every(
      (requirement) =>
        requirement.status === "satisfied" || requirement.status === "not_applicable",
    );
  const hasSafetyRefusal = diagnostics.some(isLegacySafetyRefusal);
  const outcome: LegacyCoverageOutcome =
    verified.snapshot.observations.length === 0 && hasSafetyRefusal
      ? "safety-refusal"
      : verified.snapshot.observations.length === 0
        ? "unsupported"
        : !semanticComplete ||
            diagnostics.some((diagnostic) => diagnostic.level !== "info") ||
            collectorCoverage.some((collector) => collector.outcome !== "supported")
          ? "partial"
          : "supported";
  const core: z.infer<typeof CoverageCore> = {
    schemaVersion: 1,
    inventoryId: verified.snapshot.inventoryId,
    inventoryContentHash: verified.snapshot.contentHash,
    ...(plan ? { planId: plan.planId } : {}),
    outcome,
    semanticComplete,
    artifactCount: verified.snapshot.artifacts.length,
    evidenceCount: verified.snapshot.evidence.length,
    observationCount: verified.snapshot.observations.length,
    candidateCount: verified.candidates.length,
    collectorCoverage,
    requirements: requirementCoverage,
    diagnosticCodes: uniqueSorted(diagnostics.map((diagnostic) => diagnostic.code)),
  };
  return LegacyCoverageReport.parse({ ...core, ...coverageAddress(core) });
}

export const LegacyEvidenceRequest = z
  .object({
    sourceKinds: z
      .array(
        z.enum([
          "deployed_artifact",
          "deployed_configuration",
          "broker_configuration",
          "artifact_repository",
          "source_repository",
          "runtime_observation",
          "operator_attestation",
          "service_catalog",
          "documentation",
          "naming_inference",
        ]),
      )
      .min(1),
    suggestedArtifacts: z.array(z.string().min(1).max(512)).min(1).max(32),
  })
  .strict();
export type LegacyEvidenceRequest = z.infer<typeof LegacyEvidenceRequest>;

export const LegacyCoverageGap = z
  .object({
    gapId: z.string().regex(/^lcg_[0-9a-f]{64}$/),
    category: z.enum(["missing_evidence", "conflicting_evidence", "unsupported", "safety_refusal"]),
    priority: z.enum(["critical", "high", "medium"]),
    requirement: LegacyCollectionRequirement.optional(),
    diagnosticCode: z.string().optional(),
    reason: z.string().min(1).max(2048),
    existingEvidenceIds: z.array(EvidenceId).max(512),
    request: LegacyEvidenceRequest,
  })
  .strict()
  .superRefine((gap, ctx) => {
    const { gapId: _gapId, ...core } = gap;
    if (gap.gapId !== gapAddress(core)) {
      ctx.addIssue({ code: "custom", path: ["gapId"], message: "must match gap content" });
    }
  });
export type LegacyCoverageGap = z.infer<typeof LegacyCoverageGap>;

const GapPlanCore = z
  .object({
    schemaVersion: z.literal(1),
    coverageReportId: z.string().regex(/^lcr_[0-9a-f]{64}$/),
    inventoryId: z.string().regex(/^li_[0-9a-f]{64}$/),
    gaps: z.array(LegacyCoverageGap).max(100_000),
  })
  .strict();

export const LegacyGapPlan = GapPlanCore.extend({
  gapPlanId: z.string().regex(/^lgp_[0-9a-f]{64}$/),
  contentHash: LegacySha256,
})
  .strict()
  .superRefine((plan, ctx) => {
    const { gapPlanId: _gapPlanId, contentHash: _contentHash, ...core } = plan;
    const hex = hashCanonical(core);
    if (plan.gapPlanId !== `lgp_${hex}` || plan.contentHash !== `sha256:${hex}`) {
      ctx.addIssue({ code: "custom", message: "gap-plan identity must match gap-plan content" });
    }
  });
export type LegacyGapPlan = z.infer<typeof LegacyGapPlan>;

function requestFor(requirement: LegacyCollectionRequirementType): LegacyEvidenceRequest {
  const requests: Record<LegacyCollectionRequirementType, LegacyEvidenceRequest> = {
    deployment_identity: {
      sourceKinds: ["deployed_configuration", "runtime_observation"],
      suggestedArtifacts: [
        "deployment export with environment, application, module, and component identity",
      ],
    },
    invocation_binding: {
      sourceKinds: ["deployed_configuration", "broker_configuration", "deployed_artifact"],
      suggestedArtifacts: [
        "resolved endpoint, JNDI binding, activation specification, or broker topology export",
      ],
    },
    message_direction: {
      sourceKinds: ["deployed_artifact", "source_repository", "runtime_observation"],
      suggestedArtifacts: [
        "consumer/producer declaration, listener metadata, or sanitized runtime trace",
      ],
    },
    input_schema: {
      sourceKinds: ["artifact_repository", "source_repository", "documentation"],
      suggestedArtifacts: [
        "request contract, message schema, class metadata, WSDL, XSD, or registry export",
      ],
    },
    output_schema: {
      sourceKinds: ["artifact_repository", "source_repository", "documentation"],
      suggestedArtifacts: [
        "response contract, reply schema, class metadata, WSDL, XSD, or registry export",
      ],
    },
    error_semantics: {
      sourceKinds: ["deployed_artifact", "source_repository", "documentation"],
      suggestedArtifacts: [
        "declared faults, exception metadata, dead-letter route, or reviewed error catalogue",
      ],
    },
    transaction_semantics: {
      sourceKinds: ["deployed_configuration", "deployed_artifact", "runtime_observation"],
      suggestedArtifacts: [
        "transaction attributes, unit-of-work configuration, or sanitized transaction trace",
      ],
    },
    authorization_context: {
      sourceKinds: ["deployed_configuration", "service_catalog", "operator_attestation"],
      suggestedArtifacts: [
        "role mapping, service identity binding, policy export, or reviewed operator attestation",
      ],
    },
    completion_semantics: {
      sourceKinds: ["runtime_observation", "documentation", "operator_attestation"],
      suggestedArtifacts: [
        "business completion signal, correlation rule, callback contract, or reviewed attestation",
      ],
    },
    ownership: {
      sourceKinds: ["service_catalog", "operator_attestation", "documentation"],
      suggestedArtifacts: ["service catalogue ownership record or reviewed operator attestation"],
    },
  };
  return LegacyEvidenceRequest.parse(requests[requirement]);
}

function gapAddress(core: Omit<LegacyCoverageGap, "gapId">): string {
  return `lcg_${hashCanonical(core)}`;
}

function makeGap(core: Omit<LegacyCoverageGap, "gapId">): LegacyCoverageGap {
  return LegacyCoverageGap.parse({ ...core, gapId: gapAddress(core) });
}

/** Convert coverage deficits into bounded evidence acquisition work. */
export function planLegacyCoverageGaps(
  reportInput: LegacyCoverageReport,
  diagnostics: readonly LegacyCollectorDiagnostic[] = [],
): LegacyGapPlan {
  const report = LegacyCoverageReport.parse(reportInput);
  const gaps: LegacyCoverageGap[] = report.requirements.flatMap((requirement) => {
    if (requirement.status === "satisfied" || requirement.status === "not_applicable") return [];
    return [
      makeGap({
        category:
          requirement.conflictingCandidates > 0 ? "conflicting_evidence" : "missing_evidence",
        priority: [
          "deployment_identity",
          "invocation_binding",
          "authorization_context",
          "completion_semantics",
        ].includes(requirement.requirement)
          ? "high"
          : "medium",
        requirement: requirement.requirement,
        reason: requirement.reason,
        existingEvidenceIds: requirement.evidenceIds,
        request: requestFor(requirement.requirement),
      }),
    ];
  });
  for (const diagnostic of diagnostics.filter(isLegacySafetyRefusal)) {
    gaps.push(
      makeGap({
        category: "safety_refusal",
        priority: "critical",
        diagnosticCode: diagnostic.code,
        reason: diagnostic.message,
        existingEvidenceIds: diagnostic.evidenceId ? [diagnostic.evidenceId] : [],
        request: {
          sourceKinds: ["deployed_configuration", "broker_configuration"],
          suggestedArtifacts: [
            "sanitized, allowlisted topology or configuration projection with secrets and active entities removed",
          ],
        },
      }),
    );
  }
  if (report.outcome === "unsupported") {
    gaps.push(
      makeGap({
        category: "unsupported",
        priority: "high",
        reason: "No applicable collector produced a typed observation.",
        existingEvidenceIds: [],
        request: {
          sourceKinds: ["deployed_artifact", "deployed_configuration", "broker_configuration"],
          suggestedArtifacts: ["supported deployment bundle or a new versioned collector fixture"],
        },
      }),
    );
  }
  const deduplicated = [...new Map(gaps.map((gap) => [gap.gapId, gap])).values()].sort(
    (left, right) => left.gapId.localeCompare(right.gapId),
  );
  const core: z.infer<typeof GapPlanCore> = {
    schemaVersion: 1,
    coverageReportId: report.reportId,
    inventoryId: report.inventoryId,
    gaps: deduplicated,
  };
  const hex = hashCanonical(core);
  return LegacyGapPlan.parse({
    ...core,
    gapPlanId: `lgp_${hex}`,
    contentHash: `sha256:${hex}`,
  });
}

export function assessAndPlanLegacyCoverage(
  input: LegacyProductInput | LegacyInventoryResult,
  options: AssessLegacyCoverageOptions = {},
): { report: LegacyCoverageReport; gapPlan: LegacyGapPlan } {
  const verified = verifyLegacyProductInput(input);
  const report = assessLegacyCoverage(verified, options);
  return { report, gapPlan: planLegacyCoverageGaps(report, verified.snapshot.diagnostics) };
}
