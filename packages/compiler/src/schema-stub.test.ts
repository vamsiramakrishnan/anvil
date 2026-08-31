import { describe, expect, it } from "vitest";
import { bundleDocument, materializeSchema } from "./decycle.js";
import { SCHEMA_MAP_KEYS, truncateToStub } from "./schema-stub.js";

/**
 * Every keyword whose value is a map of schemas, spelled out here on purpose:
 * deriving this from `SCHEMA_MAP_KEYS` would make these tests agree with the
 * implementation by construction and blind them to the failure that actually
 * matters — a keyword missing from that set. Kept in draft order: draft-04/07
 * (OpenAPI 3.0), then 2019-09/2020-12 (OpenAPI 3.1).
 */
const CONTAINER_KEYWORDS = [
  "properties",
  "patternProperties",
  "definitions",
  "dependencies",
  "$defs",
  "dependentSchemas",
] as const;

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
    if (
      (CONTAINER_KEYWORDS as readonly string[]).includes(k) &&
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
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
  it("SCHEMA_MAP_KEYS covers every container keyword", () => {
    // The guard Codex's finding asks for: a keyword the implementation forgets
    // is exactly the silent failure this whole change is about.
    expect([...CONTAINER_KEYWORDS].filter((k) => !SCHEMA_MAP_KEYS.has(k))).toEqual([]);
  });

  /** Nesting deep enough through `keyword` that the bound lands inside it. */
  const deep = (keyword: string, levels: number): Record<string, unknown> => {
    let node: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < levels; i++) node = { type: "object", [keyword]: { nested: node } };
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

  // The bound lands on a container or on the schema below it depending on
  // parity, so sweep nesting depth against the bound itself: one of these
  // combinations always stops exactly on a container. Every container keyword
  // gets the same sweep — `properties` passing proves nothing about the rest.
  it.each(CONTAINER_KEYWORDS)("bundleDocument's depth bound: %s", (keyword) => {
    let fired = 0;
    for (let levels = 2; levels <= 10; levels++) {
      for (let maxDepth = 2; maxDepth <= 9; maxDepth++) {
        const doc = {
          paths: { "/thing": { get: { responses: { "200": { schema: deep(keyword, levels) } } } } },
        };
        const { document, depthLimitedAt } = bundleDocument(doc, maxDepth);
        if (depthLimitedAt.length > 0) fired++;
        assertNoStringSlots(document, `${keyword} levels=${levels} maxDepth=${maxDepth}`);
      }
    }
    expect(fired).toBeGreaterThan(0); // the bound really fired
  });

  it.each(CONTAINER_KEYWORDS)("materializeSchema's node budget: %s", (keyword) => {
    let fired = 0;
    for (let levels = 2; levels <= 10; levels++) {
      for (let maxNodes = 2; maxNodes <= 24; maxNodes++) {
        const { schema, nodeBudgetLimitedAt } = materializeSchema(
          deep(keyword, levels),
          {},
          4,
          maxNodes,
        );
        if (nodeBudgetLimitedAt.length > 0) fired++;
        assertNoStringSlots(schema, `${keyword} levels=${levels} maxNodes=${maxNodes}`);
      }
    }
    expect(fired).toBeGreaterThan(0); // the budget really fired
  });

  it("keeps draft-07 `dependencies` array members arrays", () => {
    // `dependencies` is the mixed form: a member may be a string[] of property
    // names rather than a schema. Truncation must not turn one into an object.
    const doc = {
      paths: {
        "/t": {
          get: {
            responses: {
              "200": {
                schema: { type: "object", dependencies: { card: ["billing_address", "cvv"] } },
              },
            },
          },
        },
      },
    };
    for (let maxDepth = 1; maxDepth <= 6; maxDepth++) {
      const { document } = bundleDocument(doc, maxDepth);
      const dep = (document as Record<string, never>).paths["/t"].get.responses["200"].schema
        ?.dependencies?.card;
      if (dep !== undefined) expect(Array.isArray(dep), `maxDepth=${maxDepth}`).toBe(true);
    }
  });
});
