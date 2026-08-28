import { type Operation, Operation as OperationSchema } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { execute, type HttpResponse, InMemoryLedger, MockTransport } from "./index.js";

/**
 * The transport gate, proved structurally rather than cosmetically.
 *
 * The interesting assertion in every case here is `transport.requests` being
 * empty. An error code alone would not distinguish "the runtime refused" from
 * "the runtime sent a well-formed lie and the upstream happened to reject it",
 * and it is the first of those that this gate exists to guarantee.
 */
function op(overrides: Record<string, unknown> = {}): Operation {
  return OperationSchema.parse({
    id: "banking.get_balance.list",
    canonicalName: "list_balance",
    displayName: "Get account balance",
    sourceRef: { kind: "wsdl", path: "/BankingPort/GetAccountBalance", method: "post" },
    effect: { kind: "read", resource: "balance", risk: "low", reversible: true },
    input: { params: [] },
    idempotency: { mode: "natural", keyDerivation: "none" },
    retries: { mode: "safe", maxAttempts: 2, backoff: "exponential_jitter", retryOn: ["http_503"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "banking balance list" },
    mcp: { toolName: "banking_list_balance" },
    skill: { intentExamples: [] },
    state: "approved",
    ...overrides,
  });
}

const ok = (body: unknown): HttpResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(body),
});

const baseCtx = {
  serviceId: "banking",
  baseUrl: "https://banking.example.com",
  allowedHosts: ["banking.example.com"],
  env: "dev",
  sleep: async () => {},
  rng: () => 0.5,
};

