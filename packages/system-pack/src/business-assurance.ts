import { BusinessProject, hashCanonical } from "@anvil/air";
import {
  type AssuranceCheck,
  type AssuranceContext,
  type AssuranceEvidence,
  type AssuranceNode,
  planAssurance,
} from "./assurance-graph.js";

/** Derive dependencies from the private compiled business project, including its held-out oracles. */
export function planBusinessAssurance(
  raw: BusinessProject,
  context: AssuranceContext,
  prior: AssuranceEvidence[] = [],
) {
  const project = BusinessProject.parse(raw);
  if (
    new Set(project.tasks.map((task) => task.id)).size !== project.tasks.length ||
    project.tasks.some(
      (task) => !project.definition.actions.some((action) => action.id === task.action),
    )
  )
    throw new Error("Assurance tasks must have unique identities and declared actions");
  const { actions, ...definition } = project.definition;
  const nodes: AssuranceNode[] = [
    { id: "definition", digest: hashCanonical(definition), dependencies: [], complete: true },
  ];
  const checks: AssuranceCheck[] = [];
  for (const [name, source] of Object.entries(project.sources)) {
    const { operations, ...metadata } = source;
    nodes.push({
      id: `source:${name}`,
      digest: hashCanonical(metadata),
      dependencies: [],
      complete: true,
    });
    for (const operation of operations)
      nodes.push({
        id: `operation:${name}:${operation.id}`,
        digest: hashCanonical(operation),
        dependencies: [`source:${name}`],
        complete: true,
      });
  }
  for (const action of actions) {
    const id = `action:${action.id}`;
    nodes.push({
      id,
      digest: hashCanonical(action),
      dependencies: [
        "definition",
        ...new Set(action.steps.map((s) => `operation:${s.source}:${s.operationId}`)),
      ],
      complete: true,
    });
    const tasks = project.tasks.filter((t) => t.action === action.id);
    const taskId = `tasks:${action.id}`;
    nodes.push({ id: taskId, digest: hashCanonical(tasks), dependencies: [id], complete: true });
    // A declaration is a request to run the host's conformance and oracle checks, never a pass.
    checks.push({
      id: `qualify:${action.id}`,
      nodes: [taskId],
      implementation: "anvil-business-qualification/v1",
    });
  }
  return planAssurance(nodes, checks, context, prior);
}
