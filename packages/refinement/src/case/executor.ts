import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AirDocument } from "@anvil/air";
import type { Deficiency } from "../deficiency.js";
import type { Refinement } from "../model.js";
import { reconcile } from "../reconcile.js";
import type { SkillExecutor } from "../skills/executor.js";
import { skillByName } from "../skills/registry.js";
import { validateProposal } from "../skills/validate.js";
import type { AgentDriver } from "./driver.js";
import { verifyFrozenEvidence } from "./evidence.js";
import { contextForCase } from "./identity-binding.js";
import {
  asSkillExecutor,
  type InvestigationHarness,
  type InvestigationRequest,
  type InvestigationResult,
  type InvestigationStatus,
  proposalFromCase,
  type SearchStep,
} from "./investigation.js";
import { transition, verifyFrozenStages } from "./lifecycle.js";
import { openCase } from "./materialize.js";
import {
  CASE_AUX,
  CASE_OUTPUT,
  type ClaimSet,
  parseClaimSet,
  type ValidationReport,
} from "./model.js";
import { detectConflicts, readEvidence, readProposal } from "./proposal.js";

/**
 * The **case-backed investigation harness**: the design's answer to "give Claude
 * Code a case, not a prompt". It materialises an isolated case for a deficiency,
 * hands it to an `AgentDriver` to investigate (the live Claude Code driver, or the
 * scripted one in tests), and reads the phase outputs back into a structured
 * `InvestigationResult` — including the honest declines ("conflicted",
 * "insufficient_evidence"). It never mutates AIR; a proposal it returns is still
 * re-validated and reconciled by the deterministic core downstream.
 */
export interface CaseHarnessOptions {
  air: AirDocument;
  driver: AgentDriver;
  /** Where cases are materialised (default `.refinement`). */
  root?: string;
  /** Repository scopes the executor may inspect. */
  inspect?: string[];
}

export class CaseInvestigationHarness implements InvestigationHarness {
  readonly name: string;
  constructor(private readonly options: CaseHarnessOptions) {
    this.name = `case:${options.driver.name}`;
  }

  async investigate(request: InvestigationRequest): Promise<InvestigationResult> {
    const materialised = openCase(this.options.air, request.deficiency, {
      root: this.options.root,
      inspect: this.options.inspect,
    });
    await this.options.driver.run(materialised.dir);
    return readInvestigation(materialised.dir);
  }
}

/** A drop-in `SkillExecutor` (for `runRefinements`) backed by a case investigation. */
export function caseExecutor(options: CaseHarnessOptions): SkillExecutor {
  return asSkillExecutor(new CaseInvestigationHarness(options));
}

/* -------------------------------------------------------------------------- */
/* Reading a completed case                                                   */
/* -------------------------------------------------------------------------- */

function readJsonIf<T>(dir: string, rel: string): T | undefined {
  const full = join(dir, rel);
  return existsSync(full) ? (JSON.parse(readFileSync(full, "utf8")) as T) : undefined;
}

/**
 * Assemble the structured `InvestigationResult` from a completed case directory —
 * the boundary between the untrusted `output/` an executor wrote and the typed
 * result the loop consumes. The status the executor declared in `result.json` is
 * honoured, but a claimed `proposal_generated` with no actual proposal is
 * downgraded to `insufficient_evidence`: the files, not the label, are the truth.
 */
