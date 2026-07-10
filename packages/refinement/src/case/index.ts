/**
 * The **case** subsystem — the investigation framework. It turns "run a skill" from
 * one opaque `execute(skill, context)` call into a bounded research job with a body,
 * organised around four clear components:
 *   - **case lifecycle** — the run store (`store`), its explicit state machine and
 *     tamper-evident stage freezing (`lifecycle`), and materialisation (`materialize`);
 *   - **evidence acquisition** — the provider boundary that resolves coordinates into
 *     frozen artifacts (`evidence`);
 *   - **agent execution** — a swappable driver (`driver`) over an execution backend
 *     bound by a policy (`execution-policy`, `process-runner`);
 *   - **proposal validation** — identity binding (`identity-binding`), synthesis,
 *     validation, and finalization as rails (`proposal`).
 *
 * A thin `CaseService` (`service`) is the façade the CLI drives these through; a
 * phased method per skill (`procedure`), a structured result that can honestly decline
 * (`investigation`), a case-backed harness that plugs back into the deterministic pack
 * pipeline (`executor`), a multi-pass escalation ladder (`escalate`), and per-skill
 * component metrics (`metrics`) round out the subsystem.
 *
 * Division of labour: the agent owns investigation and synthesis; Anvil owns
 * admissibility, safety, validation, and application.
 */

export * from "./battery/index.js";
export * from "./driver.js";
export * from "./escalate.js";
export * from "./evidence.js";
export * from "./execution-policy.js";
export * from "./executor.js";
export * from "./identity.js";
export * from "./identity-binding.js";
export * from "./investigation.js";
export * from "./lifecycle.js";
export * from "./materialize.js";
export * from "./metrics.js";
export * from "./model.js";
export * from "./procedure.js";
export * from "./process-runner.js";
export * from "./proposal.js";
export * from "./service.js";
export * from "./store.js";
