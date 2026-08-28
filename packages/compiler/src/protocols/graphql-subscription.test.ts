import { describe, expect, it } from "vitest";
import { adaptGraphql } from "./graphql.js";

/**
 * Subscriptions, which used to compile to an operation with no wire binding and
 * a diagnostic saying Anvil had no streaming client.
 *
 * They now compile to a bounded observation window: same document builder as a
 * query, a different wire, and a contract that says when the window closes.
 */
const SDL = `
  schema { query: Query, subscription: Subscription }
  type Item { id: ID! quantityOnHand: Int! }
  type Query { item(id: ID!): Item }
  type Subscription {
    inventoryChanged(warehouseId: ID!): Item
    ticks: Item
  }
`;

describe("GraphQL subscriptions", () => {
  it("compiles a subscription document, not a query one", () => {
    const doc = adaptGraphql(SDL);
    const op = doc.paths?.["/graphql/Subscription/inventoryChanged"]?.post as Record<
      string,
      unknown
    >;
    expect(op["x-anvil-wire-binding"]).toMatchObject({
      protocol: "graphql_sse",
      document:
        "subscription Anvil_InventoryChanged($warehouseId: ID!) " +
        "{ inventoryChanged(warehouseId: $warehouseId) { id quantityOnHand } }",
      rootField: "inventoryChanged",
    });
  });

  it("carries the bound that makes the call terminate", () => {
    // Without this the transport gate refuses the operation: a subscription with
    // no bound has nothing to make it return.
    const doc = adaptGraphql(SDL);
    const op = doc.paths?.["/graphql/Subscription/ticks"]?.post as Record<string, unknown>;
    expect(op["x-anvil-stream"]).toEqual({
      transport: "graphql_sse",
      delivery: "at_most_once",
      maxEvents: 100,
      maxSeconds: 30,
    });
  });

  it("leaves a query on the ordinary GraphQL wire", () => {
    // One builder serves all three kinds; only the protocol it is filed under
    // differs. A consumer reading one as the other gets a parse failure, which
    // is what the discriminator exists to make impossible.
    const doc = adaptGraphql(SDL);
    const op = doc.paths?.["/graphql/Query/item"]?.post as Record<string, unknown>;
    expect(op["x-anvil-wire-binding"]).toMatchObject({ protocol: "graphql" });
    expect(op["x-anvil-stream"]).toBeUndefined();
  });

  it("no longer reports a subscription as unencodable", () => {
    const diagnostics: { code?: string }[] = [];
    adaptGraphql(SDL, "svc", diagnostics as never);
    expect(diagnostics.map((d) => d.code)).not.toContain("graphql_binding_unencodable");
  });
});

describe("the manifest resizes the window", () => {
  // The defaults answer "what is happening right now". An operation that needs
  // a longer look gets it from an operator's manifest — a reviewed, diffable
  // declaration — never from an agent input at call time.
  const manifest = (streamYaml: string, operation = "ticks") => `
service:
  name: inventory
operations:
  ${operation}:
${streamYaml}
`;

  it("raises the ceilings on an operation that streams, and says so in review notes", async () => {
    const { compile } = await import("../compile.js");
    const air = await compile({
      spec: SDL,
      manifest: manifest("    stream:\n      max_events: 500\n      max_seconds: 120"),
      serviceId: "inventory",
    });
    const op = air.operations.find((o) => o.id.includes("tick"));
    expect(op?.stream).toEqual({
      transport: "graphql_sse",
      delivery: "at_most_once",
      maxEvents: 500,
      maxSeconds: 120,
    });
    expect(op?.reviewNotes.join(" ")).toContain("Observation window resized by manifest");
  });

  it("resizes one ceiling and leaves the other at its default", async () => {
    const { compile } = await import("../compile.js");
    const air = await compile({
      spec: SDL,
      manifest: manifest("    stream:\n      max_seconds: 5"),
      serviceId: "inventory",
    });
    const op = air.operations.find((o) => o.id.includes("tick"));
    expect(op?.stream).toMatchObject({ maxEvents: 100, maxSeconds: 5 });
  });

  it("refuses to create a window on an operation that does not stream", async () => {
    const { compile } = await import("../compile.js");
    const air = await compile({
      spec: SDL,
      manifest: manifest("    stream:\n      max_events: 500", "item"),
      serviceId: "inventory",
    });
    const op = air.operations.find((o) => o.id.includes("item"));
    expect(op?.stream).toBeUndefined();
    expect(op?.reviewNotes.join(" ")).toContain("never create one");
  });

  it("refuses a window past AIR's own ceiling, at parse time", async () => {
    // The manifest cap IS the schema cap: a window five minutes wide is a
    // observation; one an hour wide is a durable consumer wearing a parameter.
    const { compile } = await import("../compile.js");
    await expect(
      compile({
        spec: SDL,
        manifest: manifest("    stream:\n      max_seconds: 4000"),
        serviceId: "inventory",
      }),
    ).rejects.toThrow();
  });
});

describe("AIR itself refuses an unbounded window", () => {
  it("caps both ceilings on the schema, not just in manifest validation", async () => {
    // The manifest cap alone would leave a hand-edited air.json free to carry
    // a week-long window. The schema is where "bounded" is enforced, so both
    // routes into AIR go through the same refusal.
    const { StreamContractSchema, STREAM_MAX_SECONDS_CEILING, STREAM_MAX_EVENTS_CEILING } =
      await import("@anvil/air");
    const window = (overrides: Record<string, unknown>) =>
      StreamContractSchema.safeParse({
        transport: "graphql_sse",
        delivery: "at_most_once",
        maxEvents: 100,
        maxSeconds: 30,
        ...overrides,
      });
    expect(window({}).success).toBe(true);
    expect(window({ maxSeconds: STREAM_MAX_SECONDS_CEILING }).success).toBe(true);
    expect(window({ maxSeconds: STREAM_MAX_SECONDS_CEILING + 1 }).success).toBe(false);
    expect(window({ maxEvents: STREAM_MAX_EVENTS_CEILING + 1 }).success).toBe(false);
  });
});
