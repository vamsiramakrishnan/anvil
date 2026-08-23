import type { Diagnostic } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { adaptProto } from "./grpc.js";
import { httpRuleOf } from "./grpc-http-rule.js";

/**
 * `google.api.http` support, tested at both ends: the rule reader on plain data,
 * and the adapter on real proto text.
 *
 * Every refusal gets its own fixture carrying exactly one problem. A fixture
 * that trips two checks proves neither — an assertion that passes for a reason
 * other than the one it names is how a control gets deleted without a test
 * noticing, which the mutation gate exists to catch.
 */

/** protobufjs hands back one single-key object per option written on a method. */
const options = (rule: Record<string, unknown>): unknown => [{ "(google.api.http)": rule }];

describe("httpRuleOf", () => {
  const fields = ["order_id", "view", "order"];

  it("returns undefined when the method carries no annotation at all", () => {
    // Distinct from a refusal: no annotation falls back to gRPC's own path and
    // keeps asking for a declared facade, rather than refusing outright.
    expect(httpRuleOf(undefined, fields)).toBeUndefined();
    expect(httpRuleOf([{ deprecated: true }], fields)).toBeUndefined();
  });

  it("reads a verb, a path, and the fields bound into it", () => {
    const outcome = httpRuleOf(options({ get: "/v1/orders/{order_id}" }), fields);
    expect(outcome).toEqual({
      ok: true,
      rule: {
        verb: "get",
        path: "/v1/orders/{order_id}",
        pathFields: ["order_id"],
        body: undefined,
      },
    });
  });

  it("keeps a custom-method verb suffix as a literal part of the path", () => {
    // `:cancel` is AIP-136's spelling for an action on a resource. It is path
    // text, not a template, so it must survive untouched.
    const outcome = httpRuleOf(
      options({ post: "/v1/orders/{order_id}:cancel", body: "*" }),
      fields,
    );
    expect(outcome).toMatchObject({ ok: true, rule: { path: "/v1/orders/{order_id}:cancel" } });
  });

  it("treats an explicit single-segment pattern as the bare field", () => {
    const outcome = httpRuleOf(options({ get: "/v1/orders/{order_id=*}" }), fields);
    expect(outcome).toMatchObject({ ok: true, rule: { path: "/v1/orders/{order_id}" } });
  });

  it("reads a named body field", () => {
    const outcome = httpRuleOf(options({ post: "/v1/orders", body: "order" }), fields);
    expect(outcome).toMatchObject({ ok: true, rule: { body: "order", pathFields: [] } });
  });

  it("refuses a pattern spanning more than one path segment", () => {
    // The runtime percent-encodes a path parameter, so a value containing a
    // slash would address a different resource instead of failing.
    const outcome = httpRuleOf(options({ get: "/v1/{order_id=orders/*}" }), fields);
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { reason: string }).reason).toContain("more than one path segment");
  });

  it("refuses a template binding a field inside a nested message", () => {
    const outcome = httpRuleOf(options({ get: "/v1/{order.id}" }), fields);
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { reason: string }).reason).toContain("top-level field name only");
  });

  it("refuses a custom method kind", () => {
    const outcome = httpRuleOf(options({ custom: { kind: "OPTIONS", path: "/v1/x" } }), fields);
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { reason: string }).reason).toContain("custom");
  });

  it("refuses a rule that declares no HTTP method", () => {
    const outcome = httpRuleOf(options({ body: "*" }), fields);
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { reason: string }).reason).toContain("no HTTP method");
  });

  it("refuses a rule declaring more than one HTTP method", () => {
    const outcome = httpRuleOf(options({ get: "/v1/a", post: "/v1/a" }), fields);
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { reason: string }).reason).toContain("more than one HTTP method");
  });

  it("refuses a path that is not absolute", () => {
    const outcome = httpRuleOf(options({ get: "v1/orders" }), fields);
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { reason: string }).reason).toContain("not absolute");
  });

  it("refuses a template binding a field the request message does not declare", () => {
    const outcome = httpRuleOf(options({ get: "/v1/orders/{nope}" }), fields);
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { reason: string }).reason).toContain("does not declare");
  });

  it("refuses a body naming a field the request message does not declare", () => {
    const outcome = httpRuleOf(options({ post: "/v1/orders", body: "nope" }), fields);
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { reason: string }).reason).toContain("does not declare");
  });

  it("refuses a field sent as the body and also bound into the path", () => {
    // One value, two wire destinations that can disagree.
    const outcome = httpRuleOf(options({ post: "/v1/{order_id}", body: "order_id" }), fields);
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { reason: string }).reason).toContain("also binds it into the path");
  });

  it("refuses a template binding one field twice", () => {
    const outcome = httpRuleOf(options({ get: "/v1/{order_id}/x/{order_id}" }), fields);
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { reason: string }).reason).toContain("more than once");
  });

  it("refuses when the request message could not be resolved", () => {
    // An unresolved import leaves nothing to check the bindings against, and a
    // mapping Anvil cannot check is one it does not claim.
    const outcome = httpRuleOf(options({ get: "/v1/orders/{order_id}" }), undefined);
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { reason: string }).reason).toContain("could not be resolved");
  });
});

