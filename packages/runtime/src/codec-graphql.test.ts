import { type Operation, Operation as OperationSchema } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { execute, type HttpResponse, InMemoryLedger, MockTransport } from "./index.js";

/**
 * GraphQL on the wire.
 *
 * The interesting assertions are about what does *not* happen: no caller value
 * reaches the query text, and an `errors` array in a 200 never reaches the
 * caller as a result.
 */
const DOCUMENT =
  "mutation Anvil_Checkout($input: CheckoutInput!) { checkout(input: $input) { id status } }";

function op(overrides: Record<string, unknown> = {}): Operation {
  return OperationSchema.parse({
    id: "storefront.checkout.create",
    canonicalName: "create_checkout",
    displayName: "Checkout",
    sourceRef: {
      kind: "graphql",
      path: "/graphql/Mutation/checkout",
      method: "post",
      binding: {
        protocol: "graphql",
        document: DOCUMENT,
        operationName: "Anvil_Checkout",
        rootField: "checkout",
      },
    },
    effect: { kind: "mutation", resource: "order", risk: "financial", reversible: false },
    input: {
      params: [],
      body: {
        contentType: "application/json",
        required: true,
        schema: { type: "object", properties: { input: { type: "object" } } },
        projection: "fields",
        fields: [{ name: "input", required: true, schema: { type: "object" } }],
      },
    },
    idempotency: { mode: "natural", keyDerivation: "none" },
    retries: { mode: "safe", maxAttempts: 3, backoff: "fixed", retryOn: ["http_503"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "storefront checkout create" },
    mcp: { toolName: "storefront_create_checkout" },
    skill: { intentExamples: [] },
    state: "approved",
    ...overrides,
  });
}

const json = (body: unknown, status = 200): HttpResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const baseCtx = {
  serviceId: "storefront",
  baseUrl: "https://shop.example.com/graphql",
  allowedHosts: ["shop.example.com"],
  env: "dev",
  sleep: async () => {},
  rng: () => 0.5,
};

describe("the GraphQL codec posts a document, not a path", () => {
  it("posts to the one endpoint, with the field in the body", async () => {
    const transport = new MockTransport(() => json({ data: { checkout: { id: "o1" } } }));
    await execute(
      op(),
      { input: { input: { cartId: "c1" } } },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    const sent = transport.requests[0];
    expect(sent?.method).toBe("POST");
    expect(sent?.url).toBe("https://shop.example.com/graphql");
    expect(sent?.url).not.toContain("Mutation");
    expect(sent?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({
      query: DOCUMENT,
      operationName: "Anvil_Checkout",
      variables: { input: { cartId: "c1" } },
    });
  });

  it("never puts a caller value into the query text", async () => {
    // The document is compiled from the SDL and posted as handed. A value
    // spliced into a statement is a value that can rewrite the statement.
    const transport = new MockTransport(() => json({ data: { checkout: { id: "o1" } } }));
    await execute(
      op(),
      { input: { input: { cartId: '") { evil } #' } } },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    const sent = JSON.parse(transport.requests[0]?.body ?? "{}") as { query: string };
    expect(sent.query).toBe(DOCUMENT);
    expect(sent.query).not.toContain("evil");
  });

  it("unwraps the root field the operation called", async () => {
    const transport = new MockTransport(() =>
      json({ data: { checkout: { id: "o1", status: "PENDING" } } }),
    );
    const res = await execute(
      op(),
      { input: { input: {} } },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(res.outcome).toBe("success");
    if (res.outcome !== "success") throw new Error("expected success");
    expect(res.data).toEqual({ id: "o1", status: "PENDING" });
  });
});

describe("a GraphQL error is a failure, not a result", () => {
  it("refuses an errors array delivered with HTTP 200", async () => {
    const transport = new MockTransport(() => json({ errors: [{ message: "Cart is empty" }] }));
    const res = await execute(
      op(),
      { input: { input: {} } },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") throw new Error("expected a refusal");
    expect(res.envelope.error.message).toContain("Cart is empty");
  });

  it("refuses a partial response rather than handing over half a shape", async () => {
    // `data` present *and* `errors` present. AIR's output contract describes
    // one shape; a half-filled one alongside errors the caller cannot see is
    // how someone acts on data that was never really returned.
    const transport = new MockTransport(() =>
      json({
        data: { checkout: { id: "o1", status: null } },
        errors: [{ message: "status failed" }],
      }),
    );
    const res = await execute(
      op(),
      { input: { input: {} } },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(res.outcome).toBe("error");
  });

  it("never retries one — GraphQL names no transient error", async () => {
    const transport = new MockTransport(() => json({ errors: [{ message: "boom" }] }));
    await execute(
      op(),
      { input: { input: {} } },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(transport.requests).toHaveLength(1);
  });

  it("still refuses an unconfirmed mutation before any document is posted", async () => {
    const transport = new MockTransport(() => json({ data: { checkout: {} } }));
    const res = await execute(
      op({ confirmation: { required: true, risk: "financial" } }),
      { input: { input: {} } },
      { ...baseCtx, transport, ledger: new InMemoryLedger() },
    );
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") throw new Error("expected a refusal");
    expect(res.envelope.error.code).toBe("confirmation_required");
    expect(transport.requests).toHaveLength(0);
  });
});
