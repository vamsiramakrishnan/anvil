import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTPUT_SCHEMA_BUDGET_TOKENS,
  MCP_OUTPUT_VIEWS,
  outputResultProperties,
  publishedOutputSchema,
  publishedWorkflowOutputSchema,
} from "./output-schema.js";
import { type JsonSchema, Operation } from "./schema.js";

function operation(output: { schema?: JsonSchema; agentProjection?: unknown } = {}): Operation {
  return Operation.parse({
    id: "things.get",
    canonicalName: "get_thing",
    displayName: "Get thing",
    sourceRef: { kind: "openapi", path: "/things/{id}", method: "get" },
    effect: { kind: "read", action: "get", resource: "thing", risk: "none" },
    input: { params: [] },
    idempotency: { mode: "natural", mechanism: "none" },
    retries: { mode: "safe", maxAttempts: 3, backoff: "exponential", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "things get" },
    mcp: { toolName: "get_thing" },
    skill: { intentExamples: [] },
    state: "approved",
    output,
  });
}

const record: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    owner: { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
  },
  required: ["id"],
};

describe("publishedOutputSchema", () => {
  it("places a record's own fields at the top level, each optional, beside the reserved views", () => {
    const published = publishedOutputSchema(operation({ schema: record }));
    expect(published.omitted).toBeUndefined();
    const schema = published.schema as JsonSchema;
    expect(schema.type).toBe("object");
    expect(schema.required).toBeUndefined();
    const properties = schema.properties as Record<string, JsonSchema>;
    expect(Object.keys(properties)).toEqual([
      "id",
      "owner",
      MCP_OUTPUT_VIEWS.dryRun,
      MCP_OUTPUT_VIEWS.projection,
      MCP_OUTPUT_VIEWS.unvalidated,
    ]);
    // Nested strictness survives verbatim: only the TOP level is relaxed.
    expect(properties.owner?.required).toEqual(["email"]);
  });

  it("wraps a non-record response exactly as structuredContent does: under `result`", () => {
    const published = publishedOutputSchema(
      operation({ schema: { type: "array", items: { type: "string" } } }),
    );
    const properties = (published.schema as JsonSchema).properties as Record<string, JsonSchema>;
    expect(properties.result).toEqual({ type: "array", items: { type: "string" } });
    expect(properties[MCP_OUTPUT_VIEWS.dryRun]).toBeDefined();
  });

  it("mirrors outputResultProperties for both placements", () => {
    expect(outputResultProperties(operation({ schema: record }))).toEqual(record.properties);
    expect(outputResultProperties(operation({ schema: { type: "integer" } }))).toEqual({
      result: { type: "integer" },
    });
    expect(outputResultProperties(operation())).toBeUndefined();
  });

  it("declares nothing when there is no response schema", () => {
    expect(publishedOutputSchema(operation())).toEqual({ omitted: "absent" });
  });

  it("declares nothing when the served shape is an agent projection of the wire schema", () => {
    expect(
      publishedOutputSchema(
        operation({ schema: record, agentProjection: { rename: { id: "thing_id" } } }),
      ),
    ).toEqual({ omitted: "agent_projection" });
  });

  it("declares nothing for a schema too weak to check", () => {
    expect(publishedOutputSchema(operation({ schema: {} }))).toEqual({ omitted: "too_weak" });
    expect(publishedOutputSchema(operation({ schema: { type: "object" } }))).toEqual({
      omitted: "too_weak",
    });
    expect(
      publishedOutputSchema(operation({ schema: { type: "object", properties: {} } })),
    ).toEqual({ omitted: "too_weak" });
    expect(publishedOutputSchema(operation({ schema: { oneOf: [record] } }))).toEqual({
      omitted: "too_weak",
    });
  });

  it("omits — never trims — a schema over the token budget, and 0 disables publishing", () => {
    const wide: JsonSchema = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [
          `field_${i}`,
          { type: "string", description: `Field number ${i} of a very wide legacy record.` },
        ]),
      ),
    };
    expect(publishedOutputSchema(operation({ schema: wide }))).toEqual({
      omitted: "over_budget",
    });
    expect(publishedOutputSchema(operation({ schema: wide }), 100_000).schema).toBeDefined();
    expect(publishedOutputSchema(operation({ schema: record }), 0)).toEqual({
      omitted: "disabled",
    });
    expect(DEFAULT_OUTPUT_SCHEMA_BUDGET_TOKENS).toBe(400);
  });

  it("is a pure function of the contract: measured calibration never changes the decision", () => {
    const measured = operation({ schema: record });
    measured.disclosureCost = {
      toolTokens: 1,
      responseItemTokens: 0,
      responseTokens: 0,
      charsPerToken: 0.01,
      estimator: "test",
    };
    expect(publishedOutputSchema(measured)).toEqual(publishedOutputSchema(operation({ schema: record })));
  });
});

describe("publishedWorkflowOutputSchema", () => {
  it("keeps the last step's schema intact under `result` and adds the trace", () => {
    const published = publishedWorkflowOutputSchema(operation({ schema: record }));
    const properties = (published.schema as JsonSchema).properties as Record<string, JsonSchema>;
    expect(properties.result).toEqual(record);
    expect(properties.result?.required).toEqual(["id"]);
    expect(properties.trace?.type).toBe("string");
    expect(properties[MCP_OUTPUT_VIEWS.projection]).toBeDefined();
  });

  it("reports the same omissions as a single operation", () => {
    expect(publishedWorkflowOutputSchema(operation())).toEqual({ omitted: "absent" });
    expect(publishedWorkflowOutputSchema(operation({ schema: {} }))).toEqual({
      omitted: "too_weak",
    });
    expect(publishedWorkflowOutputSchema(operation({ schema: record }), 0)).toEqual({
      omitted: "disabled",
    });
  });
});
