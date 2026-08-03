import { type AirDocument, type AsyncContract, Operation } from "@anvil/air";
import type { HttpRequest, HttpResponse, Transport } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildMcpServer, type McpBuildOptions } from "./server.js";

/**
 * What a served tool says about finishing a job it did not finish.
 *
 * The two halves pinned here are not symmetric. The first — a resolving contract
 * reaches the agent as coordinates it can follow — is a feature, and a missing
 * feature is an inconvenience. The second — a contract that does NOT resolve
 * produces *nothing* — is the safety property, and getting it wrong costs an
 * agent an unbounded poll loop against a tool it cannot call. So most of what
 * follows is the negative case, once per way a contract can fail, each asserting
 * absence on both channels: the description the model reads and the `_meta` a
 * client branches on. Half a contract on either channel is the whole bug.
 */

const transport: Transport = {
  async send(_req: HttpRequest): Promise<HttpResponse> {
    return { status: 202, headers: {}, body: "{}" };
  },
};

/** The long-running mutation: returns a handle, not a result. */
function createExport(over: Partial<Operation> = {}): Operation {
  return Operation.parse({
    id: "exports.create",
    canonicalName: "create_export",
    displayName: "Create export",
    description: "Starts an export.",
    sourceRef: { kind: "openapi", path: "/exports", method: "post" },
    effect: { kind: "mutation", action: "create", resource: "export", risk: "low" },
    input: { params: [] },
    idempotency: { mode: "none", mechanism: "none" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: false, risk: "low" },
    auth: { type: "none", scopes: [] },
    cli: { command: "exports create" },
    mcp: { toolName: "create_export" },
    skill: { intentExamples: [] },
    state: "approved",
    longRunning: true,
    ...over,
  });
}

/** The poll target: an approved read that accepts the handle. */
function exportStatus(over: Partial<Operation> = {}): Operation {
  return Operation.parse({
    id: "exports.status",
    canonicalName: "get_export_status",
    displayName: "Get export status",
    description: "Reads an export job.",
    sourceRef: { kind: "openapi", path: "/exports/{job_id}", method: "get" },
    effect: { kind: "read", action: "get", resource: "export", risk: "none" },
    input: { params: [{ name: "job_id", in: "path", required: true, schema: { type: "string" } }] },
    idempotency: { mode: "none", mechanism: "none" },
    retries: { mode: "safe", maxAttempts: 3, backoff: "exponential", retryOn: ["timeout"] },
    confirmation: { required: false, risk: "low" },
    auth: { type: "none", scopes: [] },
    cli: { command: "exports status" },
    mcp: { toolName: "get_export_status" },
    skill: { intentExamples: [] },
    state: "approved",
    ...over,
  });
}

const contract = (over: Partial<AsyncContract> = {}): AsyncContract => ({
  statusOperationId: "exports.status",
  jobIdField: "job.id",
  statusJobIdParam: "job_id",
  stateField: "state",
  terminalStates: ["succeeded", "failed"],
  pendingStates: ["queued", "running"],
  ...over,
});

