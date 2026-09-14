import { setImmediate } from "node:timers/promises";
import { type AirDocument, hashCanonical, loadAirDocument } from "@anvil/air";
import { applyPatch } from "./apply.js";
import { curatedCatalog, lexicalRoute } from "./benchmark/routing.js";
import { evaluateRepairCases, type RepairCheck, repairInvariantHash } from "./controller-eval.js";
import type { Deficiency } from "./deficiency.js";
import type { Refinement } from "./model.js";
import { buildRefinementPlan } from "./plan.js";
import { reconcile } from "./reconcile.js";
import { assembleContext, evidenceForTarget } from "./skills/context.js";
import type { SkillProposal, VerifiableArtifact } from "./skills/contract.js";
import { HeuristicSkillExecutor, type SkillExecutor } from "./skills/executor.js";
import { skillFor } from "./skills/registry.js";
import { validateProposal } from "./skills/validate.js";
import { targetKey } from "./target.js";

export interface RepairEvaluation {
  /** Version or hash of the operator-owned test battery. Must change when tests change. */
  id: string;
  evaluate(air: AirDocument, signal: AbortSignal): Promise<RepairCheck[]>;
}

export interface RepairAttempt {
  round: number;
  contextHash: string;
  deficiency: string;
  status: "accepted" | "rejected" | "review" | "declined" | "error";
  reason: string;
  proposal?: SkillProposal;
  artifacts?: VerifiableArtifact[];
  refinement?: Refinement;
  beforeHash: string;
  afterHash?: string;
}

export interface RepairCheckpoint {
  version: 1;
  baselineHash: string;
  evaluatorId: string;
  executor: string;
  attempts: RepairAttempt[];
  rounds: number;
  currentHash: string;
  stop: "running" | "complete" | "stalled" | "budget" | "canceled";
  initialDeficiencies: number;
  remainingDeficiencies: number;
  checks: { total: number; initialPassed: number; currentPassed: number };
}

export interface RepairControllerOptions {
  executor?: SkillExecutor;
  evaluation?: RepairEvaluation;
  maxRounds?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  resume?: RepairCheckpoint;
  /** Persist atomically. A failure aborts the run, rather than claiming durable progress. */
  checkpoint?(checkpoint: RepairCheckpoint): Promise<void>;
}

const deficiencyKey = (d: Deficiency) => `${d.code}:${targetKey(d.target)}`;
const positive = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
};

/** Stop waiting for an uncooperative executor; its late output cannot enter the controller. */
async function bounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const canceled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error("Repair canceled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(work), canceled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function checkedCases(cases: RepairCheck[]): RepairCheck[] {
  if (
    !Array.isArray(cases) ||
    cases.some((c) => !c || typeof c.id !== "string" || !c.id || typeof c.passed !== "boolean")
  )
    throw new Error("Invalid evaluation cases");
  if (new Set(cases.map((c) => c.id)).size !== cases.length)
    throw new Error("Duplicate evaluation case IDs");
  return cases;
}

function regression(before: RepairCheck[], after: RepairCheck[]): string | undefined {
  const index = new Map(after.map((c) => [c.id, c.passed]));
  if (before.length !== after.length || before.some((c) => !index.has(c.id)))
    return "Evaluation case inventory changed";
  const lost = before.find((c) => c.passed && !index.get(c.id));
  return lost ? `Evaluation regressed: ${lost.id}` : undefined;
}

/**
 * Bounded audit → investigate → validate → evaluate → accept → re-audit loop.
 * Only the existing policy's auto tier can advance AIR. Every candidate is
 * evaluated in isolation against the latest accepted state and ORIGINAL tasks.
 * Resume replays and revalidates accepted proposals; stored verdicts grant nothing.
 */
