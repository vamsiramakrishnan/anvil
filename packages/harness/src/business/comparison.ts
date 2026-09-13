import { hashCanonical, operationInputSchema } from "@anvil/air";
import { compileBusiness } from "@anvil/compiler";
import {
  type AgentAdapter,
  type Driver,
  type Property,
  runSkillTask,
  type SkillRun,
} from "@anvil/fuzz";
import { generateBundle } from "@anvil/generators";
import type { BusinessProject, ProjectRevision } from "./project.js";

export const BUSINESS_EVALUATION_LANES = ["raw", "business", "business-skill"] as const;
export type BusinessEvaluationLane = (typeof BUSINESS_EVALUATION_LANES)[number];
export type BusinessTask = BusinessProject["tasks"][number];
/** Trusted operator module: same agent/config and independent backend oracle in all lanes. */
export interface BusinessEvaluator {
  id: string;
  version: string;
  agent: AgentAdapter;
  /** New isolated equivalent backend on every trial; its seed and policy cannot depend on lane. */
  fixture(
    project: BusinessProject,
    task: BusinessTask,
    seed: number,
    lane: BusinessEvaluationLane,
  ): Promise<{
    driver: Driver;
    /** Must assert terminal state and unauthorized effects from backend observations. */
    properties: Property[];
  }>;
}
export interface BusinessComparisonTrial {
  task: string;
  lane: BusinessEvaluationLane;
  seed: number;
  elapsedMs: number;
  calls: number;
  run: SkillRun;
}
export interface BusinessComparisonReport {
  schemaVersion: 1;
  projectDigest: string;
  planDigest: string;
  evaluator: { id: string; version: string };
  agent: { id: string; metadata: Record<string, string> };
  configuration: { repeats: number; seed: number; maxCalls: number; timeoutMs: number };
  status: "completed" | "cancelled";
  trials: BusinessComparisonTrial[];
  summary: Array<{
    lane: BusinessEvaluationLane;
    passed: number;
    failed: number;
    inconclusive: number;
    total: number;
    successInterval95: [number, number] | null;
    meanCalls: number | null;
    meanLatencyMs: number | null;
  }>;
  /** Tokens require a metered provider adapter; never substitute characters or fabricated counts. */
  tokens: null;
}
function interval(passed: number, total: number): [number, number] | null {
  if (!total) return null;
  const z = 1.96,
    p = passed / total,
    denominator = 1 + (z * z) / total;
  const middle = (p + (z * z) / (2 * total)) / denominator;
  const width =
    (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return [Math.max(0, middle - width), Math.min(1, middle + width)];
}
export async function compareBusinessProject(
  revision: ProjectRevision,
  evaluator: BusinessEvaluator,
  options: {
    repeats?: number;
    seed?: number;
    maxCalls?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    onTrial?(trial: BusinessComparisonTrial): void;
  } = {},
): Promise<BusinessComparisonReport> {
  const project = structuredClone(revision.project);
  if (hashCanonical(project) !== revision.digest)
    throw new Error("Evaluation project digest mismatch.");
  if (!project.tasks.length)
    throw new Error("Add held-out evaluation tasks before running a comparison.");
  const configuration = {
    repeats: options.repeats ?? 3,
    seed: options.seed ?? 42,
    maxCalls: options.maxCalls ?? 20,
    timeoutMs: options.timeoutMs ?? 60_000,
  };
  if (
    !Number.isInteger(configuration.repeats) ||
    configuration.repeats < 1 ||
    configuration.repeats > 20 ||
    !Number.isSafeInteger(configuration.seed) ||
    !Number.isInteger(configuration.maxCalls) ||
    configuration.maxCalls < 1 ||
    configuration.maxCalls > 100 ||
    !Number.isInteger(configuration.timeoutMs) ||
    configuration.timeoutMs < 1 ||
    configuration.timeoutMs > 300_000
  )
    throw new Error("Evaluation budgets exceed supported bounds.");
  if (
    !evaluator.id ||
    !evaluator.version ||
    !evaluator.agent.id ||
    !Object.keys(evaluator.agent.metadata).length
  )
    throw new Error("Record evaluator version and model configuration before comparing lanes.");
  const { air, plan } = compileBusiness(project.definition, project.sources);
  for (const task of project.tasks)
    if (!plan.definition.actions.some((a) => a.id === task.action && a.state === "approved"))
      throw new Error(`Review and approve evaluation action ${task.action} first.`);
  const files = generateBundle(air, { businessPlan: plan }).files;
  const skill = files["skill/SKILL.md"] ?? "";
  const references = Object.fromEntries(
    Object.entries(files).filter(([path]) => path.startsWith("skill/reference/")),
  );
  const raw = Object.values(project.sources).flatMap((source) =>
    source.operations.filter((op) => op.state === "approved"),
  );
  if (new Set(raw.map((op) => op.id)).size !== raw.length)
    throw new Error("Raw comparison requires distinct operation ids across sources.");
  const trials: BusinessComparisonTrial[] = [];
  for (let repeat = 0; repeat < configuration.repeats; repeat++) {
    for (const task of project.tasks) {
      const seed = configuration.seed + repeat;
      // Rotate presentation order; each lane still receives the exact same task and fixture seed.
      for (let offset = 0; offset < 3; offset++) {
        if (options.signal?.aborted) break;
        const lane = BUSINESS_EVALUATION_LANES[(repeat + offset) % 3] as BusinessEvaluationLane;
        const fixture = await evaluator.fixture(
          structuredClone(project),
          structuredClone(task),
          seed,
          lane,
        );
        if (!fixture.properties.length)
          throw new Error("An independent backend oracle is required.");
        const operations =
          lane === "raw" ? raw : air.operations.filter((op) => op.state === "approved");
        const started = performance.now();
        const run = await runSkillTask({
          task: {
            task: task.prompt,
            skill: lane === "business-skill" ? skill : "",
            references: lane === "business-skill" ? references : {},
            catalog: operations.map((op) => ({
              operation: op.id,
              description: op.description ?? op.id,
              inputSchema: operationInputSchema(op),
            })),
          },
          agent: evaluator.agent,
          driver: fixture.driver,
          properties: fixture.properties,
          seed,
          maxCalls: configuration.maxCalls,
          timeoutMs: configuration.timeoutMs,
          signal: options.signal,
          identity: {
            project: revision.digest,
            plan: plan.digest,
            evaluator: `${evaluator.id}@${evaluator.version}`,
            fixture: hashCanonical(task.fixture),
            oracle: hashCanonical(task.expected),
          },
        });
        const trial = {
          task: task.id,
          lane,
          seed,
          elapsedMs: Math.round(performance.now() - started),
          calls: run.traces.reduce((n, t) => n + t.events.length, 0),
          run,
        };
        trials.push(trial);
        options.onTrial?.(trial);
      }
      if (options.signal?.aborted) break;
    }
    if (options.signal?.aborted) break;
  }
  return {
    schemaVersion: 1,
    projectDigest: revision.digest,
    planDigest: plan.digest,
    evaluator: { id: evaluator.id, version: evaluator.version },
    agent: { id: evaluator.agent.id, metadata: { ...evaluator.agent.metadata } },
    configuration,
    status: options.signal?.aborted ? "cancelled" : "completed",
    trials,
    tokens: null,
    summary: BUSINESS_EVALUATION_LANES.map((lane) => {
      const rows = trials.filter((t) => t.lane === lane),
        passed = rows.filter((t) => t.run.status === "passed").length;
      const failed = rows.filter((t) => t.run.status === "failed").length;
      return {
        lane,
        passed,
        failed,
        inconclusive: rows.length - passed - failed,
        total: rows.length,
        successInterval95: interval(passed, rows.length),
        meanCalls: rows.length ? rows.reduce((n, t) => n + t.calls, 0) / rows.length : null,
        meanLatencyMs: rows.length ? rows.reduce((n, t) => n + t.elapsedMs, 0) / rows.length : null,
      };
    }),
  };
}