async function connect(operations: Operation[], options?: Partial<McpBuildOptions>) {
  const air: AirDocument = {
    service: { id: "test", version: "1.0.0", canonicalName: "test" },
    operations,
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

interface ServedTool {
  description: string;
  meta: Record<string, unknown>;
}

/** The creating tool exactly as an agent receives it in `tools/list`. */
async function servedCreateExport(
  operations: Operation[],
  options?: Partial<McpBuildOptions>,
): Promise<ServedTool> {
  const client = await connect(operations, options);
  const listed = await client.listTools();
  await client.close();
  const tool = listed.tools.find((t) => t.name === "create_export");
  if (!tool) throw new Error("fixture tool was not served");
  return {
    description: tool.description ?? "",
    meta: (tool._meta ?? {}) as Record<string, unknown>,
  };
}

/**
 * Every `anvil/async_*` key on a served tool. Asserted as a whole rather than key
 * by key, because the property under test is that a broken contract leaves *no*
 * trace — a per-key assertion would pass while a stray coordinate leaked.
 */
const asyncKeys = (tool: ServedTool): string[] =>
  Object.keys(tool.meta)
    .filter((key) => key.startsWith("anvil/async"))
    .sort();

describe("a resolving contract reaches the agent", () => {
  it("appends the mechanical sentence to the description the model reads", async () => {
    const tool = await servedCreateExport([
      createExport({ asyncContract: contract() }),
      exportStatus(),
    ]);
    // Coordinates, not intentions: the tool NAME to call (not the operation id),
    // the field to read the handle from, the parameter to put it in, and the
    // states that mean stop. An agent can follow this without interpreting it.
    expect(tool.description).toContain("read the job handle from 'job.id'");
    expect(tool.description).toContain("poll 'get_export_status' with 'job_id'");
    expect(tool.description).toContain("until it reaches one of: succeeded, failed");
    // The compiled posture is still there — the contract is appended to the
    // description, never a replacement for it.
    expect(tool.description).toContain("Starts an export.");
    expect(tool.description).toContain("Long-running");
  });

  it("publishes the same coordinates as flat _meta beside the safety posture", async () => {
    const tool = await servedCreateExport([
      createExport({ asyncContract: contract() }),
      exportStatus(),
    ]);
    expect(tool.meta["anvil/async_status_tool"]).toBe("get_export_status");
    expect(tool.meta["anvil/async_job_id_field"]).toBe("job.id");
    expect(tool.meta["anvil/async_status_job_id_param"]).toBe("job_id");
    expect(tool.meta["anvil/async_state_field"]).toBe("state");
    expect(tool.meta["anvil/async_terminal_states"]).toEqual(["succeeded", "failed"]);
    expect(tool.meta["anvil/async_pending_states"]).toEqual(["queued", "running"]);
    // The posture block is untouched: async metadata sits beside it, not over it.
    expect(tool.meta["anvil/effect"]).toBe("mutation");
    expect(tool.meta["anvil/operation_id"]).toBe("exports.create");
  });

  it("names a poll interval only when the service stated one", async () => {
    const silent = await servedCreateExport([
      createExport({ asyncContract: contract() }),
      exportStatus(),
    ]);
    expect(silent.meta["anvil/async_poll_interval_seconds"]).toBeUndefined();
    expect(silent.description).not.toContain("between polls");

    const stated = await servedCreateExport([
      createExport({ asyncContract: contract({ pollIntervalSeconds: 5 }) }),
      exportStatus(),
    ]);
    expect(stated.meta["anvil/async_poll_interval_seconds"]).toBe(5);
    expect(stated.description).toContain("5s between polls");
  });

  it("is deterministic: the same document serves byte-identical tool surfaces", async () => {
    const ops = () => [createExport({ asyncContract: contract() }), exportStatus()];
    const first = await servedCreateExport(ops());
    const second = await servedCreateExport(ops());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("a contract that does not resolve produces nothing", () => {
  /**
   * One case per `AsyncContractIssue` the runtime can reach with a contract
   * present. Each asserts silence on both channels, because a leak on either one
   * is enough to start the loop.
   */
  const broken: Array<{ issue: string; operations: () => Operation[] }> = [
    {
      issue: "status_operation_missing",
      operations: () => [
        createExport({ asyncContract: contract({ statusOperationId: "exports.nope" }) }),
        exportStatus(),
      ],
    },
    {
      issue: "status_operation_not_approved",
      operations: () => [
        createExport({ asyncContract: contract() }),
        exportStatus({ state: "generated" }),
      ],
    },
    {
      issue: "status_operation_is_mutation",
      operations: () => [
        createExport({ asyncContract: contract() }),
        exportStatus({
          effect: { kind: "mutation", action: "update", resource: "export", risk: "low" },
        }),
      ],
    },
    {
      issue: "status_param_missing",
      operations: () => [
        createExport({ asyncContract: contract({ statusJobIdParam: "invented" }) }),
        exportStatus(),
      ],
    },
    {
      issue: "no_terminal_states",
      operations: () => [
        createExport({ asyncContract: contract({ terminalStates: [] }) }),
        exportStatus(),
      ],
    },
  ];

  for (const { issue, operations } of broken) {
    it(`says nothing at all when the contract fails with ${issue}`, async () => {
      const tool = await servedCreateExport(operations());
      expect(asyncKeys(tool)).toEqual([]);
      expect(tool.description).not.toContain("read the job handle");
      expect(tool.description).not.toContain("get_export_status");
      // The compiled description is left exactly as it was — including its bare
      // "poll for status" line, which is vague but honest about being vague. The
      // failure mode is dressing a broken contract in the register of a working
      // one, not the absence of prose.
      expect(tool.description).toBe(
        "Starts an export. This is a low mutation. Not retry-safe. Long-running: returns before completion; poll for status.",
      );
    });
  }

  it("says nothing when there is no contract at all", async () => {
    const tool = await servedCreateExport([createExport(), exportStatus()]);
    expect(asyncKeys(tool)).toEqual([]);
    expect(tool.description).not.toContain("read the job handle");
  });

  it("does not promise polling a tool the estate has not approved, even in dev mode", async () => {
    // `includeUnapproved` registers the unapproved status tool, so the poll would
    // technically succeed *here*. Serving the sentence anyway would make the tool
    // surface depend on a dev flag: an agent trained against the dev server would
    // follow instructions that silently vanish in production. The contract's
    // approval rule is the contract's, not the server's.
    const tool = await servedCreateExport(
      [createExport({ asyncContract: contract() }), exportStatus({ state: "generated" })],
      { includeUnapproved: true },
    );
    expect(asyncKeys(tool)).toEqual([]);
  });
});

describe("the rest of the surface is undisturbed", () => {
  it("leaves the status tool itself with no async metadata", async () => {
    const client = await connect([createExport({ asyncContract: contract() }), exportStatus()]);
    const listed = await client.listTools();
    await client.close();
    const status = listed.tools.find((t) => t.name === "get_export_status");
    const meta = (status?._meta ?? {}) as Record<string, unknown>;
    expect(Object.keys(meta).filter((key) => key.startsWith("anvil/async"))).toEqual([]);
  });

  it("still serves and executes a synchronous operation unchanged", async () => {
    const client = await connect([createExport({ asyncContract: contract() }), exportStatus()]);
    const result = await client.callTool({
      name: "get_export_status",
      arguments: { job_id: "job_1" },
    });
    expect(result.isError).toBeFalsy();
    await client.close();
  });
});
