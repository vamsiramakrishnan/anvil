import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.js";
import type { CompilerSource } from "./source/compiler-source.js";
import { computeSourceHash, deriveSnapshotId, type SourceInputFile } from "./source/hash.js";

/**
 * Two source formats that used to stop at one file, for reasons that were about
 * the tooling rather than the format.
 *
 * Swagger 2.0 spans files exactly as OpenAPI 3.x does; only the converter could
 * not follow them. A GraphQL schema is split across files more often than not,
 * and SDL has no import statement at all — composition *is* concatenation, so
 * reading the entrypoint alone compiles a Query type missing most of its
 * fields.
 */

const enc = (s: string) => new TextEncoder().encode(s);

function sourceOf(
  files: Record<string, string>,
  entrypoint: string,
  format: "swagger" | "graphql",
): CompilerSource {
  const inputs: SourceInputFile[] = Object.entries(files).map(([path, text]) => ({
    path,
    bytes: enc(text),
  }));
  const sourceHash = computeSourceHash(inputs);
  return {
    snapshotId: deriveSnapshotId(sourceHash),
    sourceHash,
    origin: { kind: "filesystem", uri: "./specs" },
    entrypoint: { path: entrypoint, format, version: format === "swagger" ? "2.0" : "1.0" },
    files: new Map(inputs.map((f) => [f.path, f.bytes])),
  };
}

const SWAGGER_ENTRY = `swagger: "2.0"
info: { title: Widgets, version: "1.0.0" }
host: widgets.example.com
basePath: /v1
schemes: [https]
paths:
  /widgets:
    get:
      operationId: listWidgets
      parameters:
        - $ref: './params.yaml#/parameters/PageSize'
      responses:
        "200":
          description: ok
          schema:
            type: array
            items: { $ref: './models.yaml#/definitions/Widget' }
    post:
      operationId: createWidget
      parameters:
        - name: body
          in: body
          required: true
          schema: { $ref: './models.yaml#/definitions/Widget' }
      responses:
        "201": { description: created }
`;

const SWAGGER_MODELS = `definitions:
  Widget:
    type: object
    required: [id]
    properties:
      id: { type: string }
      name: { type: string }
      owner: { $ref: './shared.yaml#/definitions/Owner' }
`;

const SWAGGER_SHARED = `definitions:
  Owner:
    type: object
    properties:
      email: { type: string }
`;

const SWAGGER_PARAMS = `parameters:
  PageSize:
    name: pageSize
    in: query
    type: integer
    required: false
`;

const swaggerFiles = {
  "api.yaml": SWAGGER_ENTRY,
  "models.yaml": SWAGGER_MODELS,
  "shared.yaml": SWAGGER_SHARED,
  "params.yaml": SWAGGER_PARAMS,
};

