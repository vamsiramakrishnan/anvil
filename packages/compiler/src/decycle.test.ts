import { describe, expect, it } from "vitest";
import { bundleDocument, DEFAULT_MAX_SCHEMA_DEPTH, materializeSchema } from "./decycle.js";

describe("bundleDocument", () => {
  it("leaves an acyclic, shallow document untouched", () => {
    const doc = { a: { b: { c: 1 } }, list: [1, 2, 3] };
    const { document, truncatedAt, depthLimitedAt } = bundleDocument(doc);
    expect(document).toEqual(doc);
    expect(truncatedAt).toEqual([]);
    expect(depthLimitedAt).toEqual([]);
  });

  it("truncates a genuine self-referential ANONYMOUS cycle and reports its path", () => {
    // No components.schemas here — this cycle isn't reachable through a named
    // schema, so it falls back to the anonymous-structure safety net.
    const group: Record<string, unknown> = { type: "object", description: "a group" };
    group.subgroups = { type: "array", items: group }; // group -> subgroups -> group (real cycle)
    const { document, truncatedAt } = bundleDocument({ Group: group });
    expect(truncatedAt.length).toBeGreaterThan(0);
    expect(() => JSON.stringify(document)).not.toThrow();
    const doc = document as { Group: { subgroups: { items: { type: string } } } };
    expect(doc.Group.subgroups.items.type).toBe("object");
    expect((doc.Group.subgroups.items as { properties?: unknown }).properties).toBeUndefined();
  });

  it("does NOT truncate a diamond (same anonymous object reached twice, no cycle)", () => {
    const shared = { type: "string", description: "shared leaf" };
    const doc = { a: shared, b: shared, c: { nested: shared } };
    const { document, truncatedAt } = bundleDocument(doc);
    expect(truncatedAt).toEqual([]);
    const out = document as typeof doc;
    expect(out.a).toEqual(shared);
    expect(out.b).toEqual(shared);
    expect(out.c.nested).toEqual(shared);
  });

  it("bounds a very deep but finite, non-cyclic ANONYMOUS schema chain", () => {
    let node: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < DEFAULT_MAX_SCHEMA_DEPTH + 20; i++) {
      node = { type: "object", properties: { next: node } };
    }
    // Depth only counts once inside real schema content (the `schema` key) —
    // see the wrapper-structure test below for why that matters.
    const { document, depthLimitedAt, truncatedAt } = bundleDocument({
      paths: { "/x": { get: { responses: { "200": { content: { "application/json": { schema: node } } } } } } },
    });
    expect(truncatedAt).toEqual([]); // not a cycle
    expect(depthLimitedAt.length).toBeGreaterThan(0);
    expect(() => JSON.stringify(document)).not.toThrow();
  });

  it("does NOT count ordinary OpenAPI wrapper nesting against the schema depth bound", () => {
    // paths -> /entries -> post -> requestBody -> content -> media-type -> schema
    // is 6 keys of pure document structure before any schema content begins —
    // a tiny 2-property schema at the end of that chain must not be truncated.
    const schema = { type: "object", properties: { amount: { type: "integer" }, memo: { type: "string" } } };
    const doc = {
      paths: {
        "/entries": {
          post: { requestBody: { content: { "application/json": { schema } } }, responses: {} },
        },
      },
    };
    const { document, depthLimitedAt, truncatedAt } = bundleDocument(doc, 4);
    expect(truncatedAt).toEqual([]);
    expect(depthLimitedAt).toEqual([]);
    const out = document as typeof doc;
    expect(Object.keys(out.paths["/entries"].post.requestBody.content["application/json"].schema.properties)).toEqual(
      ["amount", "memo"],
    );
  });

  it("stays fast on a heavily cross-referential (diamond-rich) ANONYMOUS graph", () => {
    // Simulates the shape of the failure mode even without named schemas: N
    // objects that all reference each other, none individually a cycle, but
    // the fan-out compounds without memoization.
    const nodes: Record<string, Record<string, unknown>> = {};
    const names = Array.from({ length: 40 }, (_, i) => `n${i}`);
    for (const name of names) nodes[name] = { type: "object", properties: {} };
    for (const name of names) {
      const props = nodes[name]?.properties as Record<string, unknown>;
      for (const other of names) props[other] = nodes[other];
    }
    const start = Date.now();
    const { document } = bundleDocument({ root: nodes[0] });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
    expect(() => JSON.stringify(document)).not.toThrow();
  });

  describe("named component schemas — the real Stripe fix", () => {
    it("collapses every USE of a named schema to a $ref, keeping one full definition", () => {
      const customer = { type: "object", properties: { id: { type: "string" } } };
      const doc = {
        components: { schemas: { customer } },
        paths: {
          "/charges": { get: { responses: { "200": { content: { "application/json": { schema: customer } } } } } },
          "/invoices": { get: { responses: { "200": { content: { "application/json": { schema: customer } } } } } },
        },
      };
      const { document } = bundleDocument(doc);
      const out = document as {
        components: { schemas: { customer: Record<string, unknown> } };
        paths: Record<string, { get: { responses: { "200": { content: { "application/json": { schema: unknown } } } } } }>;
      };
      // The one real definition still has its properties.
      expect(out.components.schemas.customer.properties).toEqual(customer.properties);
      // Every other use is a lightweight pointer, not a duplicated inline copy.
      expect(out.paths["/charges"].get.responses["200"].content["application/json"].schema).toEqual({
        $ref: "#/components/schemas/customer",
      });
      expect(out.paths["/invoices"].get.responses["200"].content["application/json"].schema).toEqual({
        $ref: "#/components/schemas/customer",
      });
    });

    it("represents a self-referential named schema as an ordinary $ref — no truncation, no stub", () => {
      const group: Record<string, unknown> = { type: "object", properties: {} };
      (group.properties as Record<string, unknown>).subgroups = { type: "array", items: group };
      const doc = { components: { schemas: { Group: group } } };
      const { document, truncatedAt, depthLimitedAt } = bundleDocument(doc);
      expect(truncatedAt).toEqual([]);
      expect(depthLimitedAt).toEqual([]);
      const out = document as { components: { schemas: { Group: { properties: { subgroups: { items: unknown } } } } } };
      expect(out.components.schemas.Group.properties.subgroups.items).toEqual({
        $ref: "#/components/schemas/Group",
      });
    });

    it("resolves a cross-referential cycle among named schemas (A -> B -> A) as clean $refs", () => {
      const a: Record<string, unknown> = { type: "object", properties: {} };
      const b: Record<string, unknown> = { type: "object", properties: { a } };
      (a.properties as Record<string, unknown>).b = b;
      const doc = { components: { schemas: { A: a, B: b } } };
      const { document, truncatedAt } = bundleDocument(doc);
      expect(truncatedAt).toEqual([]);
      const out = document as {
        components: { schemas: { A: { properties: { b: unknown } }; B: { properties: { a: unknown } } } };
      };
      expect(out.components.schemas.A.properties.b).toEqual({ $ref: "#/components/schemas/B" });
      expect(out.components.schemas.B.properties.a).toEqual({ $ref: "#/components/schemas/A" });
    });

    it("stays fast and small on the real Stripe failure shape: many named schemas, all cross-referencing", () => {
      // This is the actual pattern that made anvil compile hang on Stripe's
      // real spec: ~860 named schemas, each referencing many others, with zero
      // true cycles. Cost must be O(schemas), not O(paths to a schema).
      const schemas: Record<string, Record<string, unknown>> = {};
      const names = Array.from({ length: 200 }, (_, i) => `Type${i}`);
      for (const name of names) schemas[name] = { type: "object", properties: {} };
      for (const name of names) {
        const props = schemas[name]?.properties as Record<string, unknown>;
        for (const other of names) props[other] = schemas[other];
      }
      const start = Date.now();
      const { document } = bundleDocument({ components: { schemas } });
      const elapsed = Date.now() - start;
      // This dense a fixture (every one of 200 types holding a property for
      // every other type) is the real regression signal on *time*, not size —
      // 200 schemas x 200 $ref pointers each is a legitimately ~2MB document
      // even with zero duplication. What must NOT happen is each of those
      // 40,000 references re-walking and re-cloning its target's own
      // (further cross-referential) subtree, which is what made this hang.
      expect(elapsed).toBeLessThan(1000);
      const out = document as { components: { schemas: Record<string, { properties: Record<string, unknown> }> } };
      // Every reference is a genuine $ref pointer, not an inlined copy.
      expect(out.components.schemas.Type0?.properties.Type1).toEqual({
        $ref: "#/components/schemas/Type1",
      });
    });
  });

  describe("collapseExpandable (vendor-declared expandable fields)", () => {
    it("collapses a Stripe-shaped `anyOf` + `x-expansionResources` field to its compact (string) form", () => {
      const customerObject = { type: "object", properties: { id: { type: "string" } } };
      const field = {
        description: "ID of the customer this charge is for.",
        nullable: true,
        anyOf: [{ type: "string", maxLength: 5000 }, customerObject],
        "x-expansionResources": { oneOf: [customerObject] },
      };
      const { document } = bundleDocument({ charge: { properties: { customer: field } } });
      const out = document as {
        charge: { properties: { customer: Record<string, unknown> } };
      };
      const collapsed = out.charge.properties.customer;
      expect(collapsed.anyOf).toBeUndefined();
      expect(collapsed["x-expansionResources"]).toBeUndefined();
      expect(collapsed.type).toBe("string");
      expect(collapsed.maxLength).toBe(5000);
      expect(collapsed.description).toContain("expand");
      expect(collapsed.nullable).toBe(true);
    });

    it("leaves an ordinary anyOf/oneOf alone when there is no x-expansionResources marker", () => {
      const field = { anyOf: [{ type: "string" }, { type: "integer" }] };
      const { document } = bundleDocument({ f: field });
      expect(document).toEqual({ f: field });
    });

    it("leaves an anyOf alone when x-expansionResources doesn't match any of its alternatives", () => {
      const unrelated = { type: "object", properties: { z: { type: "string" } } };
      const field = {
        anyOf: [{ type: "string" }, { type: "integer" }],
        "x-expansionResources": { oneOf: [unrelated] },
      };
      const { document } = bundleDocument({ f: field });
      const out = document as { f: Record<string, unknown> };
      expect(out.f.anyOf).toBeDefined();
    });
  });
});

