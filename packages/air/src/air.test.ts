import { describe, expect, it } from "vitest";
import {
  airFromYaml,
  airToJson,
  airToYaml,
  cliFlag,
  evidenceConfidence,
  kebabCase,
  loadAirDocument,
  type Operation,
  operationInputSchema,
  propKey,
  snakeCase,
} from "./index.js";

const refundOp = {
  id: "payments.refund.create",
  canonicalName: "create_refund",
  displayName: "Create refund",
  description: "Creates a refund for a captured payment.",
  sourceRef: { kind: "openapi", path: "/payments/{payment_id}/refunds", method: "post" },
  effect: { kind: "mutation", resource: "refund", risk: "financial", reversible: false },
  input: {
    params: [
      { name: "paymentId", in: "path", required: true, schema: { type: "string" } },
      { name: "amount", in: "body", required: true, schema: { type: "integer", minimum: 1 } },
      { name: "currency", in: "body", required: true, schema: { type: "string" } },
    ],
  },
  idempotency: { mode: "required", mechanism: "header", key: "Idempotency-Key" },
  retries: { mode: "safe", maxAttempts: 3, backoff: "exponential_jitter", retryOn: ["http_429"] },
  confirmation: { required: true, risk: "financial" },
  auth: { type: "oauth2_client_credentials", scopes: ["payments.write"] },
  cli: { command: "payments refunds create" },
  mcp: { toolName: "payments_create_refund" },
  skill: { intentExamples: ["Refund payment pay_123 for 25 dollars."] },
};

const doc = {
  service: {
    id: "payments",
    version: "2026-07-09",
    source: { kind: "openapi", uri: "./payments.openapi.yaml" },
  },
  operations: [refundOp],
};

describe("naming", () => {
  it("derives snake, kebab, and cli flags consistently", () => {
    expect(snakeCase("paymentId")).toBe("payment_id");
    expect(kebabCase("paymentId")).toBe("payment-id");
    expect(propKey("Idempotency-Key")).toBe("idempotency_key");
    expect(cliFlag("paymentId")).toBe("--payment-id");
    expect(snakeCase("HTTPStatusCode")).toBe("http_status_code");
  });
});

describe("AirDocument", () => {
  it("applies defaults and validates structure", () => {
    const air = loadAirDocument(doc);
    expect(air.anvilVersion).toBe("0.1.0");
    const op = air.operations[0] as Operation;
    expect(op.state).toBe("generated");
    expect(op.effect.reversible).toBe(false);
    // No claims → derived confidence is 0 (there is no stored aggregate).
    expect(op.evidence.claims).toEqual([]);
    expect(evidenceConfidence(op.evidence)).toBe(0);
    expect(op.retries.baseDelayMs).toBe(200);
  });

  it("round-trips through YAML and JSON", () => {
    const air = loadAirDocument(doc);
    const back = airFromYaml(airToYaml(air));
    expect(back.operations[0]?.id).toBe("payments.refund.create");
    const json = JSON.parse(airToJson(air));
    expect(json.operations[0].mcp.toolName).toBe("payments_create_refund");
  });

  it("rejects unknown enum values", () => {
    const bad = structuredClone(doc) as { operations: { effect: { kind: string } }[] };
    bad.operations[0].effect.kind = "teleport";
    expect(() => loadAirDocument(bad)).toThrow();
  });
});

describe("operationInputSchema", () => {
  it("synthesizes idempotency_key and confirm as required for unsafe ops", () => {
    const air = loadAirDocument(doc);
    const schema = operationInputSchema(air.operations[0] as Operation);
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    const required = schema.required as string[];
    expect(required).toEqual(
      expect.arrayContaining(["payment_id", "amount", "currency", "idempotency_key", "confirm"]),
    );
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.confirm?.const).toBe(true);
    expect(props.idempotency_key?.type).toBe("string");
  });
});
