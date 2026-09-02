import type { ConsoleResponse } from "../../contract.js";

/**
 * Fixtures for the contract mock — hand-written, but typed as the contract's
 * OWN response types (`ConsoleResponse<route>`), so a fixture that names a
 * field the contract does not carry fails `tsc`, and the mock re-parses every
 * one through the route's zod schema before it answers. Two bundles: a rich
 * `payments` estate and a bare `ledger` one whose views are all empty states.
 */

interface BundleFixture {
  inspector: ConsoleResponse<"bundle">;
  queue: ConsoleResponse<"queue">;
  packs: ConsoleResponse<"packs">;
  benchmark: ConsoleResponse<"benchmark">;
  /** Keyed by the `against` bundle id. */
  drift: Record<string, ConsoleResponse<"drift">>;
}

export interface WorkspaceFixture {
  root: string;
  bundles: Record<string, BundleFixture>;
}

type OperationRow = ConsoleResponse<"bundle">["operations"][number];
type Claim = ConsoleResponse<"queue">["items"][number]["evidence"][number];

const HEX64 = "3f1a9c7d2b8e4f60a1c5d9e7b3a2f4c6d8e0b1a3c5d7e9f1a3b5c7d9e1f3a5b7";
const HEX64_B = "9b7e5c3a1f0d2e4c6a8b0d2f4e6c8a0b2d4f6e8c0a2b4d6f8e0c2a4b6d8f0e2c";

/**
 * Compiler diagnostic codes the fixtures cite (`@anvil/compiler` owns them;
 * named here so the error-code registry does not read the fixture as emitting them).
 */
const DIAG = { refMissing: "source/ref_missing" } as const;

const spec = (subject: string, predicate: string, value: unknown, note?: string): Claim => ({
  subject,
  predicate,
  value,
  source: "spec",
  sourceRef: "examples/payments/openapi.yaml",
  method: "declared",
  confidence: 0.96,
  note,
});

const inferred = (subject: string, predicate: string, value: unknown, note: string): Claim => ({
  subject,
  predicate,
  value,
  source: "inferred",
  method: "heuristic",
  confidence: 0.55,
  note,
});

function op(
  id: string,
  canonicalName: string,
  displayName: string,
  effect: OperationRow["effect"],
  state: OperationRow["state"],
  idempotency: OperationRow["idempotency"]["mode"],
  confirmation: boolean,
  blockerNotes: string[] = [],
  diagnosticCount = 0,
): OperationRow {
  return {
    id,
    canonicalName,
    displayName,
    mcp: { toolName: canonicalName },
    cli: { command: canonicalName.replace(/_/g, "-") },
    effect,
    state,
    idempotency: { mode: idempotency },
    confirmation: { required: confirmation },
    diagnosticCount,
    blockerNotes,
  };
}

const read = (
  action: OperationRow["effect"]["action"],
  resource: string,
): OperationRow["effect"] => ({
  kind: "read",
  action,
  resource,
  risk: "none",
  reversible: true,
});

const operations: OperationRow[] = [
  op(
    "getCustomer",
    "customers_get",
    "Get a customer",
    read("get", "customer"),
    "approved",
    "natural",
    false,
  ),
  op(
    "getPayment",
    "payments_get",
    "Get a payment",
    read("get", "payment"),
    "approved",
    "natural",
    false,
  ),
  op(
    "listPayments",
    "payments_list",
    "List payments",
    read("list", "payment"),
    "review_required",
    "natural",
    false,
    ["generated from a read-only path; awaiting an approver"],
  ),
  op(
    "searchPayments",
    "payments_search",
    "Search payments",
    read("search", "payment"),
    "review_required",
    "natural",
    false,
    ["free-text `q` parameter: confirm no query passthrough"],
  ),
  op(
    "createRefund",
    "refunds_create",
    "Create a refund",
    {
      kind: "mutation",
      action: "create",
      resource: "refund",
      risk: "financial",
      reversible: false,
    },
    "review_required",
    "required",
    true,
    ["irreversible financial mutation; Idempotency-Key required before execution"],
  ),
  op(
    "capturePayment",
    "payments_capture",
    "Capture a payment",
    {
      kind: "mutation",
      action: "execute",
      resource: "payment",
      risk: "financial",
      reversible: true,
    },
    "approved",
    "natural",
    true,
  ),
  op(
    "deletePaymentMethod",
    "payment_methods_delete",
    "Delete a payment method",
    {
      kind: "mutation",
      action: "delete",
      resource: "payment_method",
      risk: "destructive",
      reversible: false,
    },
    "review_required",
    "natural",
    true,
    ["destructive: removes the customer's stored instrument"],
  ),
  op(
    "sendReceipt",
    "receipts_send",
    "Send a receipt",
    { kind: "mutation", action: "send", resource: "receipt", risk: "low", reversible: false },
    "review_required",
    "none",
    true,
    ["no idempotency contract: a retry sends a second e-mail", "no description in the source spec"],
  ),
  op(
    "exportStatement",
    "statements_export",
    "Export a statement",
    read("export", "statement"),
    "blocked",
    "natural",
    false,
    ["response schema unresolved: $ref '#/components/schemas/Statement' is missing"],
    1,
  ),
];