describe("materializeSchema", () => {
  it("resolves a $ref back into a full, self-contained schema", () => {
    const namedSchemas = { customer: { type: "object", properties: { id: { type: "string" } } } };
    const { schema, refDepthLimitedAt } = materializeSchema({ $ref: "#/components/schemas/customer" }, namedSchemas);
    expect(schema).toEqual(namedSchemas.customer);
    expect(refDepthLimitedAt).toEqual([]);
  });

  it("resolves nested $refs inside properties, transitively, when given room", () => {
    const namedSchemas = {
      charge: { type: "object", properties: { customer: { $ref: "#/components/schemas/customer" } } },
      customer: { type: "object", properties: { id: { type: "string" } } },
    };
    // Explicit depth 2: hop 1 resolves `charge`, hop 2 resolves its `customer` ref.
    const { schema } = materializeSchema({ $ref: "#/components/schemas/charge" }, namedSchemas, 2);
    const out = schema as { properties: { customer: { properties: { id: unknown } } } };
    expect(out.properties.customer.properties.id).toEqual({ type: "string" });
  });

  it("stops at the default depth (1 hop): a nested named-type field becomes a small typed stub, not a further expansion", () => {
    // This is the real, measured default — see DEFAULT_MAX_REF_DEPTH's doc
    // comment: a single real Stripe operation hit 50MB at depth 3, because
    // each hop's newly-reached distinct schemas grow ~100x. Depth 1 is enough
    // for a caller to see an operation's own real fields; a field that is
    // itself another named type gets an honest "this is a Customer object"
    // stub instead of continuing to expand.
    const namedSchemas = {
      charge: { type: "object", properties: { customer: { $ref: "#/components/schemas/customer" } } },
      customer: { type: "object", properties: { id: { type: "string" } } },
    };
    const { schema, refDepthLimitedAt } = materializeSchema({ $ref: "#/components/schemas/charge" }, namedSchemas);
    const out = schema as { properties: { customer: { properties?: unknown; type?: string; description?: string } } };
    expect(out.properties.customer.properties).toBeUndefined();
    expect(out.properties.customer.description).toContain("customer");
    expect(refDepthLimitedAt.length).toBe(1);
  });

  it("truncates a genuine cycle among named schemas instead of infinitely recursing", () => {
    const namedSchemas = {
      Group: { type: "object", properties: { subgroups: { type: "array", items: { $ref: "#/components/schemas/Group" } } } },
    };
    const { schema, refDepthLimitedAt } = materializeSchema({ $ref: "#/components/schemas/Group" }, namedSchemas);
    expect(() => JSON.stringify(schema)).not.toThrow();
    expect(refDepthLimitedAt.length).toBeGreaterThan(0);
  });

  it("leaves an unresolvable $ref alone rather than silently dropping it", () => {
    const { schema } = materializeSchema({ $ref: "#/components/schemas/doesNotExist" }, {});
    expect(schema).toEqual({ $ref: "#/components/schemas/doesNotExist" });
  });

  it("passes through a schema with no $refs unchanged", () => {
    const plain = { type: "string", description: "just a string" };
    const { schema } = materializeSchema(plain, {});
    expect(schema).toEqual(plain);
  });
});
