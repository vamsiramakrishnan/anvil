import type { z } from "zod";
import {
  type ExpectedOutputInfo,
  expectedOutputJsonSchema,
  type zAllowedToolsDoc,
  zCaseDocument,
  type zCaseFieldFacts,
  zCaseProposal,
  type zCaseTargetDoc,
  type zCaseTask,
  type zCaseToolsDoc,
  zClaimSet,
  type zClauseVerdict,
  type zEvidenceArtifact,
  type zEvidencePolicyDoc,
  zEvidenceReport,
  type zProcedureDoc,
  type zProposedCheck,
  type zTestPlan,
  type zValidationReport,
} from "./schema.js";

/**
 * The **case** model — the on-disk layout constants plus the types and parsers for
 * everything a case reads and writes. Every type here is *derived* from the Zod
 * schemas in `schema.ts` (the single source of truth); the parsers are `.parse`
 * over those schemas, so untrusted executor output is validated at the boundary and
 * there are no hand-written parsers or unsafe casts.
 *
 * The case is deliberately phased. One undifferentiated agent should not both invent
 * and approve a result, so the investigation is split into roles whose outputs stay
 * separate and machine-readable:
 *   research   → `output/evidence.json`    (find relevant artifacts)
 *   extract    → `output/claims.json`      (turn evidence into atomic claims)
 *   synthesize → `output/proposal.json`    (draft the patch from claims only)
 *   critique   → `output/critique.json`    (try to falsify every clause)
 *   test       → `output/tests.json`       (the checks that prove the change)
 */

/* -------------------------------------------------------------------------- */
/* Phases + on-disk layout                                                    */
/* -------------------------------------------------------------------------- */

export type CasePhase = "research" | "extract" | "synthesize" | "critique" | "test";

export const CASE_PHASES: readonly CasePhase[] = [
  "research",
  "extract",
  "synthesize",
  "critique",
  "test",
];

/** The role each phase plays, for rendering the brief. */
export const PHASE_ROLE: Record<CasePhase, string> = {
  research: "Researcher",
  extract: "Claim extractor",
  synthesize: "Synthesizer",
  critique: "Critic",
  test: "Test writer",
};

/**
 * The canonical case file and its generated views. `case.json` is the single source
 * of truth for a case's inputs; `CASE.md` and `expected-output.schema.json` are
 * generated FROM it and must never drift.
 */
export const CASE_FILES = {
  /** The one canonical input document. */
  doc: "case.json",
  /** Generated view: the human/agent brief. */
  brief: "CASE.md",
  /** Generated view: the proposal contract. */
  expectedSchema: "expected-output.schema.json",
} as const;

/** The machine-readable outputs each phase deposits (relative to the case dir). */
export const CASE_OUTPUT = {
  research: "output/evidence.json",
  extract: "output/claims.json",
  synthesize: "output/proposal.json",
  critique: "output/critique.json",
  test: "output/tests.json",
} as const satisfies Record<CasePhase, string>;

/**
 * Auxiliary outputs that are not one-per-phase: the retrieval plan, any behavioural
 * experiments, the single `result.json` (the honest outcome), and the lifecycle
 * record (current run state + stage-freeze hashes). These are optional — a case can
 * close on a `result.json` alone.
 */
export const CASE_AUX = {
  searchPlan: "output/search-plan.json",
  experiments: "output/experiments.json",
  result: "output/result.json",
  lifecycle: "output/lifecycle.json",
} as const;

/* -------------------------------------------------------------------------- */
/* Types — inferred from the Zod schemas (single source of truth)             */
/* -------------------------------------------------------------------------- */

export type CaseDocument = z.infer<typeof zCaseDocument>;
export type CaseTask = z.infer<typeof zCaseTask>;
export type CaseFieldFacts = z.infer<typeof zCaseFieldFacts>;
export type CaseTargetDoc = z.infer<typeof zCaseTargetDoc>;
export type EvidencePolicyDoc = z.infer<typeof zEvidencePolicyDoc>;
export type AllowedToolsDoc = z.infer<typeof zAllowedToolsDoc>;
export type CaseToolsDoc = z.infer<typeof zCaseToolsDoc>;
export type ProcedureDoc = z.infer<typeof zProcedureDoc>;

/** Parse the canonical `case.json`, validating every section. */
export function parseCaseDocument(json: unknown): CaseDocument {
  return zCaseDocument.parse(json);
}
export type EvidenceArtifact = z.infer<typeof zEvidenceArtifact>;
export type EvidenceReport = z.infer<typeof zEvidenceReport>;
export type ClaimSet = z.infer<typeof zClaimSet>;
export type CaseProposal = z.infer<typeof zCaseProposal>;
export type ClauseVerdict = z.infer<typeof zClauseVerdict>;
export type ValidationReport = z.infer<typeof zValidationReport>;
export type ProposedCheck = z.infer<typeof zProposedCheck>;
export type TestPlan = z.infer<typeof zTestPlan>;

/* -------------------------------------------------------------------------- */
/* Parsers — Zod `.parse` over the single schema source                       */
/* -------------------------------------------------------------------------- */

/** Parse an executor's `output/proposal.json`, rejecting a malformed shape loudly. */
export function parseCaseProposal(json: unknown): CaseProposal {
  return zCaseProposal.parse(json);
}

/** Parse `output/evidence.json`. */
export function parseEvidenceReport(json: unknown): EvidenceReport {
  return zEvidenceReport.parse(json);
}

/** Parse `output/claims.json`. */
export function parseClaimSet(json: unknown): ClaimSet {
  return zClaimSet.parse(json);
}

/* -------------------------------------------------------------------------- */
/* Expected-output schema (generated from Zod)                                */
/* -------------------------------------------------------------------------- */

export type { ExpectedOutputInfo };

/** The JSON Schema for a case's `output/proposal.json`, with the case constants baked in. */
export function expectedOutputSchema(info: ExpectedOutputInfo): Record<string, unknown> {
  return expectedOutputJsonSchema(info);
}
