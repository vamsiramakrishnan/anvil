import type { BusinessSurface } from "@anvil/air";

/** Guidance is a projection of the reviewed business view, with no private execution data. */
export function businessSkill(surface: BusinessSurface): string {
  return [
    "---",
    "name: business-actions",
    "description: Select business actions, clarify inputs, inspect effects, and handle incomplete outcomes.",
    "---",
    "",
    "# Business actions",
    "",
    "Choose an action from the user's intended outcome. Clarify missing business facts before calling it. The gateway resolves API details and enforces policy; do not reconstruct its private steps in prompts or scripts.",
    "",
    "For mutations, keep one idempotency key for the same intent. Confirmation declares intent; human approval, where required, must come from the trusted approval service.",
    "",
    "Read `status` before reporting success. Only `completed` means the declared result was produced. For `partial` or `reconciliation_required`, report the completed effects and follow `next_action`. Never rotate a key to get around an uncertain result. Give the capability owner the `trace_id` for investigation.",
    "",
    ...surface.actions.flatMap((action) => [
      `## ${action.id}`,
      "",
      `Use for: ${action.guidance.intents.join("; ")}.`,
      "",
      ...(action.guidance.counterIntents.length
        ? [`Do not select for: ${action.guidance.counterIntents.join("; ")}.`, ""]
        : []),
      ...(action.guidance.clarify.length
        ? [`Clarify: ${action.guidance.clarify.join("; ")}.`, ""]
        : []),
      `Escalate: ${action.guidance.escalate.join("; ")}.`,
      "",
      `Effects: ${action.effects.length ? action.effects.join("; ") : "Read only"}.`,
      "",
    ]),
  ].join("\n");
}
