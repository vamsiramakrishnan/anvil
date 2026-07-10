/**
 * The deterministic EVAL layer: scores behaviour families over an AIR document
 * and measures the before/after of a candidate patch. No LLM, no randomness —
 * every number here is reproducible from the AIR document alone.
 */

export * from "./delta.js";
export * from "./families.js";
