import { hashCanonical } from "@anvil/air";
import { z } from "zod";
import { LegacyDeploymentCoordinate, LegacySha256 } from "../core/index.js";
import type { LegacyInventoryResult } from "../inventory.js";
import { legacyLogicalCapabilityId, legacyOccurrenceId } from "./identity.js";
import { type LegacyProductInput, verifyLegacyProductInput } from "./input.js";

const OccurrenceSummary = z
  .object({
    occurrenceId: z.string().regex(/^lco_[0-9a-f]{64}$/),
    logicalCapabilityId: z.string().regex(/^lcl_[0-9a-f]{64}$/),
    candidateId: z.string().regex(/^lc_[0-9a-f]{64}$/),
    coordinate: LegacyDeploymentCoordinate,
    candidateHash: LegacySha256,
    coordinateHash: LegacySha256,
    invocationHash: LegacySha256,
    evidenceHash: LegacySha256,
    claimsHash: LegacySha256,
    conflictsHash: LegacySha256,
    dispositionHash: LegacySha256,
  })
  .strict();
export type LegacyOccurrenceSummary = z.infer<typeof OccurrenceSummary>;

const LineageSnapshot = z
  .object({
    logicalCapabilityId: z.string().regex(/^lcl_[0-9a-f]{64}$/),
    occurrences: z.array(OccurrenceSummary).min(1),
  })
  .strict();
export type LegacyLineageSnapshot = z.infer<typeof LineageSnapshot>;

export const LegacyLineageChangeKind = z.enum([
  "occurrence_count",
  "deployment",
  "invocation",
  "evidence",
  "claims",
  "conflicts",
  "disposition",
]);
export type LegacyLineageChangeKind = z.infer<typeof LegacyLineageChangeKind>;

const ChangedLineage = z
  .object({
    logicalCapabilityId: z.string().regex(/^lcl_[0-9a-f]{64}$/),
    changeKinds: z.array(LegacyLineageChangeKind).min(1),
    before: LineageSnapshot,
    after: LineageSnapshot,
  })
  .strict();
export type LegacyChangedLineage = z.infer<typeof ChangedLineage>;

const DiffCore = z
  .object({
    schemaVersion: z.literal(1),
    beforeInventoryId: z.string().regex(/^li_[0-9a-f]{64}$/),
    afterInventoryId: z.string().regex(/^li_[0-9a-f]{64}$/),
    addedLineages: z.array(LineageSnapshot),
    removedLineages: z.array(LineageSnapshot),
    changedLineages: z.array(ChangedLineage),
    unchangedLogicalCapabilityIds: z.array(z.string().regex(/^lcl_[0-9a-f]{64}$/)),
    addedOccurrenceIds: z.array(z.string().regex(/^lco_[0-9a-f]{64}$/)),
    removedOccurrenceIds: z.array(z.string().regex(/^lco_[0-9a-f]{64}$/)),
    retainedOccurrenceIds: z.array(z.string().regex(/^lco_[0-9a-f]{64}$/)),
  })
  .strict();

export const LegacyInventoryDiff = DiffCore.extend({
  diffId: z.string().regex(/^lid_[0-9a-f]{64}$/),
  contentHash: LegacySha256,
})
  .strict()
  .superRefine((diff, ctx) => {
    const { diffId: _diffId, contentHash: _contentHash, ...core } = diff;
    const expected = diffAddress(core);
    if (diff.diffId !== expected.diffId || diff.contentHash !== expected.contentHash) {
      ctx.addIssue({ code: "custom", message: "diff identity must match diff content" });
    }
  });
export type LegacyInventoryDiff = z.infer<typeof LegacyInventoryDiff>;

function sha(value: unknown): `sha256:${string}` {
  return `sha256:${hashCanonical(value)}`;
}

function arrayHash(values: readonly string[]): string {
  return hashCanonical([...values].sort());
}

function lineageMap(
  input: ReturnType<typeof verifyLegacyProductInput>,
): Map<string, LegacyLineageSnapshot> {
  const groups = new Map<string, LegacyOccurrenceSummary[]>();
  for (const candidate of input.candidates) {
    const logicalCapabilityId = legacyLogicalCapabilityId(input.snapshot.estate, candidate);
    const occurrence: LegacyOccurrenceSummary = OccurrenceSummary.parse({
      occurrenceId: legacyOccurrenceId(candidate),
      logicalCapabilityId,
      candidateId: candidate.candidateId,
      coordinate: candidate.coordinate,
      candidateHash: sha(candidate),
      coordinateHash: sha(candidate.coordinate),
      invocationHash: sha(candidate.invocation),
      evidenceHash: sha([...candidate.evidenceIds].sort()),
      claimsHash: sha(
        candidate.claims.map((claim) => ({
          dimension: claim.dimension,
          state: claim.state,
          assertions: claim.assertions.map((assertion) => ({
            value: assertion.value,
            bases: [...assertion.bases].sort(),
          })),
        })),
      ),
      conflictsHash: sha(
        candidate.conflicts.map((conflict) => ({
          dimension: conflict.dimension,
          values: conflict.values,
        })),
      ),
      dispositionHash: sha({
        businessSemantics: candidate.businessSemantics,
        disposition: candidate.disposition,
      }),
    });
    groups.set(logicalCapabilityId, [...(groups.get(logicalCapabilityId) ?? []), occurrence]);
  }
  return new Map(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([logicalCapabilityId, occurrences]) => [
        logicalCapabilityId,
        LineageSnapshot.parse({
          logicalCapabilityId,
          occurrences: occurrences.sort((left, right) =>
            left.occurrenceId.localeCompare(right.occurrenceId),
          ),
        }),
      ]),
  );
}

