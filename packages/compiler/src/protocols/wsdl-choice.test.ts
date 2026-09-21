import type { Diagnostic, JsonSchema } from "@anvil/air";
import { materializeSchemaBranches } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compile } from "../compile.js";
import { detectProtocolFormat } from "./index.js";
import { adaptWsdl, wsdlVersionOf } from "./wsdl.js";

/**
 * `xsd:choice` used to flatten into co-required siblings — a request schema
 * an agent could only satisfy by sending every branch. It now lowers to
 * optional members under a `oneOf` that admits exactly one branch, and says
 * so once per type. WSDL 2.0 used to lower to zero operations in silence; it
 * is now refused by name.
 */

const wsdl = (types: string, requestElement = "PayRequest") => `<?xml version="1.0"?>
<definitions name="Payments" targetNamespace="urn:pay"
  xmlns="http://schemas.xmlsoap.org/wsdl/"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:tns="urn:pay" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <types>
    <xsd:schema targetNamespace="urn:pay">
      ${types}
    </xsd:schema>
  </types>
  <message name="PayInput"><part name="parameters" element="tns:${requestElement}"/></message>
  <message name="PayOutput"><part name="parameters" element="tns:PayResponse"/></message>
  <portType name="PaymentsPort">
    <operation name="Pay"><input message="tns:PayInput"/><output message="tns:PayOutput"/></operation>
  </portType>
  <binding name="PaymentsBinding" type="tns:PaymentsPort">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="Pay">
      <soap:operation soapAction="urn:pay/Pay"/>
      <input><soap:body use="literal"/></input>
      <output><soap:body use="literal"/></output>
    </operation>
  </binding>
  <service name="Payments">
    <port name="PaymentsPort" binding="tns:PaymentsBinding">
      <soap:address location="https://pay.example.com/soap"/>
    </port>
  </service>
</definitions>`;

const RESPONSE = `<xsd:element name="PayResponse"><xsd:complexType><xsd:sequence>
  <xsd:element name="receiptId" type="xsd:string"/>
</xsd:sequence></xsd:complexType></xsd:element>`;

/** "Must be absent": the false schema, as `constraintFor` spells it. */
const ABSENT = { not: {} };
const absent = (...names: string[]) => Object.fromEntries(names.map((n) => [n, ABSENT]));

type Schema = Record<string, unknown>;
const requestSchemaOf = (doc: ReturnType<typeof adaptWsdl>): Schema => {
  const op = doc.paths?.["/PaymentsPort/Pay"]?.post as Record<string, unknown>;
  const body = op.requestBody as { content: Record<string, { schema: Schema }> };
  return body.content["application/json"]?.schema as Schema;
};

describe("xsd:choice lowers to optional members under a oneOf", () => {
  const TYPES = `
    <xsd:element name="PayRequest"><xsd:complexType><xsd:sequence>
      <xsd:element name="amount" type="xsd:decimal"/>
      <xsd:choice>
        <xsd:element name="card" type="xsd:string"/>
        <xsd:element name="bankAccount" type="xsd:string"/>
      </xsd:choice>
      <xsd:element name="note" type="xsd:string" minOccurs="0"/>
    </xsd:sequence></xsd:complexType></xsd:element>
    ${RESPONSE}`;
  const diagnostics: Diagnostic[] = [];
  const doc = adaptWsdl(wsdl(TYPES), undefined, "pay.wsdl", diagnostics);
  const schema = requestSchemaOf(doc);

  it("keeps every branch visible and typed, but never co-required", () => {
    expect(Object.keys(schema.properties as object).sort()).toEqual([
      "amount",
      "bankAccount",
      "card",
      "note",
    ]);
    expect(schema.required).toEqual(["amount"]);
  });

  it("admits exactly one branch, so an agent cannot send all of them", () => {
    expect(schema.oneOf).toEqual([{ required: ["card"] }, { required: ["bankAccount"] }]);
  });

  it("says so once per type, naming the branches", () => {
    const lowered = diagnostics.filter((d) => d.code === "wsdl_choice_lowered");
    expect(lowered).toHaveLength(1);
    expect(lowered[0]).toMatchObject({ level: "warning", path: "PayRequest" });
    expect(lowered[0]?.message).toContain("(card | bankAccount)");
  });
});