describe("gRPC adapter — google.api.http", () => {
  const annotated = `
    syntax = "proto3";
    package acme.orders.v1;
    message GetOrderRequest { string order_id = 1; string view = 2; }
    message DeleteOrderRequest { string order_id = 1; }
    message CreateOrderRequest { string parent = 1; Order order = 2; }
    message Order { string id = 1; int32 total_cents = 2; }
    service OrderService {
      rpc GetOrder(GetOrderRequest) returns (Order) {
        option (google.api.http) = { get: "/v1/orders/{order_id}" };
      }
      rpc DeleteOrder(DeleteOrderRequest) returns (Order) {
        option (google.api.http) = { delete: "/v1/orders/{order_id}" };
      }
      rpc CreateOrder(CreateOrderRequest) returns (Order) {
        option (google.api.http) = { post: "/v1/orders" body: "order" };
      }
    }
  `;

  it("lowers an annotated method to the verb and path it declares", () => {
    const doc = adaptProto(annotated);
    const get = doc.paths?.["/v1/orders/{order_id}"]?.get as Record<string, unknown>;
    expect(get).toBeDefined();
    expect(get["x-anvil-wire-binding"]).toMatchObject({ protocol: "grpc", transport: "http_rule" });
    // The gRPC coordinate is gone: the gateway serves the declared route.
    expect(doc.paths?.["/acme.orders.v1.OrderService/GetOrder"]).toBeUndefined();
  });

  it("binds path fields as path parameters and the rest as query parameters", () => {
    const doc = adaptProto(annotated);
    const get = doc.paths?.["/v1/orders/{order_id}"]?.get as Record<string, unknown>;
    expect(get.parameters).toEqual([
      { name: "order_id", in: "path", required: true, schema: { type: "string" } },
      { name: "view", in: "query", required: false, schema: { type: "string" } },
    ]);
    // A `get:` rule declares no body, so none is emitted.
    expect(get.requestBody).toBeUndefined();
  });

  it("sends the named body field as the body and the rest as query", () => {
    const doc = adaptProto(annotated);
    const post = doc.paths?.["/v1/orders"]?.post as Record<string, unknown>;
    expect(post.parameters).toEqual([
      { name: "parent", in: "query", required: false, schema: { type: "string" } },
    ]);
    expect(post.requestBody).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } },
    });
  });

  it("merges two RPCs that declare different verbs on one path", () => {
    // gRPC coordinates are unique per method; declared routes are not. Writing
    // the verb into the existing path object rather than replacing it is what
    // keeps `GET` from being dropped when `DELETE` arrives.
    const doc = adaptProto(annotated);
    const entry = doc.paths?.["/v1/orders/{order_id}"] as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(["delete", "get"]);
  });

  it("lets the declared verb classify the operation, dropping the name heuristic", () => {
    // `GetOrder` matches the read-name heuristic, but with a rule present the
    // declared GET is the evidence and `x-anvil-effect` steps aside, so the
    // operation classifies exactly as the OpenAPI document it now is.
    const doc = adaptProto(annotated);
    const get = doc.paths?.["/v1/orders/{order_id}"]?.get as Record<string, unknown>;
    expect(get["x-anvil-effect"]).toBeUndefined();
  });

  it("keeps the gRPC path and the weaker transcoding claim when unannotated", () => {
    const bare = `
      syntax = "proto3";
      package a.b;
      message R { string id = 1; }
      service S { rpc GetThing(R) returns (R) {} }
    `;
    const doc = adaptProto(bare);
    const op = doc.paths?.["/a.b.S/GetThing"]?.post as Record<string, unknown>;
    expect(op["x-anvil-wire-binding"]).toMatchObject({ transport: "json_transcoded" });
    // Unannotated, the name heuristic is still the only read/write evidence.
    expect(op["x-anvil-effect"]).toBe("read");
  });

  it("records no binding for an annotated rule it declines, and does not fall back", () => {
    // Falling back to gRPC's own path would aim the call at a coordinate the
    // gateway provably does not serve.
    const multiSegment = `
      syntax = "proto3";
      package a.b;
      message R { string name = 1; }
      service S {
        rpc Archive(R) returns (R) {
          option (google.api.http) = { post: "/v1/{name=orders/*}:archive" body: "*" };
        }
      }
    `;
    const diagnostics: Diagnostic[] = [];
    const doc = adaptProto(multiSegment, "demo", undefined, diagnostics);
    const op = doc.paths?.["/a.b.S/Archive"]?.post as Record<string, unknown>;
    expect(op["x-anvil-wire-binding"]).toBeUndefined();
    expect(diagnostics.map((d) => d.code)).toContain("grpc_http_rule_unencodable");
  });

  it("ignores an annotation on a streaming RPC, which is refused before it is read", () => {
    const streaming = `
      syntax = "proto3";
      package a.b;
      message R { string id = 1; }
      service S {
        rpc Tail(R) returns (stream R) {
          option (google.api.http) = { get: "/v1/tail/{id}" };
        }
      }
    `;
    const diagnostics: Diagnostic[] = [];
    const doc = adaptProto(streaming, "demo", undefined, diagnostics);
    // No route makes a stream a single JSON exchange, so the declared one is moot.
    expect(doc.paths?.["/v1/tail/{id}"]).toBeUndefined();
    const op = doc.paths?.["/a.b.S/Tail"]?.post as Record<string, unknown>;
    expect(op["x-anvil-wire-binding"]).toBeUndefined();
    expect(diagnostics.map((d) => d.code)).toContain("grpc_binding_unencodable");
  });

  it("asks for each value exactly once when the whole message is the body", () => {
    // `body: "*"` with a path binding must not repeat the path field in the
    // body: two slots for one value are two slots that can disagree.
    const wholeBody = `
      syntax = "proto3";
      package a.b;
      message R { string id = 1; string note = 2; }
      service S {
        rpc Update(R) returns (R) {
          option (google.api.http) = { patch: "/v1/things/{id}" body: "*" };
        }
      }
    `;
    const doc = adaptProto(wholeBody);
    const op = doc.paths?.["/v1/things/{id}"]?.patch as Record<string, unknown>;
    const schema = (op.requestBody as { content: Record<string, { schema: JsonSchema }> }).content[
      "application/json"
    ]?.schema;
    expect(Object.keys((schema as { properties: object }).properties)).toEqual(["note"]);
  });
});

interface JsonSchema {
  properties?: Record<string, unknown>;
}
