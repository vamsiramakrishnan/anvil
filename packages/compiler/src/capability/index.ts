/**
 * @anvil/compiler/capability — capability contracts, disclosure plans, and
 * surface signatures: the agent-facing layer over the effective contract.
 *
 * One `CapabilityContract` → one `DisclosurePlan` (the single disclosure owner)
 * and one `SurfaceSignature` (the cross-surface compatibility fingerprint shared
 * by MCP, CLI, skill, simulator, and target packaging). See ADR-0015.
 */
export * from "./contract.js";
export * from "./disclosure.js";
export * from "./edit.js";
export * from "./model.js";
export * from "./signature.js";
