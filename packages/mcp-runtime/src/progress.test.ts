import { type AirDocument, loadAirDocument, Operation, type Workflow } from "@anvil/air";
import { InMemoryLedger, type Transport } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Progress } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { buildMcpServer } from "./server.js";

/**
 * `notifications/progress` is opt-in per request: a client that passes a
 * progressToken (the SDK does so whenever `onprogress` is given) hears one
 * mark per workflow step and one per status poll; a client that does not
 * hears nothing at all.
 */

function read(over: Partial<z.input<typeof Operation>> = {}): Operation {
  return Operation.parse({
    id: "things.get",
    canonicalName: "get_thing",
    displayName: "Get thing",
    sourceRef: { kind: "openapi", path: "/things", method: "get" },
    effect: { kind: "read", action: "list", resource: "thing", risk: "none" },
    input: { params: [] },
    idempotency: { mode: "natural", mechanism: "none" },
    retries: { mode: "safe", maxAttempts: 2, backoff: "none", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "things get" },
    mcp: { toolName: "get_thing" },
    skill: { intentExamples: [] },
    state: "approved",
    output: { schema: { type: "object", properties: { id: { type: "string" } } } },
    ...over,
  });
}

/** A long-running submit whose contract polls `jobs.status`. */
function submit(): Operation {
  return read({
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
      terminalStates: ["done", "failed"],
      pendingStates: ["pending"],
    },
  });
}

function status(): Operation {
  return read({
    id: "jobs.status",
    canonicalName: "get_job_status",
    displayName: "Get job status",
    sourceRef: { kind: "openapi", path: "/jobs/{job_id}", method: "get" },
    input: { params: [{ name: "job_id", in: "path", required: true, schema: { type: "string" } }] },
    cli: { command: "jobs status" },
    mcp: { toolName: "get_job_status" },
    output: {
      schema: {
        type: "object",
        properties: { id: { type: "string" }, status: { type: "string" } },
      },
    },
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
  body: () => unknown,
): Promise<{ client: Client; server: McpServer }> {
  const transport: Transport = {
    send: async () => ({ status: 200, headers: {}, body: JSON.stringify(body()) }),
  };
  const ledger = new InMemoryLedger();
  const server = buildMcpServer(doc, {
    contextFor: () => ({
      transport,
      serviceId: "svc",
      baseUrl: "https://api.example.com",
      allowedHosts: ["api.example.com"],
      env: "dev",
      ledger,
    }),
  });
  const client = new Client({ name: "t", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function threeStep(): Workflow {
  return {
    id: "svc.three",
    capabilityId: "svc.cap",
    displayName: "Three reads",
    description: "",
    intentExamples: [],
    steps: ["a", "b", "c"].map((suffix) => ({
      operationId: `things.get_${suffix}`,
      description: "",
      optional: false,
      bindings: {},
    })),
    humanApproval: false,
    state: "approved",
    evidence: { claims: [] },
  };
}

function threeOps(): Operation[] {
  return ["a", "b", "c"].map((suffix) =>
    read({
      id: `things.get_${suffix}`,
      canonicalName: `get_thing_${suffix}`,
      mcp: { toolName: `get_thing_${suffix}` },
    }),
  );
}

function marks(heard: Progress[]): Array<[number, number | undefined, string | undefined]> {
  return heard.map((p) => [p.progress, p.total, p.message]);
}

describe("progress notifications", () => {
  it("reports one mark per workflow step, then completion, when a progressToken was passed", async () => {
    const { client } = await connect(air(threeOps(), [threeStep()]), () => ({ id: "x" }));
    const heard: Progress[] = [];
    const result = await client.callTool({ name: "svc_three", arguments: {} }, undefined, {
      onprogress: (progress) => {
        heard.push(progress);
      },
    });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(marks(heard)).toEqual([
      [0, 3, "step 1/3: things.get_a"],
      [1, 3, "step 2/3: things.get_b"],
      [2, 3, "step 3/3: things.get_c"],
      [3, 3, "workflow complete"],
    ]);
  });

  it("stays silent for a caller that passed no progressToken", async () => {
    const { client, server } = await connect(air(threeOps(), [threeStep()]), () => ({ id: "x" }));
    const sent = vi.spyOn(server.server, "notification");
    const result = await client.callTool({ name: "svc_three", arguments: {} });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(sent.mock.calls.filter(([n]) => n.method === "notifications/progress")).toHaveLength(0);
  });

  it("marks a status poll pending or terminal from the contract's own state field", async () => {
    let state = "pending";
    const { client } = await connect(air([submit(), status()]), () => ({
      id: "j_1",
      status: state,
    }));
    const polls: Progress[] = [];
    const onprogress = (progress: Progress) => {
      polls.push(progress);
    };
    await client.callTool({ name: "get_job_status", arguments: { job_id: "j_1" } }, undefined, {
      onprogress,
    });
    state = "done";
    await client.callTool({ name: "get_job_status", arguments: { job_id: "j_1" } }, undefined, {
      onprogress,
    });
    await client.close();
    expect(marks(polls)).toEqual([
      [0, 1, "j_1: pending"],
      [1, 1, "j_1: done (terminal)"],
    ]);
  });

  it("marks a webhook-only (synthetic) status tool's poll as pending until a completion is cached", async () => {
    const webhookOnly = submit();
    webhookOnly.asyncContract = {
      jobIdField: "id",
      statusJobIdParam: "job_id",
      stateField: "status",
      terminalStates: ["done"],
      pendingStates: ["pending"],
      webhook: {
        webhookOperationId: "jobs.webhook",
        webhookJobIdField: "data.id",
        webhookStateField: "data.status",
        signatureVerification: {
          scheme: "hmac_sha256_header",
          headerName: "X-Signature",
          encoding: "hex",
          secretRef: "WEBHOOK_SECRET",
        },
      },
    };
    const receiver = read({
      id: "jobs.webhook",
      canonicalName: "job_webhook",
      displayName: "Job webhook",
      sourceRef: { kind: "openapi", path: "/webhooks/jobs", method: "post" },
      cli: { command: "jobs webhook" },
      mcp: { toolName: "job_webhook" },
      archetype: "webhook_receiver",
    });
    const { client } = await connect(air([webhookOnly, receiver]), () => ({ id: "j_1" }));
    const polls: Progress[] = [];
    const result = await client.callTool(
      { name: "create_job_status", arguments: { job_id: "j_1" } },
      undefined,
      {
        onprogress: (progress) => {
          polls.push(progress);
        },
      },
    );
    await client.close();
    expect(result.structuredContent).toMatchObject({ status: "pending" });
    expect(marks(polls)).toEqual([[0, 1, "j_1: pending"]]);
  });
});
