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
