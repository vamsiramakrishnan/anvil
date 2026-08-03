import { type AirDocument, Operation } from "@anvil/air";
import type { HttpRequest, HttpResponse, Transport } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { MCP_PROJECTION } from "./projection.js";
import { buildMcpServer, type McpBuildOptions } from "./server.js";

/**
 * End-to-end checks over the real MCP transport: the two changes are supposed to
 * compose (a projection lowers cost per item, which raises the page that fits),
 * and composition is exactly what unit tests on either half cannot show.
 */

interface Recorder {
  requests: HttpRequest[];
  transport: Transport;
}

function recorder(body: unknown): Recorder {
  const requests: HttpRequest[] = [];
  return {
    requests,
    transport: {
      async send(req: HttpRequest): Promise<HttpResponse> {
        requests.push(req);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
      },
    },
  };
}

function listOperation(over?: Partial<Operation>): Operation {
  const op = Operation.parse({
    id: "test.thing.list",
    canonicalName: "thing_list",
    displayName: "List Things",
    sourceRef: { kind: "openapi", path: "/things", method: "get" },
    effect: { kind: "read", action: "list", resource: "thing", risk: "low", reversible: false },
    input: {
      params: [
        {
          name: "per_page",
          in: "query",
          required: false,
          schema: { type: "integer" },
          inferred: false,
        },
      ],
    },
    idempotency: {
      mode: "none",
      mechanism: "header",
      key: "Idempotency-Key",
      keyDerivation: "client_supplied",
    },
    retries: { mode: "safe", maxAttempts: 1, backoff: "exponential", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "thing list" },
    mcp: { toolName: "thing_list" },
    skill: { intentExamples: [] },
    state: "approved",
    ...over,
  });
  return op;
}

