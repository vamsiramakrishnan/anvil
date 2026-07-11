/**
 * @anvil/certification — static and executable certification.
 *
 * A pack is `certified` only after its generated surfaces were booted (against the
 * contract-faithful simulator) and exercised, and every safety mutant was killed —
 * never merely because artifact files exist. See ADR-0018.
 */
export * from "./certify.js";
export * from "./checks.js";
export * from "./model.js";
export * from "./mutate.js";
