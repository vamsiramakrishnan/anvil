import { Operation as OperationSchema, operationInputSchema } from "@anvil/air";
import { exampleInput, generateMockRoutes } from "@anvil/generators";
import { operationZodShape } from "@anvil/mcp-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Synthesis ↔ serving agreement: `exampleInput` (what the loopback self-test
 * and the skill examples feed a tool) must validate against the SAME operation's
 * zod shape (what the generated MCP server enforces) — all three surfaces derive
 * from one AIR input schema, so a synthesized example a tool rejects is a
 * contract split, not a data problem. Each case here pins a shape that broke a
 * real corpus system before it was fixed.
 */

type BodySchema = Record<string, unknown>;

function opWithBody(schema: BodySchema, required = true) {
  const op = OperationSchema.parse({
    id: "svc.things.create",
    canonicalName: "create_thing",
    displayName: "Create thing",
    sourceRef: { kind: "openapi", path: "/things", method: "post" },
    effect: { kind: "mutation", resource: "thing", risk: "medium", reversible: true },
    input: {
      params: [],
      body: { contentType: "application/json", required, schema, projection: "whole", fields: [] },
    },
    idempotency: { mode: "none", mechanism: "none", keyDerivation: "none" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "svc things create" },
    mcp: { toolName: "svc_create_thing" },
    skill: { intentExamples: [] },
    state: "approved",
  });
  op.input.schema = operationInputSchema(op);
  return op;
}

function opWithParam(name: string, schema: BodySchema, required = false) {
  const op = OperationSchema.parse({
    id: "svc.things.list",
    canonicalName: "list_things",
    displayName: "List things",
    sourceRef: { kind: "openapi", path: "/things", method: "get" },
    effect: { kind: "read", resource: "thing", risk: "none", reversible: true },
    input: { params: [{ name, in: "query", required, schema, inferred: false }] },
    idempotency: { mode: "natural", mechanism: "none", keyDerivation: "none" },
    retries: { mode: "safe", maxAttempts: 3, backoff: "exponential", retryOn: [] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "svc things list" },
    mcp: { toolName: "svc_list_things" },
    skill: { intentExamples: [] },
    state: "approved",
  });
  op.input.schema = operationInputSchema(op);
  return op;
}

const accepts = (op: ReturnType<typeof opWithBody>) =>
  z.object(operationZodShape(op)).safeParse(exampleInput(op));

describe("synthesis ↔ zod shape agreement", () => {
  it("record/additionalProperties body synthesizes a representative map entry", () => {
    const op = opWithBody({ type: "object", additionalProperties: { type: "string" } });
    const args = exampleInput(op);
    expect(args.body).toEqual({ key: "example" });
    expect(accepts(op).success).toBe(true);
  });

  it("array-of-objects body synthesizes one element per array", () => {
    const op = opWithBody({
      type: "object",
      required: ["inputs"],
      properties: {
        inputs: {
          type: "array",
          items: { type: "object", properties: { id: { type: "string" } } },
        },
      },
    });
    const args = exampleInput(op) as { body: { inputs: unknown[] } };
    expect(args.body.inputs).toEqual([{ id: "example" }]);
    expect(accepts(op).success).toBe(true);
  });

  it("nested required arrays synthesize non-null (HubSpot batch bodies)", () => {
    // The HubSpot shape: `example: null` stamped on every schema, required
    // nested array + map fields. A null example is an annotation, not a value.
    const op = opWithBody({
      type: "object",
      required: ["inputs", "properties"],
      properties: {
        inputs: { type: "array", example: null, items: { type: "object" } },
        properties: {
          type: "object",
          additionalProperties: { type: "string", example: null },
          example: null,
        },
      },
    });
    const args = exampleInput(op) as { body: Record<string, unknown> };
    expect(args.body.inputs).toEqual([{}]);
    expect(args.body.properties).toEqual({ key: "example" });
    expect(accepts(op).success).toBe(true);
  });

  it("a base object refined by anyOf required-constraints stays an object (Intercom create-contact)", () => {
    const op = opWithBody({
      type: "object",
      properties: { email: { type: "string" }, role: { type: "string" } },
      anyOf: [{ required: ["email"] }, { required: ["role"] }],
    });
    const args = exampleInput(op) as { body: Record<string, unknown> };
    expect(args.body.email).toBe("example");
    expect(accepts(op).success).toBe(true);
  });

  it("oneOf without base structure takes the first branch", () => {
    const op = opWithBody({ oneOf: [{ type: "object", properties: { a: { type: "integer" } } }] });
    expect(exampleInput(op).body).toEqual({ a: 1 });
    expect(accepts(op).success).toBe(true);
  });

  it("a bare non-string enum is accepted as its literal value, not its spelling", () => {
    const op = opWithParam("page_size", { enum: [25, 50, 100] }, true);
    expect(exampleInput(op).page_size).toBe(25);
    expect(accepts(op).success).toBe(true);
  });

  it("a bare JSON string body flows through synthesis, zod, and the mock contract (Jira addWatcher)", () => {
    const op = opWithBody({ type: "string" });
    expect(exampleInput(op).body).toBe("example");
    expect(accepts(op).success).toBe(true);
    // The mock's routing table carries the top-level type so its validator
    // accepts the same non-object body the executor sends.
    const air = { operations: [op] } as unknown as Parameters<typeof generateMockRoutes>[0];
    const route = generateMockRoutes(air)[0];
    expect(route?.body?.schemaType).toBe("string");
  });

  it("an optional input that synthesizes null is omitted, never sent as null", () => {
    // zod models optional as ABSENT; an explicit null would be rejected.
    const op = opWithParam("filter", { example: null }, false);
    expect("filter" in exampleInput(op)).toBe(false);
    expect(accepts(op).success).toBe(true);
  });

  it("an all-optional message body synthesizes {} and stays valid (proto3-lowered ops)", () => {
    const op = opWithBody({ type: "object" });
    expect(exampleInput(op).body).toEqual({});
    expect(accepts(op).success).toBe(true);
  });
});
