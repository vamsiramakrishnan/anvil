import { describe, expect, it } from "vitest";
import {
  createLegacyArtifact,
  createLegacyEvidence,
  createLegacyObservation,
  finalizeLegacyInventory,
  type LegacyClaimDimension,
  type LegacyCollectorDiagnostic,
  reconcileLegacyInventory,
} from "../core/index.js";
import type { LegacyInventoryResult } from "../inventory.js";
import {
  assessAndPlanLegacyCoverage,
  assessLegacyCoverage,
  createLegacyCollectionPlan,
  createLegacyCollectorFactV2,
  createLegacyCollectorMemberMetadataV2,
  createLegacyCollectorProblemV2,
  diffLegacyInventories,
  explainLegacyCandidate,
  FAIL_CLOSED_LEGACY_COLLECTION_POLICY,
  LegacyCollectionPlan,
  type LegacyCollectionSource,
  LegacyCollectorDescriptorV2,
  LegacyCollectorFactV2,
  LegacyCollectorMemberMetadataV2,
  LegacyCollectorProblemV2,
  LegacyEvidenceGraph,
  legacyLogicalCapabilityId,
  legacyOccurrenceId,
  PURE_OFFLINE_COLLECTOR_BOUNDARY_V2,
  projectLegacyEvidenceGraph,
  verifyLegacyCollectionPlan,
} from "./index.js";

const sha = (digit: string) => `sha256:${digit.repeat(64)}` as const;

interface ResultOptions {
  artifactDigit?: string;
  deploymentDigit?: string;
  destination?: string;
  direction?: "produce" | "consume" | "request_reply" | "publish" | "subscribe" | "unknown";
  claims?: readonly LegacyClaimDimension[];
  diagnostics?: readonly LegacyCollectorDiagnostic[];
  empty?: boolean;
}

function inventoryResult(options: ResultOptions = {}): LegacyInventoryResult {
  const artifactDigit = options.artifactDigit ?? "a";
  const artifact = createLegacyArtifact({
    schemaVersion: 1,
    digest: sha(artifactDigit),
    bytes: 128,
    mediaType: "application/xml",
    role: "runtime_configuration",
    path: "exports/broker.xml",
    source: {
      kind: "broker_configuration",
      systemId: "broker-prod",
      revision: `export-${artifactDigit}`,
    },
  });
  const evidence = createLegacyEvidence({
    schemaVersion: 1,
    artifactId: artifact.artifactId,
    sourceKind: artifact.source.kind,
    collectorId: "messaging",
    basis: "configured",
    coordinate: { path: artifact.path, pointer: "/queues/0" },
  });
  const claims = (options.claims ?? ["technical_name", "binding_target"]).map((dimension) => ({
    dimension,
    value:
      dimension === "input_schema"
        ? "urn:acme:RefundRequested"
        : dimension === "error_semantics"
          ? "PAY.REFUND.DLQ"
          : dimension === "transaction_boundary"
            ? "local"
            : dimension === "owner"
              ? "payments-platform"
              : "PAY.REFUND.REQUEST",
    basis: "configured" as const,
    evidenceIds: [evidence.evidenceId],
  }));
  const observation = createLegacyObservation({
    schemaVersion: 1,
    collectorId: "messaging",
    coordinate: {
      environment: "prod-au",
      platform: "ibm-mq-9",
      application: "payments",
      module: "refunds",
      component: "RefundListener",
      deploymentDigest: sha(options.deploymentDigit ?? "b"),
    },
    invocation: {
      kind: "message",
      protocol: "ibm_mq",
      destination: options.destination ?? "PAY.REFUND.REQUEST",
      direction: options.direction ?? "consume",
    },
    claims,
    evidenceIds: [evidence.evidenceId],
  });
  const empty = options.empty ?? false;
  const snapshot = finalizeLegacyInventory({
    schemaVersion: 1,
    estate: { id: "payments-estate", name: "Payments estate" },
    artifacts: [artifact],
    evidence: empty ? [] : [evidence],
    observations: empty ? [] : [observation],
    diagnostics: [...(options.diagnostics ?? [])],
  });
  return {
    snapshot,
    candidates: reconcileLegacyInventory(snapshot),
    collectors: [
      {
        collector: "messaging",
        inputMembers: 1,
        observations: empty ? 0 : 1,
        diagnostics: options.diagnostics?.length ?? 0,
      },
    ],
  };
}

