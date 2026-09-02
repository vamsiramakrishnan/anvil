import type { ConsoleResponse } from "../../contract.js";

/**
 * The report-shaped half of the contract mock's fixtures: the benchmark's
 * confusion analysis, drift against a second bundle, and a contract-valid
 * harness task. Split from `fixtures.ts` (which holds the estate — operations,
 * capabilities, workflows, packs) so neither file crosses the module-size
 * ratchet; both are typed as the contract's own response types.
 */

export const HEX64 = "3f1a9c7d2b8e4f60a1c5d9e7b3a2f4c6d8e0b1a3c5d7e9f1a3b5c7d9e1f3a5b7";
const HEX64_B = "9b7e5c3a1f0d2e4c6a8b0d2f4e6c8a0b2d4f6e8c0a2b4d6f8e0c2a4b6d8f0e2c";

export function paymentsBenchmark(): ConsoleResponse<"benchmark"> {
  return {
    router: "lexical",
    catalogSize: 9,
    bundleHash: HEX64_B,
    fresh: true,
    summary: {
      total: 27,
      passed: 21,
      score: 0.78,
      curatedRouted: 21,
      bareRouted: 14,
      upliftPts: 25.9,
    },
    confusion: {
      posture: "candidate",
      minClusterEvidence: 2,
      hubPartnerFraction: 0.5,
      hubMinPartners: 2,
      hubs: [
        {
          operationId: "getPayment",
          toolName: "payments_get",
          distinctPartners: 3,
          taskCount: 5,
          intents: ["show me the payment for order 8813", "what did the customer pay last week"],
        },
      ],
      clusters: [
        {
          id: "cluster_payment_lookup",
          members: [
            { operationId: "getPayment", toolName: "payments_get" },
            { operationId: "listPayments", toolName: "payments_list" },
            { operationId: "searchPayments", toolName: "payments_search" },
          ],
          taskCount: 9,
          edges: [
            {
              intended: "searchPayments",
              routed: "getPayment",
              count: 3,
              intents: ["find the payment for order 8813", "which payment matches invoice 77"],
              sharedTokens: ["payment", "find"],
            },
            {
              intended: "listPayments",
              routed: "getPayment",
              count: 2,
              intents: ["what did the customer pay last week"],
              sharedTokens: ["payment"],
            },
          ],
          sharedTokens: ["payment"],
        },
        {
          id: "cluster_money_moves",
          members: [
            { operationId: "createRefund", toolName: "refunds_create" },
            { operationId: "capturePayment", toolName: "payments_capture" },
          ],
          taskCount: 6,
          edges: [
            {
              intended: "createRefund",
              routed: "capturePayment",
              count: 1,
              intents: ["give the money back for the cancelled order"],
              sharedTokens: ["money"],
            },
          ],
          sharedTokens: ["money", "amount"],
        },
      ],
    },
  };
}

export function paymentsDrift(): Record<string, ConsoleResponse<"drift">> {
  return {
    "payments-next": {
      bundleId: "payments",
      against: "payments-next",
      items: [
        {
          id: "drift_01",
          kind: "idempotency_changed",
          severity: "high",
          operationId: "createRefund",
          coordinate: "operations.createRefund.idempotency.mode",
          message: "idempotency mode changed from required to key_supported",
          facts: { before: "required", after: "key_supported" },
          affectedCapabilityIds: ["refunds"],
        },
        {
          id: "drift_02",
          kind: "docs_changed",
          severity: "info",
          operationId: "getPayment",
          coordinate: "operations.getPayment.description",
          message: "description changed",
          facts: {},
          affectedCapabilityIds: ["refunds", "payments"],
        },
      ],
    },
  };
}

/** A contract-valid harness task, for the export-task mock. */
export function fixtureTask(clusterId: string): ConsoleResponse<"exportTask">["task"] {
  return {
    schemaVersion: 1,
    taskId: "rt_0123456789abcdef01234567",
    taskHash: HEX64,
    service: { id: "payments", version: "2026-06" },
    sourceContractHash: HEX64_B,
    repository: {
      revision: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      inspectScopes: ["src/payments"],
    },
    skill: { name: "group-proposal", version: 1, contractHash: HEX64 },
    deficiency: {
      code: "missing_operation_description",
      severity: "medium",
      target: { kind: "group", groupId: clusterId },
      message: `intents are mis-routed between the members of ${clusterId}`,
      facts: { clusterId },
    },
    context: { clusterId },
    policy: {
      allowedSources: ["spec", "source_impl"],
      minimumStrength: "corroborated",
      writablePredicates: [],
      supportingPredicates: [],
      writableFields: ["description"],
      constraints: ["do_not_loosen_safety"],
      mustNot: ["invent an operation the service does not expose"],
      minimumVerification: "verified",
    },
    procedure: {
      skill: "group-proposal",
      question: "which composite tool would route these intents unambiguously?",
      searchHints: ["payment", "lookup"],
      steps: [{ phase: "research", instruction: "read the members' handlers" }],
    },
    mustNot: ["invent an operation the service does not expose"],
    expectedSubmission: {},
  };
}
