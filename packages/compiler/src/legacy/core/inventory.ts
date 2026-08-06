import { hashCanonical } from "@anvil/air";
import {
  type EvidenceSourceKind,
  type LegacyEvidenceRecord,
  LegacyInventoryDraft,
  LegacyInventorySnapshot,
  type LegacyInventorySnapshot as LegacyInventorySnapshotType,
  type LegacyRankedEvidence,
} from "./model.js";

const SOURCE_RANK: Readonly<Record<EvidenceSourceKind, number>> = {
  deployed_artifact: 900,
  deployed_configuration: 900,
  broker_configuration: 800,
  artifact_repository: 700,
  source_repository: 600,
  runtime_observation: 500,
  operator_attestation: 400,
  service_catalog: 300,
  documentation: 200,
  naming_inference: 100,
};

/**
 * Relative evidentiary authority. A rank is useful for review ordering only:
 * it never selects one conflicting assertion or turns an observation into an
 * approved business semantic.
 */
export function evidenceSourceRank(kind: EvidenceSourceKind): number {
  return SOURCE_RANK[kind];
}

/** Rank evidence for presentation without dropping lower-ranked records. */
export function rankLegacyEvidence(
  records: readonly LegacyEvidenceRecord[],
): LegacyRankedEvidence[] {
  return records
    .map((record) => ({
      evidenceId: record.evidenceId,
      sourceKind: record.sourceKind,
      rank: evidenceSourceRank(record.sourceKind),
    }))
    .sort(
      (left, right) => right.rank - left.rank || left.evidenceId.localeCompare(right.evidenceId),
    );
}

function canonicalOrder(left: unknown, right: unknown): number {
  return hashCanonical(left).localeCompare(hashCanonical(right));
}

function normalizeDraft(input: LegacyInventoryDraft): LegacyInventoryDraft {
  return {
    ...input,
    artifacts: [...input.artifacts].sort((left, right) =>
      left.artifactId.localeCompare(right.artifactId),
    ),
    evidence: [...input.evidence].sort((left, right) =>
      left.evidenceId.localeCompare(right.evidenceId),
    ),
    observations: [...input.observations].sort((left, right) =>
      left.observationId.localeCompare(right.observationId),
    ),
    diagnostics: [...input.diagnostics].sort(canonicalOrder),
  };
}

/** Finalize captured facts into an order-independent, content-addressed snapshot. */
export function finalizeLegacyInventory(input: LegacyInventoryDraft): LegacyInventorySnapshotType {
  const draft = normalizeDraft(LegacyInventoryDraft.parse(input));
  const hex = hashCanonical(draft);
  return LegacyInventorySnapshot.parse({
    ...draft,
    inventoryId: `li_${hex}`,
    contentHash: `sha256:${hex}`,
  });
}

/**
 * Parse and verify both record references and the snapshot's content-derived
 * identity. Returns canonical ordering, so subsequent serialization is stable.
 */
export function verifyLegacyInventory(input: unknown): LegacyInventorySnapshotType {
  const snapshot = LegacyInventorySnapshot.parse(input);
  const draft = LegacyInventoryDraft.parse({
    schemaVersion: snapshot.schemaVersion,
    estate: snapshot.estate,
    artifacts: snapshot.artifacts,
    evidence: snapshot.evidence,
    observations: snapshot.observations,
    diagnostics: snapshot.diagnostics,
  });
  const expected = finalizeLegacyInventory(draft);
  if (
    snapshot.contentHash !== expected.contentHash ||
    snapshot.inventoryId !== expected.inventoryId
  ) {
    throw new Error("legacy inventory contentHash/inventoryId does not match its captured facts");
  }
  return expected;
}
