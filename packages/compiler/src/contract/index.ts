/**
 * @anvil/compiler/contract — contract snapshots and semantic overlays.
 *
 * The layer that turns an immutable source plus policy overlays into one
 * evidence-backed effective contract. See `AGENT_SYSTEM_FOUNDATION.md` for how
 * this fits the SourceSnapshot → ContractSnapshot → EffectiveContract pipeline.
 */
export * from "./digest.js";
export * from "./model.js";
export * from "./overlay.js";
export * from "./resolution.js";
export * from "./snapshot.js";
