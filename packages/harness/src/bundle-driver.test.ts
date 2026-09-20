import { operationSafetyInputKeys } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { describe, expect, it } from "vitest";
import { argsFor, cliFlagsFor, expectedWire, withoutConfirmationInput } from "./bundle-driver.js";

const COLLISION_SPEC = `openapi: 3.0.0
info: { title: widgets, version: 1.0.0 }
paths:
  /widgets:
    post:
      operationId: createWidget
      tags: [widgets]
      parameters:
        - name: idempotency_key
          in: query
          required: true
          example: business-query-key
          schema: { type: string }
        - name: confirm
          in: query
          required: true
          example: business-confirm
          schema: { type: string }
      responses: { '201': { description: created } }
`;

const COLLISION_MANIFEST = `operations:
  createWidget:
    state: approved
    idempotency:
      strategy: required_request_key
      key_location: header
      header: Idempotency-Key
    confirmation:
      required: true
      risk: high
`;

describe("bundle driver safety-input collisions", () => {
  it("keeps business fields distinct from namespaced safety controls on every driven surface", async () => {
    const air = await compile({
      spec: COLLISION_SPEC,
      manifest: COLLISION_MANIFEST,
      serviceId: "widgets",
    });
    const op = air.operations[0];
    if (!op) throw new Error("fixture: createWidget not compiled");

    const safety = operationSafetyInputKeys(op);
    expect(safety).toEqual({
      idempotencyKey: "anvil_idempotency_key",
      confirm: "anvil_confirm",
    });

    const args = argsFor(op, "collision");
    expect(args.idempotency_key).toBe("business-query-key");
    expect(args.confirm).toBe("business-confirm");
    expect(args[safety.idempotencyKey]).toMatch(/^collision-/);
    expect(args[safety.confirm]).toBe(true);

    expect(cliFlagsFor(op, args)).toEqual([
      "--input-idempotency-key",
      "business-query-key",
      "--input-confirm",
      "business-confirm",
      "--idempotency-key",
      args[safety.idempotencyKey],
    ]);

    const wire = expectedWire(op, args);
    expect(wire.query).toEqual({
      idempotency_key: "business-query-key",
      confirm: "business-confirm",
    });
    expect(wire.headers["idempotency-key"]).toBe(args[safety.idempotencyKey]);

    const unconfirmed = withoutConfirmationInput(op, args);
    expect(unconfirmed.confirm).toBe("business-confirm");
    expect(unconfirmed).not.toHaveProperty(safety.confirm);
  });
});

const STYLE_SPEC = `openapi: 3.0.0
info: { title: catalog, version: 1.0.0 }
paths:
  /items/{ids}:
    get:
      operationId: listItems
      tags: [items]
      parameters:
        - name: ids
          in: path
          required: true
          schema: { type: array, items: { type: string } }
        - name: tag
          in: query
          schema: { type: array, items: { type: string } }
        - name: sort
          in: query
          style: pipeDelimited
          schema: { type: array, items: { type: string } }
        - name: filter
          in: query
          style: deepObject
          schema: { type: object, additionalProperties: { type: string } }
        - name: X-Meta
          in: header
          schema: { type: object, additionalProperties: { type: string } }
      responses:
        "200": { description: ok }
`;

describe("expectedWire serializes parameters by the shared style table", () => {
  it("expects repeated keys, delimited lists, deep objects and simple headers", async () => {
    const air = await compile({ spec: STYLE_SPEC, serviceId: "catalog" });
    const op = air.operations.find((o) => o.sourceRef.operationId === "listItems");
    if (!op) throw new Error("listItems not compiled");
    const wire = expectedWire(op, {
      ids: ["a b", "c"],
      tag: ["x", "y"],
      sort: ["name", "date"],
      filter: { color: "red", size: "m" },
      x_meta: { k: "v" },
    });
    expect(wire.path).toBe("/items/a%20b,c");
    // Exactly the shape the mock records, so a repeat is an array on both sides.
    expect(wire.query).toEqual({
      tag: ["x", "y"],
      sort: "name|date",
      "filter[color]": "red",
      "filter[size]": "m",
    });
    expect(wire.headers["x-meta"]).toBe("k,v");
  });
});
