import { relative, resolve, sep } from "node:path";
import { type AirDocument, contractHash, hashCanonical } from "@anvil/air";
import { resolveWorkspace } from "../case/identity.js";
import { BASE_INVESTIGATION_DENY, evidencePolicyForSkill } from "../case/policy.js";
import { procedureFor } from "../case/procedure.js";
import type { Deficiency } from "../deficiency.js";
import { assembleContext, evidenceForTarget } from "../skills/context.js";
import { skillFor } from "../skills/registry.js";
import { rejectHarness } from "./errors.js";
import {
  expectedHarnessSubmissionSchema,
  parseRefinementTask,
  type RefinementTask,
  zRefinementTask,
} from "./schema.js";

export interface CreateRefinementTaskOptions {
  repositoryRoot: string;
  repositoryRevision: string;
  inspectScopes?: string[];
}

type RefinementTaskCore = Omit<RefinementTask, "taskId" | "taskHash">;

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function portableScopes(root: string, inspect: readonly string[]): string[] {
  const workspace = resolveWorkspace({ repositoryRoot: root, inspect: [...inspect] });
  return workspace.inspectScopes.map(
    (scope) => relative(workspace.repositoryRoot, scope).split(sep).join("/") || ".",
  );
}

function taskCore(task: RefinementTask): RefinementTaskCore {
  const { taskId: _taskId, taskHash: _taskHash, ...core } = task;
  return core;
}

/** Canonical digest of the task's complete, portable instruction body. */
export function refinementTaskHash(task: RefinementTask): string {
  return hashCanonical(taskCore(task));
}

/** Verify the self-described task hash and its deterministic id. */
export function verifyRefinementTaskIntegrity(task: RefinementTask): void {
  const actual = refinementTaskHash(task);
  const expectedId = `rt_${actual.slice(0, 24)}`;
  const issues: string[] = [];
  if (task.taskHash !== actual) issues.push(`taskHash ${task.taskHash} does not match ${actual}`);
  if (task.taskId !== expectedId) issues.push(`taskId ${task.taskId} does not match ${expectedId}`);
  if (issues.length > 0) {
    rejectHarness(
      "refinement/task_integrity_failed",
      "task",
      "The refinement task was changed after Anvil exported it.",
      issues,
    );
  }
}

/**
 * Export one deterministic, process-neutral research task. The snapshot helps a
 * harness investigate; import always rebuilds authoritative context from current AIR.
 */
export function createRefinementTask(
  air: AirDocument,
  deficiency: Deficiency,
  options: CreateRefinementTaskOptions,
): RefinementTask {
  const skill = skillFor(deficiency.code);
  if (!skill) {
    rejectHarness(
      "refinement/invalid_task",
      "task",
      `No refinement skill implements deficiency '${deficiency.code}'.`,
    );
  }
  const policy = evidencePolicyForSkill(skill);
  const procedure = procedureFor(skill);
  const context = assembleContext(air, deficiency, evidenceForTarget(air, deficiency));
  const root = resolve(options.repositoryRoot);
  const core: RefinementTaskCore = {
    schemaVersion: 1,
    service: { id: air.service.id, version: air.service.version },
    sourceContractHash: contractHash(air),
    repository: {
      revision: options.repositoryRevision,
      inspectScopes: portableScopes(root, options.inspectScopes ?? []),
    },
    skill: {
      name: skill.name,
      version: skill.version,
      contractHash: hashCanonical(skill),
    },
    deficiency: zRefinementTask.shape.deficiency.parse(
      jsonClone({
        code: deficiency.code,
        severity: deficiency.severity,
        target: deficiency.target,
        message: deficiency.message,
        facts: deficiency.facts,
      }),
    ),
    context: zRefinementTask.shape.context.parse(jsonClone(context)),
    policy,
    procedure: {
      skill: skill.name,
      question: procedure.question(deficiency.target),
      searchHints: procedure.searchHints,
      steps: procedure.steps.map((step) => ({
        phase: step.phase,
        instruction: step.instruction,
      })),
    },
    mustNot: [...BASE_INVESTIGATION_DENY, ...policy.mustNot],
    expectedSubmission: expectedHarnessSubmissionSchema(policy.writableFields),
  };
  const taskHash = hashCanonical(core);
  return parseRefinementTask({
    ...core,
    taskId: `rt_${taskHash.slice(0, 24)}`,
    taskHash,
  });
}
