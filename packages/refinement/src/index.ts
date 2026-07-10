/**
 * @anvil/refinement — the front half of the quality flywheel. It **deterministically
 * detects** what AIR is missing or weak (documentation, agent usability, safety,
 * mock/eval coverage) and rolls the findings into a refinement plan. There are no
 * agents here by design: detection must be reproducible and must never mutate the
 * canonical model. Later stages gather evidence, propose semantic patches, and
 * measure the delta — but nothing is proposed that a detector did not first name.
 */

export * from "./deficiency.js";
export * from "./detect.js";
export * from "./plan.js";
export * from "./target.js";
