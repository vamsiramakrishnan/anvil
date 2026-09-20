import {
  type AirDocument,
  type JsonSchema,
  loadAirDocument,
  MCP_OUTPUT_VIEWS,
  Operation,
  type Workflow,
} from "@anvil/air";
import type { Transport } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { buildMcpServer, type McpBuildOptions } from "./server.js";

/**
 * Once a tool declares `outputSchema`, the SDK validates every non-error
 * result against it — on the server before it is sent, and again in the
 * client after `listTools()` cached the schema. So the tests here drive a real
 * client through both validators: a result that reaches `structuredContent`
 * below has satisfied the published contract twice.
 */

const record: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    amount: { type: "integer" },
    owner: { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
  },
  required: ["id", "amount"],
};

function operation(over: Partial<z.input<typeof Operation>> = {}): Operation {
  return Operation.parse({
    id: "things.get",
    canonicalName: "get_thing",
    displayName: "Get thing",
    sourceRef: { kind: "openapi", path: "/things", method: "get" },
    effect: { kind: "read", action: "list", resource: "thing", risk: "none" },
    input: { params: [{ name: "q", in: "query", required: false, schema: { type: "string" } }] },
    idempotency: { mode: "natural", mechanism: "none" },
    retries: { mode: "safe", maxAttempts: 2, backoff: "none", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "things get" },
    mcp: { toolName: "get_thing" },
    skill: { intentExamples: [] },
    state: "approved",
    output: { schema: record },
    ...over,
  });
}

function air(operations: Operation[], workflows: Workflow[] = []): AirDocument {
  return loadAirDocument({
    service: { id: "svc", version: "1.0.0", source: { kind: "openapi" } },
    operations,
    workflows,
  });
}