const source: LegacyCollectionSource = {
  id: "payments-source",
  kind: "source_repository" as const,
  systemId: "github-payments",
  root: "source",
  revision: "b7d5f84",
  expectedRoles: ["source_manifest", "deployment_descriptor"],
  context: {
    environment: "prod-au",
    application: "payments",
    platform: "weblogic-14",
    domain: "payments-domain",
    cluster: "payments-cluster",
  },
};

describe("legacy collection plan", () => {
  it("normalizes source and requirement order into one content identity", () => {
    const otherSource: LegacyCollectionSource = {
      ...source,
      id: "broker-export",
      kind: "broker_configuration" as const,
      systemId: "mq-prod",
      root: "exports/mq",
      revision: "export-17",
      expectedRoles: ["broker_export"],
      context: { ...source.context, queueManager: "PAYMENTS.QM1" },
    };
    const first = createLegacyCollectionPlan({
      schemaVersion: 1,
      estate: { id: "payments-estate" },
      sources: [source, otherSource],
      requirements: ["input_schema", "deployment_identity", "invocation_binding"],
      policy: FAIL_CLOSED_LEGACY_COLLECTION_POLICY,
    });
    const reordered = createLegacyCollectionPlan({
      policy: { ...FAIL_CLOSED_LEGACY_COLLECTION_POLICY },
      requirements: ["invocation_binding", "deployment_identity", "input_schema"],
      sources: [
        { ...otherSource, context: { ...otherSource.context } },
        { ...source, context: { ...source.context } },
      ],
      estate: { id: "payments-estate" },
      schemaVersion: 1,
    });
    expect(reordered).toEqual(first);
    expect(verifyLegacyCollectionPlan(first)).toEqual(first);
  });

  it("fails closed on unknown fields, mutable repositories, policy weakening, and tampering", () => {
    const base = {
      schemaVersion: 1 as const,
      estate: { id: "payments-estate" },
      sources: [source],
      requirements: ["deployment_identity" as const],
      policy: FAIL_CLOSED_LEGACY_COLLECTION_POLICY,
    };
    expect(() => createLegacyCollectionPlan({ ...base, surprise: true } as never)).toThrow();
    expect(() =>
      createLegacyCollectionPlan({
        ...base,
        sources: [{ ...source, revision: undefined }],
      }),
    ).toThrow(/immutable revision/);
    expect(() =>
      createLegacyCollectionPlan({
        ...base,
        policy: { ...FAIL_CLOSED_LEGACY_COLLECTION_POLICY, networkAccess: "allow" } as never,
      }),
    ).toThrow();
    const plan = createLegacyCollectionPlan(base);
    expect(() => LegacyCollectionPlan.parse({ ...plan, contentHash: sha("f") })).toThrow(
      /match plan content/,
    );
  });
});

describe("legacy evidence graph and explanation", () => {
  it("projects deterministic typed nodes and edges with no invented evidence", () => {
    const result = inventoryResult();
    const graph = projectLegacyEvidenceGraph(result);
    expect(
      projectLegacyEvidenceGraph({ ...result, candidates: [...result.candidates].reverse() }),
    ).toEqual(graph);
    const inventoryEvidence = new Set(result.snapshot.evidence.map((item) => item.evidenceId));
    expect(
      graph.nodes.every((node) => node.evidenceIds.every((id) => inventoryEvidence.has(id))),
    ).toBe(true);
    expect(
      graph.edges.every((edge) => edge.evidenceIds.every((id) => inventoryEvidence.has(id))),
    ).toBe(true);
    expect(graph.nodes.map((node) => node.kind)).toEqual(
      expect.arrayContaining([
        "artifact",
        "evidence",
        "observation",
        "deployment",
        "component",
        "capability",
        "claim",
      ]),
    );
    const badEvidence = `le_${"f".repeat(64)}`;
    const edge = graph.edges[0];
    expect(edge).toBeDefined();
    expect(() =>
      LegacyEvidenceGraph.parse({
        ...graph,
        edges: [{ ...edge, evidenceIds: [badEvidence] }, ...graph.edges.slice(1)],
      }),
    ).toThrow(/outside this graph/);
  });

  it("rejects a structurally valid but stale or modified candidate projection", () => {
    const result = inventoryResult();
    const candidate = result.candidates[0];
    if (!candidate) throw new Error("fixture did not produce a candidate");
    expect(() =>
      projectLegacyEvidenceGraph({
        ...result,
        candidates: [{ ...candidate, disposition: "review_required" }],
      }),
    ).toThrow(/do not match the verified inventory/);
  });

  it("explains assertions with exact artifact coordinates and leaves dimensions unknown", () => {
    const result = inventoryResult();
    const candidate = result.candidates[0];
    if (!candidate) throw new Error("fixture did not produce a candidate");
    const explanation = explainLegacyCandidate(result, candidate.candidateId);
    expect(explanation.evidence[0]?.evidence.coordinate).toEqual({
      path: "exports/broker.xml",
      pointer: "/queues/0",
    });
    expect(explanation.unknownDimensions).toContain("business_operation");
    expect(explanation.occurrenceId).toBe(legacyOccurrenceId(candidate));
    expect(explanation.logicalCapabilityId).toBe(
      legacyLogicalCapabilityId(result.snapshot.estate, candidate),
    );
  });
});

