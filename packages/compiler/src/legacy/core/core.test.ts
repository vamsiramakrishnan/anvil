import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createLegacyArtifact,
  createLegacyEvidence,
  createLegacyObservation,
  type EvidenceSourceKind,
  evidenceSourceRank,
  finalizeLegacyInventory,
  type LegacyArtifactRecord as LegacyArtifact,
  LegacyArtifactInput,
  LegacyArtifactRecord,
  type LegacyCapabilityObservation,
  type LegacyDeploymentCoordinate,
  type LegacyInventoryDraft as LegacyDraft,
  type LegacyEvidenceRecord,
  LegacyInventoryDraft,
  rankLegacyEvidence,
  reconcileLegacyInventory,
  verifyLegacyInventory,
} from "./index.js";

const sha = (digit: string) => `sha256:${digit.repeat(64)}` as const;

const coordinate: LegacyDeploymentCoordinate = {
  environment: "prod-au",
  platform: "websphere-9",
  application: "payments",
  module: "refund-ejb",
  component: "RefundListener",
  deploymentDigest: sha("a"),
};

function artifact(
  digit: string,
  kind: EvidenceSourceKind,
  path = `captures/${digit}.json`,
): LegacyArtifact {
  return createLegacyArtifact({
    schemaVersion: 1,
    digest: sha(digit),
    bytes: 42,
    mediaType: "application/json",
    role: kind === "documentation" ? "documentation" : "runtime_configuration",
    path,
    source: { kind, systemId: `system-${digit}`, revision: `revision-${digit}` },
  });
}

function evidence(captured: LegacyArtifact, collectorId = "test-collector"): LegacyEvidenceRecord {
  return createLegacyEvidence({
    schemaVersion: 1,
    artifactId: captured.artifactId,
    sourceKind: captured.source.kind,
    collectorId,
    basis: captured.source.kind === "runtime_observation" ? "observed" : "configured",
    coordinate: { path: captured.path, pointer: "/resources/0" },
  });
}

function observation(
  captured: LegacyEvidenceRecord,
  value?: string,
  destination = "PAY.REFUND.REQUEST",
): LegacyCapabilityObservation {
  return createLegacyObservation({
    schemaVersion: 1,
    collectorId: captured.collectorId,
    coordinate,
    invocation: {
      kind: "message",
      protocol: "ibm_mq",
      destination,
      direction: "unknown",
    },
    evidenceIds: [captured.evidenceId],
    claims: value
      ? [
          {
            dimension: "business_effect",
            value,
            basis: captured.basis,
            evidenceIds: [captured.evidenceId],
          },
        ]
      : [],
  });
}

function draft(
  artifacts: LegacyArtifact[],
  evidenceRecords: LegacyEvidenceRecord[],
  observations: LegacyCapabilityObservation[],
): LegacyDraft {
  return {
    schemaVersion: 1,
    estate: { id: "payments-prod", name: "Payments production" },
    artifacts,
    evidence: evidenceRecords,
    observations,
    diagnostics: [],
  };
}

