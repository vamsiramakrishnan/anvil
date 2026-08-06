import { DEFICIENCY_CATALOG, type Deficiency, targetOperationId } from "@anvil/refinement";

/** Findings that still require a person before an approved operation can ship. */
export function unresolvedReadiness(
  deficiencies: readonly Deficiency[],
  approvedOperationIds: ReadonlySet<string>,
): string[] {
  return deficiencies
    .filter((deficiency) => {
      const operationId = targetOperationId(deficiency.target);
      const disposition = DEFICIENCY_CATALOG[deficiency.code].readinessDisposition;
      return (
        (disposition === "blocked" || disposition === "humanDecisionRequired") &&
        operationId !== undefined &&
        approvedOperationIds.has(operationId)
      );
    })
    .map(
      (deficiency) =>
        `${targetOperationId(deficiency.target)}: ${deficiency.code} — ${deficiency.message}`,
    );
}
