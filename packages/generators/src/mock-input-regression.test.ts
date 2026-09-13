import { materializeSchemaBranches } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { exampleFromSchema } from "./mock.js";
import { patternExample } from "./mock-pattern.js";

describe("real corpus input witnesses", () => {
  it.each([
    "^[{]?[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}[}]?$",
    "[0-9A-Z]{2}",
    "^[A-Z]{3}$",
  ])("synthesizes a validated witness for %s", (pattern) => {
    expect(new RegExp(pattern).test(patternExample(pattern)!)).toBe(true);
  });
  it("selects one required-only union branch and preserves literal discriminators", () => {
    const schema = {
      type: "object",
      properties: { page_id: { type: "string" }, database_id: { type: "string" } },
      oneOf: [{ required: ["page_id"] }, { required: ["database_id"] }],
    };
    const input = exampleFromSchema(schema);
    expect(input).toEqual({ page_id: "example" });
    expect(
      z
        .fromJSONSchema(materializeSchemaBranches(schema) as Parameters<typeof z.fromJSONSchema>[0])
        .safeParse(input).success,
    ).toBe(true);
    expect(exampleFromSchema({ type: "string", const: "page_id" })).toBe("page_id");
    expect(
      z
        .fromJSONSchema(materializeSchemaBranches(schema) as Parameters<typeof z.fromJSONSchema>[0])
        .safeParse({ page_id: "page", database_id: "database" }).success,
    ).toBe(false);
  });
  it("preserves explicit closed branches and boolean property schemas", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" }, allowed: true, denied: false },
      oneOf: [
        { properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false },
      ],
    };
    expect(materializeSchemaBranches(schema)).toEqual(schema);
  });
});
