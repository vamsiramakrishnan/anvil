import {
  finalizeLegacyCapabilityBindingRecord,
  type LegacyCapabilityBinding,
} from "@anvil/compiler/legacy";

/**
 * A reviewed binding fixture for this package's own tests — built with
 * `finalizeLegacyCapabilityBindingRecord` directly, the same shortcut
 * `packages/compiler/src/legacy/bridge/plan.test.ts` takes for the same
 * reason: this package's tests exist to prove the bridge and facade, not to
 * re-derive the refinement pipeline. The full inventory → refine → approve →
 * bridge → conformance path is exercised once, for real, in `e2e.test.ts`.
 */
export function fixtureLegacyCapabilityBinding(
  overrides: Partial<{ timeoutMs: number }> = {},
): LegacyCapabilityBinding {
  return finalizeLegacyCapabilityBindingRecord({
    schemaVersion: 1,
    inventoryId: `li_${"1".repeat(64)}`,
    inventoryContentHash: `sha256:${"2".repeat(64)}`,
    candidateId: `lc_${"3".repeat(64)}`,
    candidateHash: `sha256:${"4".repeat(64)}`,
    taskId: `lrt_${"5".repeat(64)}`,
    taskHash: `sha256:${"6".repeat(64)}`,
    proposalId: `lrp_${"7".repeat(64)}`,
    proposalHash: `sha256:${"8".repeat(64)}`,
    receiptId: `lrr_${"9".repeat(64)}`,
    receiptHash: `sha256:${"a".repeat(64)}`,
    operation: {
      name: "refunds.submit_refund",
      summary: "Submit a refund",
      description: "Submits one reviewed refund request.",
      effect: "create",
      exposure: "mcp_tool",
      inputSchema: { type: "object", properties: { refundId: { type: "string" } } },
      outputSchema: { type: "object", properties: { accepted: { type: "boolean" } } },
      errors: [
        { code: "REFUND_REJECTED", meaning: "Rejected", retryable: false, recovery: "Review it" },
      ],
    },
    transport: {
      kind: "message",
      protocol: "jms",
      target: "jms/RefundRequests",
      direction: "request_reply",
      payloadEncoding: "json",
      reply: { mode: "reply_to", correlationField: "JMSCorrelationID" },
    },
    semantics: {
      completion: "application_accepted",
      timeoutMs: overrides.timeoutMs ?? 200,
      authorization: { mode: "bridge_identity", scopes: [] },
      idempotency: { mode: "client_key", carrier: "refundId" },
      retry: { mode: "safe_transient", maxAttempts: 3 },
    },
    runtime: { placement: "deployment_local_bridge", status: "not_implemented" },
  });
}
