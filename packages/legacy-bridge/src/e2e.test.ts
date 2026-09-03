import {
  assessLegacyRefinementProposal,
  collectLegacyInventory,
  createLegacyRefinementProposal,
  createLegacyRefinementTask,
  createLegacyReviewReceipt,
  createReviewedLegacyCapabilityBinding,
  planLegacyBridge,
} from "@anvil/compiler/legacy";
import { describe, expect, it } from "vitest";
import { runLegacyBridgeConformance } from "./conformance.js";

/**
 * One approved messaging capability, end to end: an offline AsyncAPI export
 * → inventory → refinement task/proposal/receipt → reviewed binding, whose
 * runtime status starts `not_implemented` exactly as
 * `skills/anvil/reference/legacy-estates.md` documents → a bridge plan →
 * conformance against an in-process broker double → a binding promoted to
 * `conformance_passed`.
 *
 * The AsyncAPI 3 request/reply shape (a `send` operation naming a `reply`
 * channel) is the same one
 * `packages/compiler/src/legacy/collectors/messaging/messaging.test.ts`
 * already proves the collector reads correctly; reused here rather than
 * invented so this test's evidence is exactly what the messaging collector
 * is independently tested against.
 */
const ASYNCAPI_REQUEST_REPLY = `asyncapi: 3.0.0
info:
  title: Payments socket
  version: 1.0.0
channels:
  refundCommands:
    address: PAY.REFUND.REQUEST
    messages:
      RefundCommand:
        $ref: '#/components/messages/RefundCommand'
  refundReplies:
    address: PAY.REFUND.REPLY
    messages:
      RefundReply:
        $ref: '#/components/messages/RefundReply'
operations:
  submitRefund:
    action: send
    channel:
      $ref: '#/channels/refundCommands'
    messages:
      - $ref: '#/components/messages/RefundCommand'
    reply:
      channel:
        $ref: '#/channels/refundReplies'
      messages:
        - $ref: '#/components/messages/RefundReply'
components:
  messages:
    RefundCommand:
      messageId: refund-command
      contentType: application/json
      correlationId:
        location: '$message.header#/correlationId'
      payload:
        type: object
        properties:
          refundId:
            type: string
    RefundReply:
      payload:
        type: object
        properties:
          accepted:
            type: boolean
`;

