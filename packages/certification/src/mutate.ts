/**
 * The mutation battery. A certification that only checks "the files exist" or
 * "the tests pass" is worthless if it survives a safety regression. Each mutant
 * deliberately weakens one control; the certification must *kill* it.
 *
 * ## What "killed" means
 *
 * A mutant is killed only when BOTH of these hold:
 *
 *  1. the surface signature classifies the weakening — as `safety-sensitive`
 *     for a safety mutant, as any non-`compatible` change otherwise — so a prior
 *     attestation cannot be carried over to the weakened contract; and
 *  2. at least one certification check FAILS against the weakened contract:
 *     the static checks always, and the executable checks (booting the weakened
 *     surface and holding it to the certified contract as oracle — see
 *     `executable-checks.ts`) when the executable phase is on.
 *
 * The first alone was the old definition, and it proved only that the digest
 * moved — a bundle whose confirmation gate had been removed would "kill" the
 * mutant while every check still passed, because the checks were only ever
 * asked whether the weakened contract was consistent with itself. The second
 * is what makes the battery a test of the checks rather than of the hash:
 * every killed mutant names the check that caught it, and a safety mutant that
 * changes the digest but fails NO check is reported as a survivor with
 * `survivedBy: "no check failed"` — a real finding about the certification,
 * never rounded up.
 *
 * An inapplicable mutant (nothing on the surface to weaken) is neither killed
 * nor survived: `applicable: false, killed: false`. It cannot fail a
 * certification, and it cannot count toward the "at least one safety mutant
 * killed" that `certified` requires either.
 */
import type { AirDocument, Operation } from "@anvil/air";
import { diffSurfaceSignature, surfaceSignatureFor } from "@anvil/compiler";
import { type CertificationDeployTarget, staticChecks } from "./checks.js";
import { executableChecks } from "./executable-checks.js";
import type { CertificationCheck } from "./model.js";

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

/** Does the operation declare an object item schema with named properties? */
function declaresObjectOutput(op: Operation): boolean {
  const schema = op.output.schema;
  if (!schema || typeof schema !== "object") return false;
  const props = schema.properties;
  if (props && typeof props === "object" && Object.keys(props).length > 0) return true;
  const items = schema.items;
  return (
    !!items &&
    typeof items === "object" &&
    !Array.isArray(items) &&
    !!(items as { properties?: unknown }).properties
  );
}

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
    // Inline object schemas only: an operation that declares no item shape has
    // no output contract to corrupt, and a `$ref` corruption would have to
    // rewrite the shared component every other operation reads.
    name: "corrupt_output_schema",
    safety: false,
    apply(air) {
      const next = clone(air);
      const op = firstApproved(next, declaresObjectOutput);
      if (!op) return undefined;
      op.output = { ...op.output, schema: { type: "number", "x-mutant": true } };
      return next;
    },
  },
];

export interface MutantResult {
  name: string;
  /** Whether the weakening was safety-sensitive (mirrors the mutant's own flag). */
  safety: boolean;
  applicable: boolean;
  killed: boolean;
  /** The surface-signature diff's verdict on the weakening (applicable mutants only). */
  classification?: string;
  /** The ids of the checks that failed against the weakened contract — why it died. */
  killedBy?: string[];
  /** Why an applicable mutant lived. `"no check failed"` is a finding about the checks. */
  survivedBy?: string;
}

export interface MutationBatteryOptions {
  mutants?: Mutant[];
  /**
   * Boot the weakened surface and run the executable checks against it (with
   * the certified contract as oracle). Off, only the static checks can kill.
   */
  executable?: boolean;
  seed?: number;
  deployTarget?: CertificationDeployTarget;
}

/** The static and (when on) executable checks that fail against a weakened contract. */
function failingChecks(
  mutated: AirDocument,
  oracle: AirDocument,
  options: MutationBatteryOptions,
): CertificationCheck[] {
  // The pack is deliberately NOT passed: `static/pack_surface_matches` would
  // fail every mutant on the digest alone, which is the exact tautology this
  // battery exists to refuse.
  const checks = [...staticChecks(mutated, undefined, options.deployTarget)];
  if (options.executable) {
    checks.push(...executableChecks(mutated, { seed: options.seed, oracle }));
  }
  return checks.filter((c) => !c.ok);
}

/** Run the battery. See the module header for what a kill requires. */
export function runMutationBattery(
  air: AirDocument,
  options: MutationBatteryOptions = {},
): MutantResult[] {
  const baseline = surfaceSignatureFor(air);
  return (options.mutants ?? STANDARD_MUTANTS).map((mutant) => {
    const mutated = mutant.apply(air);
    if (!mutated) {
      return { name: mutant.name, safety: mutant.safety, applicable: false, killed: false };
    }
    const report = diffSurfaceSignature(baseline, surfaceSignatureFor(mutated));
    const required = mutant.safety ? "safety-sensitive" : "a change";
    const classified = mutant.safety
      ? report.classification === "safety-sensitive"
      : report.classification !== "compatible";
    const failed = failingChecks(mutated, air, options).map((c) => c.id);

    const reasons: string[] = [];
    if (!classified) {
      reasons.push(
        `surface signature classified it as ${report.classification}, not ${required}` +
          (failed.length > 0 ? ` (checks that failed: ${failed.join(", ")})` : ""),
      );
    }
    if (failed.length === 0) reasons.push("no check failed");
    const killed = reasons.length === 0;
    return {
      name: mutant.name,
      safety: mutant.safety,
      applicable: true,
      killed,
      classification: report.classification,
      ...(killed ? { killedBy: failed } : { survivedBy: reasons.join("; ") }),
    };
  });
}