describe("multi-file Swagger 2.0", () => {
  it("pulls a schema, and its own transitive reference, across files", async () => {
    const air = await compileSource(sourceOf(swaggerFiles, "api.yaml", "swagger"), {
      serviceId: "widgets",
    });
    const create = air.operations.find((o) => o.canonicalName === "create_widget");
    const props = Object.keys(create?.input.body?.schema?.properties ?? {});
    // `Widget` came from models.yaml; `owner` came from shared.yaml through it.
    expect(props).toEqual(expect.arrayContaining(["id", "name", "owner"]));
  });

  it("pulls a shared parameter across files", async () => {
    const air = await compileSource(sourceOf(swaggerFiles, "api.yaml", "swagger"), {
      serviceId: "widgets",
    });
    const list = air.operations.find((o) => o.canonicalName === "list_widgets");
    expect(list?.input.params.map((p) => p.name)).toContain("pageSize");
  });

  it("keeps a self-referential definition a reference, not an inlined cycle", async () => {
    // The reason this bundles rather than dereferences. Resolving every `$ref`
    // would turn `Widget.children: [Widget]` into a genuine circular object, and
    // the 2.0 converter cannot walk one — it either throws or never terminates.
    const recursive = SWAGGER_MODELS.replace(
      "      owner: { $ref: './shared.yaml#/definitions/Owner' }",
      `      owner: { $ref: './shared.yaml#/definitions/Owner' }
      children:
        type: array
        items: { $ref: '#/definitions/Widget' }`,
    );
    const air = await compileSource(
      sourceOf({ ...swaggerFiles, "models.yaml": recursive }, "api.yaml", "swagger"),
      { serviceId: "widgets" },
    );
    const create = air.operations.find((o) => o.canonicalName === "create_widget");
    expect(Object.keys(create?.input.body?.schema?.properties ?? {})).toContain("children");
  });

  it("refuses a reference to a file the snapshot does not carry", async () => {
    // Caught by source-reference resolution, before the bundler ever runs.
    const { "models.yaml": _dropped, ...missing } = swaggerFiles;
    await expect(
      compileSource(sourceOf(missing, "api.yaml", "swagger"), { serviceId: "widgets" }),
    ).rejects.toThrow(/resolve source references/i);
  });

  it("refuses a reference into a file that exists but has no such definition", async () => {
    // The bundler's own refusal, and the only one that reaches it: the file
    // resolves, so nothing upstream objects, and a pointer at a definition that
    // is not there would otherwise be dropped in silence — shipping a surface
    // smaller than the source describes with nothing to say so.
    const dangling = SWAGGER_ENTRY.replace(
      "schema: { $ref: './models.yaml#/definitions/Widget' }",
      "schema: { $ref: './models.yaml#/definitions/Nope' }",
    );
    await expect(
      compileSource(sourceOf({ ...swaggerFiles, "api.yaml": dangling }, "api.yaml", "swagger"), {
        serviceId: "widgets",
      }),
    ).rejects.toThrow(/Swagger 2\.0 references.*definitions\/Nope/s);
  });
});

const SDL_ENTRY = `schema { query: Query, mutation: Mutation }
type Query { _ping: String }
type Mutation { _noop: String }
`;

const SDL_PRODUCT = `type Product { id: ID! name: String! }
extend type Query {
  product(id: ID!): Product
}
`;

const SDL_ORDER = `type Order { id: ID! total: Int! }
extend type Mutation { placeOrder(productId: ID!, quantity: Int!): Order }
`;

describe("multi-file GraphQL SDL", () => {
  const files = {
    "schema.graphql": SDL_ENTRY,
    "types/product.graphql": SDL_PRODUCT,
    "types/order.graphql": SDL_ORDER,
  };

  it("composes every SDL file in the snapshot into one schema", async () => {
    const air = await compileSource(sourceOf(files, "schema.graphql", "graphql"), {
      serviceId: "shop",
    });
    const names = air.operations.map((o) => o.sourceRef.path);
    expect(names).toContain("/graphql/Query/product");
    expect(names).toContain("/graphql/Mutation/placeOrder");
  });

  it("compiles a query document against types declared in another file", async () => {
    // The selection set is read from the composed schema, so a mutation in one
    // file returning a type from the same file still resolves its fields.
    const air = await compileSource(sourceOf(files, "schema.graphql", "graphql"), {
      serviceId: "shop",
    });
    const place = air.operations.find((o) => o.sourceRef.path === "/graphql/Mutation/placeOrder");
    const binding = place?.sourceRef.binding;
    expect(binding?.protocol).toBe("graphql");
    expect(binding?.protocol === "graphql" && binding.document).toContain(
      "placeOrder(productId: $productId, quantity: $quantity) { id total }",
    );
  });

  it("is order-independent, so the composed schema is stable", async () => {
    // Same bytes in a different insertion order must produce the same contract,
    // or a snapshot would compile differently depending on directory listing.
    const forward = await compileSource(sourceOf(files, "schema.graphql", "graphql"), {
      serviceId: "shop",
    });
    const reversed = await compileSource(
      sourceOf(
        {
          "types/order.graphql": SDL_ORDER,
          "types/product.graphql": SDL_PRODUCT,
          "schema.graphql": SDL_ENTRY,
        },
        "schema.graphql",
        "graphql",
      ),
      { serviceId: "shop" },
    );
    expect(forward.operations.map((o) => o.id).sort()).toEqual(
      reversed.operations.map((o) => o.id).sort(),
    );
  });
});
