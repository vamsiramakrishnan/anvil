import { z } from "zod";

/**
 * The deploy targets a compiled bundle carries a plan for. Both are plan-only:
 * Anvil emits the artifacts, `anvil publish --target` gates them identically,
 * and an operator applies them. Declared once, here, so the publication
 * record's schema (`certify.ts`), the CLI's `--target` choices, and the
 * per-target artifact lists can never disagree about what a target is.
 */
export const DEPLOYMENT_PLAN_TARGETS = ["cloud-run", "kubernetes"] as const;
export const DeploymentPlanTarget = z.enum(DEPLOYMENT_PLAN_TARGETS);
export type DeploymentPlanTarget = z.infer<typeof DeploymentPlanTarget>;
