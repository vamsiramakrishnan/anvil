import { type AirDocument, loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { applyPatch, applyPatches, semanticDiff } from "./apply.js";
import type { SemanticPatch } from "./skills/contract.js";

/**
 * One operation with everything `apply.ts` needs to locate: a required param, a
 * body field (`reason`, undocumented) under the "fields" projection, a declared
 * `rate_limited` error, and a parent capability.
 */
function fixtureDoc(): AirDocument {
  return loadAirDocument({
    service: {
      id: "payments",
      displayName: "Payments",
      version: "1",
      source: { kind: "openapi" },
    },
    capabilities: [
      {
        id: "payments.refunds",
        displayName: "Refunds",
        description: "",
        operationIds: ["payments.refunds.create"],
      },
    ],
    operations: [
      {
        id: "payments.refunds.create",
        canonicalName: "create_refund",
        displayName: "Create refund",
        description: "Creates a refund.",
        capabilityId: "payments.refunds",
        sourceRef: { kind: "openapi", path: "/refunds", method: "post" },
        effect: { kind: "mutation", action: "create", risk: "financial" },
        input: {
          params: [{ name: "paymentId", in: "path", required: true, schema: { type: "string" } }],
          body: {
            projection: "fields",
            fields: [{ name: "reason", required: true, schema: { type: "string" } }],
          },
        },
        errors: [{ code: "rate_limited" }],
        idempotency: { mode: "none" },
        retries: { mode: "none" },
        confirmation: { required: false },
        auth: { type: "api_key" },
        cli: { command: "payments refunds create" },
        mcp: { toolName: "payments_create_refund" },
        skill: { intentExamples: ["Create a refund."] },
      },
    ],
  });
}

const OPERATION_ID = "payments.refunds.create";

describe("applyPatch", () => {
  it("sets an operation description and records the change", () => {
    const air = fixtureDoc();
    const patch: SemanticPatch = {
      target: { kind: "operation", operationId: OPERATION_ID },
      set: { description: "Issues a refund for a prior payment." },
    };
    const result = applyPatch(air, patch);

    const op = result.air.operations.find((o) => o.id === OPERATION_ID);
    expect(op?.description).toBe("Issues a refund for a prior payment.");
    expect(result.changes).toEqual([
      {
        target: patch.target,
        key: "description",
        before: "Creates a refund.",
        after: "Issues a refund for a prior payment.",
      },
    ]);
  });

  it("sets a body field description", () => {
    const air = fixtureDoc();
    const patch: SemanticPatch = {
      target: { kind: "field", operationId: OPERATION_ID, path: "input.body.reason" },
      set: { description: "Why the refund is being issued." },
    };
    const result = applyPatch(air, patch);

    const op = result.air.operations.find((o) => o.id === OPERATION_ID);
    const field = op?.input.body?.fields.find((f) => f.name === "reason");
    expect(field?.description).toBe("Why the refund is being issued.");
    expect(result.changes[0]?.before).toBeUndefined();
  });

  it("sets field examples onto the JSON Schema examples property", () => {
    const air = fixtureDoc();
    const patch: SemanticPatch = {
      target: { kind: "field", operationId: OPERATION_ID, path: "input.body.reason" },
      set: { examples: ["duplicate charge", "customer request"] },
    };
    const result = applyPatch(air, patch);

    const op = result.air.operations.find((o) => o.id === OPERATION_ID);
    const field = op?.input.body?.fields.find((f) => f.name === "reason");
    expect(field?.schema.examples).toEqual(["duplicate charge", "customer request"]);
  });

  it("sets an error message and retryable flag", () => {
    const air = fixtureDoc();
    const result = applyPatches(air, [
      {
        target: { kind: "error", operationId: OPERATION_ID, code: "rate_limited" },
        set: { message: "Too many refund requests; back off and retry.", retryable: true },
      },
    ]);

    const op = result.air.operations.find((o) => o.id === OPERATION_ID);
    const spec = op?.errors.find((e) => e.code === "rate_limited");
    expect(spec?.message).toBe("Too many refund requests; back off and retry.");
    expect(spec?.retryable).toBe(true);
    expect(result.changes).toHaveLength(2);
  });

  it("sets the idempotency carrier onto an operation", () => {
    const air = fixtureDoc();
    const result = applyPatches(air, [
      {
        target: { kind: "operation", operationId: OPERATION_ID },
        set: {
          idempotency_mode: "required",
          idempotency_mechanism: "header",
          idempotency_key: "Idempotency-Key",
        },
      },
    ]);

    const op = result.air.operations.find((o) => o.id === OPERATION_ID);
    expect(op?.idempotency).toEqual({
      mode: "required",
      mechanism: "header",
      key: "Idempotency-Key",
      keyDerivation: "none",
    });
    expect(result.changes).toEqual([
      { target: expect.anything(), key: "idempotency_mode", before: "none", after: "required" },
      {
        target: expect.anything(),
        key: "idempotency_mechanism",
        before: "none",
        after: "header",
      },
      {
        target: expect.anything(),
        key: "idempotency_key",
        before: undefined,
        after: "Idempotency-Key",
      },
    ]);
  });

  it("sets the retry basis onto an operation without touching its idempotency carrier", () => {
    const air = fixtureDoc();
    const result = applyPatch(air, {
      target: { kind: "operation", operationId: OPERATION_ID },
      set: { retry_basis: "natural_idempotent" },
    });

    const op = result.air.operations.find((o) => o.id === OPERATION_ID);
    expect(op?.retries.basis).toBe("natural_idempotent");
    expect(op?.idempotency.mode).toBe("none");
  });

  it("sets the pagination carrier onto an operation", () => {
    const air = fixtureDoc();
    const result = applyPatches(air, [
      {
        target: { kind: "operation", operationId: OPERATION_ID },
        set: {
          pagination_style: "cursor",
          pagination_cursor_param: "after",
          pagination_items_field: "items",
          pagination_next_field: "nextCursor",
        },
      },
    ]);

    const op = result.air.operations.find((o) => o.id === OPERATION_ID);
    expect(op?.pagination).toEqual({
      style: "cursor",
      cursorParam: "after",
      itemsField: "items",
      nextField: "nextCursor",
    });
    expect(result.changes).toHaveLength(4);
    expect(result.changes[0]?.key).toBe("pagination_style");
    expect(result.changes[0]?.after).toBe("cursor");
    expect(result.changes[1]?.key).toBe("pagination_cursor_param");
    expect(result.changes[1]?.after).toBe("after");
    expect(result.changes[2]?.key).toBe("pagination_items_field");
    expect(result.changes[2]?.after).toBe("items");
    expect(result.changes[3]?.key).toBe("pagination_next_field");
    expect(result.changes[3]?.after).toBe("nextCursor");
  });

  it("applies pagination_style first regardless of the patch's key order", () => {
    const air = fixtureDoc();
    const result = applyPatch(air, {
      target: { kind: "operation", operationId: OPERATION_ID },
      set: { pagination_items_field: "items", pagination_style: "page" },
    });

    const op = result.air.operations.find((o) => o.id === OPERATION_ID);
    expect(op?.pagination).toMatchObject({ style: "page", itemsField: "items" });
    expect(result.changes.map((c) => c.key)).toEqual([
      "pagination_style",
      "pagination_items_field",
    ]);
  });

  it("never fabricates a pagination style to anchor a field-only patch", () => {
    const air = fixtureDoc();
    const result = applyPatch(air, {
      target: { kind: "operation", operationId: OPERATION_ID },
      set: { pagination_items_field: "items" },
    });

    // The fixture operation has no pagination and the patch proposes no style:
    // inventing `style: "cursor"` would be a business fact no evidence claimed.
    const op = result.air.operations.find((o) => o.id === OPERATION_ID);
    expect(op?.pagination).toBeUndefined();
    expect(result.changes).toEqual([]);
  });

  it("sets a capability description", () => {
    const air = fixtureDoc();
    const patch: SemanticPatch = {
      target: { kind: "capability", capabilityId: "payments.refunds" },
      set: { description: "Issue and manage refunds for payments." },
    };
    const result = applyPatch(air, patch);

    const cap = result.air.capabilities.find((c) => c.id === "payments.refunds");
    expect(cap?.description).toBe("Issue and manage refunds for payments.");
  });

  it("never mutates the input document", () => {
    const air = fixtureDoc();
    const originalDescription = air.operations.find((o) => o.id === OPERATION_ID)?.description;

    applyPatch(air, {
      target: { kind: "operation", operationId: OPERATION_ID },
      set: { description: "Something entirely different." },
    });

    expect(air.operations.find((o) => o.id === OPERATION_ID)?.description).toBe(
      originalDescription,
    );
  });

  it("skips an unlocatable target and records no changes", () => {
    const air = fixtureDoc();
    const result = applyPatch(air, {
      target: { kind: "operation", operationId: "payments.refunds.nonexistent" },
      set: { description: "Never applied." },
    });

    expect(result.changes).toEqual([]);
    expect(result.air).toEqual(air);
  });

  it("skips an unrecognised key on a valid target and records no changes", () => {
    const air = fixtureDoc();
    const result = applyPatch(air, {
      target: { kind: "operation", operationId: OPERATION_ID },
      set: { notARealKey: "ignored" },
    });

    expect(result.changes).toEqual([]);
  });
});

describe("applyPatches", () => {
  it("threads the document forward so later patches see earlier ones", () => {
    const air = fixtureDoc();
    const result = applyPatches(air, [
      {
        target: { kind: "operation", operationId: OPERATION_ID },
        set: { description: "First pass." },
      },
      {
        target: { kind: "operation", operationId: OPERATION_ID },
        set: { description: "Second pass." },
      },
    ]);

    const op = result.air.operations.find((o) => o.id === OPERATION_ID);
    expect(op?.description).toBe("Second pass.");
    expect(result.changes).toHaveLength(2);
    expect(result.changes[1]?.before).toBe("First pass.");
  });
});

describe("semanticDiff", () => {
  it("renders one line per change with an arrow between before/after", () => {
    const air = fixtureDoc();
    const result = applyPatch(air, {
      target: { kind: "operation", operationId: OPERATION_ID },
      set: { description: "Issues a refund." },
    });

    const text = semanticDiff(result.changes);
    expect(text).toBe(`${OPERATION_ID} .description: "Creates a refund." → "Issues a refund."`);
  });

  it("reports no changes for an empty list", () => {
    expect(semanticDiff([])).toBe("(no changes)");
  });
});