describe("legacy coverage and gap planning", () => {
  it("does not equate candidate yield with semantic completeness", () => {
    const result = inventoryResult();
    const plan = createLegacyCollectionPlan({
      schemaVersion: 1,
      estate: { id: "payments-estate" },
      sources: [source],
      requirements: [
        "deployment_identity",
        "invocation_binding",
        "input_schema",
        "authorization_context",
        "completion_semantics",
      ],
      policy: FAIL_CLOSED_LEGACY_COLLECTION_POLICY,
    });
    const { report, gapPlan } = assessAndPlanLegacyCoverage(result, { plan });
    expect(report.candidateCount).toBe(1);
    expect(report.semanticComplete).toBe(false);
    expect(report.outcome).toBe("partial");
    expect(
      report.requirements.find((item) => item.requirement === "authorization_context")?.status,
    ).toBe("missing");
    expect(gapPlan.gaps.map((gap) => gap.requirement)).toEqual(
      expect.arrayContaining(["authorization_context", "completion_semantics"]),
    );
  });

  it("distinguishes unsupported input from a safety refusal", () => {
    const unsupported = inventoryResult({ empty: true });
    expect(assessLegacyCoverage(unsupported).outcome).toBe("unsupported");
    const refusalDiagnostic: LegacyCollectorDiagnostic = {
      level: "error",
      code: "legacy/messaging/secret_like_value",
      message: "Refused secret-bearing export.",
      collectorId: "messaging",
      remediation: "Export allowlisted topology only.",
    };
    const refused = inventoryResult({ empty: true, diagnostics: [refusalDiagnostic] });
    const { report, gapPlan } = assessAndPlanLegacyCoverage(refused);
    expect(report.outcome).toBe("safety-refusal");
    expect(gapPlan.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "safety_refusal",
          diagnosticCode: refusalDiagnostic.code,
        }),
      ]),
    );
  });
});

describe("legacy inventory diff", () => {
  it("retains logical lineage across deployment changes while changing occurrence identity", () => {
    const before = inventoryResult({ artifactDigit: "1", deploymentDigit: "2" });
    const after = inventoryResult({ artifactDigit: "3", deploymentDigit: "4" });
    const diff = diffLegacyInventories(before, after);
    expect(diff.addedLineages).toHaveLength(0);
    expect(diff.removedLineages).toHaveLength(0);
    expect(diff.changedLineages).toHaveLength(1);
    expect(diff.changedLineages[0]?.changeKinds).toEqual(
      expect.arrayContaining(["deployment", "evidence"]),
    );
    expect(diff.addedOccurrenceIds).toHaveLength(1);
    expect(diff.removedOccurrenceIds).toHaveLength(1);
    expect(diffLegacyInventories(before, after)).toEqual(diff);
  });

  it("reports assertion changes independently from occurrence identity", () => {
    const before = inventoryResult({ claims: ["technical_name"] });
    const after = inventoryResult({ claims: ["technical_name", "input_schema"] });
    const diff = diffLegacyInventories(before, after);
    expect(diff.retainedOccurrenceIds).toHaveLength(1);
    expect(diff.changedLineages[0]?.changeKinds).toContain("claims");
    expect(diff.changedLineages[0]?.changeKinds).not.toContain("deployment");
  });

  it("keeps a direction refinement in the same lineage and reports the invocation change", () => {
    const before = inventoryResult({ direction: "unknown" });
    const after = inventoryResult({ direction: "consume" });
    const diff = diffLegacyInventories(before, after);
    expect(diff.addedLineages).toHaveLength(0);
    expect(diff.removedLineages).toHaveLength(0);
    expect(diff.changedLineages[0]?.changeKinds).toContain("invocation");
    expect(diff.changedLineages[0]?.changeKinds).not.toContain("deployment");
  });

  it("does not join different logical destinations", () => {
    const before = inventoryResult({ destination: "PAY.REFUND.REQUEST" });
    const after = inventoryResult({ destination: "PAY.CAPTURE.REQUEST" });
    const diff = diffLegacyInventories(before, after);
    expect(diff.addedLineages).toHaveLength(1);
    expect(diff.removedLineages).toHaveLength(1);
    expect(diff.changedLineages).toHaveLength(0);
  });
});

