import type { Refinement } from "../model.js";
import type { InvestigationResult } from "./investigation.js";

/**
 * **Measure the investigator as a component.** The point is not "is the agent
 * smarter than the deterministic executor?" but "which deficiency classes justify
 * the extra investigation cost?". One observation per case run — its structured
 * result, the reconciled refinement (if any), and optional cost/runtime — rolls up
 * per skill so you can compare the case harness against the deterministic baseline
 * and see where the intelligence actually pays for itself.
 */
export interface CaseObservation {
  skill: string;
  result: InvestigationResult;
  /** The reconciled refinement, when the proposal made it through validation. */
  refinement?: Refinement;
  tokens?: number;
  costUsd?: number;
  elapsedMs?: number;
}

export interface SkillMetrics {
  skill: string;
  runs: number;
  /** Fraction of runs that produced a proposal at all. */
  proposalRate: number;
  /** Fraction of runs whose proposal was auto-approved or measured improved. */
  acceptedRate: number;
  /** Fraction of runs that surfaced a contradiction (a discovery, not a failure). */
  conflictDiscoveryRate: number;
  /** Fraction of runs whose proposal regressed a measured family (never applied). */
  regressionRate: number;
  /** Fraction of accepted refinements that raised at least one eval family. */
  evalImprovementRate: number;
  avgClaims: number;
  avgSourcesInspected: number;
  tokens?: number;
  costUsd?: number;
  elapsedMs?: number;
}

function isAccepted(r: Refinement): boolean {
  return r.status === "approved" || r.status === "improved";
}

function distinctSources(result: InvestigationResult): number {
  return new Set(result.artifacts.map((a) => a.uri)).size;
}

/** Roll observations up into one metrics row per skill (stable, alphabetical order). */
export function caseMetrics(observations: CaseObservation[]): SkillMetrics[] {
  const bySkill = new Map<string, CaseObservation[]>();
  for (const o of observations) {
    const arr = bySkill.get(o.skill) ?? [];
    arr.push(o);
    bySkill.set(o.skill, arr);
  }

  const rows: SkillMetrics[] = [];
  for (const [skill, obs] of bySkill) {
    const runs = obs.length;
    const proposals = obs.filter((o) => o.result.status === "proposal_generated");
    const refinements = obs.map((o) => o.refinement).filter((r): r is Refinement => Boolean(r));
    const accepted = refinements.filter(isAccepted);
    const regressed = refinements.filter((r) => r.status === "regressed");
    const improvedEval = accepted.filter((r) => r.evalDelta.some((d) => d.verdict === "improved"));

    const sum = (f: (o: CaseObservation) => number | undefined): number | undefined => {
      const vals = obs.map(f).filter((v): v is number => typeof v === "number");
      return vals.length ? vals.reduce((a, b) => a + b, 0) : undefined;
    };

    rows.push({
      skill,
      runs,
      proposalRate: runs ? proposals.length / runs : 0,
      acceptedRate: runs ? accepted.length / runs : 0,
      conflictDiscoveryRate: runs
        ? obs.filter((o) => o.result.conflicts.length > 0).length / runs
        : 0,
      regressionRate: runs ? regressed.length / runs : 0,
      evalImprovementRate: accepted.length ? improvedEval.length / accepted.length : 0,
      avgClaims: runs ? obs.reduce((a, o) => a + o.result.claims.length, 0) / runs : 0,
      avgSourcesInspected: runs ? obs.reduce((a, o) => a + distinctSources(o.result), 0) / runs : 0,
      tokens: sum((o) => o.tokens),
      costUsd: sum((o) => o.costUsd),
      elapsedMs: sum((o) => o.elapsedMs),
    });
  }
  return rows.sort((a, b) => a.skill.localeCompare(b.skill));
}