const evidenceFor: Record<string, Claim[]> = {
  listPayments: [
    spec("listPayments", "effect.kind", "read", "GET with no body"),
    spec("listPayments", "idempotency.mode", "natural"),
    spec("listPayments", "pagination", "cursor"),
  ],
  searchPayments: [
    spec("searchPayments", "effect.kind", "read"),
    inferred("searchPayments", "archetype", "search", "free-text `q`; no query language detected"),
  ],
  createRefund: [
    spec("createRefund", "effect.kind", "mutation"),
    spec("createRefund", "idempotency.mode", "required", "Idempotency-Key header documented"),
    spec("createRefund", "effect.reversible", false, "manifest: irreversible financial mutation"),
  ],
  deletePaymentMethod: [spec("deletePaymentMethod", "effect.risk", "destructive")],
  sendReceipt: [
    inferred("sendReceipt", "idempotency.mode", "none", "POST without a key; unproven"),
  ],
  exportStatement: [],
};

const suggestion = (row: OperationRow): string =>
  row.state === "blocked" ? "resolve blocking diagnostics and recompile" : "approve";

function paymentsInspector(): ConsoleResponse<"bundle"> {
  return {
    id: "payments",
    path: "/work/estate/payments",
    service: {
      id: "payments",
      version: "2026-06",
      displayName: "Payments API",
      owner: "payments-platform",
      environment: "prod",
      source: {
        kind: "openapi",
        uri: "examples/payments/openapi.yaml",
        pathGrammar: {
          classification: "resource_grammar",
          basis: "estate_evidence",
          evidence: {
            operations: 9,
            readMethodOperations: 5,
            parameterizedPathOperations: 6,
            verbTerminalOperations: 1,
            dottedTerminalOperations: 0,
            repeatedVerbWords: 0,
          },
        },
      },
      auth: {
        type: "oauth2_client_credentials",
        scopes: ["payments.read", "payments.write"],
        principal: "service",
        secretSource: "env",
        credentialProfile: "payments_prod",
        carrier: { in: "header", name: "Authorization", scheme: "Bearer" },
        provider: {
          tokenEndpoint: "https://auth.payments.example.test/oauth/token",
          grant: "client_credentials",
          clientAuth: "client_secret_basic",
        },
      },
      servers: [],
    },
    source: { kind: "openapi", uri: "examples/payments/openapi.yaml" },
    pathGrammar: {
      classification: "resource_grammar",
      basis: "estate_evidence",
      evidence: {
        operations: 9,
        readMethodOperations: 5,
        parameterizedPathOperations: 6,
        verbTerminalOperations: 1,
        dottedTerminalOperations: 0,
        repeatedVerbWords: 0,
      },
    },
    diagnostics: [
      {
        level: "error",
        code: DIAG.refMissing,
        message: "$ref '#/components/schemas/Statement' does not resolve",
        operationId: "exportStatement",
        path: "paths./statements/{id}/export.get.responses.200",
      },
      {
        level: "warning",
        code: "weak_operation_name",
        message: "canonical name carries a verb-terminal path; the operation has no description",
        operationId: "sendReceipt",
      },
    ],
    operations: operations.map((row) => ({ ...row })),
    capabilities: [
      {
        id: "refunds",
        lifecycle: "approved",
        source: "manifest",
        displayName: "Refunds",
        members: ["getPayment", "createRefund"],
        budget: { capabilityId: "refunds", toolCount: 2, disclosureTokens: 640, verdict: "ok" },
      },
      {
        id: "payments",
        lifecycle: "proposed",
        source: "resource",
        displayName: "Payments",
        members: ["getPayment", "listPayments", "searchPayments", "capturePayment", "sendReceipt"],
        budget: {
          capabilityId: "payments",
          toolCount: 16,
          disclosureTokens: 5120,
          measuredOperations: 5,
          unmeasuredOperations: 0,
          verdict: "warning",
          diagnostic: {
            level: "warning",
            code: "capability_disclosure_token_budget",
            message: "16 tools exceed the 15-tool comfort budget",
            capabilityId: "payments",
          },
        },
      },
      {
        id: "customers",
        lifecycle: "proposed",
        source: "resource",
        displayName: "Customers",
        members: ["getCustomer"],
        budget: { capabilityId: "customers", toolCount: 1, disclosureTokens: 310, verdict: "ok" },
      },
      {
        id: "everything",
        lifecycle: "proposed",
        source: "service",
        displayName: "Everything",
        members: operations.map((row) => row.id),
        budget: {
          capabilityId: "everything",
          toolCount: 23,
          disclosureTokens: 7360,
          measuredOperations: 9,
          unmeasuredOperations: 0,
          verdict: "blocked",
          diagnostic: {
            level: "error",
            code: "capability_budget_exceeded",
            message: "23 tools exceed the 20-tool budget; approve with --allow-large and a note",
            capabilityId: "everything",
          },
        },
      },
    ],
    workflows: [
      {
        id: "refund_customer",
        state: "approved",
        steps: [
          {
            operationId: "getPayment",
            description: "find the payment",
            optional: false,
            bindings: {},
          },
          {
            operationId: "createRefund",
            description: "issue an idempotent refund",
            optional: false,
            bindings: { paymentId: "$.steps[0].id" },
          },
        ],
        supersedes: ["createRefund"],
        plan: { registrable: true },
        refusals: [],
      },
      {
        id: "reconcile_statement",
        state: "review_required",
        steps: [
          {
            operationId: "exportStatement",
            description: "export the statement",
            optional: false,
            bindings: {},
          },
          {
            operationId: "listPayments",
            description: "list the period",
            optional: false,
            bindings: {},
          },
        ],
        supersedes: ["exportStatement"],
        plan: { registrable: false, skipReason: "step exportStatement is blocked" },
        refusals: [
          {
            operationId: "exportStatement",
            workflowId: "reconcile_statement",
            reason: "cannot supersede a blocked operation",
          },
        ],
      },
    ],
    servedSurface: {
      before: ["customers_get", "payments_get", "payments_capture", "refunds_create"],
      after: ["customers_get", "payments_get", "payments_capture", "refund_customer"],
    },
  };
}

