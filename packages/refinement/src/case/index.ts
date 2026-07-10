/**
 * The **case** subsystem — the investigation framework. It turns "run a skill" from
 * one opaque `execute(skill, context)` call into a bounded research job with a body:
 * a materialised case directory (`materialize`), executable rails the agent works
 * with (`commands`), a swappable agent driver (`driver`), a phased investigation
 * method per skill (`procedure`), a structured result that can honestly decline
 * (`investigation`), a case-backed harness that plugs back into the deterministic
 * pack pipeline (`executor`), a multi-pass escalation ladder (`escalate`), and
 * per-skill component metrics (`metrics`).
 *
 * Division of labour: the agent owns investigation and synthesis; Anvil owns
 * admissibility, safety, validation, and application.
 */

export * from "./battery/index.js";
export * from "./commands.js";
export * from "./driver.js";
export * from "./escalate.js";
export * from "./executor.js";
export * from "./investigation.js";
export * from "./materialize.js";
export * from "./metrics.js";
export * from "./model.js";
export * from "./procedure.js";
