import { describe, expect, it } from "vitest";
import {
  createLegacyArtifact,
  createLegacyEvidence,
  createLegacyObservation,
  finalizeLegacyInventory,
  type LegacyInventorySnapshot,
  reconcileLegacyInventory,
} from "../core/index.js";
import {
  finalizeLegacyRefinementTask,
  LegacyCapabilityBinding,
  LegacyRefinementProposal,
  type LegacyRefinementSubmission,
  LegacyRefinementTask,
  LegacyReviewReceipt,
} from "./model.js";
import {
  assessLegacyRefinementProposal,
  createLegacyRefinementProposal,
  createLegacyRefinementTask,
  createLegacyReviewReceipt,
  createReviewedLegacyCapabilityBinding,
} from "./workflow.js";

const DIGEST_A = `sha256:${"a".repeat(64)}` as const;
const DIGEST_B = `sha256:${"b".repeat(64)}` as const;
const DIGEST_C = `sha256:${"c".repeat(64)}` as const;

function inventory(): LegacyInventorySnapshot {
  const artifact = createLegacyArtifact({
    schemaVersion: 1,
    digest: DIGEST_A,
    bytes: 100,
    mediaType: "text/plain",
    role: "broker_export",
    path: "prod/refunds.mqsc",
    source: { kind: "broker_configuration", systemId: "mq-prod", revision: "42" },
  });
  const evidenceV1 = createLegacyEvidence({
    schemaVersion: 1,
    artifactId: artifact.artifactId,
    sourceKind: "broker_configuration",
    collectorId: "messaging",
    basis: "configured",
    coordinate: { path: artifact.path, pointer: "line:1" },
  });
  const evidenceV2 = createLegacyEvidence({
    schemaVersion: 1,
    artifactId: artifact.artifactId,
    sourceKind: "broker_configuration",
    collectorId: "messaging",
    basis: "configured",
    coordinate: { path: artifact.path, pointer: "line:2" },
  });
  const coordinate = {
    environment: "prod",
    platform: "ibm_mq",
    application: "refund-service",
    module: "refund-service",
    component: "refund-requests",
    deploymentDigest: DIGEST_B,
  } as const;
  const invocation = {
    kind: "message",
    protocol: "ibm_mq",
    destination: "refund.requests",
    direction: "request_reply",
  } as const;
  const observationV1 = createLegacyObservation({
    schemaVersion: 1,
    collectorId: "messaging",
    coordinate,
    invocation,
    claims: [
      {
        dimension: "binding_target",
        value: "PAY.REFUND.V1",
        basis: "configured",
        evidenceIds: [evidenceV1.evidenceId],
      },
    ],
    evidenceIds: [evidenceV1.evidenceId],
  });
  const observationV2 = createLegacyObservation({
    schemaVersion: 1,
    collectorId: "messaging",
    coordinate,
    invocation,
    claims: [
      {
        dimension: "binding_target",
        value: "PAY.REFUND.V2",
        basis: "configured",
        evidenceIds: [evidenceV2.evidenceId],
      },
    ],
    evidenceIds: [evidenceV2.evidenceId],
  });
  return finalizeLegacyInventory({
    schemaVersion: 1,
    estate: { id: "payments" },
    artifacts: [artifact],
    evidence: [evidenceV1, evidenceV2],
    observations: [observationV1, observationV2],
    diagnostics: [],
  });
}