describe("CollectorV2 contract", () => {
  const member = createLegacyCollectorMemberMetadataV2({
    sourceId: "mq-export",
    path: "exports/topology.mqsc",
    digest: sha("a"),
    bytes: 128,
    role: "broker_export",
    sourceKind: "broker_configuration",
    mediaType: "text/plain",
  });
  const memberId = member.memberId;
  const evidence = { memberId, basis: "configured" as const, pointer: "/queues/0" };

  it("makes the pure/offline boundary and accepted capabilities explicit", () => {
    const descriptor = LegacyCollectorDescriptorV2.parse({
      apiVersion: "anvil.dev/legacy-collector/v2",
      id: "ibm-mq-v2",
      version: "2.0.0",
      displayName: "IBM MQ collector",
      runtimeBoundary: PURE_OFFLINE_COLLECTOR_BOUNDARY_V2,
      accepts: {
        sourceKinds: ["broker_configuration"],
        artifactRoles: ["broker_export"],
        extensions: [".mqsc"],
        mediaTypes: ["text/plain"],
      },
      capabilities: ["invocation_binding", "message_direction"],
      limits: { maxMemberBytes: 1024, maxMembers: 100, maxOutputFacts: 1000 },
    });
    expect(descriptor.runtimeBoundary.mode).toBe("pure_offline");
    expect(() =>
      LegacyCollectorMemberMetadataV2.parse({ ...member, bytes: member.bytes + 1 }),
    ).toThrow(/match member provenance/);
    expect(() =>
      LegacyCollectorDescriptorV2.parse({
        ...descriptor,
        runtimeBoundary: { ...descriptor.runtimeBoundary, networkAccess: true },
      }),
    ).toThrow();
    expect(() =>
      LegacyCollectorDescriptorV2.parse({ ...descriptor, pluginUrl: "https://x" }),
    ).toThrow();
  });

  it("content-addresses facts and rejects claim evidence outside the fact", () => {
    const input = {
      schemaVersion: 2 as const,
      collectorId: "ibm-mq-v2",
      coordinate: {
        environment: "prod-au",
        platform: "ibm-mq-9",
        application: "payments",
        module: "refunds",
        component: "RefundListener",
        deploymentDigest: sha("a"),
      },
      invocation: {
        kind: "message" as const,
        protocol: "ibm_mq" as const,
        destination: "PAY.REFUND.REQUEST",
        direction: "consume" as const,
      },
      evidence: [evidence],
      claims: [
        {
          dimension: "binding_target" as const,
          value: "PAY.REFUND.REQUEST",
          basis: "configured" as const,
          evidence: [evidence],
        },
      ],
    };
    const fact = createLegacyCollectorFactV2(input);
    expect(createLegacyCollectorFactV2(input)).toEqual(fact);
    expect(() => LegacyCollectorFactV2.parse({ ...fact, contentHash: sha("f") })).toThrow();
    const firstClaim = input.claims[0];
    if (!firstClaim) throw new Error("fixture did not produce a claim");
    expect(() =>
      createLegacyCollectorFactV2({
        ...input,
        claims: [
          {
            ...firstClaim,
            evidence: [{ ...evidence, pointer: "/queues/1" }],
          },
        ],
      }),
    ).toThrow(/claim evidence/);
  });

  it("emits structured, deterministic, non-retryable problems", () => {
    const input = {
      schemaVersion: 2 as const,
      collectorId: "ibm-mq-v2",
      stage: "collect" as const,
      category: "safety_refusal" as const,
      severity: "error" as const,
      code: "legacy/messaging/secret_like_value",
      message: "Secret-bearing export was refused.",
      remediation: "Provide a sanitized topology export.",
      memberId,
      evidenceIds: [],
      retryable: false as const,
    };
    const problem = createLegacyCollectorProblemV2(input);
    expect(createLegacyCollectorProblemV2(input)).toEqual(problem);
    expect(() => LegacyCollectorProblemV2.parse({ ...problem, retryable: true })).toThrow();
  });
});
