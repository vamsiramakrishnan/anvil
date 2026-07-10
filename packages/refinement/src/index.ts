/**
 * @anvil/refinement — the quality flywheel's machinery.
 *
 * Detection (`detect.ts`, `plan.ts`) is **deterministic and agent-free**: it names
 * what AIR is missing or weak and never mutates the canonical model, so nothing is
 * ever proposed that a detector did not first name.
 *
 * The skill layer (`skills/`) turns a named deficiency into a *proposal*. A
 * `RefinementSkill` is a typed procedure — trigger, context, evidence policy,
 * output boundary, constraints, validation — kept strictly separate from the
 * `SkillExecutor` that runs it (Claude Code, Codex, or the deterministic reference
 * executor). Every proposal is judged by the same deterministic validators, so an
 * unreliable executor can be used safely: only grounded, in-boundary proposals pass.
 *
 * Reconciliation (`reconcile.ts`, `pack.ts`) is the back half. It applies a
 * candidate patch to a throwaway clone (`apply.ts`), measures only the eval
 * families it affects (`evals/`) with the safety guard always among them, and
 * routes the result through the approval policy (`approval.ts`). A refinement is
 * accepted only when it is *demonstrated* better and safe — the whole point of the
 * loop. A `RefinementPack` is the reviewable, serialisable output unit.
 */

export * from "./apply.js";
export * from "./approval.js";
export * from "./artifacts.js";
export * from "./assess.js";
export * from "./case/index.js";
export * from "./deficiency.js";
export * from "./detect.js";
export * from "./evals/index.js";
export * from "./model.js";
export * from "./pack.js";
export * from "./plan.js";
export * from "./reconcile.js";
export * from "./skilldoc.js";
export * from "./skills/index.js";
export * from "./target.js";
