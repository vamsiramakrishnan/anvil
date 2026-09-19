/**
 * Small text utilities every surface shares, so "did you mean …?" means the
 * same thing on the generated CLI, the `anvil` CLI, and compiler diagnostics.
 */

/** Levenshtein distance — inputs are short names, O(n·m) is fine. */
export function editDistance(a: string, b: string): number {
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] as number;
      prev[j] = Math.min(
        tmp + 1,
        (prev[j - 1] as number) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length] as number;
}

/**
 * The nearest candidate within a plausible-typo distance, or undefined. A
 * "suggestion" further than about a third of the candidate's length is noise,
 * not a typo, and is never offered.
 */
export function nearestMatch(typed: string, candidates: Iterable<string>): string | undefined {
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(typed, candidate);
    if (!best || distance < best.distance) best = { candidate, distance };
  }
  if (!best) return undefined;
  return best.distance <= Math.max(2, Math.ceil(best.candidate.length / 3))
    ? best.candidate
    : undefined;
}