describe("legacy bridge, end to end: inventory to conformance", () => {
  it("takes one reviewed messaging candidate from offline evidence to a conformance-passed binding", async () => {
    // 1. Inventory — offline evidence only, no estate ever contacted.
    const { snapshot, candidates } = collectLegacyInventory({
      estate: { id: "payments-estate" },
      environment: "prod",
      application: "payments",
      source: { kind: "deployed_configuration", systemId: "payments-estate:prod" },
      collector: "messaging",
      members: [
        {
          path: "contracts/asyncapi-refunds.yaml",
          bytes: new TextEncoder().encode(ASYNCAPI_REQUEST_REPLY),
        },
      ],
    });
    expect(snapshot.diagnostics.filter((d) => d.level === "error")).toEqual([]);

    // The operation observation is the only one whose invocation direction the
    // normalizer derives as `request_reply` (it alone carries a reply
    // channel) — the two plain channel observations stay `unknown`/`publish`.
    const candidate = candidates.find(
      (item) => item.invocation.kind === "message" && item.invocation.direction === "request_reply",
    );
    if (!candidate) throw new Error("expected one request/reply candidate from the fixture");
    expect(candidate.conflicts).toEqual([]);

    // The physical binding target ("PAY.REFUND.REQUEST") is a captured
    // assertion, distinct from the AsyncAPI channel's logical key
    // ("refundCommands") — reading it out rather than reusing the logical
    // key is what `assessTransport`'s `invented_transport_target` check
    // exists to force.
    const targetAssertion = candidate.claims
      .find((claim) => claim.dimension === "binding_target")
      ?.assertions.find((assertion) => assertion.value === "PAY.REFUND.REQUEST");
    if (!targetAssertion) throw new Error("expected a captured binding_target assertion");

    // 2. Refine — a task naming every required decision, then an untrusted
    // proposal that resolves each of them from captured evidence only.
    const task = createLegacyRefinementTask(snapshot, candidate.candidateId);
    const evidenceRefs = candidate.evidenceIds.map((evidenceId, index) => ({
      kind: "inventory" as const,
      refId: `ev${index}`,
      evidenceId,
    }));
    const claimEvidence = task.requiredDecisions
      .filter((decision) => decision.kind !== "conflict_resolution")
      .map((decision) => ({
        claim: decision.kind,
        evidenceRefIds: evidenceRefs.map((ref) => ref.refId),
      }));
    const proposal = createLegacyRefinementProposal(task, {
      schemaVersion: 1,
      taskId: task.taskId,
      taskHash: task.taskHash,
      status: "proposal_generated",
      executor: { name: "lane-e-e2e-fixture" },
      summary: "Bridge the reviewed refund request/reply exchange.",
      evidence: evidenceRefs,
      claimEvidence,
      resolutions: [],
      operation: {
        name: "refunds.submit_refund",
        summary: "Submit a refund",
        description: "Submits a reviewed refund request over the payments queue.",
        effect: "create",
        exposure: "mcp_tool",
        inputSchema: { type: "object", properties: { refundId: { type: "string" } } },
        outputSchema: { type: "object", properties: { accepted: { type: "boolean" } } },
        errors: [
          {
            code: "REFUND_REJECTED",
            meaning: "Rejected by the payments estate",
            retryable: false,
            recovery: "Review the refund and resubmit if appropriate.",
          },
        ],
      },
      transport: {
        kind: "message",
        protocol: "other",
        target: "PAY.REFUND.REQUEST",
        direction: "request_reply",
        payloadEncoding: "json",
        reply: { mode: "reply_to", correlationField: "correlationId" },
      },
      semantics: {
        completion: "application_accepted",
        timeoutMs: 200,
        authorization: { mode: "bridge_identity", scopes: [] },
        idempotency: { mode: "client_key", carrier: "refundId" },
        retry: { mode: "safe_transient", maxAttempts: 3 },
      },
    });

    const assessment = assessLegacyRefinementProposal(snapshot, task, proposal);
    expect(assessment.issues).toEqual([]);
    expect(assessment.ok).toBe(true);

    // 3. Approve — a separate, explicit human decision.
    const receipt = createLegacyReviewReceipt(snapshot, task, proposal, {
      decision: "approved",
      reviewer: "lane-e-reviewer",
      reason: "Reviewed refund request/reply exchange matches captured AsyncAPI evidence.",
    });
    const binding = createReviewedLegacyCapabilityBinding(snapshot, task, proposal, receipt);
    expect(binding.runtime).toEqual({
      placement: "deployment_local_bridge",
      status: "not_implemented",
    });

    // 4. Plan the bridge contract.
    const plan = planLegacyBridge(binding);
    expect(plan.executionAllowed).toBe(false);
    expect(plan.bindingId).toBe(binding.bindingId);

    // 5. Serve the bridge and run conformance against an in-process broker
    // double — never a real broker.
    const { report, promotedBinding } = await runLegacyBridgeConformance(binding, plan);
    expect(report.checks.filter((check) => check.status === "fail")).toEqual([]);

    // Status moves from not_implemented to conformance_passed on the binding.
    expect(promotedBinding).toBeDefined();
    expect(promotedBinding?.runtime.status).toBe("conformance_passed");
    if (promotedBinding?.runtime.status === "conformance_passed") {
      expect(promotedBinding.runtime.conformanceReportHash).toBe(report.contentHash);
    }
    // The full reviewed lineage survives promotion unchanged.
    expect(promotedBinding?.inventoryId).toBe(snapshot.inventoryId);
    expect(promotedBinding?.candidateId).toBe(candidate.candidateId);
    expect(promotedBinding?.proposalId).toBe(proposal.proposalId);
    expect(promotedBinding?.receiptId).toBe(receipt.receiptId);
  });
});
