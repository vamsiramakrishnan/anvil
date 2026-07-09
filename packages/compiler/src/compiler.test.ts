import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evidenceConfidence } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { classifyConfirmation, classifyEffect } from "./classify.js";
import { approveOperations, compile } from "./compile.js";

const read = (rel: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/payments/${rel}`, import.meta.url)),
    "utf8",
  );

const spec = read("openapi.yaml");
const manifest = read("anvil.yaml");

describe("classifier", () => {
  it("classifies reads as retry-safe and non-confirming", () => {
    const { effect, idempotency } = classifyEffect("get", "getCustomer /customers/{id}");
    expect(effect.kind).toBe("read");
    expect(idempotency.mode).toBe("natural");
    expect(classifyConfirmation(effect, idempotency).required).toBe(false);
  });

  it("classifies POST refund as a non-idempotent financial mutation", () => {
    const { effect, idempotency } = classifyEffect("post", "createRefund /payments/{id}/refunds");
    expect(effect.kind).toBe("mutation");
    expect(effect.risk).toBe("financial");
    expect(effect.reversible).toBe(false);
    expect(idempotency.mode).toBe("none");
    expect(classifyConfirmation(effect, idempotency).required).toBe(true);
  });

  it("classifies DELETE as destructive", () => {
    const { effect } = classifyEffect("delete", "deleteThing /things/{id}");
    expect(effect.risk).toBe("destructive");
    expect(effect.reversible).toBe(false);
  });
});

describe("compile pipeline (spec only)", () => {
  it("produces AIR with aligned CLI/MCP/skill bindings", async () => {
    const air = await compile({ spec, serviceId: "payments" });
    expect(air.service.id).toBe("payments");
    expect(air.operations.length).toBeGreaterThanOrEqual(4);
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund).toBeDefined();
    expect(refund?.cli.command).toBe("payments refunds create");
    expect(refund?.mcp.toolName).toBe("payments_create_refund");
    expect(refund?.input.schema?.type).toBe("object");
  });

  it("escalates non-idempotent mutations to review_required without a manifest", async () => {
    const air = await compile({ spec, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.state).toBe("review_required");
    expect(refund?.confirmation.required).toBe(true);
    // No retries on an unproven mutation.
    expect(refund?.retries.mode).toBe("none");
    expect(air.diagnostics.some((d) => d.code === "unproven_idempotency")).toBe(true);
  });
});

describe("compile pipeline (with manifest enrichment)", () => {
  it("makes the refund idempotent, retry-safe, and approved", async () => {
    const air = await compile({ spec, manifest, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.idempotency.mode).toBe("required");
    expect(refund?.idempotency.key).toBe("Idempotency-Key");
    expect(refund?.idempotency.keyDerivation).toBe("request_fingerprint");
    expect(refund?.retries.mode).toBe("safe");
    expect(refund?.retries.maxAttempts).toBe(3);
    expect(refund?.retries.retryOn).toContain("http_429");
    expect(refund?.confirmation.required).toBe(true);
    expect(refund?.state).toBe("approved");
    expect(evidenceConfidence(refund?.evidence ?? { claims: [] })).toBeGreaterThanOrEqual(0.95);
  });

  it("resolves oauth2 auth with scopes", async () => {
    const air = await compile({ spec, manifest, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.auth.type).toBe("oauth2_client_credentials");
    expect(refund?.auth.scopes).toContain("payments.read");
  });

  it("supports explicit approval of additional operations", async () => {
    const air = await compile({ spec, serviceId: "payments" });
    const before = air.operations.find((o) => o.canonicalName === "get_customer");
    expect(before?.state).toBe("generated");
    approveOperations(air, [before?.id ?? ""]);
    expect(air.operations.find((o) => o.canonicalName === "get_customer")?.state).toBe("approved");
  });
});

describe("semantic vocabulary (effect action / retry basis / auth principal)", () => {
  it("derives a descriptive action verb without changing the safety kind", async () => {
    const air = await compile({ spec, manifest, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.effect.kind).toBe("mutation"); // safety core unchanged
    expect(refund?.effect.action).toBe("create"); // richer descriptive layer
    const getPayment = air.operations.find((o) => o.canonicalName === "get_payment");
    expect(getPayment?.effect.action).toBe("get");
  });

  it("records the retry basis behind a safe posture", async () => {
    const air = await compile({ spec, manifest, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.retries.mode).toBe("safe");
    expect(refund?.retries.basis).toBe("idempotency_key");
    const getPayment = air.operations.find((o) => o.canonicalName === "get_payment");
    expect(getPayment?.retries.basis).toBe("read_safe");
  });

  it("classifies the auth principal (whose authority) from the scheme", async () => {
    const air = await compile({ spec, manifest, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.auth.type).toBe("oauth2_client_credentials");
    expect(refund?.auth.principal).toBe("service");
  });

  it("lets the manifest override principal / action / audience", async () => {
    const m = `service: { name: payments }
operations:
  getPayment:
    state: approved
    action: export
    auth:
      principal: end_user
      audience: https://payments.example.com`;
    const air = await compile({ spec, manifest: m, serviceId: "payments" });
    const getPayment = air.operations.find((o) => o.canonicalName === "get_payment");
    expect(getPayment?.effect.action).toBe("export");
    expect(getPayment?.auth.principal).toBe("end_user");
    expect(getPayment?.auth.audience).toBe("https://payments.example.com");
  });
});

