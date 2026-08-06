import { hashCanonical } from "@anvil/air";
import { evidenceSourceRank, verifyLegacyInventory } from "./inventory.js";
import {
  type LegacyCandidateClaim,
  LegacyCapabilityCandidate,
  type LegacyCapabilityCandidate as LegacyCapabilityCandidateType,
  type LegacyClaim,
  type LegacyClaimAssertion,
  type LegacyClaimConflict,
  type LegacyClaimDimension,
  type LegacyClaimValue,
  type LegacyEvidenceRecord,
  type LegacyInventorySnapshot,
} from "./model.js";

const BUSINESS_DIMENSIONS = new Set<LegacyClaimDimension>([
  "business_operation",
  "business_effect",
]);

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function claimValueKey(value: LegacyClaimValue): string {
  return hashCanonical(value);
}

interface AssertionAccumulator {
  value: LegacyClaimValue;
  bases: Set<LegacyClaim["basis"]>;
  observationIds: Set<string>;
  evidenceIds: Set<string>;
}

/**
 * Reconcile technical observations into candidates. Grouping uses only the
 * deployment coordinate and exact invocation binding; names and business
 * meanings are assertions, never identity. Every contradictory value remains
 * in the result even when one source has a higher evidence rank.
 */
export function reconcileLegacyInventory(
  input: LegacyInventorySnapshot,
): LegacyCapabilityCandidateType[] {
  const snapshot = verifyLegacyInventory(input);
  const evidenceById = new Map(snapshot.evidence.map((record) => [record.evidenceId, record]));
  const groups = new Map<string, typeof snapshot.observations>();

  for (const observation of snapshot.observations) {
    const key = hashCanonical({
      coordinate: observation.coordinate,
      invocation: observation.invocation,
    });
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }

  const candidates: LegacyCapabilityCandidateType[] = [];
  for (const [identityHash, observations] of [...groups.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const first = observations[0];
    if (!first) continue;

    const dimensions = new Map<LegacyClaimDimension, Map<string, AssertionAccumulator>>();
    for (const observation of observations) {
      for (const claim of observation.claims) {
        const assertions =
          dimensions.get(claim.dimension) ?? new Map<string, AssertionAccumulator>();
        const key = claimValueKey(claim.value);
        const current = assertions.get(key) ?? {
          value: claim.value,
          bases: new Set<LegacyClaim["basis"]>(),
          observationIds: new Set<string>(),
          evidenceIds: new Set<string>(),
        };
        current.bases.add(claim.basis);
        current.observationIds.add(observation.observationId);
        for (const evidenceId of claim.evidenceIds) current.evidenceIds.add(evidenceId);
        assertions.set(key, current);
        dimensions.set(claim.dimension, assertions);
      }
    }

    const claims: LegacyCandidateClaim[] = [];
    const conflicts: LegacyClaimConflict[] = [];
    for (const [dimension, assertionMap] of [...dimensions.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const assertions: LegacyClaimAssertion[] = [...assertionMap.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, assertion]) => ({
          value: assertion.value,
          bases: [...assertion.bases].sort(),
          observationIds: [...assertion.observationIds].sort(),
          evidence: [...assertion.evidenceIds]
            .map((evidenceId) => {
              const evidence = evidenceById.get(evidenceId) as LegacyEvidenceRecord;
              return {
                evidenceId,
                sourceKind: evidence.sourceKind,
                rank: evidenceSourceRank(evidence.sourceKind),
              };
            })
            .sort(
              (left, right) =>
                right.rank - left.rank || left.evidenceId.localeCompare(right.evidenceId),
            ),
        }));
      const conflicting = assertions.length > 1;
      claims.push({ dimension, state: conflicting ? "conflicting" : "single", assertions });
      if (conflicting) {
        conflicts.push({
          dimension,
          values: assertions.map((assertion) => assertion.value),
          evidenceIds: uniqueSorted(
            assertions.flatMap((assertion) =>
              assertion.evidence.map((evidence) => evidence.evidenceId),
            ),
          ),
        });
      }
    }

    const businessClaims = claims.filter((claim) => BUSINESS_DIMENSIONS.has(claim.dimension));
    const businessConflict = businessClaims.some((claim) => claim.state === "conflicting");
    const businessSemantics = businessConflict
      ? "conflicting"
      : businessClaims.length > 0
        ? "asserted_unverified"
        : "unknown";

    candidates.push(
      LegacyCapabilityCandidate.parse({
        schemaVersion: 1,
        candidateId: `lc_${identityHash}`,
        coordinate: first.coordinate,
        invocation: first.invocation,
        observationIds: observations.map((observation) => observation.observationId).sort(),
        evidenceIds: uniqueSorted(observations.flatMap((observation) => observation.evidenceIds)),
        claims,
        conflicts,
        businessSemantics,
        disposition:
          conflicts.length === 0 && businessSemantics === "asserted_unverified"
            ? "review_required"
            : "triage",
      }),
    );
  }

  return candidates.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}