describe("transport gate", () => {
  const cases = [
    { kind: "wsdl", protocol: "soap", path: "/BankingPort/GetAccountBalance" },
    { kind: "graphql", protocol: "graphql", path: "/graphql/Query/product" },
    { kind: "protobuf", protocol: "grpc", path: "/acme.orders.v1.OrderService/GetOrder" },
  ] as const;

  for (const c of cases) {
    it(`refuses a ${c.protocol} operation before a request is built`, async () => {
      const transport = new MockTransport(() => ok({ balance: 1 }));
      const res = await execute(
        op({ sourceRef: { kind: c.kind, path: c.path, method: "post" } }),
        { input: {} },
        { ...baseCtx, transport, ledger: new InMemoryLedger() },
      );

      expect(res.outcome).toBe("error");
      if (res.outcome !== "error") throw new Error("expected a refusal");
      expect(res.envelope.error.code).toBe("unsupported_operation");
      expect(res.envelope.error.message).toContain(c.protocol);
      // The whole point: nothing went on the wire.
      expect(transport.requests).toHaveLength(0);
    });
  }

  it("refuses an adopted MCP tool rather than degrading it to GET on the base URL", async () => {
    // `adoptMcp` emits a sourceRef with neither path nor method, which the
    // executor's `?? "/"` and `?? "get"` defaults would have silently turned
    // into a GET of the base URL — a request to something, for an operation
    // whose real invocation is a tools/call.
    const transport = new MockTransport(() => ok({}));
    const res = await execute(
      op({ sourceRef: { kind: "mcp", operationId: "core_user_get_users" } }),
      { input: {} },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(res.outcome).toBe("error");
    expect(transport.requests).toHaveLength(0);
  });

  it("executes an HTTP/JSON operation untouched", async () => {
    const transport = new MockTransport(() => ok({ balance: 1 }));
    const res = await execute(
      op({ sourceRef: { kind: "openapi", path: "/balance", method: "get" } }),
      { input: {} },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(res.outcome).toBe("success");
    expect(transport.requests).toHaveLength(1);
  });

  describe("the facade declaration", () => {
    it("lets a declared facade through and records the reason", async () => {
      const transport = new MockTransport(() => ok({ balance: 1 }));
      const res = await execute(
        op(),
        { input: {} },
        {
          ...baseCtx,
          transport,
          ledger: new InMemoryLedger(),
          protocolFacade: "a REST-to-SOAP gateway at this base URL",
        },
      );
      expect(res.outcome).toBe("success");
      expect(transport.requests).toHaveLength(1);
      // A silent escape hatch would be worse than no gate: it would move the
      // same untrue assumption somewhere nobody can see it afterwards.
      expect(res.record.policyDecisions).toContain(
        "protocol_facade_declared:soap:a REST-to-SOAP gateway at this base URL",
      );
    });

    it("does not decorate an HTTP/JSON call that never needed one", async () => {
      const transport = new MockTransport(() => ok({ balance: 1 }));
      const res = await execute(
        op({ sourceRef: { kind: "openapi", path: "/balance", method: "get" } }),
        { input: {} },
        {
          ...baseCtx,
          transport,
          ledger: new InMemoryLedger(),
          protocolFacade: "irrelevant here",
        },
      );
      expect(res.outcome).toBe("success");
      expect(res.record.policyDecisions.join(" ")).not.toContain("protocol_facade_declared");
    });

    it("is not a way past the approval gate", async () => {
      const transport = new MockTransport(() => ok({}));
      const res = await execute(
        op({ state: "review_required" }),
        { input: {} },
        {
          ...baseCtx,
          transport,
          ledger: new InMemoryLedger(),
          protocolFacade: "a REST-to-SOAP gateway at this base URL",
        },
      );
      expect(res.outcome).toBe("error");
      if (res.outcome !== "error") throw new Error("expected a refusal");
      expect(res.envelope.error.message).toContain("not approved");
      expect(transport.requests).toHaveLength(0);
    });
  });
});

/**
 * The codec seam is a refactor, and a refactor's only obligation is that
 * nothing moved. The assertion is against literal expected bytes rather than
 * anything recomputed from AIR — an expectation derived from the same model as
 * the code under test moves with the bug instead of catching it, which is the
 * exact tautology that let a non-executable bundle certify 38/38.
 */
describe("the codec seam preserves HTTP/JSON byte-for-byte", () => {
  it("sends the same method, url, headers and body it always did", async () => {
    const transport = new MockTransport(() => ok({ ok: true }));
    const res = await execute(
      op({
        sourceRef: { kind: "openapi", path: "/widgets/{widget_id}/parts", method: "post" },
        effect: { kind: "mutation", resource: "part", risk: "low", reversible: true },
        confirmation: { required: false },
        idempotency: { mode: "natural", keyDerivation: "none" },
        input: {
          params: [
            { name: "widget_id", in: "path", required: true, schema: { type: "string" } },
            { name: "expand", in: "query", required: false, schema: { type: "string" } },
            { name: "X-Tenant", in: "header", required: false, schema: { type: "string" } },
          ],
          body: {
            contentType: "application/json",
            required: true,
            schema: { type: "object", properties: { label: { type: "string" } } },
            projection: "fields",
            fields: [{ name: "label", required: true, schema: { type: "string" } }],
          },
        },
      }),
      { input: { widget_id: "w 1", expand: "a b", x_tenant: "acme", label: "left" } },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );

    expect(res.outcome).toBe("success");
    const sent = transport.requests[0];
    expect(sent?.method).toBe("POST");
    expect(sent?.url).toBe("https://banking.example.com/widgets/w%201/parts?expand=a+b");
    expect(sent?.headers["content-type"]).toBe("application/json");
    expect(sent?.headers.accept).toBe("application/json");
    expect(sent?.headers["X-Tenant"]).toBe("acme");
    expect(sent?.body).toBe('{"label":"left"}');
  });

  it("decodes a JSON response, and a non-JSON body as its own text", async () => {
    const transport = new MockTransport(() => ({
      status: 200,
      headers: {},
      body: "not json at all",
    }));
    const res = await execute(
      op({ sourceRef: { kind: "openapi", path: "/thing", method: "get" } }),
      { input: {} },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(res.outcome).toBe("success");
    if (res.outcome !== "success") throw new Error("expected success");
    expect(res.data).toBe("not json at all");
  });
});

/**
 * gRPC through a JSON transcoder.
 *
 * The one protocol whose path was never synthesized — `/package.Service/Method`
 * IS gRPC's `:path`. What Anvil cannot do is speak native gRPC from four
 * zero-dependency clients, because Python's standard library has no HTTP/2
 * client at all. A transcoder (grpc-gateway, Envoy's gRPC-JSON filter) accepts
 * JSON on that exact path, which is a fact about the deployment — so it is
 * declared, not assumed.
 */
describe("gRPC reaches a declared transcoder and nothing else", () => {
  const grpcOp = () =>
    op({
      sourceRef: {
        kind: "protobuf",
        path: "/acme.orders.v1.OrderService/GetOrder",
        method: "post",
        binding: {
          protocol: "grpc",
          service: "acme.orders.v1.OrderService",
          method: "GetOrder",
          transport: "json_transcoded",
        },
      },
    });

  it("refuses without one, and says a transcoder is what works", async () => {
    const transport = new MockTransport(() => ok({}));
    const res = await execute(
      grpcOp(),
      { input: {} },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") throw new Error("expected a refusal");
    expect(res.envelope.error.message).toContain("transcoder");
    // A native gRPC server would reject JSON over HTTP/1.1; claiming otherwise
    // is the original bug this whole model exists to end.
    expect(transport.requests).toHaveLength(0);
  });

  it("calls the real gRPC path once one is declared, and records the claim", async () => {
    const transport = new MockTransport(() => ok({ orderId: "o1" }));
    const res = await execute(
      grpcOp(),
      { input: {} },
      {
        ...baseCtx,
        transport,
        ledger: new InMemoryLedger(),
        protocolFacade: "Envoy gRPC-JSON transcoder",
      },
    );
    expect(res.outcome).toBe("success");
    expect(transport.requests[0]?.url).toBe(
      "https://banking.example.com/acme.orders.v1.OrderService/GetOrder",
    );
    expect(res.record.policyDecisions.join(" ")).toContain(
      "protocol_facade_declared:grpc:Envoy gRPC-JSON transcoder",
    );
  });
});

/**
 * A protocol facade and a subscription.
 *
 * A facade declares that the base URL serves the synthesized *coordinates*
 * over HTTP+JSON. A subscription's difference from a query is not a
 * coordinate — it is the framing of the exchange: `accept: text/event-stream`,
 * a bounded window, an array answer. If declaring a facade re-routed the call
 * through the JSON codec, the same operation would answer with one object
 * under `ANVIL_PROTOCOL_FACADE` and an array without it — two meanings for one
 * operation, selected by an environment variable. So the facade must leave a
 * subscription's wire exactly alone.
 */
describe("a facade does not change what a subscription means", () => {
  const subscription = (overrides: Record<string, unknown> = {}) =>
    op({
      sourceRef: {
        kind: "graphql",
        path: "/graphql/Subscription/ticks",
        method: "post",
        binding: {
          protocol: "graphql_sse",
          document: "subscription Anvil_Ticks { ticks { seq } }",
          operationName: "Anvil_Ticks",
          rootField: "ticks",
        },
      },
      stream: {
        transport: "graphql_sse",
        delivery: "at_most_once",
        maxEvents: 100,
        maxSeconds: 30,
      },
      ...overrides,
    });

  const sseBody = (...seqs: number[]) =>
    seqs.map((n) => `data: ${JSON.stringify({ data: { ticks: { seq: n } } })}\n\n`).join("");

  it("keeps the SSE wire — accept header, stream bound, array answer — with a facade declared", async () => {
    const transport = new MockTransport(() => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: sseBody(1, 2),
    }));
    const res = await execute(
      subscription(),
      { input: {} },
      {
        ...baseCtx,
        transport,
        ledger: new InMemoryLedger(),
        protocolFacade: "a gateway in front of the GraphQL service",
      },
    );
    expect(res.outcome).toBe("success");
    if (res.outcome !== "success") throw new Error("expected success");
    const sent = transport.requests[0];
    // The one header that makes this a subscription rather than a query.
    expect(sent?.headers.accept).toBe("text/event-stream");
    // The bound is what makes the call terminate; dropping it under a facade
    // would let the request run to the generic timeout and then retry.
    expect(sent?.streamBound).toEqual({ maxEvents: 100, maxSeconds: 30 });
    // Always an array — the same answer shape as without the facade.
    expect(res.data).toEqual([{ seq: 1 }, { seq: 2 }]);
    // The facade was declared but not *used*: nothing about this call rests on
    // it, so no facade decision may appear on the record.
    expect(res.record.policyDecisions.join(" ")).not.toContain("protocol_facade_declared");
  });

  it("is not a way past the stream bound: an unbounded subscription still refuses", async () => {
    const transport = new MockTransport(() => ok({}));
    const res = await execute(
      subscription({ stream: undefined }),
      { input: {} },
      {
        ...baseCtx,
        transport,
        ledger: new InMemoryLedger(),
        protocolFacade: "a gateway in front of the GraphQL service",
      },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") throw new Error("expected a refusal");
    expect(res.envelope.error.code).toBe("unsupported_operation");
    // The refusal names the real fix — a stream contract — not a facade,
    // because no facade can make an unbounded window terminate.
    expect(res.envelope.error.message).toContain("bound");
    expect(transport.requests).toHaveLength(0);
  });
});
