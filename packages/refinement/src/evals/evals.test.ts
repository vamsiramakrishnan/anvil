import { type AirDocument, loadAirDocument } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { evalDelta } from "./delta.js";
import { familiesFor, GUARD_FAMILY, scoreFamily } from "./families.js";

/**
 * A minimal unsafe-mutation operation: financial risk, no proven idempotency —
 * exactly the shape `unsafe_operation_refusal` must gate. `confirmed` toggles
 * the one lever that flips it from guarded to unguarded, so tests can isolate
 * the safety-guard signal from everything else.
 */
function refundOperation(opts: {
  confirmed: boolean;
  reasonDescribed: boolean;
  reasonHasExample: boolean;
}): Record<string, unknown> {
  return {
    id: "payments.refunds.create",
    canonicalName: "create_refund",
    displayName: "Create refund",
    description: "Creates a refund for a payment.",
    sourceRef: { kind: "openapi", path: "/refunds", method: "post" },
    effect: { kind: "mutation", action: "create", risk: "financial", reversible: false },
    input: {
      params: [{ name: "payment_id", in: "path", required: true, schema: { type: "string" } }],
      body: {
        projection: "fields",
        fields: [
          {
            name: "reason",
            required: true,
            schema: opts.reasonHasExample
              ? { type: "string", example: "requested by customer" }
              : { type: "string" },
            description: opts.reasonDescribed ? "Why the refund is being issued." : undefined,
          },
        ],
      },
    },
    errors: [
      { code: "conflict", message: "A refund for this payment already exists.", retryable: false },
    ],
    idempotency: { mode: "none" },
    retries: { mode: "none" },
    confirmation: { required: opts.confirmed },
    auth: { type: "api_key" },
    cli: { command: "payments refunds create" },
    mcp: { toolName: "payments_create_refund" },
    skill: { intentExamples: ["Refund a payment for a customer."] },
  };
}

function airWithRefund(opts: {
  confirmed: boolean;
  reasonDescribed: boolean;
  reasonHasExample: boolean;
}): AirDocument {
  return loadAirDocument({
    service: { id: "payments", displayName: "Payments", version: "1", source: { kind: "openapi" } },
    operations: [refundOperation(opts)],
  });
}

describe("familiesFor", () => {
  it("maps required_field_no_example to argument_mapping + field_interpretation, guard last", () => {
    expect(familiesFor("required_field_no_example")).toEqual([
      "argument_mapping",
      "field_interpretation",
      "unsafe_operation_refusal",
    ]);
  });

  it("always ends with the guard family", () => {
    const families = familiesFor("undocumented_error");
    expect(families[families.length - 1]).toBe(GUARD_FAMILY);
    expect(families).toContain("error_recovery");
  });

  it("appends the guard family even for unmapped codes", () => {
    expect(familiesFor("weak_operation_name")).toEqual(["unsafe_operation_refusal"]);
  });
});

describe("scoreFamily — field_interpretation", () => {
  it("rises once a required field gains a description and a bindable example", () => {
    const before = airWithRefund({
      confirmed: true,
      reasonDescribed: false,
      reasonHasExample: false,
    });
    const after = airWithRefund({ confirmed: true, reasonDescribed: true, reasonHasExample: true });

    const beforeScore = scoreFamily(before, "field_interpretation").score;
    const afterScore = scoreFamily(after, "field_interpretation").score;
    expect(afterScore).toBeGreaterThan(beforeScore);
  });
});

describe("evalDelta", () => {
  it("reports improved for field_interpretation and neutral for the guard on a doc-only change", () => {
    const before = airWithRefund({
      confirmed: true,
      reasonDescribed: false,
      reasonHasExample: false,
    });
    const after = airWithRefund({ confirmed: true, reasonDescribed: true, reasonHasExample: true });

    const deltas = evalDelta(before, after, ["field_interpretation", "unsafe_operation_refusal"]);
    const fieldDelta = deltas.find((d) => d.family === "field_interpretation");
    const guardDelta = deltas.find((d) => d.family === "unsafe_operation_refusal");

    expect(fieldDelta?.verdict).toBe("improved");
    expect(guardDelta?.verdict).toBe("neutral");
  });
});

describe("scoreFamily — unsafe_operation_refusal (safety guard)", () => {
  it("scores an unconfirmed, unguarded mutation lower than a confirmed one", () => {
    const guarded = airWithRefund({
      confirmed: true,
      reasonDescribed: true,
      reasonHasExample: true,
    });
    const unguarded = airWithRefund({
      confirmed: false,
      reasonDescribed: true,
      reasonHasExample: true,
    });

    const guardedScore = scoreFamily(guarded, "unsafe_operation_refusal").score;
    const unguardedScore = scoreFamily(unguarded, "unsafe_operation_refusal").score;
    expect(unguardedScore).toBeLessThan(guardedScore);
  });

  it("detects a regression via evalDelta when confirmation is removed", () => {
    const before = airWithRefund({
      confirmed: true,
      reasonDescribed: true,
      reasonHasExample: true,
    });
    const after = airWithRefund({
      confirmed: false,
      reasonDescribed: true,
      reasonHasExample: true,
    });

    const [guardDelta] = evalDelta(before, after, ["unsafe_operation_refusal"]);
    expect(guardDelta?.verdict).toBe("regressed");
  });
});

describe("scoreFamily — operation_routing", () => {
  it("routes a phrase to its own operation when the description carries distinctive words", () => {
    const air = loadAirDocument({
      service: {
        id: "payments",
        displayName: "Payments",
        version: "1",
        source: { kind: "openapi" },
      },
      operations: [
        {
          id: "payments.refunds.create",
          canonicalName: "create_refund",
          displayName: "Create refund",
          description: "Creates a refund for a payment.",
          sourceRef: { kind: "openapi", path: "/refunds", method: "post" },
          effect: { kind: "mutation", action: "create", risk: "financial" },
          input: { params: [] },
          idempotency: { mode: "required" },
          retries: { mode: "none" },
          confirmation: { required: true },
          auth: { type: "api_key" },
          cli: { command: "payments refunds create" },
          mcp: { toolName: "payments_create_refund" },
          skill: { intentExamples: ["Refund a payment for a customer."] },
        },
        {
          id: "payments.transfers.list",
          canonicalName: "list_transfers",
          displayName: "List transfers",
          description: "Lists transfers between accounts.",
          sourceRef: { kind: "openapi", path: "/transfers", method: "get" },
          effect: { kind: "read", action: "list", risk: "none" },
          input: { params: [] },
          idempotency: { mode: "natural" },
          retries: { mode: "safe", basis: "read_safe" },
          confirmation: { required: false },
          auth: { type: "api_key" },
          cli: { command: "payments transfers list" },
          mcp: { toolName: "payments_list_transfers" },
          skill: { intentExamples: ["List all transfers between accounts."] },
        },
      ],
    });

    const result = scoreFamily(air, "operation_routing");
    expect(typeof result.score).toBe("number");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.total).toBe(2);
  });
});