describe("legacy content-addressed records", () => {
  it("creates deterministic artifact, evidence, and observation identities", () => {
    const captured = artifact("1", "deployed_configuration");
    const proof = evidence(captured);
    const found = observation(proof, "creates a refund");

    const { artifactId: _artifactId, recordHash: _artifactHash, ...artifactInput } = captured;
    const { evidenceId: _evidenceId, recordHash: _evidenceHash, ...evidenceInput } = proof;
    const {
      observationId: _observationId,
      recordHash: _observationHash,
      ...observationInput
    } = found;

    expect(createLegacyArtifact(artifactInput)).toEqual(captured);
    expect(createLegacyEvidence(evidenceInput)).toEqual(proof);
    expect(
      createLegacyObservation({
        ...observationInput,
        claims: [...observationInput.claims].reverse(),
        evidenceIds: [...observationInput.evidenceIds].reverse(),
      }),
    ).toEqual(found);
  });

  it("rejects tampered record metadata and unsafe paths", () => {
    const captured = artifact("2", "deployed_artifact");
    expect(() => LegacyArtifactRecord.parse({ ...captured, bytes: captured.bytes + 1 })).toThrow();
    expect(() =>
      LegacyArtifactInput.parse({
        schemaVersion: 1,
        digest: sha("2"),
        bytes: 1,
        role: "application_binary",
        path: "../../server.xml",
        source: { kind: "deployed_artifact", systemId: "was" },
      }),
    ).toThrow(/safe relative POSIX path/);
  });

  it("rejects unmodelled payloads so collectors cannot persist content or secrets", () => {
    expect(() =>
      LegacyArtifactInput.parse({
        schemaVersion: 1,
        digest: sha("3"),
        bytes: 12,
        role: "runtime_configuration",
        path: "websphere/resources.json",
        source: { kind: "deployed_configuration", systemId: "was", password: "secret" },
        content: "password=secret",
      }),
    ).toThrow();
  });

  it("models missing direction and method without inventing wildcard semantics", () => {
    const captured = artifact("4", "deployed_configuration");
    const proof = evidence(captured);
    expect(observation(proof).invocation).toMatchObject({ direction: "unknown" });
    expect(
      createLegacyObservation({
        schemaVersion: 1,
        collectorId: "java-ee",
        coordinate,
        invocation: {
          kind: "remote_method",
          protocol: "ejb_rmi",
          interface: "com.acme.RefundRemote",
        },
        evidenceIds: [proof.evidenceId],
        claims: [],
      }).invocation,
    ).not.toHaveProperty("method");
  });
});

describe("legacy inventory identity", () => {
  it("is invariant to collector result ordering", () => {
    const artifacts = [
      artifact("5", "deployed_artifact"),
      artifact("6", "source_repository"),
      artifact("7", "documentation"),
    ];
    const proofs = artifacts.map((item) => evidence(item));
    const observations = proofs.map((item, index) => observation(item, `effect-${index}`));
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const expected = finalizeLegacyInventory(draft(artifacts, proofs, observations));

    fc.assert(
      fc.property(fc.integer({ min: 0, max: permutations.length - 1 }), (permutationIndex) => {
        const order = permutations[permutationIndex];
        if (!order) return false;
        const reordered = finalizeLegacyInventory(
          draft(
            order.map((index) => artifacts[index] as LegacyArtifact),
            [...order].reverse().map((index) => proofs[index] as LegacyEvidenceRecord),
            order.map((index) => observations[index] as LegacyCapabilityObservation),
          ),
        );
        return (
          reordered.contentHash === expected.contentHash &&
          reordered.inventoryId === expected.inventoryId
        );
      }),
    );
  });

  it("detects snapshot tampering and dangling or source-mismatched evidence", () => {
    const captured = artifact("8", "deployed_configuration");
    const proof = evidence(captured);
    const snapshot = finalizeLegacyInventory(draft([captured], [proof], [observation(proof)]));
    expect(verifyLegacyInventory(snapshot)).toEqual(snapshot);
    expect(() => verifyLegacyInventory({ ...snapshot, estate: { id: "other" } })).toThrow(
      /does not match/,
    );
    const mismatched = createLegacyEvidence({
      schemaVersion: 1,
      artifactId: captured.artifactId,
      sourceKind: "documentation",
      collectorId: "malicious-collector",
      basis: "declared",
      coordinate: { path: captured.path },
    });
    expect(() =>
      LegacyInventoryDraft.parse({
        ...draft([captured], [mismatched], []),
      }),
    ).toThrow();
    expect(() => LegacyInventoryDraft.parse(draft([], [proof], []))).toThrow(
      /outside this snapshot/,
    );
  });
});

