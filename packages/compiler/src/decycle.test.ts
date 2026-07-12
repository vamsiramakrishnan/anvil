import { describe, expect, it } from "vitest";
import {
  bundleDocument,
  DEFAULT_MAX_REF_DEPTH,
  DEFAULT_MAX_SCHEMA_DEPTH,
  DEFAULT_MAX_SCHEMA_NODES,
  materializeSchema,
} from "./decycle.js";

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
      paths: {
        "/x": {
          get: { responses: { "200": { content: { "application/json": { schema: node } } } } },
        },
      },
    });
    expect(truncatedAt).toEqual([]); // not a cycle
    expect(depthLimitedAt.length).toBeGreaterThan(0);
    expect(() => JSON.stringify(document)).not.toThrow();
  });

  it("does NOT count ordinary OpenAPI wrapper nesting against the schema depth bound", () => {
    // paths -> /entries -> post -> requestBody -> content -> media-type -> schema
    // is 6 keys of pure document structure before any schema content begins —
    // a tiny 2-property schema at the end of that chain must not be truncated.
    const schema = {
      type: "object",
      properties: { amount: { type: "integer" }, memo: { type: "string" } },
    };
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
    expect(
      Object.keys(
        out.paths["/entries"].post.requestBody.content["application/json"].schema.properties,
      ),
    ).toEqual(["amount", "memo"]);
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
          "/charges": {
            get: {
              responses: { "200": { content: { "application/json": { schema: customer } } } },
            },
          },
          "/invoices": {
            get: {
              responses: { "200": { content: { "application/json": { schema: customer } } } },
            },
          },
        },
      };
      const { document } = bundleDocument(doc);
      const out = document as {
        components: { schemas: { customer: Record<string, unknown> } };
        paths: Record<
          string,
          {
            get: { responses: { "200": { content: { "application/json": { schema: unknown } } } } };
          }
        >;
      };
      // The one real definition still has its properties.
      expect(out.components.schemas.customer.properties).toEqual(customer.properties);
      // Every other use is a lightweight pointer, not a duplicated inline copy.
      expect(out.paths["/charges"].get.responses["200"].content["application/json"].schema).toEqual(
        {
          $ref: "#/components/schemas/customer",
        },
      );
      expect(
        out.paths["/invoices"].get.responses["200"].content["application/json"].schema,
      ).toEqual({
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
      const out = document as {
        components: { schemas: { Group: { properties: { subgroups: { items: unknown } } } } };
      };
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
        components: {
          schemas: { A: { properties: { b: unknown } }; B: { properties: { a: unknown } } };
        };
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
      const { document } = bundleDocument({ components: { schemas } });
      const out = document as {
        components: { schemas: Record<string, { properties: Record<string, unknown> }> };
      };
      // The correctness signal (not a brittle wall-clock threshold, which is
      // flaky under parallel CI load): every reference is a genuine `$ref`
      // POINTER, never an inlined copy. If the old full-inline behavior
      // regressed, `Type0.properties.Type1` would be a fully-expanded object
      // (and its subtree would fan out combinatorially — the original hang);
      // as a bounded bundle it is exactly one small pointer. Total document
      // size stays O(schemas²) pointer references, never O(inlined subtrees).
      expect(out.components.schemas.Type0?.properties.Type1).toEqual({
        $ref: "#/components/schemas/Type1",
      });
      // A whole-document sanity bound: 200×200 tiny `$ref` pointers, not
      // 200 fully-inlined copies of every other type (which would be MBs each).
      expect(JSON.stringify(document).length).toBeLessThan(4_000_000);
    });
  });

  describe("structural identity — collapse never depends on vendor-supplied names", () => {
    // These tests deliberately use components with NO titles anywhere, and
    // build the input the way `dereference()` shapes it: a fresh top-level
    // copy per acyclic reference site, in-memory sharing wherever a cycle
    // forces it. They must pass without `stampSchemaTitles` (parse.ts) — that
    // stamp is display metadata only.

    it("collapses UNTITLED mutually recursive components referenced from several paths", () => {
      const a: Record<string, unknown> = { type: "object", properties: {} };
      const b: Record<string, unknown> = { type: "object", properties: { a } };
      (a.properties as Record<string, unknown>).b = b;
      // dereference-shaped use sites: fresh top-level object per site, cyclic
      // interior shared with the component's real body.
      const use = () => ({ ...a });
      const build = () => ({
        components: { schemas: { A: a, B: b } },
        paths: {
          "/one": {
            get: { responses: { "200": { content: { "application/json": { schema: use() } } } } },
          },
          "/two": {
            get: { responses: { "200": { content: { "application/json": { schema: use() } } } } },
          },
          "/three": {
            post: {
              requestBody: { content: { "application/json": { schema: use() } } },
              responses: {},
            },
          },
        },
      });
      const { document, truncatedAt } = bundleDocument(build());
      expect(truncatedAt).toEqual([]);
      expect(() => JSON.stringify(document)).not.toThrow();
      const out = document as {
        components: {
          schemas: { A: { properties: { b: unknown } }; B: { properties: { a: unknown } } };
        };
        paths: Record<
          string,
          Record<
            string,
            {
              responses?: Record<string, { content: Record<string, { schema: unknown }> }>;
              requestBody?: { content: Record<string, { schema: unknown }> };
            }
          >
        >;
      };
      const aRef = { $ref: "#/components/schemas/A" };
      expect(
        out.paths["/one"]?.get?.responses?.["200"]?.content["application/json"]?.schema,
      ).toEqual(aRef);
      expect(
        out.paths["/two"]?.get?.responses?.["200"]?.content["application/json"]?.schema,
      ).toEqual(aRef);
      expect(out.paths["/three"]?.post?.requestBody?.content["application/json"]?.schema).toEqual(
        aRef,
      );
      // The recursion itself is ordinary $refs, so the whole document is tiny.
      expect(out.components.schemas.A.properties.b).toEqual({ $ref: "#/components/schemas/B" });
      expect(out.components.schemas.B.properties.a).toEqual(aRef);
      expect(JSON.stringify(document).length).toBeLessThan(2_000);
      // Determinism: bundling an identically-built input twice is deep-equal.
      expect(bundleDocument(build()).document).toEqual(document);
    });

    it("collapses the same UNTITLED body deep-CLONED (fresh identity) at 3 sites into one $ref", () => {
      const node = {
        type: "object",
        properties: { id: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
      };
      const doc = {
        components: { schemas: { Node: node } },
        paths: {
          "/a": {
            get: {
              responses: {
                "200": { content: { "application/json": { schema: structuredClone(node) } } },
              },
            },
          },
          "/b": {
            get: {
              responses: {
                "200": { content: { "application/json": { schema: structuredClone(node) } } },
              },
            },
          },
          // A clone nested inside an anonymous wrapper schema collapses too.
          "/c": {
            post: {
              requestBody: {
                content: {
                  "application/json": {
                    schema: { type: "object", properties: { child: structuredClone(node) } },
                  },
                },
              },
              responses: {},
            },
          },
        },
      };
      const { document } = bundleDocument(doc);
      const out = document as {
        paths: Record<
          string,
          Record<
            string,
            {
              responses?: Record<string, { content: Record<string, { schema: unknown }> }>;
              requestBody?: {
                content: Record<string, { schema: { properties: { child: unknown } } }>;
              };
            }
          >
        >;
      };
      const ref = { $ref: "#/components/schemas/Node" };
      expect(out.paths["/a"]?.get?.responses?.["200"]?.content["application/json"]?.schema).toEqual(
        ref,
      );
      expect(out.paths["/b"]?.get?.responses?.["200"]?.content["application/json"]?.schema).toEqual(
        ref,
      );
      expect(
        out.paths["/c"]?.post?.requestBody?.content["application/json"]?.schema.properties.child,
      ).toEqual(ref);
    });

    it("resolves structurally identical ALIASES to the lexicographically smallest name, deterministically", () => {
      const body = () => ({ type: "object", properties: { id: { type: "string" } } });
      const build = () => ({
        components: { schemas: { Beta: body(), Alpha: body() } },
        paths: {
          "/x": {
            get: { responses: { "200": { content: { "application/json": { schema: body() } } } } },
          },
        },
      });
      const first = bundleDocument(build());
      const second = bundleDocument(build());
      expect(second.document).toEqual(first.document);
      const out = first.document as {
        components: {
          schemas: { Alpha: { properties?: unknown }; Beta: { properties?: unknown } };
        };
        paths: {
          "/x": {
            get: { responses: { "200": { content: { "application/json": { schema: unknown } } } } };
          };
        };
      };
      // Documented alias policy: no title matches a candidate name, so the
      // lexicographically smallest name wins.
      expect(out.paths["/x"].get.responses["200"].content["application/json"].schema).toEqual({
        $ref: "#/components/schemas/Alpha",
      });
      // Neither alias definition is hollowed out into a bare self/alias $ref.
      expect(out.components.schemas.Alpha.properties).toBeDefined();
      expect(out.components.schemas.Beta.properties).toBeDefined();
    });

    it("prefers the alias whose name equals the shared body's own title", () => {
      const body = () => ({ title: "Zed", type: "object", properties: { id: { type: "string" } } });
      const doc = {
        components: { schemas: { Alpha: body(), Zed: body() } },
        paths: {
          "/x": {
            get: { responses: { "200": { content: { "application/json": { schema: body() } } } } },
          },
        },
      };
      const { document } = bundleDocument(doc);
      const out = document as {
        paths: {
          "/x": {
            get: { responses: { "200": { content: { "application/json": { schema: unknown } } } } };
          };
        };
      };
      // "Alpha" sorts first, but the body says it IS "Zed" — the title-named
      // alias is the deterministic pick when it matches a candidate name.
      expect(out.paths["/x"].get.responses["200"].content["application/json"].schema).toEqual({
        $ref: "#/components/schemas/Zed",
      });
    });

    it("scale guard: ~400 UNTITLED components, ~15 cross-refs each incl. back-edge cycles, no title stamp", () => {
      // The GitHub-GraphQL-shape regression test: a big, connection-style
      // cyclic graph whose components carry no titles at all. Before
      // structural identity this was a live bomb (the compile hung until
      // parse.ts band-aided titles on); it must now bundle fast and stay
      // proportional to unique structure.
      const N = 400;
      const FAN = 15;
      const nameAt = (i: number) => `C${String(i).padStart(3, "0")}`;
      const bodies: Record<string, unknown>[] = [];
      const props: Record<string, unknown>[] = [];
      for (let i = 0; i < N; i++) {
        // Each type carries a distinguishing FIELD (like real types do):
        // `description` is an annotation and deliberately excluded from
        // structural identity (reference sites override it), so a fixture
        // distinguished ONLY by description would be a mesh of genuine
        // structural aliases — realistic types differ by field names.
        const p: Record<string, unknown> = { [`id_${i}`]: { type: "string" } };
        props.push(p);
        bodies.push({ type: "object", description: `component ${i}`, properties: p });
      }
      for (let i = 0; i < N; i++) {
        const p = props[i] as Record<string, unknown>;
        for (let j = 1; j <= FAN; j++) {
          // Wraps around N, so the graph is one dense mesh of long cycles.
          // dereference-shaped: fresh top-level copy per reference site,
          // cyclic interior shared with the target component's real body.
          p[`f${j}`] = { ...(bodies[(i + j * 7) % N] as Record<string, unknown>) };
        }
      }
      const schemas: Record<string, unknown> = {};
      for (let i = 0; i < N; i++) schemas[nameAt(i)] = bodies[i];
      const doc = {
        components: { schemas },
        paths: {
          "/root": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/json": { schema: { ...(bodies[0] as Record<string, unknown>) } },
                  },
                },
              },
            },
          },
        },
      };
      const start = Date.now();
      const { document } = bundleDocument(doc);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(5_000);
      const json = JSON.stringify(document);
      // Proportional to unique structure: N bodies × FAN tiny $ref pointers,
      // never an inlined (let alone re-inlined) subtree.
      expect(json.length).toBeLessThan(1_000_000);
      const out = document as {
        components: { schemas: Record<string, { properties: Record<string, unknown> }> };
        paths: {
          "/root": {
            get: { responses: { "200": { content: { "application/json": { schema: unknown } } } } };
          };
        };
      };
      expect(out.components.schemas.C000?.properties.f1).toEqual({
        $ref: `#/components/schemas/${nameAt(7)}`,
      });
      expect(out.components.schemas.C399?.properties.f15).toEqual({
        $ref: `#/components/schemas/${nameAt((399 + 15 * 7) % N)}`,
      });
      expect(out.paths["/root"].get.responses["200"].content["application/json"].schema).toEqual({
        $ref: "#/components/schemas/C000",
      });
    });

    it("collapses clones that diverge from their component ONLY by description (dereference site-merge)", () => {
      // The verified real-world miss (GitHub's 1.5MB GraphQL SDL): dereference
      // merges each reference SITE's description onto the resolved clone, so
      // 2,660 of 3,868 inlined component copies differed from their component
      // body only in `description`. Identity must ignore that annotation.
      const body = () => ({
        type: "object",
        properties: {
          id: { type: "string" },
          node: { type: "object", properties: { total: { type: "integer" } } },
        },
      });
      const site = (description: string) => ({ ...body(), description });
      const doc = {
        components: { schemas: { Connection: { ...body(), description: "A paginated list." } } },
        paths: {
          "/a": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: site("A list of repositories the user is watching."),
                    },
                  },
                },
              },
            },
          },
          "/b": {
            get: {
              responses: {
                "200": { content: { "application/json": { schema: site("A list of users.") } } },
              },
            },
          },
        },
      };
      const { document } = bundleDocument(doc);
      const out = document as {
        paths: Record<
          string,
          {
            get: { responses: { "200": { content: { "application/json": { schema: unknown } } } } };
          }
        >;
      };
      const ref = { $ref: "#/components/schemas/Connection" };
      expect(out.paths["/a"]?.get.responses["200"].content["application/json"].schema).toEqual(ref);
      expect(out.paths["/b"]?.get.responses["200"].content["application/json"].schema).toEqual(ref);
    });

    it("hoists a LARGE repeated anonymous structure so output TREE size stays proportional to unique structure", () => {
      // The second real failure shape from adapter-lowered documents: a large
      // ANONYMOUS structure (no component to collapse to — e.g. GraphQL args/
      // request-body schemas emitted inline per operation) shared in memory at
      // many positions. The walk memo used to return the SAME output object at
      // each position — a compact DAG that JSON.stringify expands into a full
      // copy per position (GitHub: 23,502 distinct nodes → >10.5M tree
      // positions, "Invalid string length"). Hard law: bundled output TREE
      // size (counted WITHOUT dedupe) stays bounded.
      const big: Record<string, unknown> = { type: "object", properties: {} };
      for (let i = 0; i < 40; i++) {
        (big.properties as Record<string, unknown>)[`field${i}`] = {
          type: "object",
          properties: { value: { type: "string" }, count: { type: "integer" } },
        };
      }
      const SITES = 30;
      const paths: Record<string, unknown> = {};
      for (let i = 0; i < SITES; i++) {
        // The SAME object at every site (in-memory sharing, as dereference
        // produces for cyclic/adapter-lowered graphs). No components at all.
        paths[`/op${i}`] = {
          post: {
            requestBody: { content: { "application/json": { schema: big } } },
            responses: {},
          },
        };
      }
      const build = () => ({ paths });
      const first = bundleDocument(build());
      // Tree-size count without dedupe — what serialization actually pays.
      const treeCount = (v: unknown, cap: number): number => {
        let n = 0;
        const stack: unknown[] = [v];
        while (stack.length > 0) {
          const x = stack.pop();
          if (x === null || typeof x !== "object") continue;
          n++;
          if (n >= cap) return n;
          const kids = Array.isArray(x) ? x : Object.values(x);
          for (const k of kids) stack.push(k);
        }
        return n;
      };
      const oneCopy = treeCount(big, 100_000);
      const total = treeCount(first.document, 1_000_000);
      // Without hoisting this would be ≈ SITES × oneCopy (≈3,700+); with it,
      // the structure is defined once (plus its first inline emission) and
      // every other site is a $ref pointer.
      expect(total).toBeLessThan(3 * oneCopy + 20 * SITES);
      expect(() => JSON.stringify(first.document)).not.toThrow();
      // The hoist is visible and deterministic: a synthesized component with
      // a `<nearest-title-or-key>_<hash8>` name now holds the definition.
      expect(first.synthesized.length).toBeGreaterThan(0);
      const synthName = first.synthesized[0]?.name as string;
      expect(synthName).toMatch(/^[A-Za-z][A-Za-z0-9_.-]*_[0-9a-f]{8}$/);
      const out = first.document as {
        components: { schemas: Record<string, { properties?: unknown }> };
        paths: Record<
          string,
          { post: { requestBody: { content: { "application/json": { schema: unknown } } } } }
        >;
      };
      expect(out.components.schemas[synthName]?.properties).toBeDefined();
      // Later sites reference it; the first site keeps its inline emission.
      expect(out.paths["/op29"]?.post.requestBody.content["application/json"].schema).toEqual({
        $ref: `#/components/schemas/${synthName}`,
      });
      // Determinism: same input shape → identical output, including synth names.
      const second = bundleDocument(build());
      expect(second.document).toEqual(first.document);
      expect(second.synthesized).toEqual(first.synthesized);
    });

    it("hoists repeats whose clones diverge only by depth-truncation position (identity from INPUT, not output)", () => {
      // Two positions reach the same shared structure at different depths, so
      // their EMITTED expansions differ (one is closer to the depth budget and
      // truncates earlier). Identity is computed on the INPUT graph before any
      // truncation, so the repeat still deduplicates to one definition.
      const big: Record<string, unknown> = { type: "object", properties: {} };
      for (let i = 0; i < 30; i++) {
        (big.properties as Record<string, unknown>)[`f${i}`] = {
          type: "object",
          properties: { deep: { type: "object", properties: { leaf: { type: "string" } } } },
        };
      }
      // Site A: at schema root. Site B: nested several anonymous levels down.
      let nested: Record<string, unknown> = big;
      for (let i = 0; i < 4; i++) nested = { type: "object", properties: { [`wrap${i}`]: nested } };
      const doc = {
        paths: {
          "/direct": {
            get: { responses: { "200": { content: { "application/json": { schema: big } } } } },
          },
          "/nested": {
            get: { responses: { "200": { content: { "application/json": { schema: nested } } } } },
          },
          "/again": {
            get: { responses: { "200": { content: { "application/json": { schema: big } } } } },
          },
        },
      };
      const { document, synthesized } = bundleDocument(doc);
      expect(() => JSON.stringify(document)).not.toThrow();
      expect(synthesized.length).toBeGreaterThan(0);
      const synthName = synthesized[0]?.name as string;
      const out = document as {
        components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
      };
      // The synthesized definition is walked fresh from depth 0 — full
      // fidelity, not whatever truncation the triggering position had.
      const definition = out.components.schemas[synthName];
      expect(definition?.properties?.f0).toBeDefined();
      expect(definition?.properties?.f29).toBeDefined();
    });

    it("bundling the same cyclic input twice produces deep-equal output (determinism)", () => {
      const build = () => {
        const item: Record<string, unknown> = { type: "object", properties: {} };
        const page: Record<string, unknown> = {
          type: "object",
          properties: { items: { type: "array", items: item } },
        };
        (item.properties as Record<string, unknown>).parent = page; // cycle, shared
        return {
          components: { schemas: { Item: item, Page: page } },
          paths: {
            "/pages": {
              get: {
                responses: { "200": { content: { "application/json": { schema: { ...page } } } } },
              },
            },
          },
        };
      };
      const first = bundleDocument(build());
      const second = bundleDocument(build());
      expect(second.document).toEqual(first.document);
      expect(second.truncatedAt).toEqual(first.truncatedAt);
      expect(second.depthLimitedAt).toEqual(first.depthLimitedAt);
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
    const { schema, refDepthLimitedAt } = materializeSchema(
      { $ref: "#/components/schemas/customer" },
      namedSchemas,
    );
    expect(schema).toEqual(namedSchemas.customer);
    expect(refDepthLimitedAt).toEqual([]);
  });

  it("resolves nested $refs inside properties, transitively, when given room", () => {
    const namedSchemas = {
      charge: {
        type: "object",
        properties: { customer: { $ref: "#/components/schemas/customer" } },
      },
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
      charge: {
        type: "object",
        properties: { customer: { $ref: "#/components/schemas/customer" } },
      },
      customer: { type: "object", properties: { id: { type: "string" } } },
    };
    const { schema, refDepthLimitedAt } = materializeSchema(
      { $ref: "#/components/schemas/charge" },
      namedSchemas,
    );
    const out = schema as {
      properties: { customer: { properties?: unknown; type?: string; description?: string } };
    };
    expect(out.properties.customer.properties).toBeUndefined();
    expect(out.properties.customer.description).toContain("customer");
    expect(refDepthLimitedAt.length).toBe(1);
  });

  it("truncates a genuine cycle among named schemas instead of infinitely recursing", () => {
    const namedSchemas = {
      Group: {
        type: "object",
        properties: { subgroups: { type: "array", items: { $ref: "#/components/schemas/Group" } } },
      },
    };
    const { schema, refDepthLimitedAt } = materializeSchema(
      { $ref: "#/components/schemas/Group" },
      namedSchemas,
    );
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

  it("bounds a very BROAD schema by node budget, not just ref depth (DocuSign's real shape)", () => {
    // The ref-depth bound caps a deep chain, but a single hop into a schema with
    // hundreds of properties — each itself a large object — still explodes:
    // DocuSign's `tabs`/`accountSettingsInformation` materialized to ~2.5MB PER
    // operation, and 414 of those made a 400MB AIR that took airToYaml 30s+.
    // Build one such broad schema: 500 properties, each a 20-field object.
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) {
      const fields: Record<string, unknown> = {};
      for (let j = 0; j < 20; j++) fields[`f${j}`] = { type: "string" };
      wide[`prop${i}`] = { type: "object", properties: fields };
    }
    const broad = { type: "object", properties: wide };
    const small = materializeSchema(broad, {}, DEFAULT_MAX_REF_DEPTH, 200);
    // Truncation is reported, not silent, and the output is a fraction of the input.
    expect(small.nodeBudgetLimitedAt.length).toBeGreaterThan(0);
    expect(JSON.stringify(small.schema).length).toBeLessThan(JSON.stringify(broad).length / 3);
    // A property reached AFTER the budget was spent keeps its name but its value
    // is a shallow stub — the deep 20-field body is gone, not re-expanded.
    const out = small.schema as { properties: Record<string, { properties?: unknown }> };
    expect(out.properties.prop499).toBeDefined(); // name preserved
    expect(out.properties.prop499.properties).toBeUndefined(); // body truncated
    // Still valid JSON (no cycles, no dangling structure).
    expect(() => JSON.stringify(small.schema)).not.toThrow();
  });

  it("leaves a normal-sized schema untouched by the node budget (real specs top out ~1000 nodes)", () => {
    // A realistic operation schema (PagerDuty's largest is ~1000 nodes) must be
    // byte-identical with or without the budget — the budget only fires on
    // pathological breadth, never on legitimate schemas.
    const namedSchemas = {
      item: { type: "object", properties: { a: { type: "string" }, b: { type: "integer" } } },
    };
    const ref = { $ref: "#/components/schemas/item" };
    const withBudget = materializeSchema(ref, namedSchemas, 1, DEFAULT_MAX_SCHEMA_NODES);
    const noBudget = materializeSchema(ref, namedSchemas, 1, Number.MAX_SAFE_INTEGER);
    expect(withBudget.schema).toEqual(noBudget.schema);
    expect(withBudget.nodeBudgetLimitedAt).toEqual([]);
  });
});