export async function runRepairController(
  input: AirDocument,
  options: RepairControllerOptions = {},
): Promise<{ air: AirDocument; checkpoint: RepairCheckpoint }> {
  const maxRounds = positive(options.maxRounds ?? 3, "maxRounds");
  const maxAttempts = positive(options.maxAttempts ?? 100, "maxAttempts");
  const timeoutMs = positive(options.timeoutMs ?? 60_000, "timeoutMs");
  const baseline = loadAirDocument(structuredClone(input));
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Repair time budget exhausted")),
    timeoutMs,
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let air = structuredClone(baseline);
  const executor: SkillExecutor = options.executor ?? new HeuristicSkillExecutor();
  const evaluatorId = `repair-v1:${options.evaluation?.id ?? "semantic-only"}`;
  const invariant = repairInvariantHash(baseline);
  let currentPlan = buildRefinementPlan(air);
  let currentHash = hashCanonical(air);
  const plan = () => currentPlan;
  const evaluate = async (candidate: AirDocument): Promise<RepairCheck[]> => {
    const internal = evaluateRepairCases(baseline, candidate).map((c) => ({
      ...c,
      id: `semantic:${c.id}`,
    }));
    const evaluation = options.evaluation;
    if (!evaluation) return checkedCases(internal);
    const external = checkedCases(
      await bounded(() => evaluation.evaluate(structuredClone(candidate), signal), signal),
    );
    if (external.length === 0) throw new Error("External evaluation returned no cases");
    return checkedCases([...internal, ...external.map((c) => ({ ...c, id: `external:${c.id}` }))]);
  };
  try {
    let checks = await evaluate(air);
    const state: RepairCheckpoint = {
      version: 1,
      baselineHash: hashCanonical(baseline),
      evaluatorId,
      executor: executor.name,
      attempts: [],
      rounds: 0,
      currentHash: currentHash,
      stop: "running",
      initialDeficiencies: plan().deficiencies.length,
      remainingDeficiencies: plan().deficiencies.length,
      checks: {
        total: checks.length,
        initialPassed: checks.filter((c) => c.passed).length,
        currentPassed: checks.filter((c) => c.passed).length,
      },
    };
    const assess = async (
      d: Deficiency,
      proposal: SkillProposal,
      artifacts?: VerifiableArtifact[],
    ) => {
      const skill = skillFor(d.code);
      if (!skill) throw new Error("No skill for deficiency");
      if (
        proposal.skill !== skill.name ||
        proposal.skillVersion !== skill.version ||
        proposal.deficiency !== d.code ||
        targetKey(proposal.target) !== targetKey(d.target) ||
        targetKey(proposal.patch.target) !== targetKey(d.target)
      )
        return {
          status: "rejected" as const,
          reason: "Proposal does not match the assigned skill and target",
        };
      const context = assembleContext(air, d, evidenceForTarget(air, d));
      const validated = validateProposal(
        skill,
        proposal,
        context,
        artifacts ? { artifacts } : undefined,
      );
      const refinement = reconcile({ air, context, validated, evidenceArtifacts: artifacts });
      if (refinement.status !== "approved")
        return {
          status:
            refinement.approval.tier === "review" && refinement.status !== "regressed"
              ? ("review" as const)
              : ("rejected" as const),
          reason: refinement.approval.reason,
          refinement,
        };
      const candidate = loadAirDocument(applyPatch(air, proposal.patch).air);
      if (repairInvariantHash(candidate) !== invariant)
        return {
          status: "rejected" as const,
          reason: "Protected contract or safety semantics changed",
          refinement,
        };
      if (proposal.target.kind === "operation" && proposal.patch.set.intent_examples) {
        const operationId = proposal.target.operationId;
        const op = candidate.operations.find((item) => item.id === operationId);
        const catalog = curatedCatalog(candidate.operations);
        if (
          op?.skill.intentExamples.some(
            (phrase) => lexicalRoute(phrase, catalog) !== op.mcp.toolName,
          )
        )
          return {
            status: "rejected" as const,
            reason: "New intent collides with the full operation catalog",
            refinement,
          };
      }
      const before = new Set(plan().deficiencies.map(deficiencyKey));
      const candidatePlan = buildRefinementPlan(candidate);
      const after = new Set(candidatePlan.deficiencies.map(deficiencyKey));
      if (after.has(deficiencyKey(d)) || [...after].some((key) => !before.has(key)))
        return {
          status: "rejected" as const,
          reason: "Target not resolved or new deficiencies introduced",
          refinement,
        };
      const nextChecks = await evaluate(candidate);
      const failed = regression(checks, nextChecks);
      if (failed) return { status: "rejected" as const, reason: failed, refinement };
      signal.throwIfAborted();
      air = candidate;
      currentPlan = candidatePlan;
      currentHash = hashCanonical(candidate);
      checks = nextChecks;
      return {
        status: "accepted" as const,
        reason: "Target resolved; fixed cases and protected contract preserved",
        refinement,
      };
    };
    if (options.resume) {
      const previous = structuredClone(options.resume);
      if (
        previous.version !== 1 ||
        previous.baselineHash !== state.baselineHash ||
        previous.evaluatorId !== evaluatorId ||
        previous.executor !== executor.name
      )
        throw new Error("Checkpoint baseline, evaluator or executor mismatch");
      if (
        !Array.isArray(previous.attempts) ||
        !Number.isSafeInteger(previous.rounds) ||
        previous.rounds < 0 ||
        previous.attempts.length > maxAttempts ||
        previous.rounds > maxRounds
      )
        throw new Error("Checkpoint exceeds repair budget or is malformed");
      for (const attempt of previous.attempts) {
        if (attempt.beforeHash !== currentHash) throw new Error("Checkpoint history mismatch");
        if (attempt.status === "accepted") {
          const d = plan().deficiencies.find((item) => deficiencyKey(item) === attempt.deficiency);
          if (!d || !attempt.proposal) throw new Error("Checkpoint proposal no longer applicable");
          const result = await assess(d, attempt.proposal, attempt.artifacts);
          if (result.status !== "accepted" || attempt.afterHash !== currentHash)
            throw new Error("Checkpoint acceptance failed replay");
        }
      }
      if (previous.currentHash !== currentHash) throw new Error("Checkpoint output mismatch");
      state.attempts = previous.attempts;
      state.rounds = previous.rounds;
    }
    const persist = async () => {
      state.currentHash = currentHash;
      state.remainingDeficiencies = plan().deficiencies.length;
      state.checks.currentPassed = checks.filter((c) => c.passed).length;
      await options.checkpoint?.(structuredClone(state));
    };
    const seen = new Set(state.attempts.map((a) => a.contextHash));
    while (state.rounds < maxRounds && state.attempts.length < maxAttempts && !signal.aborted) {
      const audit = plan();
      if (audit.deficiencies.length === 0) {
        state.stop = "complete";
        break;
      }
      state.rounds += 1;
      let accepted = 0;
      for (const finding of audit.deficiencies) {
        await setImmediate();
        if (signal.aborted || state.attempts.length >= maxAttempts) break;
        const d = plan().deficiencies.find(
          (item) => deficiencyKey(item) === deficiencyKey(finding),
        );
        if (!d) continue;
        const skill = skillFor(d.code);
        if (!skill) continue;
        const context = assembleContext(air, d, evidenceForTarget(air, d));
        const contextHash = hashCanonical({ skill: skill.name, context });
        if (seen.has(contextHash)) continue;
        seen.add(contextHash);
        const attempt: RepairAttempt = {
          round: state.rounds,
          contextHash,
          deficiency: deficiencyKey(d),
          beforeHash: currentHash,
          status: "declined",
          reason: "Executor returned no grounded proposal",
        };
        try {
          const proposal = await bounded(
            () => executor.execute(structuredClone(skill), structuredClone(context), signal),
            signal,
          );
          if (proposal) {
            attempt.proposal = structuredClone(proposal);
            attempt.artifacts = structuredClone(executor.evidenceArtifactsFor?.(proposal));
            Object.assign(attempt, await assess(d, attempt.proposal, attempt.artifacts));
            if (attempt.status === "accepted") {
              attempt.afterHash = currentHash;
              accepted += 1;
            }
          }
        } catch (error) {
          attempt.status = "error";
          attempt.reason = error instanceof Error ? error.message : String(error);
        }
        state.attempts.push(attempt);
        await persist();
      }
      if (!accepted) {
        state.stop = "stalled";
        break;
      }
    }
    if (signal.aborted) state.stop = options.signal?.aborted ? "canceled" : "budget";
    else if (plan().deficiencies.length === 0) state.stop = "complete";
    else if (state.attempts.length >= maxAttempts || state.rounds >= maxRounds)
      state.stop = "budget";
    await persist();
    return { air, checkpoint: structuredClone(state) };
  } finally {
    clearTimeout(timer);
  }
}
