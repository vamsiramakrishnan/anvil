import { hashCanonical } from "@anvil/air";
import { z } from "zod";
import {
  EvidenceSourceKind,
  LegacyArtifactRole,
  LegacyClaimDimension,
  LegacyClaimValue,
  LegacyDeploymentCoordinate,
  LegacyEvidenceBasis,
  LegacyEvidenceCoordinate,
  LegacyInvocation,
  LegacySha256,
} from "../core/index.js";
import type { LegacyInventoryResult } from "../inventory.js";
import { legacyLogicalCapabilityId, legacyOccurrenceId } from "./identity.js";
import { type LegacyProductInput, verifyLegacyProductInput } from "./input.js";

const EvidenceId = z.string().regex(/^le_[0-9a-f]{64}$/);
const NodeId = z.string().regex(/^lgn_[0-9a-f]{64}$/);
const EdgeId = z.string().regex(/^lge_[0-9a-f]{64}$/);
const CandidateId = z.string().regex(/^lc_[0-9a-f]{64}$/);
const ObservationId = z.string().regex(/^lo_[0-9a-f]{64}$/);

const NodeBase = {
  nodeId: NodeId,
  evidenceIds: z.array(EvidenceId).max(512),
};

export const LegacyEvidenceGraphNode = z.discriminatedUnion("kind", [
  z
    .object({
      ...NodeBase,
      kind: z.literal("artifact"),
      artifactId: z.string().regex(/^la_[0-9a-f]{64}$/),
      path: z.string(),
      role: LegacyArtifactRole,
      digest: LegacySha256,
      sourceKind: EvidenceSourceKind,
      sourceSystemId: z.string(),
    })
    .strict(),
  z
    .object({
      ...NodeBase,
      kind: z.literal("evidence"),
      evidenceId: EvidenceId,
      artifactId: z.string().regex(/^la_[0-9a-f]{64}$/),
      sourceKind: EvidenceSourceKind,
      collectorId: z.string(),
      basis: LegacyEvidenceBasis,
      coordinate: LegacyEvidenceCoordinate,
    })
    .strict(),
  z
    .object({
      ...NodeBase,
      kind: z.literal("deployment"),
      coordinate: LegacyDeploymentCoordinate,
    })
    .strict(),
  z
    .object({
      ...NodeBase,
      kind: z.literal("component"),
      coordinate: LegacyDeploymentCoordinate,
    })
    .strict(),
  z
    .object({
      ...NodeBase,
      kind: z.literal("observation"),
      observationId: ObservationId,
      collectorId: z.string(),
      coordinate: LegacyDeploymentCoordinate,
      invocation: LegacyInvocation,
    })
    .strict(),
  z
    .object({
      ...NodeBase,
      kind: z.literal("capability"),
      candidateId: CandidateId,
      occurrenceId: z.string().regex(/^lco_[0-9a-f]{64}$/),
      logicalCapabilityId: z.string().regex(/^lcl_[0-9a-f]{64}$/),
      coordinate: LegacyDeploymentCoordinate,
      invocation: LegacyInvocation,
      businessSemantics: z.enum(["unknown", "asserted_unverified", "conflicting"]),
      disposition: z.enum(["triage", "review_required"]),
    })
    .strict(),
  z
    .object({
      ...NodeBase,
      kind: z.literal("claim"),
      candidateId: CandidateId,
      dimension: LegacyClaimDimension,
      value: LegacyClaimValue,
      bases: z.array(LegacyEvidenceBasis).min(1),
      conflicting: z.boolean(),
    })
    .strict(),
]);
export type LegacyEvidenceGraphNode = z.infer<typeof LegacyEvidenceGraphNode>;

export const LegacyEvidenceGraphEdge = z
  .object({
    edgeId: EdgeId,
    kind: z.enum([
      "contains_evidence",
      "supports_observation",
      "contributes_to_capability",
      "occurs_in_deployment",
      "contains_component",
      "exposes_capability",
      "supports_claim",
    ]),
    from: NodeId,
    to: NodeId,
    evidenceIds: z.array(EvidenceId).min(1).max(512),
  })
  .strict();
export type LegacyEvidenceGraphEdge = z.infer<typeof LegacyEvidenceGraphEdge>;

const GraphCore = z
  .object({
    schemaVersion: z.literal(1),
    inventoryId: z.string().regex(/^li_[0-9a-f]{64}$/),
    inventoryContentHash: LegacySha256,
    nodes: z.array(LegacyEvidenceGraphNode).max(500_000),
    edges: z.array(LegacyEvidenceGraphEdge).max(1_000_000),
  })
  .strict();

