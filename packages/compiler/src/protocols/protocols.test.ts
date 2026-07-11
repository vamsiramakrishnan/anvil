import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../compile.js";
import { adaptDiscovery, isDiscoveryDocument } from "./discovery.js";
import { adaptGraphql } from "./graphql.js";
import { adaptProto } from "./grpc.js";
import { detectProtocolFormat } from "./index.js";
import { adaptWsdl } from "./wsdl.js";
import { findAll, localName, parseXml } from "./xml.js";

// A minimal but real-shaped Google Discovery document (Gmail's structure):
// nested resources.methods, bare `$ref: "Name"`, a `send` mutation and a
// `list` read, and an OAuth2 scope map.
const discoverySpec = JSON.stringify({
  kind: "discovery#restDescription",
  name: "gmail",
  version: "v1",
  title: "Gmail API",
  rootUrl: "https://gmail.googleapis.com/",
  auth: { oauth2: { scopes: { "https://www.googleapis.com/auth/gmail.send": { description: "Send" } } } },
  resources: {
    users: {
      resources: {
        messages: {
          methods: {
            list: {
              id: "gmail.users.messages.list",
              path: "gmail/v1/users/{userId}/messages",
              httpMethod: "GET",
              parameters: {
                userId: { type: "string", location: "path", required: true },
                labelIds: { type: "string", location: "query", repeated: true },
              },
              response: { $ref: "ListMessagesResponse" },
            },
            send: {
              id: "gmail.users.messages.send",
              path: "gmail/v1/users/{userId}/messages/send",
              httpMethod: "POST",
              description: "Sends the specified message.",
              parameters: { userId: { type: "string", location: "path", required: true } },
              request: { $ref: "Message" },
              response: { $ref: "Message" },
            },
          },
        },
      },
    },
  },
  schemas: {
    Message: {
      id: "Message",
      type: "object",
      properties: { id: { type: "string" }, threadId: { type: "string" }, raw: { type: "string" } },
    },
    ListMessagesResponse: {
      id: "ListMessagesResponse",
      type: "object",
      properties: { messages: { type: "array", items: { $ref: "Message" } } },
    },
  },
});

