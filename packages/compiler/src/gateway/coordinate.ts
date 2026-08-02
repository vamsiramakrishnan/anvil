/**
 * The one predicate every vendor adapter's `extractApi` needs and, before this
 * module existed, independently reimplemented (and independently got wrong
 * three times: apigee, apiconnect, mulesoft all let a candidate missing the
 * axis field satisfy any requested value via `!candidate.field || ...`).
 *
 * A caller-supplied disambiguating axis (version, revision, environment, ...)
 * is a hard constraint, never permission to attest a missing source value as
 * if it matched. `undefined` requested means "the caller didn't ask" — the
 * only case a candidate's own missing/absent value should pass.
 */
export function axisMatches(requested: string | undefined, candidate: string | undefined): boolean {
  if (requested === undefined) return true;
  return candidate === requested;
}

/** The same contract as {@link axisMatches}, for an axis a vendor represents as a list (e.g. WSO2/apigee environments). */
export function axisMatchesAny(
  requested: string | undefined,
  candidates: readonly string[],
): boolean {
  if (requested === undefined) return true;
  return candidates.includes(requested);
}
