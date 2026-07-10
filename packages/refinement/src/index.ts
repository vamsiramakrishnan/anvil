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
 * unreliable executor can be used safely: only grounded, in-boundary, demonstrated
 * improvements pass. Reconciliation, application, and eval-delta are later stages.
 */

export * from "./deficiency.js";
export * from "./detect.js";
export * from "./plan.js";
export * from "./skills/index.js";
export * from "./target.js";