function paymentsQueue(): ConsoleResponse<"queue"> {
  return {
    bundleId: "payments",
    items: [
      ...operations
        .filter((row) => row.state !== "approved")
        .map((row) => ({
          kind: "operation" as const,
          id: row.id,
          title: row.displayName,
          reasons: row.blockerNotes,
          evidence: evidenceFor[row.id] ?? [],
          suggestedAction: suggestion(row),
          blocking: row.state === "blocked",
        })),
      {
        kind: "capability",
        id: "payments",
        title: "Payments",
        reasons: ["resource grouping awaiting review"],
        evidence: [inferred("payments", "capability.cohesion", 0.81, "shared `payment` resource")],
        suggestedAction: "approve or reject the grouping",
        blocking: false,
      },
      {
        kind: "capability",
        id: "customers",
        title: "Customers",
        reasons: ["resource grouping awaiting review"],
        evidence: [
          spec("customers", "capability.members", ["getCustomer"], "one resource, one tool"),
        ],
        suggestedAction: "approve or reject the grouping",
        blocking: false,
      },
      {
        kind: "capability",
        id: "everything",
        title: "Everything",
        reasons: ["service grouping awaiting review", "23 tools exceed the 20-tool budget"],
        evidence: [],
        suggestedAction: "approve or reject the grouping",
        blocking: false,
      },
      {
        kind: "workflow",
        id: "reconcile_statement",
        title: "Reconcile a statement",
        reasons: ["planner refuses registration: step exportStatement is blocked"],
        evidence: [],
        suggestedAction: "unblock exportStatement, then recompile",
        blocking: true,
      },
      {
        kind: "refinement",
        id: 'missing_operation_description:{"kind":"operation","operationId":"sendReceipt"}',
        title: "Operation sendReceipt has no description",
        reasons: ["missing_operation_description"],
        evidence: [],
        suggestedAction: "describe-operation",
        blocking: false,
      },
    ],
  };
}