function validSubmission(
  task: ReturnType<typeof createLegacyRefinementTask>,
): LegacyRefinementSubmission {
  const selected = task.candidate.claims
    .find((claim) => claim.dimension === "binding_target")
    ?.assertions.find((assertion) => assertion.value === "PAY.REFUND.V2");
  const selectedEvidenceId = selected?.evidence[0]?.evidenceId;
  if (!selectedEvidenceId) throw new Error("missing test evidence");
  const semanticClaims = [
    "business_operation",
    "business_effect",
    "input_schema",
    "output_schema",
    "error_semantics",
    "completion_semantics",
    "authorization",
    "idempotency",
    "retry_policy",
  ] as const;
  return {
    schemaVersion: 1,
    taskId: task.taskId,
    taskHash: task.taskHash,
    status: "proposal_generated",
    executor: { name: "codex", model: "gpt-5" },
    summary:
      "MQ configuration and the reviewed service contract define a request/reply refund operation.",
    evidence: [
      { kind: "inventory", refId: "queue-v2", evidenceId: selectedEvidenceId },
      {
        kind: "repository",
        refId: "refund-contract",
        repository: "payments/refunds",
        revision: "0123456789abcdef",
        path: "src/refunds/contract.ts",
        startLine: 10,
        endLine: 80,
        blobDigest: DIGEST_B,
        excerptDigest: DIGEST_C,
      },
    ],
    claimEvidence: [
      ...semanticClaims.map((claim) => ({ claim, evidenceRefIds: ["refund-contract"] })),
      { claim: "transport_target", evidenceRefIds: ["queue-v2"] },
      { claim: "interaction_pattern", evidenceRefIds: ["queue-v2"] },
    ],
    resolutions: [
      {
        dimension: "binding_target",
        selectedValue: "PAY.REFUND.V2",
        evidenceRefIds: ["queue-v2"],
        reason: "The deployment ticket confirms V2 is the active production queue.",
      },
    ],
    operation: {
      name: "refunds.submit",
      summary: "Submit a refund",
      description: "Submit one reviewed refund request and return its completed business result.",
      effect: "create",
      exposure: "mcp_tool",
      inputSchema: {
        type: "object",
        properties: {
          order_id: { type: "string" },
          amount_minor_units: { type: "integer", minimum: 1 },
          reason: { type: "string" },
        },
        required: ["order_id", "amount_minor_units", "reason"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          refund_id: { type: "string" },
          outcome: { type: "string", enum: ["completed", "rejected"] },
        },
        required: ["refund_id", "outcome"],
        additionalProperties: false,
      },
      errors: [
        {
          code: "REFUND_REJECTED",
          meaning: "The refund was rejected by the refund service.",
          retryable: false,
          recovery: "Correct the refund request or escalate to the refunds team.",
        },
      ],
    },
    transport: {
      kind: "message",
      protocol: "ibm_mq",
      target: "PAY.REFUND.V2",
      direction: "request_reply",
      payloadEncoding: "json",
      reply: {
        mode: "fixed_destination",
        target: "PAY.REFUND.REPLY",
        correlationField: "correlation_id",
      },
    },
    semantics: {
      completion: "business_completed",
      timeoutMs: 30_000,
      authorization: { mode: "service_account", scopes: ["refunds.submit"] },
      idempotency: { mode: "client_key", carrier: "message.properties.idempotency_key" },
      retry: { mode: "safe_transient", maxAttempts: 3 },
    },
  };
}

function context() {
  const snapshot = inventory();
  const candidate = reconcileLegacyInventory(snapshot)[0];
  if (!candidate) throw new Error("missing candidate");
  const task = createLegacyRefinementTask(snapshot, candidate.candidateId);
  const submission = validSubmission(task);
  const proposal = createLegacyRefinementProposal(task, submission);
  return { snapshot, task, submission, proposal };
}

