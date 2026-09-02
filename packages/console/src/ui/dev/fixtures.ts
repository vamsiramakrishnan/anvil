import type { ConsoleResponse } from "../../contract.js";
import { HEX64, paymentsBenchmark, paymentsDrift } from "./fixtures-reports.js";

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

type PackTarget = ConsoleResponse<"packs">[number]["items"][number]["target"];

/** `describeTarget` as the mock renders it — the server uses the library's. */
function targetLabel(target: PackTarget): string {
  switch (target.kind) {
    case "service":
      return "service";
    case "capability":
      return target.capabilityId;
    case "operation":
      return target.operationId;
    case "field":
    case "enum":
      return `${target.operationId} ${target.path}`;
    case "error":
      return `${target.operationId} (${target.code})`;
    case "workflow":
      return target.workflowId;
    case "group":
      return target.groupId;
  }
}

const capabilityReasons: Record<string, string[]> = {
  payments: ["resource grouping awaiting review"],
  customers: ["resource grouping awaiting review"],
  everything: ["service grouping awaiting review", "23 tools exceed the 20-tool budget"],
};

const capabilityEvidence: Record<string, Claim[]> = {
  payments: [inferred("payments", "capability.cohesion", 0.81, "shared `payment` resource")],
  customers: [spec("customers", "capability.members", ["getCustomer"], "one resource, one tool")],
  everything: [],
};

/**
 * The decision queue, projected from the same fixtures the inspector, the pack
 * list, and the benchmark answer with — the way the server projects it from
 * the same files — so every item's `subject` agrees with the view it came from.
 */
function paymentsQueue(
  inspector: ConsoleResponse<"bundle">,
  packs: ConsoleResponse<"packs">,
  benchmark: ConsoleResponse<"benchmark">,
): ConsoleResponse<"queue"> {
  return {
    bundleId: "payments",
    items: [
      ...inspector.operations
        .filter((row) => row.state !== "approved")
        .map((row) => ({
          kind: "operation" as const,
          id: row.id,
          title: row.displayName,
          reasons: row.blockerNotes,
          evidence: evidenceFor[row.id] ?? [],
          suggestedAction: suggestion(row),
          blocking: row.state === "blocked",
          subject: {
            operationId: row.id,
            effect: row.effect,
            idempotency: row.idempotency,
            // AIR's rule, mirrored: no proven idempotency, no auto-retry.
            retries: {
              mode: row.idempotency.mode === "none" ? ("none" as const) : ("safe" as const),
            },
            confirmation: row.confirmation,
          },
        })),
      ...inspector.capabilities
        .filter((cap) => cap.lifecycle === "proposed")
        .map((cap) => ({
          kind: "capability" as const,
          id: cap.id,
          title: cap.displayName,
          reasons: capabilityReasons[cap.id] ?? [`${cap.source} grouping awaiting review`],
          evidence: capabilityEvidence[cap.id] ?? [],
          suggestedAction: "approve or reject the grouping",
          blocking: false,
          subject: { capabilityId: cap.id, budget: cap.budget },
        })),
      ...inspector.workflows
        .filter((wf) => !wf.plan.registrable || wf.state !== "approved")
        .map((wf) => ({
          kind: "workflow" as const,
          id: wf.id,
          title: "Reconcile a statement",
          reasons: [`planner refuses registration: ${wf.plan.skipReason ?? "not registrable"}`],
          evidence: [],
          suggestedAction: "unblock exportStatement, then recompile",
          blocking: true,
          subject: { workflowId: wf.id, plan: wf.plan },
        })),
      {
        kind: "refinement",
        id: "missing_operation_description:operation:sendReceipt",
        title: "Operation sendReceipt has no description",
        reasons: ["missing_operation_description"],
        evidence: [],
        suggestedAction: "describe-operation",
        blocking: false,
        subject: { deficiencyId: "operation:sendReceipt", skill: "describe-operation" },
      },
      ...packs.flatMap((pack) =>
        pack.items
          .filter(
            (item) =>
              item.tier === "review" &&
              (item.status === "improved" || item.status === "neutral") &&
              item.receiptPaths.length === 0,
          )
          .map((item) => ({
            kind: "pack" as const,
            id: item.refinementId,
            title: `${item.skill} → ${targetLabel(item.target)}`,
            reasons: [
              "measured clean; a person decides",
              `proposes ${item.patchSummary}`,
              `pack ${pack.hash.slice(0, 12)} at ${pack.dir}`,
            ],
            evidence: item.claims,
            suggestedAction: "approve or reject with a receipt (anvil refine approve|reject)",
            blocking: false,
            subject: {
              packHash: pack.hash,
              refinementId: item.refinementId,
              tier: item.tier,
              ...(item.delta ? { delta: item.delta } : {}),
            },
          })),
      ),
      ...(benchmark?.confusion.clusters ?? []).map((cluster) => ({
        kind: "cluster" as const,
        id: cluster.id,
        title: `${cluster.members.length} confusable tools, ${cluster.taskCount} mis-routed tasks`,
        reasons: cluster.edges.map(
          (edge) => `${edge.intended} routed to ${edge.routed} ×${edge.count}`,
        ),
        evidence: [],
        suggestedAction: `export a case file (anvil refine export-task … group:${cluster.id})`,
        blocking: false,
        subject: {
          clusterId: cluster.id,
          memberOperationIds: cluster.members.map((member) => member.operationId),
          evidence: cluster.edges,
        },
      })),
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
          receiptPaths: [],
          refinementId: "rf_describe_sendReceipt",
          skill: "describe-operation",
          target: { kind: "operation", operationId: "sendReceipt" },
          status: "neutral",
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
          receiptPaths: [],
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
          receiptPaths: [],
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
  const inspector = paymentsInspector();
  const packs = paymentsPacks();
  const benchmark = paymentsBenchmark();
  return {
    root: "/work/estate",
    bundles: {
      payments: {
        inspector,
        queue: paymentsQueue(inspector, packs, benchmark),
        packs,
        benchmark,
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
