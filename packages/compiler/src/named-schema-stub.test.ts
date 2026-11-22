import { describe, expect, it } from "vitest";
import { materializeSchema } from "./decycle.js";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const genericTruncationNote =
  "nested reference truncated by Anvil to keep the schema JSON-safe and bounded";

function expectNamedStub(value: unknown, name: string, type?: string): void {
  const stub = value as Record<string, unknown>;
  expect(stub.type).toBe(type);
  expect(stub).not.toHaveProperty("$ref");
  expect(stub).not.toHaveProperty("properties");
  expect(stub.description).toContain(`'${name}'`);
  expect(stub.description).toContain("bounded");
  expect(stub.description).toContain("full fields");
  // The named explanation already describes the cut and its full definition.
  // Appending the generic explanation repeats compiler prose at every use.
  expect(stub.description).not.toContain(genericTruncationNote);
}

describe("named schema truncation annotations", () => {
  it.each([
    "object",
    "array",
    "string",
    undefined,
  ])("keeps the name and declared type (%s) with one explanation at a depth boundary", (type) => {
    const child = type ? { type } : { oneOf: [{ type: "string" }, { type: "number" }] };
    const named = {
      Parent: { type: "object", properties: { child: ref("Child") } },
      Child: child,
    };
    const original = structuredClone(named);
    const result = materializeSchema(ref("Parent"), named);
    const schema = result.schema as { properties: { child: unknown } };

    expectNamedStub(schema.properties.child, "Child", type);
    expect(result.refDepthLimitedAt).toHaveLength(1);
    expect(result.nodeBudgetLimitedAt).toEqual([]);
    expect(named).toEqual(original);
  });

  it("keeps a cycle cut named and diagnosed without repeating its explanation", () => {
    const named = { Node: { type: "object", properties: { next: ref("Node") } } };
    const result = materializeSchema(ref("Node"), named, 20);
    const schema = result.schema as { properties: { next: unknown } };

    expectNamedStub(schema.properties.next, "Node", "object");
    expect(result.refDepthLimitedAt).toHaveLength(1);
    expect(result.nodeBudgetLimitedAt).toEqual([]);
    expect(() => JSON.stringify(schema)).not.toThrow();
  });

  it("keeps an unexpanded reference named after the node budget is exhausted", () => {
    const named = { Child: { type: "object", properties: { id: { type: "string" } } } };
    const source = { type: "object", properties: { child: ref("Child") } };
    const result = materializeSchema(source, named, 1, 2);
    const schema = result.schema as { properties: { child: unknown } };

    expectNamedStub(schema.properties.child, "Child", "object");
    expect(result.refDepthLimitedAt).toEqual([]);
    expect(result.nodeBudgetLimitedAt).toEqual(["$.properties.child"]);
  });

  it("still charges a repeated expansion against the node budget", () => {
    const child = { type: "object", properties: { id: { type: "string" } } };
    const source = {
      type: "object",
      properties: { first: ref("Child"), second: ref("Child") },
    };
    const result = materializeSchema(source, { Child: child }, 1, 9);
    const schema = result.schema as { properties: { first: unknown; second: unknown } };

    expect(schema.properties.first).toEqual(child);
    expectNamedStub(schema.properties.second, "Child", "object");
    expect(result.refDepthLimitedAt).toEqual([]);
    expect(result.nodeBudgetLimitedAt).toEqual(["$.properties.second"]);
  });

  it("retains the generic explanation and source description for an anonymous cut", () => {
    const source = {
      type: "object",
      properties: { child: { type: "string", description: "Declared source description." } },
    };
    const result = materializeSchema(source, {}, 1, 2);
    const schema = result.schema as { properties: { child: unknown } };

    expect(schema.properties.child).toEqual({
      type: "string",
      description: `Declared source description. (${genericTruncationNote})`,
    });
    expect(result.nodeBudgetLimitedAt).toEqual(["$.properties.child"]);
  });
});
