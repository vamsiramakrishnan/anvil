import { randomUUID } from "node:crypto";
import { hashCanonical } from "@anvil/air";

export interface AssuranceNode {
  id: string;
  digest: string;
  dependencies: string[];
  complete: boolean;
}
export interface AssuranceCheck {
  id: string;
  nodes: string[];
  implementation: string;
}
export interface AssuranceEvidence {
  check: string;
  inputs: string;
  passed: boolean;
  evidenceDigest: string;
  /** Run identity from the trusted runner; required for checks the plan schedules afresh. */
  runId: string;
}
export interface AssuranceContext {
  compiler: string;
  runtime: string;
  policy: string;
  configuration: string;
}

/** A missing dependency declaration invalidates all checks; never guess that an omitted edge is harmless. */
export function planAssurance(
  nodes: AssuranceNode[],
  checks: AssuranceCheck[],
  context: AssuranceContext,
  prior: AssuranceEvidence[] = [],
) {
  const graph = new Map(nodes.map((n) => [n.id, n]));
  if (graph.size !== nodes.length || new Set(checks.map((c) => c.id)).size !== checks.length)
    throw new Error("Duplicate assurance identity");
  if ([context.compiler, context.runtime, context.policy, context.configuration].some((v) => !v))
    throw new Error("Incomplete execution context");
  const visit = (id: string, stack: Set<string>, closure: Set<string>) => {
    const node = graph.get(id);
    if (!node || stack.has(id)) throw new Error("Missing or cyclic assurance dependency");
    if (closure.has(id)) return;
    if (!/^[a-f0-9]{64}$/.test(node.digest)) throw new Error("Invalid content digest");
    stack.add(id);
    for (const dependency of node.dependencies) visit(dependency, stack, closure);
    stack.delete(id);
    closure.add(id);
  };
  for (const n of nodes) visit(n.id, new Set(), new Set());
  const incomplete = nodes.some((n) => !n.complete);
  const rows = checks.map((check) => {
    if (!check.nodes.length || !check.implementation)
      throw new Error("Incomplete check declaration");
    const closure = new Set<string>();
    for (const id of check.nodes) visit(id, new Set(), closure);
    const inputs = hashCanonical({
      context,
      implementation: check.implementation,
      nodes: [...(incomplete ? graph.keys() : closure)].sort().map((id) => graph.get(id)),
    });
    const candidates = prior.filter((e) => e.check === check.id && e.inputs === inputs);
    const reusable =
      !incomplete &&
      candidates.length === 1 &&
      candidates[0]?.passed === true &&
      /^[a-f0-9]{64}$/.test(candidates[0].evidenceDigest);
    return {
      check: check.id,
      inputs,
      action: reusable ? ("reuse" as const) : ("run" as const),
      reason: incomplete
        ? "incomplete-dependencies"
        : reusable
          ? "unchanged-dependencies"
          : "missing-or-stale-evidence",
      reusedEvidence: reusable ? structuredClone(candidates[0]!) : null,
    };
  });
  return {
    runId: randomUUID(),
    graphDigest: hashCanonical({ nodes, checks, context }),
    checks: rows,
  };
}

export function attestRelease(
  bundleDigest: string,
  plan: ReturnType<typeof planAssurance>,
  evidence: AssuranceEvidence[],
) {
  if (!/^[a-f0-9]{64}$/.test(bundleDigest) || !plan.checks.length)
    throw new Error("No bundle qualification");
  for (const check of plan.checks) {
    const matches = evidence.filter((e) => e.check === check.check && e.inputs === check.inputs);
    if (
      matches.length !== 1 ||
      !matches[0]?.passed ||
      (check.action === "run" && matches[0].runId !== plan.runId) ||
      (check.action === "reuse" &&
        hashCanonical(matches[0]) !== hashCanonical(check.reusedEvidence)) ||
      !/^[a-f0-9]{64}$/.test(matches[0].evidenceDigest)
    )
      throw new Error(`Release check is missing, failed or stale: ${check.check}`);
  }
  const statement = { bundleDigest, runId: plan.runId, graphDigest: plan.graphDigest, evidence };
  return { ...statement, digest: hashCanonical(statement) };
}

/** Trusted runner executes scheduled checks and carries unchanged receipts through verbatim. */
export async function executeAssurance(
  plan: ReturnType<typeof planAssurance>,
  run: (check: {
    id: string;
    inputs: string;
  }) => Promise<{ passed: boolean; evidenceDigest: string }>,
): Promise<AssuranceEvidence[]> {
  const evidence: AssuranceEvidence[] = [];
  for (const check of plan.checks) {
    if (check.action === "reuse" && check.reusedEvidence)
      evidence.push(structuredClone(check.reusedEvidence));
    else {
      const result = await run({ id: check.check, inputs: check.inputs });
      evidence.push({
        check: check.check,
        inputs: check.inputs,
        runId: plan.runId,
        passed: result.passed,
        evidenceDigest: result.evidenceDigest,
      });
    }
  }
  return evidence;
}
