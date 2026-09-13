import { hashCanonical } from "@anvil/air";
import type { BusinessProject } from "./project.js";

export interface BusinessImpact {
  action: string;
  changes: Array<
    | "added"
    | "removed"
    | "input"
    | "output"
    | "guidance"
    | "effects"
    | "authority"
    | "policy"
    | "execution"
  >;
  sourceOperations: string[];
  evaluations: string[];
  approvalRenewal: boolean;
  compatibility: "unchanged" | "review_required";
}
/** Conservative dependency impact. Schema inclusion and semantic authority are never guessed. */
export function businessImpact(before: BusinessProject, after: BusinessProject): BusinessImpact[] {
  const ids = new Set([...before.definition.actions, ...after.definition.actions].map((a) => a.id));
  return [...ids].sort().map((action) => {
    const a = before.definition.actions.find((x) => x.id === action);
    const b = after.definition.actions.find((x) => x.id === action);
    const changes: BusinessImpact["changes"] = [];
    const changed = (x: unknown, y: unknown) =>
      hashCanonical(x ?? null) !== hashCanonical(y ?? null);
    if (!a) changes.push("added");
    else if (!b) changes.push("removed");
    else {
      if (changed(a.input, b.input)) changes.push("input");
      if (changed(a.output, b.output) || changed(a.result, b.result)) changes.push("output");
      if (changed([a.description, a.guidance], [b.description, b.guidance]))
        changes.push("guidance");
      if (
        changed(
          a.steps.map((s) => s.effect),
          b.steps.map((s) => s.effect),
        )
      )
        changes.push("effects");
      if (
        changed(
          a.steps.map((s) => [s.source, s.operationId, s.authority]),
          b.steps.map((s) => [s.source, s.operationId, s.authority]),
        )
      )
        changes.push("authority");
      if (
        changed(
          [
            a.requiredScopes,
            a.humanApproval,
            a.steps.map((s) => s.preconditions),
            before.definition.caller,
          ],
          [
            b.requiredScopes,
            b.humanApproval,
            b.steps.map((s) => s.preconditions),
            after.definition.caller,
          ],
        )
      )
        changes.push("policy");
      if (
        changed(a.steps, b.steps) ||
        changed(before.definition.gatewayUrl, after.definition.gatewayUrl)
      )
        changes.push("execution");
    }
    const sourceOperations = [
      ...new Set(
        [...(a?.steps ?? []), ...(b?.steps ?? [])].map((s) => `${s.source}:${s.operationId}`),
      ),
    ].filter((key) => {
      const index = key.indexOf(":");
      const alias = key.slice(0, index);
      const op = key.slice(index + 1);
      const left = before.sources[alias];
      const right = after.sources[alias];
      return changed(
        [left?.service, left?.operations.find((o) => o.id === op)],
        [right?.service, right?.operations.find((o) => o.id === op)],
      );
    });
    if (sourceOperations.length && !changes.includes("execution")) changes.push("execution");
    return {
      action,
      changes,
      sourceOperations,
      evaluations: changes.length
        ? [
            ...new Set(
              [...before.tasks, ...after.tasks].filter((t) => t.action === action).map((t) => t.id),
            ),
          ]
        : [],
      approvalRenewal: changes.length > 0,
      compatibility: changes.length ? ("review_required" as const) : ("unchanged" as const),
    };
  });
}