const example = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../examples/${rel}`, import.meta.url)), "utf8");

const graphqlSpec = example("graphql/schema.graphql");
const graphqlManifest = example("graphql/anvil.yaml");
const protoSpec = example("grpc/orders.proto");
const protoManifest = example("grpc/anvil.yaml");
const wsdlSpec = example("soap/bank.wsdl");
const wsdlManifest = example("soap/anvil.yaml");

describe("protocol format detection", () => {
  it("detects by file extension", () => {
    expect(detectProtocolFormat("schema.graphql", "")?.format).toBe("graphql");
    expect(detectProtocolFormat("a/b/orders.proto", "")?.format).toBe("protobuf");
    expect(detectProtocolFormat("bank.wsdl", "")?.format).toBe("wsdl");
  });

  it("detects by content when the filename is unknown", () => {
    expect(detectProtocolFormat("", protoSpec)?.format).toBe("protobuf");
    expect(detectProtocolFormat("", graphqlSpec)?.format).toBe("graphql");
    expect(detectProtocolFormat("", wsdlSpec)?.format).toBe("wsdl");
  });

  it("does not misclassify an OpenAPI YAML document as a protocol", () => {
    const openapi =
      "openapi: 3.0.0\ninfo:\n  title: X\n  version: '1'\npaths:\n  /a:\n    get:\n      responses: {}\n";
    expect(detectProtocolFormat("openapi.yaml", openapi)).toBeUndefined();
    expect(detectProtocolFormat("", openapi)).toBeUndefined();
  });

  it("detects a Google Discovery document by its kind discriminator", () => {
    expect(isDiscoveryDocument(discoverySpec)).toBe(true);
    // A `.json` filename doesn't match an extension, so it falls to content sniff.
    expect(detectProtocolFormat("gmail.json", discoverySpec)?.format).toBe("discovery");
    expect(detectProtocolFormat("", discoverySpec)?.format).toBe("discovery");
    // A plain JSON object that merely mentions the string but isn't Discovery.
    expect(isDiscoveryDocument('{"note":"discovery#restDescription is a format"}')).toBe(false);
  });

  it("records a version alongside the format", () => {
    expect(detectProtocolFormat("orders.proto", protoSpec)?.version).toBe("proto3");
    expect(detectProtocolFormat("bank.wsdl", wsdlSpec)?.version).toBe("1.1");
  });
});

describe("GraphQL adapter", () => {
  const doc = adaptGraphql(graphqlSpec);

  it("lowers queries to GET and mutations to POST", () => {
    expect(doc.paths?.["/graphql/Query/product"]?.get).toBeDefined();
    expect(doc.paths?.["/graphql/Query/products"]?.get).toBeDefined();
    expect(doc.paths?.["/graphql/Mutation/checkout"]?.post).toBeDefined();
    expect(doc.paths?.["/graphql/Mutation/cancelOrder"]?.post).toBeDefined();
  });

  it("turns field arguments into a request body schema", () => {
    const op = doc.paths?.["/graphql/Query/product"]?.get as Record<string, unknown>;
    const body = op.requestBody as { content: Record<string, { schema: { properties: object } }> };
    expect(Object.keys(body.content["application/json"].schema.properties)).toContain("id");
  });

  it("registers object/input/enum types as component schemas with refs", () => {
    const schemas = doc.components?.schemas as Record<string, Record<string, unknown>>;
    expect(schemas.Product).toBeDefined();
    expect(schemas.OrderStatus).toMatchObject({ type: "string", enum: expect.any(Array) });
    // Recursion-safe references are emitted; the compiler dereferences them.
    const cart = schemas.Cart as { properties: Record<string, unknown> };
    expect(JSON.stringify(cart)).toContain("$ref");
  });

  it("does not expose the root Query/Mutation types as schemas", () => {
    const schemas = doc.components?.schemas as Record<string, unknown>;
    expect(schemas.Query).toBeUndefined();
    expect(schemas.Mutation).toBeUndefined();
  });
});

describe("gRPC/proto adapter", () => {
  const doc = adaptProto(protoSpec);

  it("uses the gRPC wire path and infers read vs write from the method name", () => {
    expect(doc.paths?.["/acme.orders.v1.OrderService/GetOrder"]?.get).toBeDefined();
    expect(doc.paths?.["/acme.orders.v1.OrderService/ListOrders"]?.get).toBeDefined();
    expect(doc.paths?.["/acme.orders.v1.OrderService/PlaceOrder"]?.post).toBeDefined();
    expect(doc.paths?.["/acme.orders.v1.OrderService/CancelOrder"]?.post).toBeDefined();
  });

  it("lowers messages, repeated fields, maps, and enums", () => {
    const schemas = doc.components?.schemas as Record<string, Record<string, unknown>>;
    const order = schemas.Order as { properties: Record<string, Record<string, unknown>> };
    expect(order.properties.line_items).toMatchObject({ type: "array" });
    expect(order.properties.metadata).toMatchObject({ type: "object" });
    expect(schemas.OrderState).toMatchObject({ type: "string", enum: expect.any(Array) });
  });

  it("maps 64-bit integers to string and well-known types sensibly", () => {
    const schemas = doc.components?.schemas as Record<string, Record<string, unknown>>;
    const order = schemas.Order as { properties: Record<string, Record<string, unknown>> };
    // int64 serializes as a JSON string in proto3.
    expect(order.properties.total).toMatchObject({ $ref: expect.stringContaining("Money") });
    // google.protobuf.Timestamp → date-time string.
    expect(order.properties.created_at).toMatchObject({ type: "string", format: "date-time" });
  });
});

describe("SOAP/WSDL adapter", () => {
  const doc = adaptWsdl(wsdlSpec);

  it("infers read vs write from the operation name", () => {
    expect(doc.paths?.["/BankingPort/GetAccountBalance"]?.get).toBeDefined();
    expect(doc.paths?.["/BankingPort/ListTransactions"]?.get).toBeDefined();
    expect(doc.paths?.["/BankingPort/TransferFunds"]?.post).toBeDefined();
    expect(doc.paths?.["/BankingPort/CloseAccount"]?.post).toBeDefined();
  });

  it("resolves document/literal wrapped messages to the element's schema", () => {
    const op = doc.paths?.["/BankingPort/TransferFunds"]?.post as Record<string, unknown>;
    const body = op.requestBody as { content: Record<string, { schema: { properties: object } }> };
    const props = body.content["application/json"].schema.properties;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["fromAccountId", "toAccountId", "amount", "idempotencyKey"]),
    );
  });

  it("lowers named complexTypes and enumerated simpleTypes", () => {
    const schemas = doc.components?.schemas as Record<string, Record<string, unknown>>;
    expect(schemas.Money).toMatchObject({ type: "object" });
    expect(schemas.Currency).toMatchObject({ type: "string", enum: ["USD", "EUR", "GBP"] });
  });
});

describe("Google Discovery adapter", () => {
  const doc = adaptDiscovery(discoverySpec);

  it("lowers the nested resources.methods tree into flat paths + verbs", () => {
    expect(doc.paths?.["/gmail/v1/users/{userId}/messages"]?.get).toBeDefined();
    expect(doc.paths?.["/gmail/v1/users/{userId}/messages/send"]?.post).toBeDefined();
  });

  it("maps Discovery parameters (location → in, repeated → array)", () => {
    const list = doc.paths?.["/gmail/v1/users/{userId}/messages"]?.get as Record<string, unknown>;
    const params = list.parameters as Array<Record<string, unknown>>;
    const userId = params.find((p) => p.name === "userId");
    const labelIds = params.find((p) => p.name === "labelIds");
    expect(userId).toMatchObject({ in: "path", required: true });
    expect(labelIds).toMatchObject({ in: "query", schema: { type: "array" } });
  });

  it("rewrites bare $refs to component pointers and registers schemas", () => {
    const schemas = doc.components?.schemas as Record<string, Record<string, unknown>>;
    expect(schemas.Message).toMatchObject({ type: "object" });
    // The bare `$ref: "Message"` inside ListMessagesResponse became a real pointer.
    expect(JSON.stringify(schemas.ListMessagesResponse)).toContain(
      "#/components/schemas/Message",
    );
    expect(JSON.stringify(doc)).not.toContain('"$ref":"Message"'); // no dangling bare refs
  });

  it("carries the OAuth2 scopes into a security scheme", () => {
    const schemes = doc.components?.securitySchemes as Record<string, { type: string }>;
    expect(schemes.oauth2?.type).toBe("oauth2");
  });
});

describe("mini XML parser", () => {
  it("parses elements, attributes, and nesting", () => {
    const root = parseXml('<a x="1"><b>text</b><c/></a>');
    expect(root.tag).toBe("a");
    expect(root.attrs.x).toBe("1");
    expect(findAll(root, "b")[0]?.text).toBe("text");
    expect(localName("wsdl:definitions")).toBe("definitions");
  });

  it("ignores comments, CDATA, and the XML declaration", () => {
    const root = parseXml('<?xml version="1.0"?><r><!--skip--><v><![CDATA[<raw>]]></v></r>');
    expect(root.tag).toBe("r");
    expect(findAll(root, "v")[0]?.text).toBe("<raw>");
  });
});

describe("end-to-end compile through the protocol adapters", () => {
  it("compiles GraphQL: queries are approved reads, checkout is a confirmed financial mutation", async () => {
    const air = await compile({
      spec: graphqlSpec,
      manifest: graphqlManifest,
      serviceId: "storefront",
      sourceUri: "schema.graphql",
    });
    expect(air.service.source.kind).toBe("graphql");
    const products = air.operations.find((o) => o.sourceRef.operationId === "products");
    expect(products?.effect.kind).toBe("read");
    expect(products?.state).toBe("approved");
    const checkout = air.operations.find((o) => o.sourceRef.operationId === "checkout");
    expect(checkout?.effect.kind).toBe("mutation");
    expect(checkout?.effect.risk).toBe("financial");
    expect(checkout?.confirmation.required).toBe(true);
    expect(checkout?.idempotency.mode).toBe("required");
  });

  it("compiles gRPC: reads are safe, PlaceOrder is a confirmed financial mutation", async () => {
    const air = await compile({
      spec: protoSpec,
      manifest: protoManifest,
      serviceId: "orders",
      sourceUri: "orders.proto",
    });
    expect(air.service.source.kind).toBe("protobuf");
    const get = air.operations.find((o) => o.sourceRef.operationId === "GetOrder");
    expect(get?.effect.kind).toBe("read");
    expect(get?.retries.mode).toBe("safe");
    const place = air.operations.find((o) => o.sourceRef.operationId === "PlaceOrder");
    expect(place?.effect.risk).toBe("financial");
    expect(place?.confirmation.required).toBe(true);
  });

  it("compiles SOAP: TransferFunds is financial+confirmed, CloseAccount is destructive", async () => {
    const air = await compile({
      spec: wsdlSpec,
      manifest: wsdlManifest,
      serviceId: "banking",
      sourceUri: "bank.wsdl",
    });
    expect(air.service.source.kind).toBe("wsdl");
    const transfer = air.operations.find((o) => o.sourceRef.operationId === "TransferFunds");
    expect(transfer?.effect.kind).toBe("mutation");
    expect(transfer?.effect.risk).toBe("financial");
    expect(transfer?.confirmation.required).toBe(true);
    const close = air.operations.find((o) => o.sourceRef.operationId === "CloseAccount");
    expect(close?.effect.risk).toBe("destructive");
  });

  it("leaves an unenriched protocol mutation in review_required (safety default)", async () => {
    const air = await compile({
      spec: protoSpec,
      serviceId: "orders",
      sourceUri: "orders.proto",
    });
    // Without a manifest, PlaceOrder (a POST-lowered mutation) is not provably
    // idempotent, so it must not be silently exposed.
    const place = air.operations.find((o) => o.sourceRef.operationId === "PlaceOrder");
    expect(place?.state).toBe("review_required");
    expect(place?.retries.mode).toBe("none");
  });

  it("compiles Google Discovery: send is a comms mutation, list is a safe read", async () => {
    const air = await compile({
      spec: discoverySpec,
      serviceId: "gmail",
      sourceUri: "gmail.json",
    });
    expect(air.service.source.kind).toBe("discovery");
    const send = air.operations.find((o) => o.sourceRef.operationId === "gmail.users.messages.send");
    expect(send?.effect.kind).toBe("mutation");
    expect(send?.effect.risk).toBe("high"); // COMMS: sending a message
    // The request body schema resolved from the bare `$ref: "Message"`.
    expect(Object.keys(send?.input.schema?.properties ?? {})).toEqual(
      expect.arrayContaining(["id", "thread_id"]),
    );
    const list = air.operations.find((o) => o.sourceRef.operationId === "gmail.users.messages.list");
    expect(list?.effect.kind).toBe("read");
    expect(list?.retries.mode).toBe("safe");
  });
});
