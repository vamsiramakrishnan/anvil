import { EXEMPLAR_SCENARIOS } from "./scenarios.exemplars.js";
import type { FieldScenario } from "./types.js";

export * from "./effectiveness.js";
export { EFFECTIVENESS_CASES } from "./effectiveness-cases.js";
export * from "./run.js";
export * from "./types.js";

/**
 * The full battery corpus. Exemplars prove each mechanism; the batches expand the
 * deliberately-varied field and error classes the design enumerates. Assembled here
 * so the runner, the test, and `anvil case battery` all measure the same corpus.
 */
export const BATTERY_SCENARIOS: readonly FieldScenario[] = [...EXEMPLAR_SCENARIOS];