describe("the less regular choices", () => {
  it("reports a named type once, however many elements use it", () => {
    const diagnostics: Diagnostic[] = [];
    adaptWsdl(
      wsdl(`
        <xsd:complexType name="PaymentMethod"><xsd:choice>
          <xsd:element name="card" type="xsd:string"/>
          <xsd:element name="bankAccount" type="xsd:string"/>
        </xsd:choice></xsd:complexType>
        <xsd:element name="PayRequest"><xsd:complexType><xsd:sequence>
          <xsd:element name="primary" type="tns:PaymentMethod"/>
          <xsd:element name="fallback" type="tns:PaymentMethod" minOccurs="0"/>
        </xsd:sequence></xsd:complexType></xsd:element>
        ${RESPONSE}`),
      undefined,
      "pay.wsdl",
      diagnostics,
    );
    const lowered = diagnostics.filter((d) => d.code === "wsdl_choice_lowered");
    expect(lowered.map((d) => d.path)).toEqual(["PaymentMethod"]);
  });

  it("admits the empty case for an optional choice", () => {
    const doc = adaptWsdl(
      wsdl(`
        <xsd:element name="PayRequest"><xsd:complexType><xsd:sequence>
          <xsd:choice minOccurs="0">
            <xsd:element name="card" type="xsd:string"/>
            <xsd:element name="bankAccount" type="xsd:string"/>
          </xsd:choice>
        </xsd:sequence></xsd:complexType></xsd:element>
        ${RESPONSE}`),
    );
    expect(requestSchemaOf(doc).oneOf).toEqual([
      { required: ["card"] },
      { required: ["bankAccount"] },
      { properties: { card: ABSENT, bankAccount: ABSENT } },
    ]);
  });

  it("flattens a nested choice and rules out cross-branch mixing for a sequence branch", () => {
    const doc = adaptWsdl(
      wsdl(`
        <xsd:element name="PayRequest"><xsd:complexType>
          <xsd:choice>
            <xsd:element name="card" type="xsd:string"/>
            <xsd:sequence>
              <xsd:element name="routing" type="xsd:string"/>
              <xsd:element name="account" type="xsd:string"/>
              <xsd:element name="memo" type="xsd:string" minOccurs="0"/>
            </xsd:sequence>
            <xsd:choice>
              <xsd:element name="wallet" type="xsd:string"/>
              <xsd:element name="voucher" type="xsd:string"/>
            </xsd:choice>
          </xsd:choice>
        </xsd:complexType></xsd:element>
        ${RESPONSE}`),
    );
    const schema = requestSchemaOf(doc);
    expect(schema.required).toBeUndefined();
    expect(schema.oneOf).toEqual([
      { required: ["card"], properties: absent("routing", "account", "memo", "wallet", "voucher") },
      { required: ["routing", "account"], properties: absent("card", "wallet", "voucher") },
      { required: ["wallet"], properties: absent("card", "routing", "account", "memo", "voucher") },
      { required: ["voucher"], properties: absent("card", "routing", "account", "memo", "wallet") },
    ]);
  });

  it("conjoins two choices in one type, each keeping its own rule", () => {
    const doc = adaptWsdl(
      wsdl(`
        <xsd:element name="PayRequest"><xsd:complexType><xsd:sequence>
          <xsd:choice>
            <xsd:element name="card" type="xsd:string"/>
            <xsd:element name="bankAccount" type="xsd:string"/>
          </xsd:choice>
          <xsd:choice>
            <xsd:element name="email" type="xsd:string"/>
            <xsd:element name="sms" type="xsd:string"/>
          </xsd:choice>
        </xsd:sequence></xsd:complexType></xsd:element>
        ${RESPONSE}`),
    );
    const schema = requestSchemaOf(doc);
    expect(schema.oneOf).toBeUndefined();
    expect(schema.allOf).toEqual([
      { oneOf: [{ required: ["card"] }, { required: ["bankAccount"] }] },
      { oneOf: [{ required: ["email"] }, { required: ["sms"] }] },
    ]);
  });

  it("leaves a choice inside a nested element's own type to that type", () => {
    const doc = adaptWsdl(
      wsdl(`
        <xsd:element name="PayRequest"><xsd:complexType><xsd:sequence>
          <xsd:element name="amount" type="xsd:decimal"/>
          <xsd:element name="method"><xsd:complexType><xsd:choice>
            <xsd:element name="card" type="xsd:string"/>
            <xsd:element name="bankAccount" type="xsd:string"/>
          </xsd:choice></xsd:complexType></xsd:element>
        </xsd:sequence></xsd:complexType></xsd:element>
        ${RESPONSE}`),
    );
    const schema = requestSchemaOf(doc);
    expect(schema.oneOf).toBeUndefined();
    expect(schema.required).toEqual(["amount", "method"]);
    const method = (schema.properties as Record<string, Schema>).method;
    expect(method?.oneOf).toEqual([{ required: ["card"] }, { required: ["bankAccount"] }]);
    expect(method?.required).toBeUndefined();
  });
});

