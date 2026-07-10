import type { AirDocument } from "@anvil/air";
import type { Deficiency } from "../deficiency.js";
import type { Refinement } from "../model.js";
import type { JsonValue } from "../skills/contract.js";
import type { AgentDriver } from "./driver.js";
import {
  type AddEvidenceInput,
  addEvidence,
  DEFAULT_EVIDENCE_ACQUIRERS,
  type EvidenceAcquirer,
} from "./evidence.js";
import { closeCase } from "./executor.js";
import type { CaseRunState } from "./lifecycle.js";
import { currentState } from "./lifecycle.js";
import { type MaterializedCase, type OpenCaseOptions, openCase } from "./materialize.js";
import {
  type FinalizeInput,
  finalize,
  synthesizeProposal,
  validateCaseProposal,
  validateClaims,
} from "./proposal.js";
import { deleteRun, inspectTarget, type ResumedRun, resumeCase } from "./store.js";

/**
 * **The case service** — the thin façade the CLI (and any other caller) drives the
 * case lifecycle through, so the command layer depends on one cohesive surface
 * rather than a dozen loose functions. It holds no state; every method delegates to
 * the domain modules (`store`, `evidence`, `proposal`, `lifecycle`, `executor`) and
 * simply names the operations in lifecycle order. The dependency direction is
 * CLI → CaseService → domain modules, never the command implementation *being* the
 * domain implementation.
 */
export interface CaseServiceDependencies {
  /** Override the evidence providers (e.g. inject a fake in tests). Defaults applied if omitted. */
  evidenceAcquirers?: readonly EvidenceAcquirer[];
}

export class CaseService {
  private readonly evidenceAcquirers: readonly EvidenceAcquirer[];

  constructor(deps: CaseServiceDependencies = {}) {
    this.evidenceAcquirers = deps.evidenceAcquirers ?? DEFAULT_EVIDENCE_ACQUIRERS;
  }

  /** Materialise a fresh, immutable run for a deficiency. */
  open(air: AirDocument, deficiency: Deficiency, options?: OpenCaseOptions): MaterializedCase {
    return openCase(air, deficiency, options);
  }

  /** Explicitly reopen an already-materialised run. */
  resume(runDir: string): ResumedRun {
    return resumeCase(runDir);
  }

  /** Delete a run directory (the explicit destructive verb). */
  delete(runDir: string): void {
    deleteRun(runDir);
  }

  /** The run's current lifecycle state. */
  state(dir: string): CaseRunState {
    return currentState(dir);
  }

  /** Render the case's target facts and policy. */
  inspect(dir: string): string {
    return inspectTarget(dir);
  }

  /** Record one piece of evidence (research + extract phases). */
  async addEvidence(dir: string, input: AddEvidenceInput): Promise<string> {
    return addEvidence(dir, input, this.evidenceAcquirers);
  }

  /** Report claim strength, admissibility, predicate policy, and contradictions. */
  validateClaims(dir: string): string {
    return validateClaims(dir);
  }

  /** Compose the proposal from gathered claims and freeze the research stage. */
  synthesize(dir: string, set: Record<string, JsonValue>): string {
    return synthesizeProposal(dir, set);
  }

  /** Run deterministic validation and freeze the proposal stage. */
  validateProposal(air: AirDocument, dir: string): string {
    return validateCaseProposal(air, dir).text;
  }

  /** Record the honest final status. */
  finalize(dir: string, input?: FinalizeInput): string {
    return finalize(dir, input);
  }

  /** Drive the agent investigation inside a materialised case. */
  async investigate(driver: AgentDriver, dir: string): Promise<void> {
    await driver.run(dir);
  }

  /** Re-enter Anvil's rails: validate + reconcile the proposal into a refinement. */
  close(air: AirDocument, dir: string): Refinement | undefined {
    return closeCase(air, dir);
  }
}

/** A ready-to-use, stateless service instance. */
export const caseService = new CaseService();