async function connect(
  doc: AirDocument,
  body: unknown,
  options: Partial<McpBuildOptions> = {},
): Promise<Client> {
  const transport: Transport = {
    send: async () => ({ status: 200, headers: {}, body: JSON.stringify(body) }),
  };
  const server = buildMcpServer(doc, {
    contextFor: () => ({
      transport,
      serviceId: "svc",
      baseUrl: "https://api.example.com",
      allowedHosts: ["api.example.com"],
      env: "dev",
    }),
    ...options,
  });
  const client = new Client({ name: "t", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

type Listed = { outputSchema?: { properties?: Record<string, unknown>; required?: string[] } };

async function listed(client: Client, name: string): Promise<Listed | undefined> {
  const tools = await client.listTools();
  return tools.tools.find((tool) => tool.name === name) as Listed | undefined;
}

function text(result: unknown): string {
  return JSON.stringify((result as { content?: unknown }).content);
}

describe("outputSchema on tools/list", () => {
  it("declares the response fields beside the reserved views, none required at the top level", async () => {
    const client = await connect(air([operation()]), { id: "t_1", amount: 3 });
    const tool = await listed(client, "get_thing");
    await client.close();
    expect(tool?.outputSchema).toBeDefined();
    const properties = tool?.outputSchema?.properties ?? {};
    expect(Object.keys(properties)).toEqual([
      "id",
      "amount",
      "owner",
      MCP_OUTPUT_VIEWS.dryRun,
      MCP_OUTPUT_VIEWS.projection,
      MCP_OUTPUT_VIEWS.unvalidated,
    ]);
    expect(tool?.outputSchema?.required ?? []).toEqual([]);
    // Nested strictness survives the SDK's round trip.
    expect((properties.owner as { required?: string[] }).required).toEqual(["email"]);
  });

  it("declares none when the operation has no response schema, or when told not to", async () => {
    const bare = operation({ output: {} });
    const client = await connect(air([bare]), {});
    expect((await listed(client, "get_thing"))?.outputSchema).toBeUndefined();
    await client.close();

    const disabled = await connect(air([operation()]), {}, { outputSchemaBudgetTokens: 0 });
    expect((await listed(disabled, "get_thing"))?.outputSchema).toBeUndefined();
    await disabled.close();
  });

  it("declares none for a status operation that may answer from a webhook payload", async () => {
    const submit = operation({
      id: "jobs.create",
      canonicalName: "create_job",
      displayName: "Create job",
      sourceRef: { kind: "openapi", path: "/jobs", method: "post" },
      effect: { kind: "mutation", action: "create", resource: "job", risk: "low" },
      idempotency: { mode: "none", mechanism: "none" },
      retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
      cli: { command: "jobs create" },
      mcp: { toolName: "create_job" },
      longRunning: true,
      asyncContract: {
        statusOperationId: "jobs.status",
        jobIdField: "id",
        statusJobIdParam: "job_id",
        stateField: "status",
        terminalStates: ["done"],
        pendingStates: ["pending"],
      },
    });
    const status = operation({
      id: "jobs.status",
      canonicalName: "get_job_status",
      displayName: "Get job status",
      sourceRef: { kind: "openapi", path: "/jobs/{job_id}", method: "get" },
      input: {
        params: [{ name: "job_id", in: "path", required: true, schema: { type: "string" } }],
      },
      cli: { command: "jobs status" },
      mcp: { toolName: "get_job_status" },
      output: {
        schema: {
          type: "object",
          properties: { id: { type: "string" }, status: { type: "string" } },
        },
      },
    });
    const client = await connect(air([submit, status]), { id: "j_1", amount: 1 });
    expect((await listed(client, "create_job"))?.outputSchema).toBeDefined();
    expect((await listed(client, "get_job_status"))?.outputSchema).toBeUndefined();
    await client.close();
  });
});

describe("results under a declared outputSchema", () => {
  it("serves a conforming record at the top level, extra upstream fields included", async () => {
    const payload = { id: "t_1", amount: 3, owner: { email: "a@b.c", plan: "gold" }, extra: 1 };
    const client = await connect(air([operation()]), payload);
    const result = await client.callTool({ name: "get_thing", arguments: {} });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(payload);
    expect(text(result)).not.toContain("output schema");
  });

  it("serves a non-record response under `result`", async () => {
    const list = operation({ output: { schema: { type: "array", items: { type: "string" } } } });
    const client = await connect(air([list]), ["a", "b"]);
    const tool = await listed(client, "get_thing");
    expect(Object.keys(tool?.outputSchema?.properties ?? {})[0]).toBe("result");
    const result = await client.callTool({ name: "get_thing", arguments: {} });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ result: ["a", "b"] });
  });

  it("serves an off-contract payload under anvil_unvalidated and says where it differed", async () => {
    const client = await connect(air([operation()]), { id: 42, amount: "many" });
    const result = await client.callTool({ name: "get_thing", arguments: {} });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      [MCP_OUTPUT_VIEWS.unvalidated]: { id: 42, amount: "many" },
    });
    expect(text(result)).toContain("did not match the declared response schema at 'id'");
    // The data itself is still the text channel's payload, before the notice.
    expect(text(result)).toContain('\\"id\\": 42');
  });

  it("serves a dry run's plan under anvil_dry_run", async () => {
    const client = await connect(air([operation()]), {});
    const result = await client.callTool({
      name: "get_thing",
      arguments: { anvil_dry_run: true },
    });
    await client.close();
    expect(result.isError).toBeFalsy();
    const plan = (result.structuredContent as Record<string, Record<string, unknown>>)[
      MCP_OUTPUT_VIEWS.dryRun
    ];
    expect(plan?.operation).toBe("things.get");
    expect(plan?.method).toBe("GET");
  });

  it("serves a projected view under anvil_projection, whatever its shape", async () => {
    const client = await connect(air([operation()]), { id: "t_1", amount: 3 });
    const scalar = await client.callTool({
      name: "get_thing",
      arguments: { anvil_projection: "amount" },
    });
    expect(scalar.isError).toBeFalsy();
    expect(scalar.structuredContent).toEqual({ [MCP_OUTPUT_VIEWS.projection]: 3 });
    // A view whose keys collide with declared fields, with different types,
    // still conforms: it never sits where the response fields do.
    const clashing = await client.callTool({
      name: "get_thing",
      arguments: { anvil_projection: "{id: amount, amount: id}" },
    });
    await client.close();
    expect(clashing.isError).toBeFalsy();
    expect(clashing.structuredContent).toEqual({
      [MCP_OUTPUT_VIEWS.projection]: { id: 3, amount: "t_1" },
    });
  });

  it("keeps the same reserved-view placement on a tool that declares no schema", async () => {
    const client = await connect(air([operation({ output: {} })]), { id: "t_1" });
    const dry = await client.callTool({ name: "get_thing", arguments: { anvil_dry_run: true } });
    expect(Object.keys(dry.structuredContent ?? {})).toEqual([MCP_OUTPUT_VIEWS.dryRun]);
    const view = await client.callTool({
      name: "get_thing",
      arguments: { anvil_projection: "id" },
    });
    expect(view.structuredContent).toEqual({ [MCP_OUTPUT_VIEWS.projection]: "t_1" });
    const plain = await client.callTool({ name: "get_thing", arguments: {} });
    await client.close();
    expect(plain.structuredContent).toEqual({ id: "t_1" });
  });
});

