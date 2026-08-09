import { hashCanonical } from "@anvil/air";
import { z } from "zod";
import {
  LegacyCapabilityCandidate,
  type LegacyCapabilityCandidate as LegacyCapabilityCandidateType,
  type LegacyInventorySnapshot,
  reconcileLegacyInventory,
  verifyLegacyInventory,
} from "../core/index.js";
import type { LegacyCollectorRun, LegacyInventoryResult } from "../inventory.js";

export interface LegacyProductInput {
  snapshot: LegacyInventorySnapshot;
  candidates: readonly LegacyCapabilityCandidateType[];
  collectors?: readonly LegacyCollectorRun[];
}

export interface VerifiedLegacyProductInput {
  snapshot: LegacyInventorySnapshot;
  candidates: LegacyCapabilityCandidateType[];
  collectors: LegacyCollectorRun[];
}

const CollectorRun = z
  .object({
    collector: z.enum(["java-ee", "dotnet", "messaging"]),
    inputMembers: z.number().int().nonnegative(),
    observations: z.number().int().nonnegative(),
    diagnostics: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Verify the content-addressed snapshot and reject stale, omitted, injected,
 * or reordered candidate assertions. Product projections never trust a caller
 * supplied candidate list merely because it conforms to the structural schema.
 */
export function verifyLegacyProductInput(
  input: LegacyProductInput | LegacyInventoryResult,
): VerifiedLegacyProductInput {
  const snapshot = verifyLegacyInventory(input.snapshot);
  const supplied = input.candidates
    .map((candidate) => LegacyCapabilityCandidate.parse(candidate))
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  const expected = reconcileLegacyInventory(snapshot);
  if (hashCanonical(supplied) !== hashCanonical(expected)) {
    throw new Error(
      "legacy candidates do not match the verified inventory; reconcile the snapshot before projection",
    );
  }
  const collectors = [...(input.collectors ?? [])]
    .map((run) => CollectorRun.parse(run))
    .sort((left, right) => left.collector.localeCompare(right.collector));
  return { snapshot, candidates: expected, collectors };
}
