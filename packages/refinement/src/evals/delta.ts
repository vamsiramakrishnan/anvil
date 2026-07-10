import type { AirDocument } from "@anvil/air";
import type { EvalDelta, EvalFamily } from "../model.js";
import { scoreFamily } from "./families.js";

/**
 * Measure the before/after of a candidate patch, restricted to the families it
 * could plausibly affect (see `familiesFor`). Scoring the whole eval suite on
 * every patch would bury a targeted improvement in noise from unrelated
 * operations; scoring only the affected families (guard always included) keeps
 * the signal narrow and the verdict honest.
 */
export function evalDelta(
  before: AirDocument,
  after: AirDocument,
  families: EvalFamily[],
): EvalDelta[] {
  return families.map((family) => {
    const b = scoreFamily(before, family).score;
    const a = scoreFamily(after, family).score;
    const verdict = a > b ? "improved" : a < b ? "regressed" : "neutral";
    return { family, before: b, after: a, verdict };
  });
}