describe("legacy capability refinement", () => {
  it("creates deterministic tasks and an approved, runtime-honest binding", () => {
    const { snapshot, task, proposal } = context();
    expect(createLegacyRefinementTask(snapshot, task.candidateId)).toEqual(task);
    expect(task.requiredDecisions).toContainEqual(
      expect.objectContaining({ kind: "conflict_resolution", dimension: "binding_target" }),
    );
    const assessment = assessLegacyRefinementProposal(snapshot, task, proposal);
    expect(assessment).toMatchObject({ ok: true, issues: [] });

    const receipt = createLegacyReviewReceipt(snapshot, task, proposal, {
      decision: "approved",
      reviewer: "refund-owner@example.com",
      reason: "Validated against the deployment ticket and service contract.",
    });
    const binding = createReviewedLegacyCapabilityBinding(snapshot, task, proposal, receipt);
    expect(binding.operation.name).toBe("refunds.submit");
    expect(binding.transport).toMatchObject({ target: "PAY.REFUND.V2" });
    expect(binding.runtime).toEqual({
      placement: "deployment_local_bridge",
      status: "not_implemented",
    });
  });

  it("rejects tampered content-addressed task, proposal, receipt, and binding records", () => {
    const { snapshot, task, proposal } = context();
    expect(() =>
      LegacyRefinementTask.parse({ ...task, candidateId: `lc_${"f".repeat(64)}` }),
    ).toThrow();
    expect(() =>
      LegacyRefinementProposal.parse({ ...proposal, inventoryId: `li_${"f".repeat(64)}` }),
    ).toThrow();
    const receipt = createLegacyReviewReceipt(snapshot, task, proposal, {
      decision: "approved",
      reviewer: "owner@example.com",
      reason: "Reviewed.",
    });
    expect(() => LegacyReviewReceipt.parse({ ...receipt, decision: "rejected" })).toThrow();
    const binding = createReviewedLegacyCapabilityBinding(snapshot, task, proposal, receipt);
    expect(() =>
      LegacyCapabilityBinding.parse({
        ...binding,
        runtime: { ...binding.runtime, status: "ready" },
      }),
    ).toThrow();
  });

  it("does not allow the harness or evidence rank to resolve a conflict silently", () => {
    const { snapshot, task, submission } = context();
    const unresolved = { ...submission, resolutions: [] } as LegacyRefinementSubmission;
    const proposal = createLegacyRefinementProposal(task, unresolved);
    const assessment = assessLegacyRefinementProposal(snapshot, task, proposal);
    expect(assessment.issues.map((issue) => issue.code)).toContain(
      "legacy/refinement/unresolved_conflict",
    );
    expect(() =>
      createLegacyReviewReceipt(snapshot, task, proposal, {
        decision: "approved",
        reviewer: "owner@example.com",
        reason: "Approve anyway.",
      }),
    ).toThrow(/cannot be approved/);
  });

  it("rejects a freshly rehashed task that removes Anvil's required decisions", () => {
    const { snapshot, task } = context();
    const forged = finalizeLegacyRefinementTask({
      schemaVersion: 1,
      inventoryId: task.inventoryId,
      inventoryContentHash: task.inventoryContentHash,
      candidateId: task.candidateId,
      candidateHash: task.candidateHash,
      candidate: task.candidate,
      requiredDecisions: task.requiredDecisions.filter(
        (decision) => decision.kind === "business_operation",
      ),
      policy: task.policy,
    });
    const proposal = createLegacyRefinementProposal(forged, validSubmission(forged));
    expect(
      assessLegacyRefinementProposal(snapshot, forged, proposal).issues.map((issue) => issue.code),
    ).toContain("legacy/refinement/noncanonical_task");
  });

  it("rejects invented targets and conflict resolutions without captured support", () => {
    const { snapshot, task, submission } = context();
    if (submission.status !== "proposal_generated") throw new Error("expected proposal");
    const invented = {
      ...submission,
      transport: { ...submission.transport, target: "PAY.REFUND.V3" },
      resolutions: [
        {
          ...submission.resolutions[0],
          selectedValue: "PAY.REFUND.V3",
          evidenceRefIds: ["refund-contract"],
        },
      ],
    } as LegacyRefinementSubmission;
    const proposal = createLegacyRefinementProposal(task, invented);
    expect(
      assessLegacyRefinementProposal(snapshot, task, proposal).issues.map((issue) => issue.code),
    ).toEqual(
      expect.arrayContaining([
        "legacy/refinement/invented_conflict_value",
        "legacy/refinement/invented_transport_target",
      ]),
    );
  });

  it("requires explicit completion, authorization, and idempotency semantics", () => {
    const { snapshot, task, submission } = context();
    if (submission.status !== "proposal_generated") throw new Error("expected proposal");
    const unsafe = {
      ...submission,
      semantics: {
        ...submission.semantics,
        completion: "unknown",
        authorization: { mode: "unknown", scopes: [] },
        idempotency: { mode: "unknown" },
      },
    } as LegacyRefinementSubmission;
    const proposal = createLegacyRefinementProposal(task, unsafe);
    expect(
      assessLegacyRefinementProposal(snapshot, task, proposal).issues.map((issue) => issue.code),
    ).toEqual(
      expect.arrayContaining([
        "legacy/refinement/unknown_completion_semantics",
        "legacy/refinement/unknown_authorization",
        "legacy/refinement/unknown_idempotency",
        "legacy/refinement/unsafe_retry_policy",
      ]),
    );
  });

  it("rejects generic middleware tools, weak fields, and UI button state", () => {
    const { snapshot, task, submission } = context();
    if (submission.status !== "proposal_generated") throw new Error("expected proposal");
    const generic = {
      ...submission,
      operation: {
        ...submission.operation,
        name: "queue.put_message",
        inputSchema: {
          type: "object",
          properties: {
            request: { type: "object", properties: { val: { type: "string" } } },
          },
        },
        outputSchema: { type: "object", properties: { showButton: { type: "boolean" } } },
      },
    } as LegacyRefinementSubmission;
    const proposal = createLegacyRefinementProposal(task, generic);
    expect(
      assessLegacyRefinementProposal(snapshot, task, proposal).issues.map((issue) => issue.code),
    ).toEqual(
      expect.arrayContaining([
        "legacy/refinement/generic_middleware_operation",
        "legacy/refinement/weak_field_name",
        "legacy/refinement/ui_projection_exposed",
      ]),
    );
  });

  it("requires bounded pagination and prevents transport acknowledgement from claiming completion", () => {
    const { snapshot, task, submission } = context();
    if (submission.status !== "proposal_generated") throw new Error("expected proposal");
    const overstated = {
      ...submission,
      operation: {
        ...submission.operation,
        description: "The refund is completed after the queue accepts the request.",
        effect: "read",
        inputSchema: { type: "string" },
        pagination: {
          mode: "cursor",
          requestField: "cursor",
          responseItemsPath: "$.items",
        },
      },
      semantics: { ...submission.semantics, completion: "transport_accepted" },
    } as LegacyRefinementSubmission;
    const proposal = createLegacyRefinementProposal(task, overstated);
    expect(
      assessLegacyRefinementProposal(snapshot, task, proposal).issues.map((issue) => issue.code),
    ).toEqual(
      expect.arrayContaining([
        "legacy/refinement/completion_overclaim",
        "legacy/refinement/incomplete_pagination",
        "legacy/refinement/non_object_agent_schema",
        "legacy/refinement/unbounded_pagination",
      ]),
    );
  });

  it("keeps rejection auditable without producing an executable binding", () => {
    const { snapshot, task, proposal } = context();
    const receipt = createLegacyReviewReceipt(snapshot, task, proposal, {
      decision: "rejected",
      reviewer: "refund-owner@example.com",
      reason: "The production queue owner has not confirmed this mapping.",
    });
    expect(receipt.decision).toBe("rejected");
    expect(() => createReviewedLegacyCapabilityBinding(snapshot, task, proposal, receipt)).toThrow(
      /not approved/,
    );
  });

  it("records honest harness declines and refuses to approve them", () => {
    const { snapshot, task } = context();
    const proposal = createLegacyRefinementProposal(task, {
      schemaVersion: 1,
      taskId: task.taskId,
      taskHash: task.taskHash,
      status: "declined",
      executor: { name: "codex" },
      reason: "insufficient_evidence",
      summary: "No source contract establishes the business meaning of this queue.",
    });
    expect(assessLegacyRefinementProposal(snapshot, task, proposal).issues[0]?.code).toBe(
      "legacy/refinement/proposal_declined",
    );
    expect(() =>
      createLegacyReviewReceipt(snapshot, task, proposal, {
        decision: "approved",
        reviewer: "owner@example.com",
        reason: "Approve.",
      }),
    ).toThrow(/cannot be approved/);
  });
});