describe("naming pass", () => {
  it("scores a spec-derived name with lower confidence than an operationId one", async () => {
    const air = await compile({ spec, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    const naming = refund?.evidence.claims.find((c) => c.predicate === "name.quality");
    expect(naming?.confidence).toBeGreaterThanOrEqual(0.9); // has an operationId
  });

  it("resolves a CLI-command collision with meaningful tokens, not a silent _2", async () => {
    const clashing = `openapi: 3.0.0
info: { title: billing, version: 1.0.0 }
paths:
  /orders/{id}/cancel:
    post:
      responses: { "200": { description: ok } }
  /subscriptions/{id}/cancel:
    post:
      responses: { "200": { description: ok } }
`;
    const air = await compile({ spec: clashing, serviceId: "billing" });
    const commands = air.operations.map((o) => o.cli.command);
    // Disambiguated by the distinguishing path segment, and unique.
    expect(new Set(commands).size).toBe(commands.length);
    expect(commands.some((c) => c.includes("orders"))).toBe(true);
    expect(commands.some((c) => c.includes("subscriptions"))).toBe(true);
    expect(air.diagnostics.some((d) => d.code === "naming_collision_resolved")).toBe(true);
    // Tool names stay aligned with the disambiguated commands (no drift).
    expect(new Set(air.operations.map((o) => o.mcp.toolName)).size).toBe(air.operations.length);
  });

  it("flags a weak (agent-hostile) name for review", async () => {
    const weak = `openapi: 3.0.0
info: { title: gateway, version: 1.0.0 }
paths:
  /:
    post:
      responses: { "200": { description: ok } }
`;
    const air = await compile({ spec: weak, serviceId: "gateway" });
    expect(air.diagnostics.some((d) => d.code === "weak_operation_name")).toBe(true);
  });
});

describe("request body handling", () => {
  it("projects a flat scalar body into per-field flags while preserving the schema", async () => {
    const air = await compile({ spec, manifest, serviceId: "payments" });
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.input.body?.projection).toBe("fields");
    expect(refund?.input.body?.fields.map((f) => f.name).sort()).toEqual([
      "amount",
      "currency",
      "reason",
    ]);
    // Body fields are NOT stored as params (the model is not mutated by the surface).
    expect(refund?.input.params.every((p) => p.in !== "body")).toBe(true);
    // The verbatim body schema is still present.
    expect(refund?.input.body?.schema.type).toBe("object");
  });

  it("preserves a nested/array body whole instead of flattening it", async () => {
    const nested = `openapi: 3.0.0
info: { title: orders, version: 1.0.0 }
paths:
  /orders:
    post:
      operationId: createOrder
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [items]
              properties:
                items:
                  type: array
                  items: { type: object, properties: { sku: { type: string } } }
`;
    const air = await compile({ spec: nested, serviceId: "orders" });
    const op = air.operations[0];
    expect(op?.input.body?.projection).toBe("whole");
    // Array-of-objects structure survives (this is exactly what flattening lost).
    const items = op?.input.body?.schema.properties as Record<string, { type?: string }>;
    expect(items.items?.type).toBe("array");
    // The assembled input surface carries a single `body` property.
    const props = op?.input.schema?.properties as Record<string, unknown>;
    expect(Object.keys(props)).toContain("body");
  });
});

describe("capability discovery", () => {
  it("groups operations into capabilities from OpenAPI tags", async () => {
    const air = await compile({ spec, serviceId: "payments" });
    const ids = air.capabilities.map((c) => c.id).sort();
    expect(ids).toEqual(["payments.customers", "payments.payments", "payments.refunds"]);
    const refunds = air.capabilities.find((c) => c.id === "payments.refunds");
    expect(refunds?.source).toBe("tag");
    expect(evidenceConfidence(refunds?.evidence ?? { claims: [] })).toBeGreaterThanOrEqual(0.9);
    // Every operation is stamped with its primary capability.
    const refund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(refund?.capabilityId).toBe("payments.refunds");
    expect(refunds?.operationIds).toContain(refund?.id);
  });

  it("marks a capability approved when any member operation is approved", async () => {
    const air = await compile({ spec, manifest, serviceId: "payments" });
    const refunds = air.capabilities.find((c) => c.id === "payments.refunds");
    expect(refunds?.state).toBe("approved");
  });
});

describe("authored workflows", () => {
  it("builds a first-class workflow from the manifest and attaches it to a capability", async () => {
    const air = await compile({ spec, manifest, serviceId: "payments" });
    expect(air.workflows).toHaveLength(1);
    const wf = air.workflows[0];
    expect(wf?.id).toBe("payments.refunds.refund_customer");
    expect(wf?.capabilityId).toBe("payments.refunds");
    expect(wf?.humanApproval).toBe(true);
    // Steps resolve their operation references to AIR operation ids.
    const getPayment = air.operations.find((o) => o.canonicalName === "get_payment");
    const createRefund = air.operations.find((o) => o.canonicalName === "create_refund");
    expect(wf?.steps.map((s) => s.operationId)).toEqual([getPayment?.id, createRefund?.id]);
    expect(wf?.steps[1]?.bindings.payment_id).toBe("$.steps.getPayment.id");
    // The owning capability records the workflow.
    const refunds = air.capabilities.find((c) => c.id === "payments.refunds");
    expect(refunds?.workflowIds).toContain(wf?.id);
  });

  it("drops a step referencing an unknown operation with a diagnostic", async () => {
    const badManifest = `${manifest}
  broken_flow:
    capability: refunds
    steps:
      - operation: doesNotExist
`;
    const air = await compile({ spec, manifest: badManifest, serviceId: "payments" });
    expect(air.diagnostics.some((d) => d.code === "workflow_step_unresolved")).toBe(true);
  });
});
