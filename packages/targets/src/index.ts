/**
 * @anvil/targets — versioned agent-platform target profiles, kit generation, and
 * validation.
 *
 * A target's requirements live in a *versioned profile*, never scattered through a
 * generator, so a platform change is a new profile version and never leaks into
 * AIR, capability contracts, or the runtime-neutral pack identity. See ADR-0019.
 */
export * from "./gemini-enterprise.js";
export * from "./generate.js";
export * from "./model.js";
export * from "./registration.js";
export * from "./validate.js";