export const LegacyEvidenceGraph = GraphCore.extend({
  graphId: z.string().regex(/^leg_[0-9a-f]{64}$/),
  contentHash: LegacySha256,
})
  .strict()
  .superRefine((graph, ctx) => {
    const nodeIds = new Set(graph.nodes.map((node) => node.nodeId));
    const evidenceIds = new Set(
      graph.nodes.flatMap((node) => (node.kind === "evidence" ? [node.evidenceId] : [])),
    );
    const duplicateNodes = graph.nodes.length !== nodeIds.size;
    if (duplicateNodes)
      ctx.addIssue({ code: "custom", path: ["nodes"], message: "duplicate nodeId" });
    const edgeIds = new Set<string>();
    graph.edges.forEach((edge, index) => {
      if (edgeIds.has(edge.edgeId)) {
        ctx.addIssue({
          code: "custom",
          path: ["edges", index, "edgeId"],
          message: "duplicate edgeId",
        });
      }
      edgeIds.add(edge.edgeId);
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        ctx.addIssue({
          code: "custom",
          path: ["edges", index],
          message: "edge endpoint is outside this graph",
        });
      }
      edge.evidenceIds.forEach((evidenceId, evidenceIndex) => {
        if (!evidenceIds.has(evidenceId)) {
          ctx.addIssue({
            code: "custom",
            path: ["edges", index, "evidenceIds", evidenceIndex],
            message: "edge cites evidence outside this graph",
          });
        }
      });
    });
    graph.nodes.forEach((node, index) => {
      node.evidenceIds.forEach((evidenceId, evidenceIndex) => {
        if (!evidenceIds.has(evidenceId)) {
          ctx.addIssue({
            code: "custom",
            path: ["nodes", index, "evidenceIds", evidenceIndex],
            message: "node cites evidence outside this graph",
          });
        }
      });
      const { nodeId: _nodeId, ...core } = node;
      if (node.nodeId !== nodeAddress(core)) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "nodeId"],
          message: "must match node content",
        });
      }
    });
    graph.edges.forEach((edge, index) => {
      const { edgeId: _edgeId, ...core } = edge;
      if (edge.edgeId !== edgeAddress(core)) {
        ctx.addIssue({
          code: "custom",
          path: ["edges", index, "edgeId"],
          message: "must match edge content",
        });
      }
    });
    const { graphId: _graphId, contentHash: _contentHash, ...core } = graph;
    const address = graphAddress(core);
    if (graph.graphId !== address.graphId || graph.contentHash !== address.contentHash) {
      ctx.addIssue({ code: "custom", message: "graph identity must match graph content" });
    }
  });
export type LegacyEvidenceGraph = z.infer<typeof LegacyEvidenceGraph>;

type GraphNodeCore = LegacyEvidenceGraphNode extends infer Node
  ? Node extends { nodeId: string }
    ? Omit<Node, "nodeId">
    : never
  : never;

function nodeAddress(core: GraphNodeCore): string {
  return `lgn_${hashCanonical(core)}`;
}

function graphNode(core: GraphNodeCore): LegacyEvidenceGraphNode {
  return LegacyEvidenceGraphNode.parse({ ...core, nodeId: nodeAddress(core) });
}

function edgeAddress(core: Omit<LegacyEvidenceGraphEdge, "edgeId">): string {
  return `lge_${hashCanonical(core)}`;
}

function graphEdge(core: Omit<LegacyEvidenceGraphEdge, "edgeId">): LegacyEvidenceGraphEdge {
  return LegacyEvidenceGraphEdge.parse({ ...core, edgeId: edgeAddress(core) });
}