function hashes(
  lineage: LegacyLineageSnapshot,
  field:
    | "occurrenceId"
    | "coordinateHash"
    | "invocationHash"
    | "evidenceHash"
    | "claimsHash"
    | "conflictsHash"
    | "dispositionHash",
): string {
  return arrayHash(lineage.occurrences.map((occurrence) => occurrence[field]));
}

function changeKinds(
  before: LegacyLineageSnapshot,
  after: LegacyLineageSnapshot,
): LegacyLineageChangeKind[] {
  const kinds: LegacyLineageChangeKind[] = [];
  if (before.occurrences.length !== after.occurrences.length) kinds.push("occurrence_count");
  if (hashes(before, "coordinateHash") !== hashes(after, "coordinateHash"))
    kinds.push("deployment");
  if (hashes(before, "invocationHash") !== hashes(after, "invocationHash"))
    kinds.push("invocation");
  if (hashes(before, "evidenceHash") !== hashes(after, "evidenceHash")) kinds.push("evidence");
  if (hashes(before, "claimsHash") !== hashes(after, "claimsHash")) kinds.push("claims");
  if (hashes(before, "conflictsHash") !== hashes(after, "conflictsHash")) kinds.push("conflicts");
  if (hashes(before, "dispositionHash") !== hashes(after, "dispositionHash"))
    kinds.push("disposition");
  return kinds;
}

function diffAddress(core: z.infer<typeof DiffCore>): {
  diffId: string;
  contentHash: `sha256:${string}`;
} {
  const hex = hashCanonical(core);
  return { diffId: `lid_${hex}`, contentHash: `sha256:${hex}` };
}

/** Diff verified inventories at both deployment occurrence and logical lineage levels. */
export function diffLegacyInventories(
  beforeInput: LegacyProductInput | LegacyInventoryResult,
  afterInput: LegacyProductInput | LegacyInventoryResult,
): LegacyInventoryDiff {
  const before = verifyLegacyProductInput(beforeInput);
  const after = verifyLegacyProductInput(afterInput);
  const beforeLineages = lineageMap(before);
  const afterLineages = lineageMap(after);
  const logicalIds = [...new Set([...beforeLineages.keys(), ...afterLineages.keys()])].sort();
  const addedLineages: LegacyLineageSnapshot[] = [];
  const removedLineages: LegacyLineageSnapshot[] = [];
  const changedLineages: LegacyChangedLineage[] = [];
  const unchangedLogicalCapabilityIds: string[] = [];
  for (const logicalId of logicalIds) {
    const previous = beforeLineages.get(logicalId);
    const current = afterLineages.get(logicalId);
    if (!previous && current) addedLineages.push(current);
    else if (previous && !current) removedLineages.push(previous);
    else if (previous && current) {
      const kinds = changeKinds(previous, current);
      if (kinds.length === 0) unchangedLogicalCapabilityIds.push(logicalId);
      else {
        changedLineages.push(
          ChangedLineage.parse({
            logicalCapabilityId: logicalId,
            changeKinds: kinds,
            before: previous,
            after: current,
          }),
        );
      }
    }
  }
  const beforeOccurrences = new Set(
    [...beforeLineages.values()].flatMap((lineage) =>
      lineage.occurrences.map((occurrence) => occurrence.occurrenceId),
    ),
  );
  const afterOccurrences = new Set(
    [...afterLineages.values()].flatMap((lineage) =>
      lineage.occurrences.map((occurrence) => occurrence.occurrenceId),
    ),
  );
  const core: z.infer<typeof DiffCore> = {
    schemaVersion: 1,
    beforeInventoryId: before.snapshot.inventoryId,
    afterInventoryId: after.snapshot.inventoryId,
    addedLineages,
    removedLineages,
    changedLineages,
    unchangedLogicalCapabilityIds,
    addedOccurrenceIds: [...afterOccurrences].filter((id) => !beforeOccurrences.has(id)).sort(),
    removedOccurrenceIds: [...beforeOccurrences].filter((id) => !afterOccurrences.has(id)).sort(),
    retainedOccurrenceIds: [...afterOccurrences].filter((id) => beforeOccurrences.has(id)).sort(),
  };
  return LegacyInventoryDiff.parse({ ...core, ...diffAddress(core) });
}
