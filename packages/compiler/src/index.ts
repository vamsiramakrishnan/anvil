/**
 * @anvil/compiler — the compiler loop. Parses source specs, normalizes them
 * into AIR, enriches the model with agent-critical semantics, and validates the
 * result for safety. Build-time only; never on the runtime hot path.
 */

export * from "./capabilities.js";
export * from "./classify.js";
export * from "./compile.js";
export * from "./manifest.js";
export * from "./naming.js";
export * from "./normalize.js";
export * from "./parse.js";
export * from "./validate.js";
