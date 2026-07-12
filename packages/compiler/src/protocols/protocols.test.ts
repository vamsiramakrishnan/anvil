import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../compile.js";
import { adaptDiscovery, isDiscoveryDocument } from "./discovery.js";
import { adaptGraphql } from "./graphql.js";
import { adaptProto } from "./grpc.js";
import { detectProtocolFormat } from "./index.js";
import { adaptPostman, isPostmanCollection, postmanSchemaVersion } from "./postman.js";
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
  auth: {
    oauth2: { scopes: { "https://www.googleapis.com/auth/gmail.send": { description: "Send" } } },
  },
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
              scopes: ["https://www.googleapis.com/auth/gmail.send"],
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

// A minimal but real-shaped Postman Collection v2.1.0 (Auth0/Twilio-style):
// nested folders, `{{baseUrl}}` host resolved from collection variables, `:id`
// path params with url.variable metadata, query/header params, a raw-JSON body,
// urlencoded credentials, collection- AND request-level auth carrying REAL
// secret values (which must never leak into the lowered document), a saved
// example response, and pre-request/test scripts.
const postmanSpec = JSON.stringify({
  info: {
    name: "CRM API",
    description: "Customer records for the CRM.",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [{ key: "baseUrl", value: "https://api.example.com/v1" }],
  auth: {
    type: "apikey",
    apikey: [
      { key: "key", value: "X-API-Key", type: "string" },
      { key: "value", value: "TOP-SECRET-API-KEY-VALUE", type: "string" },
      { key: "in", value: "header", type: "string" },
    ],
  },
  event: [{ listen: "prerequest", script: { exec: ["pm.environment.set('ts', '1');"] } }],
  item: [
    {
      name: "Users",
      item: [
        {
          name: "List Users",
          event: [{ listen: "test", script: { exec: ["pm.test('ok', function () {});"] } }],
          request: {
            method: "GET",
            header: [
              { key: "Authorization", value: "Bearer {{token}}" },
              { key: "X-Org-Id", value: "org_123", description: "Tenant to query" },
            ],
            url: {
              raw: "{{baseUrl}}/users?limit=20&verbose=false",
              host: ["{{baseUrl}}"],
              path: ["users"],
              query: [
                { key: "limit", value: "20", description: "Page size" },
                { key: "verbose", value: "false", disabled: true },
              ],
            },
          },
          response: [],
        },
        {
          name: "Get User",
          request: {
            method: "GET",
            url: {
              raw: "{{baseUrl}}/users/:id",
              host: ["{{baseUrl}}"],
              path: ["users", ":id"],
              variable: [{ key: "id", description: "User id" }],
            },
          },
          response: [
            {
              name: "A user",
              code: 200,
              body: '{"id":"u_1","name":"Ada","age":36,"tags":["admin"],"active":true,"nickname":null}',
            },
          ],
        },
        {
          name: "Create User",
          request: {
            method: "POST",
            description: { content: "Creates a user record." },
            body: {
              mode: "raw",
              raw: '{"name":"Ada Lovelace","age":36,"tags":["admin"],"active":true}',
              options: { raw: { language: "json" } },
            },
            url: { raw: "{{baseUrl}}/users", host: ["{{baseUrl}}"], path: ["users"] },
          },
        },
      ],
    },
    {
      name: "Auth",
      item: [
        {
          name: "Login",
          request: {
            method: "POST",
            auth: {
              type: "bearer",
              bearer: [{ key: "token", value: "SECRET-BEARER-TOKEN", type: "string" }],
            },
            body: {
              mode: "urlencoded",
              urlencoded: [
                { key: "username", value: "ada" },
                { key: "password", value: "hunter2-secret" },
              ],
            },
            url: { raw: "{{baseUrl}}/login", host: ["{{baseUrl}}"], path: ["login"] },
          },
        },
      ],
    },
  ],
});

// The same shape a v2.0.0 export uses: string URLs, object-encoded auth.
const postmanV20Spec = JSON.stringify({
  info: {
    name: "Echo",
    schema: "https://schema.getpostman.com/json/collection/v2.0.0/collection.json",
  },
  item: [
    { name: "Simple GET", request: { method: "GET", url: "https://postman-echo.com/get?foo=bar" } },
    {
      name: "Basic-auth POST",
      request: {
        method: "POST",
        auth: { type: "basic", basic: { username: "ada", password: "hunter2-basic" } },
        url: "https://postman-echo.com/post",
        body: { mode: "raw", raw: '{"hello":"world"}' },
      },
    },
  ],
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

  it("detects a Postman collection by filename convention and by content sniff", () => {
    expect(isPostmanCollection(postmanSpec)).toBe(true);
    // The `.postman_collection.json` export convention, verified by content.
    const byName = detectProtocolFormat("crm.postman_collection.json", postmanSpec);
    expect(byName).toEqual({ format: "postman", version: "2.1" });
    // A bare .json (or no filename at all) falls to the content sniff.
    expect(detectProtocolFormat("crm.json", postmanSpec)?.format).toBe("postman");
    expect(detectProtocolFormat("", postmanV20Spec)).toEqual({ format: "postman", version: "2.0" });
    // A JSON file that merely mentions the schema URL is not a collection…
    expect(isPostmanCollection('{"note":"getpostman.com/json/collection/v2 is a format"}')).toBe(
      false,
    );
    // …and neither is a v1 export (no info.schema discriminator).
    expect(isPostmanCollection('{"name":"old","requests":[]}')).toBe(false);
    expect(postmanSchemaVersion(postmanSpec)).toBe("2.1");
  });
});

describe("GraphQL adapter", () => {
  const doc = adaptGraphql(graphqlSpec);

  it("lowers everything to POST (the truthful wire method), asserting reads explicitly", () => {
    const product = doc.paths?.["/graphql/Query/product"]?.post as Record<string, unknown>;
    const products = doc.paths?.["/graphql/Query/products"]?.post as Record<string, unknown>;
    expect(product).toBeDefined();
    expect(products).toBeDefined();
    expect(product["x-anvil-effect"]).toBe("read");
    expect(products["x-anvil-effect"]).toBe("read");
    const checkout = doc.paths?.["/graphql/Mutation/checkout"]?.post as Record<string, unknown>;
    const cancel = doc.paths?.["/graphql/Mutation/cancelOrder"]?.post as Record<string, unknown>;
    expect(checkout).toBeDefined();
    expect(cancel).toBeDefined();
    expect(checkout["x-anvil-effect"]).toBeUndefined();
    expect(cancel["x-anvil-effect"]).toBeUndefined();
  });

  it("turns field arguments into a request body schema", () => {
    const op = doc.paths?.["/graphql/Query/product"]?.post as Record<string, unknown>;
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

  it("uses the gRPC wire path, POST throughout, asserting reads from the method name", () => {
    const get = doc.paths?.["/acme.orders.v1.OrderService/GetOrder"]?.post as Record<
      string,
      unknown
    >;
    const list = doc.paths?.["/acme.orders.v1.OrderService/ListOrders"]?.post as Record<
      string,
      unknown
    >;
    expect(get).toBeDefined();
    expect(list).toBeDefined();
    expect(get["x-anvil-effect"]).toBe("read");
    expect(list["x-anvil-effect"]).toBe("read");
    const place = doc.paths?.["/acme.orders.v1.OrderService/PlaceOrder"]?.post as Record<
      string,
      unknown
    >;
    const cancel = doc.paths?.["/acme.orders.v1.OrderService/CancelOrder"]?.post as Record<
      string,
      unknown
    >;
    expect(place).toBeDefined();
    expect(cancel).toBeDefined();
    expect(place["x-anvil-effect"]).toBeUndefined();
    expect(cancel["x-anvil-effect"]).toBeUndefined();
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

  it("resolves message types imported from another proto file (real services split them)", () => {
    // Temporal/etcd/most real gRPC services put a method's request/response
    // messages in a sibling file. Without cross-file resolution the body
    // compiles to an opaque stub; the `resolveImport` callback loads the
    // imported file into the same protobuf root so the fields resolve.
    const service = `syntax = "proto3";
package demo.v1;
import "messages.proto";
service OrderService { rpc CreateOrder(CreateOrderRequest) returns (Order); }`;
    const messages = `syntax = "proto3";
package demo.v1;
message CreateOrderRequest { string customer_id = 1; int64 total_cents = 2; }
message Order { string id = 1; }`;
    const resolve = (p: string) => (p.endsWith("messages.proto") ? messages : undefined);
    const multi = adaptProto(service, "demo", resolve);
    const schemas = multi.components?.schemas as Record<string, Record<string, unknown>>;
    // The imported request message resolved with its real fields.
    expect(schemas.CreateOrderRequest).toBeDefined();
    const req = schemas.CreateOrderRequest as { properties: Record<string, unknown> };
    expect(Object.keys(req.properties)).toEqual(
      expect.arrayContaining(["customer_id", "total_cents"]),
    );
    const op = multi.paths?.["/demo.v1.OrderService/CreateOrder"]?.post as Record<string, unknown>;
    const body = op.requestBody as { content: Record<string, { schema: { $ref: string } }> };
    expect(body.content["application/json"].schema.$ref).toContain("CreateOrderRequest");
  });

  it("degrades gracefully when an import cannot be resolved (unchanged single-file contract)", () => {
    const service = `syntax = "proto3";
package demo.v1;
import "missing.proto";
service S { rpc Do(Req) returns (Res); }
message Res { string ok = 1; }`;
    // Resolver that never finds the import — must not throw.
    expect(() => adaptProto(service, "demo", () => undefined)).not.toThrow();
    // An unresolved RPC payload is still a *message*: it degrades to a
    // permissive object (all fields unknown, so `{}` stays valid end to end),
    // never to a scalar the JSON-transcoded wire could not carry.
    const doc = adaptProto(service, "demo", () => undefined);
    const op = doc.paths?.["/demo.v1.S/Do"]?.post as Record<string, unknown>;
    const body = op.requestBody as { content: Record<string, { schema: { type?: string } }> };
    expect(body.content["application/json"].schema).toEqual({ type: "object" });
  });
});

describe("SOAP/WSDL adapter", () => {
  const doc = adaptWsdl(wsdlSpec);

  it("lowers everything to POST, asserting reads from the operation name", () => {
    const balance = doc.paths?.["/BankingPort/GetAccountBalance"]?.post as Record<string, unknown>;
    const txns = doc.paths?.["/BankingPort/ListTransactions"]?.post as Record<string, unknown>;
    expect(balance).toBeDefined();
    expect(txns).toBeDefined();
    expect(balance["x-anvil-effect"]).toBe("read");
    expect(txns["x-anvil-effect"]).toBe("read");
    const transfer = doc.paths?.["/BankingPort/TransferFunds"]?.post as Record<string, unknown>;
    const close = doc.paths?.["/BankingPort/CloseAccount"]?.post as Record<string, unknown>;
    expect(transfer).toBeDefined();
    expect(close).toBeDefined();
    expect(transfer["x-anvil-effect"]).toBeUndefined();
    expect(close["x-anvil-effect"]).toBeUndefined();
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

describe("SOAP/WSDL multi-file resolution", () => {
  // A Travelport-shaped tree: the entry WSDL holds only bindings/services and
  // wsdl:imports the abstract WSDL, which carries the messages/portTypes and
  // includes the schema files — transitively, across sibling directories.
  const entryWsdl = `<?xml version="1.0"?>
<definitions name="AirService" xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:tns="urn:air">
  <import namespace="urn:air" location="AirAbstract.wsdl"/>
  <binding name="FlightDetailsBinding" type="tns:FlightDetailsPortType"><operation name="service"/></binding>
  <service name="AirService"><port name="FlightDetailsPort" binding="tns:FlightDetailsBinding"/></service>
</definitions>`;
  const abstractWsdl = `<?xml version="1.0"?>
<definitions name="AirService" xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:tns="urn:air" xmlns:ns1="urn:air:schema">
  <types>
    <schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:air:schema">
      <include schemaLocation="AirReqRsp.xsd"/>
    </schema>
  </types>
  <message name="FlightDetailsReq"><part name="parameters" element="ns1:FlightDetailsReq"/></message>
  <message name="FlightDetailsRsp"><part name="result" element="ns1:FlightDetailsRsp"/></message>
  <message name="PriceReq"><part name="parameters" element="ns1:PriceReq"/></message>
  <message name="PriceRsp"><part name="result" element="ns1:PriceRsp"/></message>
  <portType name="FlightDetailsPortType">
    <operation name="service"><input message="tns:FlightDetailsReq"/><output message="tns:FlightDetailsRsp"/></operation>
  </portType>
  <portType name="AirPricePortType">
    <operation name="service"><input message="tns:PriceReq"/><output message="tns:PriceRsp"/></operation>
  </portType>
</definitions>`;
  const reqRspXsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:common="urn:common" targetNamespace="urn:air:schema">
  <xs:import namespace="urn:common" schemaLocation="../common/Common.xsd"/>
  <xs:element name="FlightDetailsReq">
    <xs:complexType><xs:sequence>
      <xs:element name="Carrier" type="xs:string"/>
      <xs:element name="Origin" type="common:typeAirport"/>
    </xs:sequence></xs:complexType>
  </xs:element>
  <xs:element name="FlightDetailsRsp"><xs:complexType/></xs:element>
  <xs:element name="PriceReq">
    <xs:complexType><xs:complexContent><xs:extension base="common:BaseReq">
      <xs:sequence><xs:element name="FareBasis" type="xs:string"/></xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>
  <xs:element name="PriceRsp"><xs:complexType/></xs:element>
</xs:schema>`;
  const commonXsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:common">
  <xs:include schemaLocation="CommonTypes.xsd"/>
  <xs:complexType name="BaseReq">
    <xs:sequence><xs:element name="TraceId" type="xs:string"/></xs:sequence>
  </xs:complexType>
</xs:schema>`;
  const commonTypesXsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:common">
  <xs:simpleType name="typeAirport"><xs:restriction base="xs:string"/></xs:simpleType>
</xs:schema>`;
  const files: Record<string, string> = {
    "svc/AirAbstract.wsdl": abstractWsdl,
    "svc/AirReqRsp.xsd": reqRspXsd,
    "common/Common.xsd": commonXsd,
    "common/CommonTypes.xsd": commonTypesXsd,
  };
  const resolve = (p: string) => files[p];
  const doc = adaptWsdl(entryWsdl, resolve, "svc/Air.wsdl");

  type Op = { requestBody?: { content: Record<string, { schema: Record<string, unknown> }> } };
  const bodySchema = (path: string): Record<string, unknown> => {
    const item = doc.paths?.[path] as Record<string, Op>;
    const op = item.get ?? item.post;
    return (op as Op).requestBody?.content["application/json"]?.schema as Record<string, unknown>;
  };

  it("pulls operations from a wsdl:import'ed abstract WSDL (entry alone has none)", () => {
    expect(Object.keys(adaptWsdl(entryWsdl).paths ?? {})).toEqual([]);
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual(["/AirPrice", "/FlightDetails"]);
  });

  it("names repeated generic operation names after the portType, minus its suffix", () => {
    const item = doc.paths?.["/FlightDetails"] as Record<string, Record<string, unknown>>;
    const op = item.post;
    expect(op).toMatchObject({
      operationId: "FlightDetails",
      "x-soap-operation": "service",
      "x-soap-port-type": "FlightDetailsPortType",
    });
  });

  it("resolves a transitive xsd:include/import chain across relative directories", () => {
    const schema = bodySchema("/FlightDetails") as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.properties.Carrier).toMatchObject({ type: "string" });
    // typeAirport lives two hops away: ../common/Common.xsd → CommonTypes.xsd.
    expect(schema.properties.Origin).toMatchObject({
      $ref: "#/components/schemas/typeAirport",
    });
    expect(doc.components?.schemas?.typeAirport).toMatchObject({ type: "string" });
  });

  it("lowers a complexContent extension to allOf over its cross-file base", () => {
    const schema = bodySchema("/AirPrice") as { allOf: Record<string, unknown>[] };
    expect(schema.allOf[0]).toEqual({ $ref: "#/components/schemas/BaseReq" });
    expect(schema.allOf[1]).toMatchObject({
      type: "object",
      properties: { FareBasis: { type: "string" } },
    });
  });

  it("degrades gracefully when an import is missing (single-file contract)", () => {
    const partial = adaptWsdl(
      entryWsdl,
      (p) => (p === "svc/AirAbstract.wsdl" ? abstractWsdl : undefined),
      "svc/Air.wsdl",
    );
    // Operations still lower; the unresolved schema degrades permissively.
    expect(Object.keys(partial.paths ?? {})).toHaveLength(2);
  });

  it("survives wsdl:import and xsd:include cycles", () => {
    const selfImporting = `<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:tns="urn:x">
  <import namespace="urn:x" location="self.wsdl"/>
  <message name="M"><part name="p" type="xs:string"/></message>
  <portType name="P"><operation name="Ping"><input message="tns:M"/></operation></portType>
</definitions>`;
    expect(() => adaptWsdl(selfImporting, () => selfImporting, "self.wsdl")).not.toThrow();

    const cyclic = {
      "a.xsd": `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:include schemaLocation="b.xsd"/>
  <xs:element name="Ping" type="xs:string"/>
</xs:schema>`,
      "b.xsd": `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:include schemaLocation="a.xsd"/>
</xs:schema>`,
    } as Record<string, string>;
    const wsdl = `<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:tns="urn:x">
  <types><schema xmlns="http://www.w3.org/2001/XMLSchema"><include schemaLocation="a.xsd"/></schema></types>
  <message name="M"><part name="p" element="tns:Ping"/></message>
  <portType name="P"><operation name="Ping"><input message="tns:M"/></operation></portType>
</definitions>`;
    const cycled = adaptWsdl(wsdl, (p) => cyclic[p], "svc.wsdl");
    const item = cycled.paths?.["/P/Ping"] as Record<string, Op>;
    const op = item.post as Op;
    expect(op.requestBody?.content["application/json"]?.schema).toMatchObject({ type: "string" });
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
    expect(JSON.stringify(schemas.ListMessagesResponse)).toContain("#/components/schemas/Message");
    expect(JSON.stringify(doc)).not.toContain('"$ref":"Message"'); // no dangling bare refs
  });

  it("carries the OAuth2 scopes into a security scheme", () => {
    const schemes = doc.components?.securitySchemes as Record<string, { type: string }>;
    expect(schemes.oauth2?.type).toBe("oauth2");
  });

  it("emits per-operation security from method scopes (finding #27)", () => {
    // Gmail's send needs gmail.send while list needs only readonly — without a
    // per-operation security requirement every method inherited the document's
    // bare `oauth2: []` and lost its real scopes in the generated AIR.
    const send = doc.paths?.["/gmail/v1/users/{userId}/messages/send"]?.post as Record<
      string,
      unknown
    >;
    expect(send.security).toEqual([{ oauth2: ["https://www.googleapis.com/auth/gmail.send"] }]);
    // A method without declared scopes emits none (falls back to the document default).
    const list = doc.paths?.["/gmail/v1/users/{userId}/messages"]?.get as Record<string, unknown>;
    expect(list.security).toBeUndefined();
  });

  it("builds the server from baseUrl/servicePath, not bare rootUrl (finding #26)", () => {
    // Gmail's servicePath is "" so rootUrl alone worked by luck; Drive-shaped
    // documents put the API prefix in servicePath and their method paths are
    // relative to it — dropping it would call /files instead of /drive/v3/files.
    const drive = JSON.stringify({
      kind: "discovery#restDescription",
      name: "drive",
      version: "v3",
      title: "Drive API",
      rootUrl: "https://www.googleapis.com/",
      servicePath: "drive/v3/",
      resources: {
        files: {
          methods: {
            list: { id: "drive.files.list", path: "files", httpMethod: "GET" },
          },
        },
      },
      schemas: {},
    });
    const lowered = adaptDiscovery(drive);
    expect(lowered.servers?.[0]?.url).toBe("https://www.googleapis.com/drive/v3");
    // A document that precomputes baseUrl wins outright.
    const withBase = adaptDiscovery(
      JSON.stringify({
        kind: "discovery#restDescription",
        name: "x",
        version: "v1",
        baseUrl: "https://x.googleapis.com/api/v1/",
        rootUrl: "https://x.googleapis.com/",
        servicePath: "api/v1/",
        resources: { r: { methods: { get: { id: "x.r.get", path: "r", httpMethod: "GET" } } } },
        schemas: {},
      }),
    );
    expect(withBase.servers?.[0]?.url).toBe("https://x.googleapis.com/api/v1");
  });
});

describe("Postman Collection adapter", () => {
  const doc = adaptPostman(postmanSpec);
  type Op = Record<string, unknown>;
  const op = (path: string, method: string): Op =>
    (doc.paths?.[path] as Record<string, Op>)?.[method] as Op;

  it("lowers folder leaves to operations with folder tags and dotted operationIds", () => {
    const list = op("/users", "get");
    expect(list).toBeDefined();
    expect(list.operationId).toBe("Users.List_Users");
    expect(list.tags).toEqual(["Users"]);
    expect(op("/login", "post").tags).toEqual(["Auth"]);
    // The truthful wire method is kept — GET is GET; no effect hints needed.
    expect(list["x-anvil-effect"]).toBeUndefined();
  });

  it("resolves the {{baseUrl}} host from collection variables into servers[0]", () => {
    expect(doc.servers?.[0]?.url).toBe("https://api.example.com/v1");
  });

  it("turns `:id` segments into required path parameters with url.variable metadata", () => {
    const get = op("/users/{id}", "get");
    expect(get).toBeDefined();
    const params = get.parameters as Array<Record<string, unknown>>;
    expect(params.find((p) => p.in === "path")).toMatchObject({
      name: "id",
      required: true,
      description: "User id",
      schema: { type: "string" },
    });
  });

  it("lowers query and header params as optional, without copying saved values", () => {
    const params = op("/users", "get").parameters as Array<Record<string, unknown>>;
    const limit = params.find((p) => p.name === "limit");
    expect(limit).toMatchObject({ in: "query", required: false, description: "Page size" });
    // Postman has no requiredness; a disabled entry says so in its description.
    const verbose = params.find((p) => p.name === "verbose");
    expect(verbose).toMatchObject({ in: "query", required: false });
    expect(String(verbose?.description)).toContain("disabled");
    // Custom headers cross over; Authorization is the runtime's, never an input.
    expect(params.find((p) => p.name === "X-Org-Id")).toMatchObject({ in: "header" });
    expect(params.find((p) => String(p.name).toLowerCase() === "authorization")).toBeUndefined();
    // Saved parameter values (often credentials) are never copied.
    expect(JSON.stringify(params)).not.toContain("org_123");
  });

  it("infers a raw-JSON body schema from the example and attaches the example", () => {
    const body = op("/users", "post").requestBody as {
      content: Record<
        string,
        { schema: { properties: Record<string, unknown> }; example: unknown }
      >;
    };
    const media = body.content["application/json"];
    expect(media).toBeDefined();
    expect(media?.schema.properties).toMatchObject({
      name: { type: "string" },
      age: { type: "number" },
      tags: { type: "array", items: { type: "string" } },
      active: { type: "boolean" },
    });
    expect(media?.example).toEqual({
      name: "Ada Lovelace",
      age: 36,
      tags: ["admin"],
      active: true,
    });
  });

  it("lowers an urlencoded body from the key list only — values never cross", () => {
    const body = op("/login", "post").requestBody as {
      content: Record<string, { schema: { properties: Record<string, unknown> } }>;
    };
    const media = body.content["application/x-www-form-urlencoded"];
    expect(Object.keys(media?.schema.properties ?? {})).toEqual(["username", "password"]);
    expect(JSON.stringify(body)).not.toContain("ada");
    expect(JSON.stringify(body)).not.toContain("hunter2-secret");
  });

  it("maps collection-level auth to the document default and request-level auth per-op", () => {
    const schemes = doc.components?.securitySchemes as Record<string, Record<string, unknown>>;
    expect(schemes.apiKeyAuth).toEqual({ type: "apiKey", in: "header", name: "X-API-Key" });
    expect(schemes.bearerAuth).toEqual({ type: "http", scheme: "bearer" });
    expect(doc.security).toEqual([{ apiKeyAuth: [] }]);
    expect(op("/login", "post").security).toEqual([{ bearerAuth: [] }]);
  });

  it("NEVER leaks secret values embedded in the collection's auth blocks", () => {
    // Real collections routinely carry live tokens in auth `value` fields; the
    // adapter reads only a small non-secret allowlist, so no credential from
    // the source may appear ANYWHERE in the lowered document.
    const lowered = JSON.stringify(doc);
    expect(lowered).not.toContain("TOP-SECRET-API-KEY-VALUE");
    expect(lowered).not.toContain("SECRET-BEARER-TOKEN");
    expect(lowered).not.toContain("hunter2-secret");
  });

  it("turns a saved example response into a typed response with the example attached", () => {
    const responses = op("/users/{id}", "get").responses as Record<
      string,
      { content?: Record<string, { schema: Record<string, unknown>; example: unknown }> }
    >;
    const media = responses["200"]?.content?.["application/json"];
    expect(media?.schema).toMatchObject({
      type: "object",
      properties: {
        id: { type: "string" },
        age: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
        active: { type: "boolean" },
        nickname: { type: "string", nullable: true },
      },
    });
    expect((media?.example as Record<string, unknown> | undefined)?.name).toBe("Ada");
    // No saved response → the generic 200.
    const generic = op("/users", "post").responses as Record<string, { description: string }>;
    expect(generic["200"]?.description).toBe("Successful response.");
  });

  it("reports untranslated pre-request/test scripts instead of staying silent", () => {
    // One collection-level prerequest + one item-level test script.
    expect((doc as Record<string, unknown>)["x-anvil-postman-scripts"]).toBe(2);
    expect(doc.info?.description).toContain("2 Postman script block(s)");
    expect(doc.info?.description).toContain("Customer records for the CRM.");
  });

  it("parses the v2.0 shape too: string URLs and object-encoded auth", () => {
    const v20 = adaptPostman(postmanV20Spec);
    const get = (v20.paths?.["/get"] as Record<string, Op>)?.get as Op;
    expect(get).toBeDefined();
    expect(v20.servers?.[0]?.url).toBe("https://postman-echo.com");
    const params = get.parameters as Array<Record<string, unknown>>;
    expect(params.find((p) => p.name === "foo")).toMatchObject({ in: "query" });
    // Object-encoded basic auth registers the scheme without its credentials.
    const schemes = v20.components?.securitySchemes as Record<string, Record<string, unknown>>;
    expect(schemes.basicAuth).toEqual({ type: "http", scheme: "basic" });
    expect(JSON.stringify(v20)).not.toContain("hunter2-basic");
    // An un-inferrable raw JSON body still typed from its example.
    const post = (v20.paths?.["/post"] as Record<string, Op>)?.post as Op;
    const body = post.requestBody as { content: Record<string, { example: unknown }> };
    expect(body.content["application/json"]?.example).toEqual({ hello: "world" });
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
    // The wire method is truthful (POST) while retry/idempotency still follow
    // the adapter-asserted READ effect — exactly the posture GET-reads had.
    expect(products?.sourceRef.method).toBe("post");
    expect(products?.idempotency.mode).toBe("natural");
    expect(products?.retries.mode).toBe("safe");
    expect(products?.confirmation.required).toBe(false);
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
    expect(get?.sourceRef.method).toBe("post");
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
    const send = air.operations.find(
      (o) => o.sourceRef.operationId === "gmail.users.messages.send",
    );
    expect(send?.effect.kind).toBe("mutation");
    expect(send?.effect.risk).toBe("high"); // COMMS: sending a message
    // The request body schema resolved from the bare `$ref: "Message"`.
    expect(Object.keys(send?.input.schema?.properties ?? {})).toEqual(
      expect.arrayContaining(["id", "thread_id"]),
    );
    const list = air.operations.find(
      (o) => o.sourceRef.operationId === "gmail.users.messages.list",
    );
    expect(list?.effect.kind).toBe("read");
    expect(list?.retries.mode).toBe("safe");
  });

  it("compiles a Postman collection: GETs are safe reads, POSTs stay review_required", async () => {
    const air = await compile({
      spec: postmanSpec,
      serviceId: "crm",
      sourceUri: "crm.postman_collection.json",
    });
    expect(air.service.source.kind).toBe("postman");
    const list = air.operations.find((o) => o.sourceRef.operationId === "Users.List_Users");
    expect(list?.effect.kind).toBe("read");
    expect(list?.retries.mode).toBe("safe");
    expect(list?.sourceRef.method).toBe("get");
    // A POST from a collection is not provably idempotent — never silently exposed.
    const create = air.operations.find((o) => o.sourceRef.operationId === "Users.Create_User");
    expect(create?.effect.kind).toBe("mutation");
    expect(create?.state).toBe("review_required");
    // The no-secret-leak guarantee holds through the WHOLE pipeline, not just
    // the lowering: embedded auth values never reach the compiled AIR.
    const compiled = JSON.stringify(air);
    expect(compiled).not.toContain("TOP-SECRET-API-KEY-VALUE");
    expect(compiled).not.toContain("SECRET-BEARER-TOKEN");
    expect(compiled).not.toContain("hunter2-secret");
  });
});
