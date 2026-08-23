import { type Operation, Operation as OperationSchema } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { execute, type HttpResponse, InMemoryLedger, MockTransport } from "./index.js";

/**
 * SOAP on the wire, asserted against the bytes a real service would receive.
 *
 * Every expectation here is a literal envelope, not something recomputed from
 * AIR. An expectation derived from the same model as the code under test moves
 * with the bug instead of catching it — which is precisely how a bundle that
 * could not address its own service certified 38 checks out of 38.
 */
const BINDING = {
  soapAction: "http://example.com/banking/TransferFunds",
  envelopeNamespace: "http://schemas.xmlsoap.org/soap/envelope/",
  bodyNamespace: "http://example.com/banking",
  bodyElement: "TransferFundsRequest",
  responseElement: "TransferFundsResponse",
  contentType: "text/xml; charset=utf-8",
  soapVersion: "1.1" as const,
};

function op(overrides: Record<string, unknown> = {}): Operation {
  return OperationSchema.parse({
    id: "banking.transfer_funds.create",
    canonicalName: "create_transfer",
    displayName: "Transfer funds",
    sourceRef: {
      kind: "wsdl",
      path: "/BankingPort/TransferFunds",
      method: "post",
      binding: BINDING,
    },
    effect: { kind: "mutation", resource: "transfer", risk: "financial", reversible: false },
    input: {
      params: [],
      body: {
        contentType: "application/json",
        required: true,
        schema: {
          type: "object",
          properties: { amount: { type: "integer" }, note: { type: "string" } },
        },
        projection: "fields",
        fields: [
          { name: "amount", required: true, schema: { type: "integer" } },
          { name: "note", required: false, schema: { type: "string" } },
        ],
      },
    },
    idempotency: { mode: "natural", keyDerivation: "none" },
    retries: { mode: "safe", maxAttempts: 3, backoff: "fixed", retryOn: ["soap_transport_fault"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "banking transfer create" },
    mcp: { toolName: "banking_create_transfer" },
    skill: { intentExamples: [] },
    state: "approved",
    ...overrides,
  });
}

const soapOk = (inner: string): HttpResponse => ({
  status: 200,
  headers: { "content-type": "text/xml" },
  body:
    `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body><tns:TransferFundsResponse xmlns:tns="http://example.com/banking">${inner}` +
    `</tns:TransferFundsResponse></soap:Body></soap:Envelope>`,
});

const soapFault = (code: string, text: string, status = 500): HttpResponse => ({
  status,
  headers: { "content-type": "text/xml" },
  body:
    `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body><soap:Fault><faultcode>${code}</faultcode><faultstring>${text}</faultstring>` +
    `</soap:Fault></soap:Body></soap:Envelope>`,
});

const baseCtx = {
  serviceId: "banking",
  baseUrl: "https://banking.example.com/soap",
  allowedHosts: ["banking.example.com"],
  env: "dev",
  sleep: async () => {},
  rng: () => 0.5,
};

describe("the SOAP codec puts a real envelope on the wire", () => {
  it("posts to the declared endpoint, not the synthesized path", async () => {
    const transport = new MockTransport(() => soapOk("<ok>true</ok>"));
    await execute(
      op(),
      { input: { amount: 100 } },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );

    // `/BankingPort/TransferFunds` is a coordinate Anvil invented to hold four
    // operations apart in a path-keyed model. A SOAP service serves one address.
    expect(transport.requests[0]?.url).toBe("https://banking.example.com/soap");
    expect(transport.requests[0]?.url).not.toContain("BankingPort");
  });

  it("sends the SOAPAction header, quoted, as SOAP 1.1 requires", async () => {
    const transport = new MockTransport(() => soapOk("<ok>true</ok>"));
    await execute(
      op(),
      { input: { amount: 100 } },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(transport.requests[0]?.headers.soapaction).toBe(
      '"http://example.com/banking/TransferFunds"',
    );
    expect(transport.requests[0]?.headers["content-type"]).toBe("text/xml; charset=utf-8");
  });

  it("builds an envelope whose body element carries its namespace", async () => {
    const transport = new MockTransport(() => soapOk("<ok>true</ok>"));
    await execute(
      op(),
      { input: { amount: 100, note: "rent & bills" } },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(transport.requests[0]?.body).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
        "<soap:Body>" +
        '<n:TransferFundsRequest xmlns:n="http://example.com/banking">' +
        "<n:amount>100</n:amount>" +
        "<n:note>rent &amp; bills</n:note>" +
        "</n:TransferFundsRequest>" +
        "</soap:Body>" +
        "</soap:Envelope>",
    );
  });

  it("escapes values that would otherwise close the envelope", async () => {
    const transport = new MockTransport(() => soapOk("<ok>true</ok>"));
    await execute(
      op(),
      { input: { amount: 1, note: '</n:TransferFundsRequest><evil attr="1">' } },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    const body = transport.requests[0]?.body ?? "";
    expect(body).toContain("&lt;/n:TransferFundsRequest&gt;");
    expect(body).not.toContain("<evil");
    // Exactly one request element — injection did not add a second.
    expect(body.match(/<n:TransferFundsRequest/g)).toHaveLength(1);
  });

  it("reads the response out of the envelope", async () => {
    const transport = new MockTransport(() =>
      soapOk("<confirmationId>c_1</confirmationId><settled>false</settled>"),
    );
    const res = await execute(
      op(),
      { input: { amount: 100 } },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(res.outcome).toBe("success");
    if (res.outcome !== "success") throw new Error("expected success");
    expect(res.data).toEqual({ confirmationId: "c_1", settled: "false" });
  });

  it("collects a repeated element into an array", async () => {
    // The commonest way an XML-to-JSON mapping goes wrong: a server returning
    // one item where the contract implies many.
    const transport = new MockTransport(() => soapOk("<leg><id>a</id></leg><leg><id>b</id></leg>"));
    const res = await execute(
      op(),
      { input: { amount: 100 } },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    if (res.outcome !== "success") throw new Error("expected success");
    expect(res.data).toEqual({ leg: [{ id: "a" }, { id: "b" }] });
  });
});

describe("a SOAP fault is a failure, whatever the HTTP status says", () => {
  it("refuses an application fault instead of returning it as a result", async () => {
    const transport = new MockTransport(() => soapFault("soap:Client", "Account not found", 500));
    const res = await execute(
      op(),
      { input: { amount: 100 } },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") throw new Error("expected a refusal");
    expect(res.envelope.error.message).toContain("Account not found");
  });

  it("refuses a fault delivered with HTTP 200, which the status alone would pass", async () => {
    const transport = new MockTransport(() => soapFault("soap:Client", "Rejected", 200));
    const res = await execute(
      op(),
      { input: { amount: 100 } },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(res.outcome).toBe("error");
    expect(transport.requests).toHaveLength(1);
  });

  it("never retries a client fault — it will fail identically", async () => {
    const transport = new MockTransport(() => soapFault("soap:Client", "Rejected", 200));
    await execute(
      op(),
      { input: { amount: 100 } },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(transport.requests).toHaveLength(1);
  });

  it("retries a server fault, because that one is transient", async () => {
    let calls = 0;
    const transport = new MockTransport(() => {
      calls += 1;
      return calls < 3 ? soapFault("soap:Server", "Downstream busy", 500) : soapOk("<ok>1</ok>");
    });
    const res = await execute(
      op(),
      { input: { amount: 100 } },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(res.outcome).toBe("success");
    expect(transport.requests).toHaveLength(3);
  });

  it("does not retry a server fault when the operation is not safe to retry", async () => {
    // The safety model wins over the protocol's own opinion about transience.
    const transport = new MockTransport(() => soapFault("soap:Server", "Busy", 500));
    const res = await execute(
      op({
        idempotency: { mode: "none", mechanism: "none", keyDerivation: "none" },
        retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
        confirmation: { required: false },
      }),
      { input: { amount: 100 } },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(res.outcome).toBe("error");
    expect(transport.requests).toHaveLength(1);
  });
});

describe("the safety gates still hold over SOAP", () => {
  it("refuses an unconfirmed financial mutation before the envelope is built", async () => {
    const transport = new MockTransport(() => soapOk("<ok>1</ok>"));
    const res = await execute(
      op({ confirmation: { required: true, risk: "financial" } }),
      { input: { amount: 100 } },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") throw new Error("expected a refusal");
    expect(res.envelope.error.code).toBe("confirmation_required");
    expect(transport.requests).toHaveLength(0);
  });

  it("carries a required idempotency key into the envelope body", async () => {
    const transport = new MockTransport(() => soapOk("<ok>1</ok>"));
    const res = await execute(
      op({
        idempotency: {
          mode: "required",
          mechanism: "body",
          key: "idempotencyKey",
          keyDerivation: "client_supplied",
        },
        input: {
          params: [],
          body: {
            contentType: "application/json",
            required: true,
            schema: {
              type: "object",
              properties: { amount: { type: "integer" }, idempotencyKey: { type: "string" } },
            },
            projection: "fields",
            fields: [
              { name: "amount", required: true, schema: { type: "integer" } },
              { name: "idempotencyKey", required: true, schema: { type: "string" } },
            ],
          },
        },
      }),
      { input: { amount: 100 }, idempotencyKey: "idem-1" },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(res.outcome).toBe("success");
    expect(transport.requests[0]?.body).toContain("<n:idempotencyKey>idem-1</n:idempotencyKey>");
  });
});
