import { describe, expect, it } from "vitest";
import {
  finalizeLegacyCapabilityBindingRecord,
  LegacyCapabilityBinding,
  type LegacyCapabilityBinding as LegacyCapabilityBindingType,
  promoteLegacyCapabilityBindingToConformancePassed,
} from "./model.js";

function notImplementedBinding(): LegacyCapabilityBindingType {
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
      errors: [],
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

describe("LegacyCapabilityBinding runtime status", () => {
  it("requires a conformanceReportHash on a conformance_passed record", () => {
    const binding = notImplementedBinding();
    const { bindingId: _bindingId, contentHash: _contentHash, ...core } = binding;
    expect(() =>
      LegacyCapabilityBinding.parse({
        ...core,
        // @ts-expect-error deliberately missing the required field
        runtime: { placement: "deployment_local_bridge", status: "conformance_passed" },
      }),
    ).toThrow();
  });
});

describe("promoteLegacyCapabilityBindingToConformancePassed", () => {
  it("re-addresses the binding with runtime.status advanced, lineage unchanged", () => {
    const binding = notImplementedBinding();
    const reportHash = `sha256:${"b".repeat(64)}` as const;
    const promoted = promoteLegacyCapabilityBindingToConformancePassed(binding, reportHash);

    expect(promoted.runtime).toEqual({
      placement: "deployment_local_bridge",
      status: "conformance_passed",
      conformanceReportHash: reportHash,
    });
    expect(promoted.bindingId).not.toBe(binding.bindingId);
    expect(promoted.contentHash).not.toBe(binding.contentHash);
    expect(promoted.operation).toEqual(binding.operation);
    expect(promoted.transport).toEqual(binding.transport);
    expect(promoted.semantics).toEqual(binding.semantics);
    expect(promoted.inventoryId).toBe(binding.inventoryId);
    expect(promoted.candidateId).toBe(binding.candidateId);
    expect(promoted.proposalId).toBe(binding.proposalId);
    expect(promoted.receiptId).toBe(binding.receiptId);
  });

  it("is deterministic — promoting the same binding to the same report hash twice yields identical addresses", () => {
    const binding = notImplementedBinding();
    const reportHash = `sha256:${"c".repeat(64)}` as const;
    const first = promoteLegacyCapabilityBindingToConformancePassed(binding, reportHash);
    const second = promoteLegacyCapabilityBindingToConformancePassed(binding, reportHash);
    expect(second).toEqual(first);
  });

  it("refuses to promote a binding that is not not_implemented — never a silent double promotion", () => {
    const binding = notImplementedBinding();
    const reportHash = `sha256:${"d".repeat(64)}` as const;
    const promoted = promoteLegacyCapabilityBindingToConformancePassed(binding, reportHash);
    expect(() =>
      promoteLegacyCapabilityBindingToConformancePassed(promoted, `sha256:${"e".repeat(64)}`),
    ).toThrow(/already 'conformance_passed'/);
  });
});
