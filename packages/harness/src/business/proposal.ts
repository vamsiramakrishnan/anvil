import { BusinessDefinition, hashCanonical } from "@anvil/air";
import { compileBusiness } from "@anvil/compiler";
import { businessImpact } from "./impact.js";
import type { ProjectRevision } from "./project.js";

/** Validate an authored or harness-suggested composition without granting it execution authority. */
export function proposeBusinessUpgrade(base: ProjectRevision, definitionInput: unknown) {
  if (hashCanonical(base.project) !== base.digest)
    throw new Error("Proposal base revision mismatch");
  const definition = BusinessDefinition.parse(definitionInput);
  const { actions: oldActions, ...oldContext } = base.project.definition;
  const { actions: _actions, ...newContext } = definition;
  const contextChanged = hashCanonical(oldContext) !== hashCanonical(newContext);
  for (const action of definition.actions) {
    const prior = oldActions.find((a) => a.id === action.id);
    const content = { ...action, state: undefined };
    const unchanged =
      prior &&
      !contextChanged &&
      hashCanonical(content) === hashCanonical({ ...prior, state: undefined });
    action.state = unchanged ? prior.state : "proposed";
  }
  const project = structuredClone({ ...base.project, definition });
  // Compilation checks semantics, source approval and bounds before a proposal becomes reviewable.
  const { plan } = compileBusiness(project.definition, project.sources);
  return {
    baseDigest: base.digest,
    candidateDigest: hashCanonical(project),
    project,
    planDigest: plan.digest,
    impact: businessImpact(base.project, project),
    proposalOnly: true as const,
  };
}