describe("evidence ranking and reconciliation", () => {
  it("orders evidence but never resolves a conflict by rank", () => {
    const deployed = artifact("9", "deployed_configuration");
    const handbook = artifact("b", "documentation");
    const deployedEvidence = evidence(deployed, "websphere");
    const handbookEvidence = evidence(handbook, "docs");
    const snapshot = finalizeLegacyInventory(
      draft(
        [handbook, deployed],
        [handbookEvidence, deployedEvidence],
        [
          observation(deployedEvidence, "creates a refund"),
          observation(handbookEvidence, "only validates refund eligibility"),
        ],
      ),
    );

    const ranked = rankLegacyEvidence([handbookEvidence, deployedEvidence]);
    expect(ranked).toHaveLength(2);
    expect(ranked.map((item) => item.rank)).toEqual([900, 200]);
    expect(evidenceSourceRank("deployed_configuration")).toBeGreaterThan(
      evidenceSourceRank("documentation"),
    );

    const [candidate] = reconcileLegacyInventory(snapshot);
    expect(candidate?.businessSemantics).toBe("conflicting");
    expect(candidate?.disposition).toBe("triage");
    expect(candidate?.conflicts).toEqual([
      expect.objectContaining({
        dimension: "business_effect",
        values: expect.arrayContaining(["creates a refund", "only validates refund eligibility"]),
        evidenceIds: expect.arrayContaining([
          deployedEvidence.evidenceId,
          handbookEvidence.evidenceId,
        ]),
      }),
    ]);
    expect(candidate?.claims[0]?.assertions).toHaveLength(2);
    expect(candidate).not.toHaveProperty("selectedClaim");
  });

  it("leaves coherent asserted business semantics review-required and unknown semantics in triage", () => {
    const configured = artifact("c", "broker_configuration");
    const proof = evidence(configured);
    const asserted = finalizeLegacyInventory(
      draft([configured], [proof], [observation(proof, "submits a refund request")]),
    );
    expect(reconcileLegacyInventory(asserted)[0]).toMatchObject({
      businessSemantics: "asserted_unverified",
      disposition: "review_required",
    });

    const unknown = finalizeLegacyInventory(draft([configured], [proof], [observation(proof)]));
    expect(reconcileLegacyInventory(unknown)[0]).toMatchObject({
      businessSemantics: "unknown",
      disposition: "triage",
    });
  });

  it("groups only exact technical invocation coordinates", () => {
    const configured = artifact("d", "broker_configuration");
    const proof = evidence(configured);
    const snapshot = finalizeLegacyInventory(
      draft(
        [configured],
        [proof],
        [observation(proof, "one", "PAY.REFUND.V1"), observation(proof, "two", "PAY.REFUND.V2")],
      ),
    );
    expect(reconcileLegacyInventory(snapshot)).toHaveLength(2);
  });

  it("preserves conflicting physical bindings on one stable logical invocation", () => {
    const configured = artifact("e", "deployed_configuration");
    const broker = artifact("f", "broker_configuration");
    const configuredProof = evidence(configured, "websphere");
    const brokerProof = evidence(broker, "ibm-mq");
    const bindingObservation = (proof: LegacyEvidenceRecord, target: string) =>
      createLegacyObservation({
        schemaVersion: 1,
        collectorId: proof.collectorId,
        coordinate,
        invocation: {
          kind: "message",
          protocol: "ibm_mq",
          destination: "jms/refundRequests",
          direction: "unknown",
        },
        evidenceIds: [proof.evidenceId],
        claims: [
          {
            dimension: "binding_target",
            value: target,
            basis: "configured",
            evidenceIds: [proof.evidenceId],
          },
        ],
      });
    const snapshot = finalizeLegacyInventory(
      draft(
        [configured, broker],
        [configuredProof, brokerProof],
        [
          bindingObservation(configuredProof, "PAY.REFUND.V1"),
          bindingObservation(brokerProof, "PAY.REFUND.V2"),
        ],
      ),
    );

    const candidates = reconcileLegacyInventory(snapshot);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      disposition: "triage",
      conflicts: [
        {
          dimension: "binding_target",
          values: expect.arrayContaining(["PAY.REFUND.V1", "PAY.REFUND.V2"]),
        },
      ],
    });
  });
});