function graphAddress(core: z.infer<typeof GraphCore>): {
  graphId: string;
  contentHash: `sha256:${string}`;
} {
  const hex = hashCanonical(core);
  return { graphId: `leg_${hex}`, contentHash: `sha256:${hex}` };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** Project a verified inventory into a deterministic, fully evidenced graph. */
export function projectLegacyEvidenceGraph(
  input: LegacyProductInput | LegacyInventoryResult,
): LegacyEvidenceGraph {
  const { snapshot, candidates } = verifyLegacyProductInput(input);
  const nodes: LegacyEvidenceGraphNode[] = [];
  const edges: LegacyEvidenceGraphEdge[] = [];
  const artifactNodes = new Map<string, LegacyEvidenceGraphNode>();
  const evidenceNodes = new Map<string, LegacyEvidenceGraphNode>();
  const observationNodes = new Map<string, LegacyEvidenceGraphNode>();

  for (const artifact of snapshot.artifacts) {
    const node = graphNode({
      kind: "artifact",
      artifactId: artifact.artifactId,
      path: artifact.path,
      role: artifact.role,
      digest: artifact.digest,
      sourceKind: artifact.source.kind,
      sourceSystemId: artifact.source.systemId,
      evidenceIds: [],
    });
    nodes.push(node);
    artifactNodes.set(artifact.artifactId, node);
  }
  for (const evidence of snapshot.evidence) {
    const node = graphNode({
      kind: "evidence",
      evidenceId: evidence.evidenceId,
      artifactId: evidence.artifactId,
      sourceKind: evidence.sourceKind,
      collectorId: evidence.collectorId,
      basis: evidence.basis,
      coordinate: evidence.coordinate,
      evidenceIds: [evidence.evidenceId],
    });
    nodes.push(node);
    evidenceNodes.set(evidence.evidenceId, node);
    const artifactNode = artifactNodes.get(evidence.artifactId);
    if (!artifactNode) throw new Error(`missing artifact node for ${evidence.artifactId}`);
    edges.push(
      graphEdge({
        kind: "contains_evidence",
        from: artifactNode.nodeId,
        to: node.nodeId,
        evidenceIds: [evidence.evidenceId],
      }),
    );
  }
  for (const observation of snapshot.observations) {
    const node = graphNode({
      kind: "observation",
      observationId: observation.observationId,
      collectorId: observation.collectorId,
      coordinate: observation.coordinate,
      invocation: observation.invocation,
      evidenceIds: uniqueSorted(observation.evidenceIds),
    });
    nodes.push(node);
    observationNodes.set(observation.observationId, node);
    for (const evidenceId of observation.evidenceIds) {
      const evidenceNode = evidenceNodes.get(evidenceId);
      if (!evidenceNode) throw new Error(`missing evidence node for ${evidenceId}`);
      edges.push(
        graphEdge({
          kind: "supports_observation",
          from: evidenceNode.nodeId,
          to: node.nodeId,
          evidenceIds: [evidenceId],
        }),
      );
    }
  }

  for (const candidate of candidates) {
    const candidateEvidence = uniqueSorted(candidate.evidenceIds);
    const deploymentNode = graphNode({
      kind: "deployment",
      coordinate: candidate.coordinate,
      evidenceIds: candidateEvidence,
    });
    const componentNode = graphNode({
      kind: "component",
      coordinate: candidate.coordinate,
      evidenceIds: candidateEvidence,
    });
    const capabilityNode = graphNode({
      kind: "capability",
      candidateId: candidate.candidateId,
      occurrenceId: legacyOccurrenceId(candidate),
      logicalCapabilityId: legacyLogicalCapabilityId(snapshot.estate, candidate),
      coordinate: candidate.coordinate,
      invocation: candidate.invocation,
      businessSemantics: candidate.businessSemantics,
      disposition: candidate.disposition,
      evidenceIds: candidateEvidence,
    });
    nodes.push(deploymentNode, componentNode, capabilityNode);
    edges.push(
      graphEdge({
        kind: "occurs_in_deployment",
        from: capabilityNode.nodeId,
        to: deploymentNode.nodeId,
        evidenceIds: candidateEvidence,
      }),
      graphEdge({
        kind: "contains_component",
        from: deploymentNode.nodeId,
        to: componentNode.nodeId,
        evidenceIds: candidateEvidence,
      }),
      graphEdge({
        kind: "exposes_capability",
        from: componentNode.nodeId,
        to: capabilityNode.nodeId,
        evidenceIds: candidateEvidence,
      }),
    );
    for (const observationId of candidate.observationIds) {
      const observationNode = observationNodes.get(observationId);
      if (!observationNode) throw new Error(`missing observation node for ${observationId}`);
      const sharedEvidence = observationNode.evidenceIds.filter((id) =>
        candidate.evidenceIds.includes(id),
      );
      edges.push(
        graphEdge({
          kind: "contributes_to_capability",
          from: observationNode.nodeId,
          to: capabilityNode.nodeId,
          evidenceIds: sharedEvidence,
        }),
      );
    }
    for (const claim of candidate.claims) {
      for (const assertion of claim.assertions) {
        const assertionEvidence = uniqueSorted(
          assertion.evidence.map((record) => record.evidenceId),
        );
        const claimNode = graphNode({
          kind: "claim",
          candidateId: candidate.candidateId,
          dimension: claim.dimension,
          value: assertion.value,
          bases: [...assertion.bases].sort(),
          conflicting: claim.state === "conflicting",
          evidenceIds: assertionEvidence,
        });
        nodes.push(claimNode);
        edges.push(
          graphEdge({
            kind: "supports_claim",
            from: capabilityNode.nodeId,
            to: claimNode.nodeId,
            evidenceIds: assertionEvidence,
          }),
        );
      }
    }
  }

  const core: z.infer<typeof GraphCore> = {
    schemaVersion: 1,
    inventoryId: snapshot.inventoryId,
    inventoryContentHash: snapshot.contentHash,
    nodes: [...new Map(nodes.map((node) => [node.nodeId, node])).values()].sort((left, right) =>
      left.nodeId.localeCompare(right.nodeId),
    ),
    edges: [...new Map(edges.map((edge) => [edge.edgeId, edge])).values()].sort((left, right) =>
      left.edgeId.localeCompare(right.edgeId),
    ),
  };
  return LegacyEvidenceGraph.parse({ ...core, ...graphAddress(core) });
}
