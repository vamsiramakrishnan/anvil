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
