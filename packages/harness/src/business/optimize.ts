import { hashCanonical } from "@anvil/air";
import { AgentUsage } from "@anvil/fuzz";
import type { BusinessComparisonReport, BusinessEvaluationLane } from "./comparison.js";

/** Paired evidence gate, not a claim of population-level statistical superiority. */
export function compareInterfaceCandidate(
  baseline: BusinessComparisonReport,
  candidate: BusinessComparisonReport,
  lane: BusinessEvaluationLane,
  safetyChecks: readonly string[],
): { accepted: boolean; reasons: string[]; evidenceDigest: string } {
  const reasons: string[] = [];
  if (!safetyChecks.length) reasons.push("Independent safety checks are required");
  if (baseline.status !== "completed" || candidate.status !== "completed")
    reasons.push("Incomplete evaluation");
  if (
    hashCanonical([baseline.agent, baseline.evaluator, baseline.configuration]) !==
    hashCanonical([candidate.agent, candidate.evaluator, candidate.configuration])
  )
    reasons.push("Evaluation configuration differs");
  if (!baseline.tasksDigest || baseline.tasksDigest !== candidate.tasksDigest)
    reasons.push("Held-out tasks or oracles differ");
  const before = baseline.trials.filter((t) => t.lane === lane);
  const after = candidate.trials.filter((t) => t.lane === lane);
  const key = (t: (typeof before)[number]) => `${t.task}:${t.seed}`;
  const rows = new Map(after.map((t) => [key(t), t]));
  if (
    !before.length ||
    rows.size !== before.length ||
    after.length !== rows.size ||
    new Set(before.map(key)).size !== before.length
  )
    reasons.push("Trials are not paired");
  for (const b of before) {
    const a = rows.get(key(b));
    if (!a) {
      reasons.push("Held-out task mismatch");
      continue;
    }
    if (
      a.run.status !== "passed" ||
      safetyChecks.some(
        (id) =>
          !a.run.checks.some((c) => c.id === id && c.status === "passed") ||
          a.run.checks.some((c) => c.id === id && c.status !== "passed"),
      )
    )
      reasons.push(`Candidate failed qualification: ${key(a)}`);
    if (!AgentUsage.safeParse(a.run.usage).success || !AgentUsage.safeParse(b.run.usage).success)
      reasons.push("Provider metering is incomplete");
    else if (
      a.run.usage?.provider !== b.run.usage?.provider ||
      a.run.usage?.model !== b.run.usage?.model
    )
      reasons.push("Provider or model differs");
  }
  const costs = (ts: typeof before) => ts.reduce((sum, t) => sum + (t.run.usage?.costUsd ?? 0), 0);
  if (costs(after) >= costs(before)) reasons.push("No measured cost improvement");
  return {
    accepted: reasons.length === 0,
    reasons: [...new Set(reasons)],
    evidenceDigest: hashCanonical({ baseline, candidate, lane, safetyChecks }),
  };
}