describe("a choice nested inside a sequence branch keeps its own rule", () => {
  /** An outer choice: `card`, or a bank sequence that itself chooses a rail. */
  const NESTED = (railMinOccurs = "1") => `
    <xsd:element name="PayRequest"><xsd:complexType>
      <xsd:choice>
        <xsd:element name="card" type="xsd:string"/>
        <xsd:sequence>
          <xsd:element name="routing" type="xsd:string"/>
          <xsd:choice minOccurs="${railMinOccurs}">
            <xsd:element name="wire" type="xsd:string"/>
            <xsd:element name="ach" type="xsd:string"/>
          </xsd:choice>
        </xsd:sequence>
      </xsd:choice>
    </xsd:complexType></xsd:element>
    ${RESPONSE}`;

  it("expands the sequence into one alternative per inner branch", () => {
    // Flattening the inner members as unconstrained optionals would accept
    // both `{routing}` with no rail and `{routing, wire, ach}` with two, and
    // encode either into SOAP the service rejects. One alternative per
    // combination is what keeps the inner exactly-one rule.
    const schema = requestSchemaOf(adaptWsdl(wsdl(NESTED())));
    expect(schema.oneOf).toEqual([
      { required: ["card"], properties: absent("routing", "wire", "ach") },
      { required: ["routing", "wire"], properties: absent("card", "ach") },
      { required: ["routing", "ach"], properties: absent("card", "wire") },
    ]);
  });

  it("adds the no-rail combination when the inner choice is optional", () => {
    const schema = requestSchemaOf(adaptWsdl(wsdl(NESTED("0"))));
    expect(schema.oneOf).toEqual([
      { required: ["card"], properties: absent("routing", "wire", "ach") },
      { required: ["routing", "wire"], properties: absent("card", "ach") },
      { required: ["routing", "ach"], properties: absent("card", "wire") },
      { required: ["routing"], properties: absent("card", "wire", "ach") },
    ]);
  });

  it("still names every member of the sequence branch in the diagnostic", () => {
    const diagnostics: Diagnostic[] = [];
    adaptWsdl(wsdl(NESTED()), undefined, "pay.wsdl", diagnostics);
    const lowered = diagnostics.filter((d) => d.code === "wsdl_choice_lowered");
    expect(lowered).toHaveLength(1);
    expect(lowered[0]?.message).toContain("(card | routing | wire | ach)");
  });

  it("falls back to the permissive branch past the alternative cap", () => {
    // Nested choices multiply. Past the cap the sequence keeps its members
    // visible and requires nothing extra — permissive, not wrong — because
    // refusing valid requests is worse than admitting a few invalid ones, and
    // a schema with thousands of alternatives helps no reader.
    const rails = Array.from(
      { length: 7 },
      (_, i) => `<xsd:choice>
        <xsd:element name="a${i}" type="xsd:string"/>
        <xsd:element name="b${i}" type="xsd:string"/>
      </xsd:choice>`,
    ).join("");
    const schema = requestSchemaOf(
      adaptWsdl(
        wsdl(`
          <xsd:element name="PayRequest"><xsd:complexType>
            <xsd:choice>
              <xsd:element name="card" type="xsd:string"/>
              <xsd:sequence>${rails}</xsd:sequence>
            </xsd:choice>
          </xsd:complexType></xsd:element>
          ${RESPONSE}`),
      ),
    );
    const alternatives = schema.oneOf as Schema[];
    expect(alternatives).toHaveLength(2);
    expect(alternatives[1]?.required).toBeUndefined();
    expect(Object.keys((alternatives[1]?.properties ?? {}) as object)).toEqual(["card"]);
  });

  it("refuses none and both, and accepts exactly one, at the served surface", async () => {
    // The whole point of the lowering. This is the shape a serving surface
    // actually validates against: the operation's own body schema, through
    // the same branch materialization and JSON-Schema import the MCP runtime
    // and the generated CLI use. An encoding the importer refuses, or one the
    // bundler's depth bound guts, fails here rather than in production.
    const air = await compile({
      spec: wsdl(NESTED()),
      serviceId: "payments",
      sourceUri: "pay.wsdl",
    });
    const pay = air.operations.find((o) => o.sourceRef.operationId === "Pay");
    const body = pay?.input.body?.schema;
    expect(body).toBeDefined();
    const validator = z.fromJSONSchema(
      materializeSchemaBranches(body as JsonSchema) as Parameters<typeof z.fromJSONSchema>[0],
    );
    const accepts = (value: unknown) => validator.safeParse(value).success;
    expect(accepts({ card: "4111" })).toBe(true);
    expect(accepts({ routing: "021", wire: "w" })).toBe(true);
    expect(accepts({ routing: "021", ach: "a" })).toBe(true);
    // The two the flattened lowering used to let through.
    expect(accepts({ routing: "021" })).toBe(false);
    expect(accepts({ routing: "021", wire: "w", ach: "a" })).toBe(false);
    // And the outer rule, which it also lost.
    expect(accepts({ card: "4111", routing: "021", wire: "w" })).toBe(false);
    expect(accepts({})).toBe(false);
  });
});

