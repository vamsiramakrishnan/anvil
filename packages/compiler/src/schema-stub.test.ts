import { describe, expect, it } from "vitest";
import { bundleDocument, materializeSchema } from "./decycle.js";
import { SCHEMA_MAP_KEYS, truncateToStub } from "./schema-stub.js";

/**
 * Every value reachable at a "this must be a schema" position. A string here
 * is the exact shape that took the generated MCP server down: zod's
 * `fromJSONSchema` does `'$id' in schema` and `in` throws on a primitive.
 */
function schemaSlotValues(
  node: unknown,
  path = "$",
  out: [string, unknown][] = [],
): [string, unknown][] {
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      schemaSlotValues(v, `${path}[${i}]`, out);
    });
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (SCHEMA_MAP_KEYS.has(k) && v !== null && typeof v === "object" && !Array.isArray(v)) {
      for (const [mk, mv] of Object.entries(v as Record<string, unknown>)) {
        out.push([`${path}.${k}.${mk}`, mv]);
        schemaSlotValues(mv, `${path}.${k}.${mk}`, out);
      }
      continue;
    }
    if (k === "items" || k === "additionalProperties" || k === "not") out.push([`${path}.${k}`, v]);
    schemaSlotValues(v, `${path}.${k}`, out);
  }
  return out;
}

describe("truncateToStub", () => {
  it("keeps a schema a schema", () => {
    expect(truncateToStub({ type: "object", properties: {} })).toMatchObject({ type: "object" });
    expect(truncateToStub({ type: "string" })).toHaveProperty("description");
  });

  it("keeps an array an array", () => {
    expect(truncateToStub(["repo", "read:org"])).toEqual([]);
  });

  it("collapses a map OF schemas to an empty map, never a described stub", () => {
    // A `properties` map is a container. Stamping `description` onto it would
    // mint a member literally named `description` whose value is a string —
    // invalid JSON Schema at a position that must hold a schema.
    const stub = truncateToStub({ name: { type: "string" }, id: { type: "string" } }, true);
    expect(stub).toEqual({});
    expect(stub).not.toHaveProperty("description");
  });
});

describe("truncation never emits a non-schema where a schema belongs", () => {
  /** A `properties` map deep enough that the depth bound lands inside it. */
  const deep = (levels: number): Record<string, unknown> => {
    let node: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < levels; i++) node = { type: "object", properties: { nested: node } };
    return node;
  };

  const assertNoStringSlots = (root: unknown, label: string): void => {
    for (const [where, value] of schemaSlotValues(root)) {
      expect(
        typeof value,
        `${label} ${where} must hold a schema, got ${JSON.stringify(value)}`,
      ).not.toBe("string");
    }
  };

  // The bound lands on a `properties` map or on the schema below it depending
  // on parity, so sweep both the nesting depth and the bound itself: one of
  // these combinations always stops exactly on a container.
  it("bundleDocument's depth bound leaves every schema slot an object", () => {
    let fired = 0;
    for (let levels = 2; levels <= 12; levels++) {
      for (let maxDepth = 2; maxDepth <= 9; maxDepth++) {
        const doc = {
          paths: { "/thing": { get: { responses: { "200": { schema: deep(levels) } } } } },
        };
        const { document, depthLimitedAt } = bundleDocument(doc, maxDepth);
        if (depthLimitedAt.length > 0) fired++;
        assertNoStringSlots(document, `levels=${levels} maxDepth=${maxDepth}`);
      }
    }
    expect(fired).toBeGreaterThan(0); // the bound really fired
  });

  it("materializeSchema's node budget leaves every schema slot an object", () => {
    let fired = 0;
    for (let levels = 2; levels <= 12; levels++) {
      for (let maxNodes = 2; maxNodes <= 24; maxNodes++) {
        const { schema, nodeBudgetLimitedAt } = materializeSchema(deep(levels), {}, 4, maxNodes);
        if (nodeBudgetLimitedAt.length > 0) fired++;
        assertNoStringSlots(schema, `levels=${levels} maxNodes=${maxNodes}`);
      }
    }
    expect(fired).toBeGreaterThan(0); // the budget really fired
  });
});
