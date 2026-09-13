import { expect, it } from "vitest";
import { materializeSchema } from "./decycle.js";

it("preserves compact discriminating oneOf contracts at a reference depth boundary", () => {
  const result = materializeSchema(
    { oneOf: [{ $ref: "#/components/schemas/Page" }, { $ref: "#/components/schemas/Database" }] },
    {
      Page: {
        type: "object",
        properties: { page_id: { type: "string", format: "uuid" } },
        required: ["page_id"],
      },
      Database: {
        type: "object",
        properties: { database_id: { type: "string", format: "uuid" } },
        required: ["database_id"],
      },
    },
    0,
  );
  const schema = result.schema as { oneOf: Array<{ required: string[] }> };
  expect(schema.oneOf.map((branch) => branch.required)).toEqual([["page_id"], ["database_id"]]);
  expect(result.refDepthLimitedAt).toEqual([]);
});