describe("outputSchema on a workflow tool", () => {
  function workflow(): Workflow {
    return {
      id: "svc.pair",
      capabilityId: "svc.cap",
      displayName: "Pair",
      description: "Two reads.",
      intentExamples: [],
      steps: [
        { operationId: "things.get", description: "", optional: false, bindings: {} },
        { operationId: "things.get2", description: "", optional: false, bindings: {} },
      ],
      humanApproval: false,
      state: "approved",
      evidence: { claims: [] },
    };
  }
  const second = () =>
    operation({ id: "things.get2", canonicalName: "get_thing2", mcp: { toolName: "get_thing2" } });

  it("declares the last step's schema, strict, under `result`, plus the trace", async () => {
    const client = await connect(air([operation(), second()], [workflow()]), {
      id: "t_1",
      amount: 3,
    });
    const tool = await listed(client, "svc_pair");
    const properties = tool?.outputSchema?.properties ?? {};
    expect(Object.keys(properties)).toEqual([
      "result",
      "trace",
      MCP_OUTPUT_VIEWS.dryRun,
      MCP_OUTPUT_VIEWS.projection,
      MCP_OUTPUT_VIEWS.unvalidated,
    ]);
    expect((properties.result as { required?: string[] }).required).toEqual(["id", "amount"]);

    const result = await client.callTool({ name: "svc_pair", arguments: {} });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      result: { id: "t_1", amount: 3 },
      trace: "things.get:ok, things.get2:ok",
    });
  });

  it("serves an off-contract final payload under anvil_unvalidated, keeping the trace", async () => {
    const client = await connect(air([operation(), second()], [workflow()]), { id: "t_1" });
    const result = await client.callTool({ name: "svc_pair", arguments: {} });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      [MCP_OUTPUT_VIEWS.unvalidated]: { id: "t_1" },
      trace: "things.get:ok, things.get2:ok",
    });
    expect(text(result)).toContain("at 'result.amount'");
  });

  it("serves a projected final payload and a dry run under their reserved keys", async () => {
    const client = await connect(air([operation(), second()], [workflow()]), {
      id: "t_1",
      amount: 3,
    });
    const view = await client.callTool({
      name: "svc_pair",
      arguments: { anvil_projection: "amount" },
    });
    expect(view.isError).toBeFalsy();
    expect(view.structuredContent).toEqual({
      [MCP_OUTPUT_VIEWS.projection]: 3,
      trace: "things.get:ok, things.get2:ok",
    });
    const dry = await client.callTool({ name: "svc_pair", arguments: { anvil_dry_run: true } });
    await client.close();
    expect(dry.isError).toBeFalsy();
    expect(Object.keys(dry.structuredContent ?? {})).toEqual([MCP_OUTPUT_VIEWS.dryRun]);
  });
});

describe("declared server capabilities", () => {
  it("advertises tools (with listChanged) and resources explicitly", async () => {
    const client = await connect(air([operation()]), {});
    const capabilities = client.getServerCapabilities();
    await client.close();
    expect(capabilities?.tools).toEqual({ listChanged: true });
    expect(capabilities?.resources).toEqual({});
  });
});
