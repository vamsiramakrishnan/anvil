import { describe, expect, it } from "vitest";
import {
  finalizeLegacyCapabilityBindingRecord,
  type LegacyCapabilityBinding,
} from "../refinement/model.js";
import {
  assessLegacyBridgeDriver,
  type LegacyBridgeDriverDescriptor,
  planLegacyBridge,
} from "./index.js";

function addressedBinding(): LegacyCapabilityBinding {
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
        {
          code: "REFUND_REJECTED",
          meaning: "Rejected",
          retryable: false,
          recovery: "Review it",
        },
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
      timeoutMs: 30_000,
      authorization: { mode: "bridge_identity", scopes: [] },
      idempotency: { mode: "client_key", carrier: "refundId" },
      retry: { mode: "safe_transient", maxAttempts: 3 },
    },
    runtime: { placement: "deployment_local_bridge", status: "not_implemented" },
  });
}

describe("legacy bridge planning", () => {
  it("requires runtime, safety and request/reply capabilities", () => {
    const first = planLegacyBridge(addressedBinding());
    const second = planLegacyBridge(addressedBinding());

    expect(second).toEqual(first);
    expect(first.executionAllowed).toBe(false);
    expect(first.requiredCapabilities).toEqual(
      expect.arrayContaining([
        "reply_correlation",
        "idempotency_enforcement",
        "bounded_retry",
        "recorded_conformance",
      ]),
    );
    expect(first.unverifiedLiveFacts).toContain("target_exists");
    expect(first.conformance.map((test) => test.id)).toContain("legacy-bridge/reply_correlation");
  });

  it("rejects drivers missing required capabilities", () => {
    const descriptor: LegacyBridgeDriverDescriptor = {
      schemaVersion: 1,
      id: "thin-jms",
      version: "1.0.0",
      transports: [{ kind: "message", protocols: ["jms"] }],
      capabilities: ["transport_client"],
      deterministicGeneration: true,
      liveDiscovery: false,
      acceptsSecrets: false,
    };
    const assessment = assessLegacyBridgeDriver(planLegacyBridge(addressedBinding()), descriptor);
    expect(assessment.supported).toBe(false);
    expect(assessment.missingCapabilities).toContain("authorization");
    expect(assessment.reasons).toContain("Driver 'thin-jms' is missing 'authorization'.");
  });
});