const delta = (
  clusterId: string,
  passedBefore: number,
  passedAfter: number,
  flippedToFail: Array<{ operationId: string; intent: string }>,
): NonNullable<ConsoleResponse<"packs">[number]["items"][number]["delta"]> => ({
  schemaVersion: 1,
  reportType: "anvil.group-routing-delta",
  clusterId,
  proposalKind: "workflow",
  scope: "member_tasks",
  router: "lexical",
  totalTasks: 16,
  passedBefore,
  passedAfter,
  upliftPts: Math.round(((passedAfter - passedBefore) / 16) * 1000) / 10,
  flippedToPass:
    passedAfter > passedBefore
      ? [{ operationId: "searchPayments", intent: "find the payment for order 8813" }]
      : [],
  flippedToFail,
  hypothetical: {
    catalogSize: 8,
    compositeTool: "lookup_payment",
    supersededOperationIds: ["listPayments", "searchPayments"],
  },
  simulated: false,
  simulationNote: "hypothetical catalog routed with the same lexical router; not executed",
});

function paymentsPacks(): ConsoleResponse<"packs"> {
  return [
    {
      dir: "/work/estate/packs/payments-2026-06-12",
      hash: HEX64,
      service: { id: "payments", version: "2026-06" },
      summary: { proposed: 3, approved: 0, review: 2, rejected: 0, regressed: 1, skipped: 0 },
      items: [
        {
          refinementId: "rf_describe_sendReceipt",
          skill: "describe-operation",
          target: { kind: "operation", operationId: "sendReceipt" },
          status: "validated",
          tier: "review",
          patchSummary:
            'description="Send the receipt for a captured payment to the customer\'s e-mail address."',
          claims: [
            {
              subject: "sendReceipt",
              predicate: "description",
              value: "Send the receipt for a captured payment",
              source: "source_impl",
              sourceRef: "src/receipts/send.ts:12",
              confidence: 0.9,
            },
          ],
        },
        {
          refinementId: "rf_group_lookup_payment",
          skill: "group-proposal",
          target: { kind: "group", groupId: "cluster_payment_lookup" },
          status: "improved",
          tier: "review",
          patchSummary: 'workflow="lookup_payment" supersedes=["listPayments","searchPayments"]',
          claims: [
            {
              subject: "cluster_payment_lookup",
              predicate: "routing.uplift",
              value: 12.5,
              source: "generated_mock",
              confidence: 0.8,
            },
          ],
          delta: delta("cluster_payment_lookup", 11, 13, []),
        },
        {
          refinementId: "rf_group_money_moves",
          skill: "group-proposal",
          target: { kind: "group", groupId: "cluster_money_moves" },
          status: "regressed",
          tier: "reject",
          patchSummary: 'workflow="move_money" supersedes=["createRefund","capturePayment"]',
          claims: [],
          delta: delta("cluster_money_moves", 12, 10, [
            { operationId: "createRefund", intent: "refund the duplicate charge on invoice 77" },
            { operationId: "capturePayment", intent: "capture the authorised amount now" },
          ]),
        },
      ],
      receipts: [],
    },
  ];
}

function paymentsBenchmark(): ConsoleResponse<"benchmark"> {
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

function paymentsDrift(): Record<string, ConsoleResponse<"drift">> {
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

function ledgerInspector(): ConsoleResponse<"bundle"> {
  return {
    id: "ledger",
    path: "/work/estate/ledger",
    service: {
      id: "ledger",
      version: "1.0.0",
      source: { kind: "openapi", uri: "ledger/openapi.yaml" },
      auth: { type: "none", scopes: [], principal: "anonymous", secretSource: "none" },
      servers: [],
    },
    source: { kind: "openapi", uri: "ledger/openapi.yaml" },
    diagnostics: [],
    operations: [
      op(
        "listEntries",
        "entries_list",
        "List ledger entries",
        read("list", "entry"),
        "approved",
        "natural",
        false,
      ),
      op(
        "getEntry",
        "entries_get",
        "Get a ledger entry",
        read("get", "entry"),
        "approved",
        "natural",
        false,
      ),
    ],
    capabilities: [],
    workflows: [],
    servedSurface: {
      before: ["entries_list", "entries_get"],
      after: ["entries_list", "entries_get"],
    },
  };
}

/** A fresh, independently mutable copy of the whole fixture workspace. */
export function fixtureWorkspace(): WorkspaceFixture {
  return {
    root: "/work/estate",
    bundles: {
      payments: {
        inspector: paymentsInspector(),
        queue: paymentsQueue(),
        packs: paymentsPacks(),
        benchmark: paymentsBenchmark(),
        drift: paymentsDrift(),
      },
      ledger: {
        inspector: ledgerInspector(),
        queue: { bundleId: "ledger", items: [] },
        packs: [],
        benchmark: null,
        drift: {},
      },
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