async function connect(op: Operation, transport: Transport, options?: Partial<McpBuildOptions>) {
  const air: AirDocument = {
    service: { id: "test", version: "1.0.0", canonicalName: "test" },
    operations: [op],
    workflows: [],
  };
  const server = buildMcpServer(air, {
    contextFor: () => ({
      transport,
      serviceId: "test",
      baseUrl: "http://test",
      allowedHosts: ["test"],
    }),
    ...options,
  });
  const client = new Client({ name: "t", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const bigPage = {
  items: Array.from({ length: 3 }, (_, i) => ({
    id: `id-${i}`,
    name: `Thing ${i}`,
    blob: "z".repeat(400),
  })),
};

function textOf(result: unknown): string {
  return JSON.stringify((result as { content?: unknown }).content);
}

describe("anvil_projection over MCP", () => {
  it("is published as a reserved control on every tool", async () => {
    const client = await connect(listOperation(), recorder({}).transport);
    const tools = await client.listTools();
    const schema = tools.tools[0]?.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties?.[MCP_PROJECTION]).toBeDefined();
    expect(schema.properties?.anvil_dry_run).toBeDefined();
    await client.close();
  });

  it("narrows both the text content and the structured content", async () => {
    const rec = recorder(bigPage);
    const client = await connect(listOperation(), rec.transport);
    const result = await client.callTool({
      name: "thing_list",
      arguments: { [MCP_PROJECTION]: "items[].{id: id}" },
    });
    // structuredContent must be projected too, or the "saving" is illusory: the
    // caller pays for the full payload on the other channel.
    expect(textOf(result)).not.toContain("zzz");
    expect(JSON.stringify(result.structuredContent)).not.toContain("zzz");
    expect(textOf(result)).toContain("id-2");
    await client.close();
  });

  it("refuses a malformed expression with a validation_error", async () => {
    const rec = recorder(bigPage);
    const client = await connect(listOperation(), rec.transport);
    const result = await client.callTool({
      name: "thing_list",
      arguments: { [MCP_PROJECTION]: "items[].{" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("validation_error");
    expect(textOf(result)).toContain(MCP_PROJECTION);
    await client.close();
  });

  it("refuses BEFORE paying the upstream cost", async () => {
    const rec = recorder(bigPage);
    const client = await connect(listOperation(), rec.transport);
    await client.callTool({ name: "thing_list", arguments: { [MCP_PROJECTION]: "items[].{" } });
    expect(rec.requests.length).toBe(0);
    await client.close();
  });

  it("never falls back to the unprojected payload", async () => {
    const rec = recorder(bigPage);
    const client = await connect(listOperation(), rec.transport);
    const result = await client.callTool({
      name: "thing_list",
      arguments: { [MCP_PROJECTION]: "{a: @, b: @}" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain("zzz");
    await client.close();
  });

  it("never forwards the control upstream as a query parameter", async () => {
    const rec = recorder(bigPage);
    const client = await connect(listOperation(), rec.transport);
    await client.callTool({
      name: "thing_list",
      arguments: { [MCP_PROJECTION]: "items[].id" },
    });
    expect(rec.requests[0]?.url).not.toContain("anvil_projection");
    await client.close();
  });

  it("runs before the truncation measurement, not after", async () => {
    const rec = recorder(bigPage);
    // A budget far too small for the raw page, ample for the projected one. If
    // projection ran after the cut, this would still be truncated.
    const client = await connect(listOperation(), rec.transport, { resultTokenBudget: 40 });
    const projected = await client.callTool({
      name: "thing_list",
      arguments: { [MCP_PROJECTION]: "items[].id" },
    });
    expect(textOf(projected)).not.toContain("[truncated:");

    const raw = await client.callTool({ name: "thing_list", arguments: {} });
    expect(textOf(raw)).toContain("[truncated:");
    await client.close();
  });
});

describe("budget-derived page size over MCP", () => {
  const measured = {
    toolTokens: 200,
    responseItemTokens: 100,
    responseTokens: 0,
    charsPerToken: 4,
    estimator: "o200k_base",
  };

  it("injects a size solved from the budget when the caller gave none", async () => {
    const op = listOperation();
    op.pagination = { style: "cursor", pageSizeParam: "per_page", cursorParam: "page_token" };
    op.disclosureCost = measured;
    const rec = recorder(bigPage);
    const client = await connect(op, rec.transport, { resultTokenBudget: 1_000 });
    await client.callTool({ name: "thing_list", arguments: {} });
    expect(rec.requests[0]?.url).toContain("per_page=10");
    await client.close();
  });

  it("NEVER overrides an explicit caller value", async () => {
    const op = listOperation();
    op.pagination = { style: "cursor", pageSizeParam: "per_page" };
    op.disclosureCost = measured;
    const rec = recorder(bigPage);
    const client = await connect(op, rec.transport, { resultTokenBudget: 1_000 });
    await client.callTool({ name: "thing_list", arguments: { per_page: 200 } });
    expect(rec.requests[0]?.url).toContain("per_page=200");
    await client.close();
  });

  it("injects nothing for an unmeasured operation", async () => {
    const op = listOperation();
    op.pagination = { style: "cursor", pageSizeParam: "per_page" };
    const rec = recorder(bigPage);
    const client = await connect(op, rec.transport);
    await client.callTool({ name: "thing_list", arguments: {} });
    expect(rec.requests[0]?.url).not.toContain("per_page");
    await client.close();
  });

  it("shows the injected size in a dry run, before anything is spent", async () => {
    const op = listOperation();
    op.pagination = { style: "cursor", pageSizeParam: "per_page" };
    op.disclosureCost = measured;
    const rec = recorder(bigPage);
    const client = await connect(op, rec.transport, { resultTokenBudget: 1_000 });
    const result = await client.callTool({
      name: "thing_list",
      arguments: { anvil_dry_run: true },
    });
    expect(textOf(result)).toContain("per_page=10");
    expect(rec.requests.length).toBe(0);
    await client.close();
  });
});

describe("silent-cap detection", () => {
  it("warns when a full page arrives with no continuation marker", async () => {
    const op = listOperation();
    op.pagination = {
      style: "cursor",
      cursorParam: "page_token",
      itemsField: "items",
      nextField: "next_page_token",
      maxPageSize: 3,
    };
    const client = await connect(op, recorder(bigPage).transport);
    const result = await client.callTool({ name: "thing_list", arguments: {} });
    expect(textOf(result)).toContain("disclosure warning");
    expect(textOf(result)).toContain("page_token");
    await client.close();
  });

  it("stays quiet when the response admits it is capped", async () => {
    const op = listOperation();
    op.pagination = {
      style: "cursor",
      cursorParam: "page_token",
      itemsField: "items",
      nextField: "next_page_token",
      maxPageSize: 3,
    };
    const client = await connect(op, recorder({ ...bigPage, next_page_token: "tok" }).transport);
    const result = await client.callTool({ name: "thing_list", arguments: {} });
    expect(textOf(result)).not.toContain("disclosure warning");
    await client.close();
  });

  it("survives truncation — the warning is appended after the cut", async () => {
    const op = listOperation();
    op.pagination = { style: "cursor", itemsField: "items", maxPageSize: 3 };
    const client = await connect(op, recorder(bigPage).transport, { resultTokenBudget: 40 });
    const result = await client.callTool({ name: "thing_list", arguments: {} });
    expect(textOf(result)).toContain("[truncated:");
    expect(textOf(result)).toContain("disclosure warning");
    await client.close();
  });
});

describe("result budget options", () => {
  it("honors the deprecated character budget verbatim", async () => {
    const client = await connect(listOperation(), recorder(bigPage).transport, {
      resultCharacterBudget: 120,
    });
    const result = await client.callTool({ name: "thing_list", arguments: {} });
    expect(textOf(result)).toContain("served 120 of");
    await client.close();
  });

  it("treats a 0 character budget as truncation disabled, as it always did", async () => {
    const client = await connect(listOperation(), recorder(bigPage).transport, {
      resultCharacterBudget: 0,
    });
    const result = await client.callTool({ name: "thing_list", arguments: {} });
    expect(textOf(result)).not.toContain("[truncated:");
    await client.close();
  });

  it("declines to size a page when the caller declared no budget", async () => {
    const op = listOperation();
    op.pagination = { style: "cursor", pageSizeParam: "per_page" };
    op.disclosureCost = {
      toolTokens: 200,
      responseItemTokens: 100,
      responseTokens: 0,
      charsPerToken: 4,
      estimator: "o200k_base",
    };
    const rec = recorder(bigPage);
    const client = await connect(op, rec.transport, { resultCharacterBudget: 0 });
    await client.callTool({ name: "thing_list", arguments: {} });
    expect(rec.requests[0]?.url).not.toContain("per_page");
    await client.close();
  });
});
