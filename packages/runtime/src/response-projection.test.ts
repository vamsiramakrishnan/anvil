import { describe, expect, it } from "vitest";
import { applyAgentProjection } from "./response-projection.js";

describe("applyAgentProjection", () => {
  it("selects and renames nested array fields without mutating the wire response", () => {
    const wire = {
      pageTitle: "Customers",
      layout: { columns: ["name", "status"] },
      items: [
        { customerId: "cus_1", displayName: "Ada", rowActions: ["edit"] },
        { customerId: "cus_2", displayName: "Lin", rowActions: ["edit"] },
      ],
    };
    const projected = applyAgentProjection(wire, {
      include: ["items.customerId", "items.displayName"],
      rename: { "items.customerId": "items.customer_id", "items.displayName": "items.name" },
    });

    expect(projected).toEqual({
      items: [
        { customer_id: "cus_1", name: "Ada" },
        { customer_id: "cus_2", name: "Lin" },
      ],
    });
    expect(wire.items[0]).toHaveProperty("rowActions");
  });

  it("never overwrites an existing destination while renaming", () => {
    expect(
      applyAgentProjection(
        { id: "wire", customer_id: "existing" },
        { rename: { id: "customer_id" } },
      ),
    ).toEqual({ id: "wire", customer_id: "existing" });
  });
});