export function readInvestigation(dir: string): InvestigationResult {
  const proposalDoc = readProposal(dir);
  const evidence = readEvidence(dir);
  const claimSet = readJsonIf<ClaimSet>(dir, CASE_OUTPUT.extract);
  const claims = claimSet ? parseClaimSet(claimSet).claims : [];
  const validation = readJsonIf<ValidationReport>(dir, CASE_OUTPUT.critique);
  const experimentsDoc = readJsonIf<{ experiments: InvestigationResult["experiments"] }>(
    dir,
    CASE_AUX.experiments,
  );
  const searchDoc = readJsonIf<{ searchPlan: SearchStep[] }>(dir, CASE_AUX.searchPlan);
  const resultDoc = readJsonIf<{ status?: InvestigationStatus; summary?: string }>(
    dir,
    CASE_AUX.result,
  );
  const conflicts = detectConflicts(claims);

  let status: InvestigationStatus;
  if (resultDoc?.status) {
    status = resultDoc.status;
  } else if (proposalDoc && validation?.status !== "rejected") {
    status = "proposal_generated";
  } else if (conflicts.length > 0) {
    status = "conflicted";
  } else {
    status = "insufficient_evidence";
  }
  // The files are the truth: never claim a proposal we do not actually have.
  if (status === "proposal_generated" && !proposalDoc) status = "insufficient_evidence";

  return {
    status,
    searchPlan: searchDoc?.searchPlan ?? [],
    artifacts: evidence?.artifacts ?? [],
    claims,
    conflicts,
    experiments: experimentsDoc?.experiments ?? [],
    critique: (validation?.clauses ?? []).map((c) => ({
      clause: c.clause,
      supported: c.supported,
      reason: c.reason,
    })),
    proposal:
      status === "proposal_generated" && proposalDoc ? proposalFromCase(proposalDoc) : undefined,
    summary: resultDoc?.summary ?? summarize(status, conflicts.length, claims.length),
  };
}

function summarize(status: InvestigationStatus, conflicts: number, claims: number): string {
  switch (status) {
    case "proposal_generated":
      return `Grounded a proposal from ${claims} claim(s).`;
    case "conflicted":
      return `${conflicts} contradiction(s) across ${claims} claim(s); declined to propose.`;
    case "insufficient_evidence":
      return `Only ${claims} claim(s); not enough to ground a proposal.`;
    case "blocked_by_missing_source":
      return "A required source was unavailable.";
    case "supported":
      return "Existing semantics already supported by evidence.";
  }
}

/* -------------------------------------------------------------------------- */
/* Closing a case into a Refinement                                           */
/* -------------------------------------------------------------------------- */

/**
 * Close a completed case into a `Refinement` by running the exact deterministic
 * back half the deterministic executor's proposals go through: validate the
 * proposal against the skill contract, then reconcile (measure + approve) it. A
 * case with no proposal (an honest decline) yields `undefined` — nothing to apply.
 * This is the join point where a Claude Code investigation re-enters Anvil's rails.
 */
export function closeCase(air: AirDocument, dir: string): Refinement | undefined {
  const proposalDoc = readProposal(dir);
  if (!proposalDoc) return undefined;
  // Integrity, in two layers. First: the frozen output stages (evidence, claims,
  // proposal) must not have been rewritten since they were frozen. Second: every
  // verified filesystem excerpt must still match its source — if the repository
  // changed under the investigation, its evidence is no longer trustworthy.
  verifyFrozenStages(dir);
  const integrity = verifyFrozenEvidence(dir);
  if (!integrity.ok) {
    throw new Error(
      `Frozen evidence no longer matches the source repository: ${integrity.mismatches
        .map((m) => `${m.uri} (${m.reason})`)
        .join("; ")}. Refusing to close this case.`,
    );
  }
  const { task, context } = contextForCase(air, dir);
  const skill = skillByName(task.skill);
  if (!skill) throw new Error(`Unknown skill '${task.skill}' for case at ${dir}.`);
  const validated = validateProposal(skill, proposalFromCase(proposalDoc), context);
  const refinement = reconcile({ air, context, validated });
  transition(dir, "closed");
  return refinement;
}

/** Open a case for a deficiency without running any driver (materialise-only). */
export function materializeCase(
  air: AirDocument,
  deficiency: Deficiency,
  options: { root?: string; inspect?: string[] } = {},
): string {
  return openCase(air, deficiency, options).dir;
}
