import { type Operation, Operation as OperationSchema, type Param } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { execute, type HttpResponse, InMemoryLedger, MockTransport } from "./index.js";

/**
 * Parameter serialization on the wire, asserted against literal URLs and
 * header values. The refusals assert that nothing was sent: `[object Object]`
 * was always a well-formed request, which is exactly why it went unnoticed.
 */
function op(params: Param[]): Operation {
  return OperationSchema.parse({
    id: "catalog.item.list",
    canonicalName: "list_items",
    displayName: "List items",
    sourceRef: { kind: "openapi", path: "/items/{id}", method: "get" },
    effect: { kind: "read", resource: "item", risk: "low", reversible: true },
    input: { params },
    idempotency: { mode: "natural", keyDerivation: "none" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "catalog item list" },
    mcp: { toolName: "catalog_list_items" },
    skill: { intentExamples: [] },
    state: "approved",
  });
}

const param = (name: string, where: Param["in"], extra: Partial<Param> = {}): Param =>
  ({ name, in: where, required: false, schema: { type: "string" }, inferred: false, ...extra }) as Param;

const ok = (): HttpResponse => ({ status: 200, headers: {}, body: "[]" });

const baseCtx = {
  serviceId: "catalog",
  baseUrl: "https://catalog.example.com",
  allowedHosts: ["catalog.example.com"],
  env: "dev",
  sleep: async () => {},
  rng: () => 0.5,
};

async function send(params: Param[], input: Record<string, unknown>) {
  const transport = new MockTransport(() => ok());
  const res = await execute(op(params), { input }, { ...baseCtx, transport, ledger: new InMemoryLedger() });
  return { res, sent: transport.requests[0], transport };
}

describe("query parameter serialization", () => {
  it("repeats the key for an exploded form array (the OpenAPI default)", async () => {
    const { res, sent } = await send([param("id", "path"), param("tag", "query")], {
      id: "x",
      tag: ["a", "b c"],
    });
    expect(res.outcome).toBe("success");
    expect(sent?.url).toBe("https://catalog.example.com/items/x?tag=a&tag=b+c");
  });

  it("honours the declared style and explode", async () => {
    const cases: Array<[Partial<Param>, unknown, string]> = [
      [{ explode: false }, ["a", "b"], "tag=a%2Cb"],
      [{ style: "spaceDelimited" }, ["a", "b"], "tag=a+b"],
      [{ style: "pipeDelimited" }, [1, 2], "tag=1%7C2"],
      [{ style: "deepObject" }, { x: 1, y: "z" }, "tag%5Bx%5D=1&tag%5By%5D=z"],
      [{}, { x: 1, y: "z" }, "x=1&y=z"],
      [{ explode: false }, { x: 1, y: "z" }, "tag=x%2C1%2Cy%2Cz"],
    ];
    for (const [extra, value, expected] of cases) {
      const { res, sent } = await send([param("id", "path"), param("tag", "query", extra)], {
        id: "x",
        tag: value,
      });
      expect(res.outcome, JSON.stringify(extra)).toBe("success");
      expect(sent?.url).toBe(`https://catalog.example.com/items/x?${expected}`);
    }
  });

  it("refuses a nested object with a typed error instead of sending [object Object]", async () => {
    const { res, transport } = await send([param("id", "path"), param("filter", "query")], {
      id: "x",
      filter: { range: { min: 1 } },
    });
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") throw new Error("expected a refusal");
    expect(res.envelope.error.code).toBe("unsupported_operation");
    expect(res.envelope.error.message).toContain("filter");
    expect(res.envelope.error.details).toMatchObject({ param: "filter", in: "query" });
    expect(transport.requests).toHaveLength(0);
  });

  it("refuses an object under a delimiter style, which defines none", async () => {
    const { res, transport } = await send(
      [param("id", "path"), param("filter", "query", { style: "pipeDelimited" })],
      { id: "x", filter: { a: 1 } },
    );
    expect(res.outcome).toBe("error");
    expect(transport.requests).toHaveLength(0);
  });
});

describe("path and header serialization", () => {
  it("joins arrays with literal commas and percent-encodes each item", async () => {
    const { res, sent } = await send([param("id", "path")], { id: ["a/b", "c d"] });
    expect(res.outcome).toBe("success");
    expect(sent?.url).toBe("https://catalog.example.com/items/a%2Fb,c%20d");
  });

  it("serializes an object in the simple style, exploded or not", async () => {
    const plain = await send([param("id", "path"), param("X-Meta", "header")], {
      id: "x",
      x_meta: { a: 1, b: "two" },
    });
    expect(plain.sent?.headers["X-Meta"]).toBe("a,1,b,two");
    const exploded = await send(
      [param("id", "path"), param("X-Meta", "header", { explode: true })],
      { id: "x", x_meta: { a: 1, b: "two" } },
    );
    expect(exploded.sent?.headers["X-Meta"]).toBe("a=1,b=two");
  });

  it("refuses a header whose value has no simple encoding", async () => {
    const { res, transport } = await send([param("id", "path"), param("X-Meta", "header")], {
      id: "x",
      x_meta: [{ a: 1 }],
    });
    expect(res.outcome).toBe("error");
    if (res.outcome !== "error") throw new Error("expected a refusal");
    expect(res.envelope.error.details).toMatchObject({ param: "X-Meta", in: "header" });
    expect(transport.requests).toHaveLength(0);
  });

  it("keeps scalars exactly as before", async () => {
    const { sent } = await send(
      [param("id", "path"), param("q", "query"), param("X-Tenant", "header"), param("sid", "cookie")],
      { id: "w 1", q: "a b", x_tenant: "acme", sid: "s1" },
    );
    expect(sent?.url).toBe("https://catalog.example.com/items/w%201?q=a+b");
    expect(sent?.headers["X-Tenant"]).toBe("acme");
    expect(sent?.headers.cookie).toBe("sid=s1");
  });
});
