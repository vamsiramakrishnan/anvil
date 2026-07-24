import { Operation, operationInputSchema } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { operationZodShape } from "./zodshape.js";

function keyedOperation() {
  const operation = Operation.parse({
    id: "payments.refunds.create",
    canonicalName: "create_refund",
    displayName: "Create refund",
    sourceRef: { kind: "openapi", path: "/refunds", method: "post" },
    effect: {
      kind: "mutation",
      action: "create",
      resource: "refund",
      risk: "financial",
      reversible: false,
    },
    input: { params: [] },
    idempotency: {
      mode: "required",
      mechanism: "header",
      key: "Idempotency-Key",
      keyDerivation: "client_supplied",
    },
    retries: { mode: "safe", maxAttempts: 3, backoff: "exponential", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "payments refunds create" },
    mcp: { toolName: "payments_create_refund" },
    skill: { intentExamples: [] },
    state: "approved",
  });
  operation.input.schema = operationInputSchema(operation);
  return operation;
}

describe("operationZodShape", () => {
  it.each([
    ["spaces", "business operation"],
    ["Unicode", "business-é"],
    ["more than 255 characters", "x".repeat(256)],
  ])("enforces the portable idempotency-key contract: %s", (_case, key) => {
    const validator = z.object(operationZodShape(keyedOperation()));
    expect(validator.safeParse({ idempotency_key: key }).success).toBe(false);
  });

  it("accepts a 255-character visible-ASCII idempotency key", () => {
    const validator = z.object(operationZodShape(keyedOperation()));
    expect(validator.safeParse({ idempotency_key: "x".repeat(255) }).success).toBe(true);
  });

  it("publishes distinct safety properties when business fields collide", () => {
    const operation = keyedOperation();
    operation.confirmation = { required: true, risk: "financial" };
    operation.input.params = [
      {
        name: "idempotency_key",
        in: "query",
        required: true,
        schema: { type: "string" },
        inferred: false,
      },
      {
        name: "confirm",
        in: "query",
        required: true,
        schema: { type: "string" },
        inferred: false,
      },
    ];
    operation.input.schema = operationInputSchema(operation);
    const validator = z.object(operationZodShape(operation));

    expect(
      validator.safeParse({
        idempotency_key: "business-key",
        confirm: "business-confirm",
        anvil_idempotency_key: "write-key",
        anvil_confirm: true,
      }).success,
    ).toBe(true);
    expect(
      validator.safeParse({
        idempotency_key: "business-key",
        confirm: "business-confirm",
      }).success,
    ).toBe(false);
  });

  it("retains modeled source constraints on the synthesized key", () => {
    const operation = keyedOperation();
    operation.input.params = [
      {
        name: "request_key",
        in: "query",
        required: true,
        schema: { type: "string", format: "uuid" },
        inferred: false,
      },
    ];
    operation.idempotency = {
      mode: "required",
      mechanism: "query",
      key: "request_key",
      keyDerivation: "client_supplied",
    };
    operation.input.schema = operationInputSchema(operation);
    const validator = z.object(operationZodShape(operation));

    expect(validator.safeParse({ idempotency_key: "not-a-uuid" }).success).toBe(false);
    expect(
      validator.safeParse({
        idempotency_key: "550e8400-e29b-41d4-a716-446655440000",
      }).success,
    ).toBe(true);
  });
});
