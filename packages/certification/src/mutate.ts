/**
 * The mutation battery. A certification that only checks "the files exist" or
 * "the tests pass" is worthless if it survives a safety regression. Each mutant
 * deliberately weakens a safety control; the certification must *kill* it —
 * detect it as a change to the certified surface (safety mutants as
 * safety-sensitive). This proves the attestation is tight: no weakened contract
 * can silently reuse a prior certification.
 */
import type { AirDocument, Operation } from "@anvil/air";
import { diffSurfaceSignature, surfaceSignatureFor } from "@anvil/compiler";

export interface Mutant {
  name: string;
  /** Whether the weakening is safety-sensitive (a stronger detection requirement). */
  safety: boolean;
  /** Apply the mutation to a fresh clone; returns undefined if inapplicable. */
  apply: (air: AirDocument) => AirDocument | undefined;
}

const clone = (air: AirDocument): AirDocument => structuredClone(air);
const firstApproved = (air: AirDocument, pred: (op: Operation) => boolean): Operation | undefined =>
  air.operations.find((o) => o.state === "approved" && pred(o));

/** The standard mutants every certification must kill. */
export const STANDARD_MUTANTS: Mutant[] = [
  {
    name: "remove_confirmation",
    safety: true,
    apply(air) {
      const next = clone(air);
      const op = firstApproved(next, (o) => o.confirmation.required);
      if (!op) return undefined;
      op.confirmation.required = false;
      return next;
    },
  },
  {
    name: "enable_unsafe_retry",
    safety: true,
    apply(air) {
      const next = clone(air);
      const op = firstApproved(
        next,
        (o) => o.effect.kind === "mutation" && o.idempotency.mode === "none",
      );
      if (!op) return undefined;
      op.retries = { ...op.retries, mode: "safe" };
      return next;
    },
  },
  {
    name: "drop_oauth_scope",
    safety: true,
    apply(air) {
      const next = clone(air);
      const op = firstApproved(next, (o) => o.auth.scopes.length > 0);
      if (!op) return undefined;
      op.auth = { ...op.auth, scopes: op.auth.scopes.slice(1) };
      return next;
    },
  },
  {
    name: "weaken_mutation_to_read",
    safety: true,
    apply(air) {
      const next = clone(air);
      const op = firstApproved(next, (o) => o.effect.kind === "mutation");
      if (!op) return undefined;
      op.effect.kind = "read";
      return next;
    },
  },
  {
    name: "corrupt_output_schema",
    safety: false,
    apply(air) {
      const next = clone(air);
      const op = firstApproved(next, () => true);
      if (!op) return undefined;
      op.output = { ...op.output, schema: { type: "number", "x-mutant": true } };
      return next;
    },
  },
];

export interface MutantResult {
  name: string;
  applicable: boolean;
  killed: boolean;
  classification?: string;
}

/** Run the battery: a mutant is killed when the surface signature detects it. */
export function runMutationBattery(
  air: AirDocument,
  mutants: Mutant[] = STANDARD_MUTANTS,
): MutantResult[] {
  const baseline = surfaceSignatureFor(air);
  return mutants.map((mutant) => {
    const mutated = mutant.apply(air);
    if (!mutated) return { name: mutant.name, applicable: false, killed: true };
    const report = diffSurfaceSignature(baseline, surfaceSignatureFor(mutated));
    // Any detected change kills the mutant (the attestation cannot carry over);
    // a safety mutant must be detected specifically as safety-sensitive.
    const detected = report.classification !== "compatible";
    const killed = mutant.safety ? report.classification === "safety-sensitive" : detected;
    return { name: mutant.name, applicable: true, killed, classification: report.classification };
  });
}
