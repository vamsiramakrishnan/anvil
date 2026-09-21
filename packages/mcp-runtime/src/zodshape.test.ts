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

  it("publishes a compositor body the importer accepts, with its rule intact", () => {
    // An `xsd:choice` reaches here as a whole-projection body carrying a
    // `oneOf`. Registering the tool builds a validator from it, so an encoding
    // the importer refuses (`not` outside the `{ not: {} }` never-form) takes
    // the server down at startup for every operation, not just this one — and
    // one whose alternatives lose their sibling property types admits the
    // cross-branch mixture the choice exists to forbid.
    const absent = { not: {} };
    const operation = keyedOperation();
    operation.input.body = {
      contentType: "application/json",
      required: true,
      projection: "whole",
      fields: [],
      schema: {
        type: "object",
        properties: {
          card: { type: "string" },
          routing: { type: "string" },
          wire: { type: "string" },
        },
        oneOf: [
          { required: ["card"], properties: { routing: absent, wire: absent } },
          { required: ["routing", "wire"], properties: { card: absent } },
        ],
      },
    };
    operation.input.schema = operationInputSchema(operation);
    const validator = z.object(operationZodShape(operation));
    const accepts = (body: unknown) => validator.safeParse({ body, idempotency_key: "k" }).success;

    expect(accepts({ card: "4111" })).toBe(true);
    expect(accepts({ routing: "021", wire: "w" })).toBe(true);
    expect(accepts({ routing: "021" })).toBe(false);
    expect(accepts({ card: "4111", routing: "021", wire: "w" })).toBe(false);
    expect(accepts({})).toBe(false);
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