describe("through the whole compiler", () => {
  it("carries the oneOf into the operation's body and surfaces the diagnostic", async () => {
    const spec = wsdl(`
      <xsd:element name="PayRequest"><xsd:complexType><xsd:sequence>
        <xsd:element name="amount" type="xsd:decimal"/>
        <xsd:choice>
          <xsd:element name="card" type="xsd:string"/>
          <xsd:element name="bankAccount" type="xsd:string"/>
        </xsd:choice>
      </xsd:sequence></xsd:complexType></xsd:element>
      ${RESPONSE}`);
    const air = await compile({ spec, serviceId: "payments", sourceUri: "pay.wsdl" });
    const pay = air.operations.find((o) => o.sourceRef.operationId === "Pay");
    expect(pay?.input.body?.schema).toMatchObject({
      required: ["amount"],
      oneOf: [{ required: ["card"] }, { required: ["bankAccount"] }],
    });
    // A body with a compositor is surfaced whole rather than split into flags,
    // so the exactly-one rule reaches every surface intact.
    expect(pay?.input.body?.projection).toBe("whole");
    expect(air.diagnostics.map((d) => d.code)).toContain("wsdl_choice_lowered");
  });
});

describe("WSDL 2.0 is refused by name", () => {
  const WSDL_20 = `<?xml version="1.0"?>
<description xmlns="http://www.w3.org/ns/wsdl" targetNamespace="urn:pay"
  xmlns:tns="urn:pay" xmlns:wsoap="http://www.w3.org/ns/wsdl/soap">
  <types/>
  <interface name="Payments">
    <operation name="Pay" pattern="http://www.w3.org/ns/wsdl/in-out">
      <input messageLabel="In" element="tns:PayRequest"/>
      <output messageLabel="Out" element="tns:PayResponse"/>
    </operation>
  </interface>
  <binding name="PaymentsSoap" interface="tns:Payments" type="http://www.w3.org/ns/wsdl/soap"/>
  <service name="PaymentsService" interface="tns:Payments">
    <endpoint name="PaymentsEndpoint" binding="tns:PaymentsSoap" address="https://pay.example.com/soap"/>
  </service>
</description>`;

  it("is labelled 2.0 by extension and by content sniff", () => {
    expect(wsdlVersionOf(WSDL_20)).toBe("2.0");
    expect(detectProtocolFormat("pay.wsdl", WSDL_20)).toEqual({ format: "wsdl", version: "2.0" });
    expect(detectProtocolFormat("", WSDL_20)).toEqual({ format: "wsdl", version: "2.0" });
  });

  it("produces zero operations on purpose, with an error that says why", () => {
    const diagnostics: Diagnostic[] = [];
    const doc = adaptWsdl(WSDL_20, undefined, "pay.wsdl", diagnostics);
    expect(Object.keys(doc.paths ?? {})).toEqual([]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        level: "error",
        code: "wsdl_version_unsupported",
        path: "pay.wsdl",
        message: expect.stringContaining("WSDL 2.0"),
      }),
    ]);
  });

  it("does not mistake a 1.1 document that merely mentions 2.0 for one", () => {
    const bait = wsdl(RESPONSE).replace(
      "<types>",
      "<documentation>see http://www.w3.org/ns/wsdl for the 2.0 edition</documentation><types>",
    );
    expect(wsdlVersionOf(bait)).toBe("1.1");
    const diagnostics: Diagnostic[] = [];
    const doc = adaptWsdl(bait, undefined, "pay.wsdl", diagnostics);
    expect(Object.keys(doc.paths ?? {})).toEqual(["/PaymentsPort/Pay"]);
    expect(diagnostics.map((d) => d.code)).not.toContain("wsdl_version_unsupported");
  });

  it("compiles end to end to an empty, error-carrying service rather than throwing", async () => {
    const air = await compile({ spec: WSDL_20, serviceId: "payments", sourceUri: "pay.wsdl" });
    expect(air.operations).toEqual([]);
    expect(air.diagnostics).toContainEqual(
      expect.objectContaining({ level: "error", code: "wsdl_version_unsupported" }),
    );
  });
});
