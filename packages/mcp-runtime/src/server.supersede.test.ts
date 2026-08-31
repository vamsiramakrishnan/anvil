import { type AirDocument, loadAirDocument, Operation, type Workflow } from "@anvil/air";
import type { Transport } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { buildMcpServer } from "./server.js";

/**
 * Composition is subtractive: an approved workflow that declares `supersedes`
 * REPLACES those operation tools rather than adding a fourth tool beside three
 * it wraps.
 *
 * The two tests this file exists for are the ones that would let the feature
 * regress into a hazard rather than a no-op:
 *
 *  - an INELIGIBLE workflow suppresses nothing. If eligibility were decided
 *    after suppression, a skipped workflow would delete its members' tools and
 *    register no composite in their place — the agent loses the operations AND
 *    the thing that was supposed to stand in for them.
 *  - suppression is a DISCLOSURE decision only. The operation stays in AIR and
 *    keeps generating into the CLI and the client SDKs; that half is asserted
 *    in packages/generators/src/supersede-surface.test.ts, which can see both
 *    surfaces at once.
 */

const mockTransport: Transport = {
  send: async () => ({ status: 200, headers: {}, body: "{}" }),
};

function op(id: string, toolName: string, overrides?: Partial<Operation>): Operation {
  return Operation.parse({
    id,
    canonicalName: toolName,
    displayName: toolName,
    sourceRef: { kind: "openapi", path: `/${toolName}`, method: "get" },
    effect: { kind: "read", action: "get", resource: "thing", risk: "low", reversible: false },
    input: { params: [] },
    idempotency: {
      mode: "none",
      mechanism: "header",
      key: "Idempotency-Key",
      keyDerivation: "client_supplied",
    },
    retries: { mode: "safe", maxAttempts: 3, backoff: "exponential", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: toolName },
    mcp: { toolName },
    skill: { intentExamples: [] },
    state: "approved",
    output: { schema: { type: "object", properties: { id: { type: "string" } } } },
    ...overrides,
  });
}

function workflow(overrides?: Partial<Workflow>): Workflow {
  return {
    id: "test.workflow.compose",
    capabilityId: "test.capability",
    displayName: "Compose",
    description: "A composite",
    intentExamples: [],
    steps: [
      { operationId: "test.op1", description: "", optional: false, bindings: {} },
      { operationId: "test.op2", description: "", optional: false, bindings: {} },
    ],
    humanApproval: false,
    state: "approved",
    evidence: { claims: [] },
    ...overrides,
  };
}

function documentWith(wf: Workflow, operations = [op("test.op1", "op1"), op("test.op2", "op2")]) {
  return loadAirDocument({
    service: { id: "test", version: "1.0.0", source: { kind: "openapi" } },
    operations,
    workflows: [wf],
  });
}

async function toolNames(air: AirDocument, options: Record<string, unknown> = {}) {
  const server = buildMcpServer(air, {
    contextFor: () => ({
      transport: mockTransport,
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
  const listed = await client.listTools();
  await client.close();
  return listed.tools.map((tool) => tool.name).sort();
}

describe("workflow supersession — the served MCP surface", () => {
  it("without supersedes, a workflow is purely additive (the behaviour being fixed)", async () => {
    expect(await toolNames(documentWith(workflow()))).toEqual([
      "op1",
      "op2",
      "test_workflow_compose",
    ]);
  });

  it("an approved workflow removes the operation tools it supersedes", async () => {
    const air = documentWith(workflow({ supersedes: ["test.op1", "test.op2"] }));
    // Three tools became one. That is the whole point: a higher-order tool
    // replaces what it wraps instead of sitting beside it.
    expect(await toolNames(air)).toEqual(["test_workflow_compose"]);
  });

  it("reports every supersession through onSupersedeOperation", async () => {
    const onSupersedeOperation = vi.fn();
    await toolNames(documentWith(workflow({ supersedes: ["test.op2"] })), {
      onSupersedeOperation,
    });
    expect(onSupersedeOperation).toHaveBeenCalledWith("test.op2", "test.workflow.compose");
  });

  it("names what it replaced in the composite tool's _meta", async () => {
    const server = buildMcpServer(documentWith(workflow({ supersedes: ["test.op2"] })), {
      contextFor: () => ({
        transport: mockTransport,
        serviceId: "test",
        baseUrl: "http://test",
        allowedHosts: ["test"],
      }),
    });
    const client = new Client({ name: "t", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    await client.close();
    const composite = listed.tools.find((tool) => tool.name === "test_workflow_compose");
    expect(composite?._meta?.["anvil/supersedes"]).toEqual(["test.op2"]);
  });

  describe("an INELIGIBLE workflow suppresses nothing", () => {
    /**
     * Every one of these workflows declares `supersedes`. Every one of them is
     * refused registration for a different reason. In every case the operation
     * tools must survive untouched — a workflow that does not register has
     * nothing to offer in exchange for the tools it would delete.
     */
    const ineligible: Array<[string, Workflow, Operation[] | undefined]> = [
      [
        "unapproved workflow",
        workflow({ state: "review_required", supersedes: ["test.op1", "test.op2"] }),
        undefined,
      ],
      [
        "a step operation that is not approved",
        workflow({ supersedes: ["test.op1"] }),
        [op("test.op1", "op1"), op("test.op2", "op2", { state: "review_required" })],
      ],
      [
        "a malformed binding",
        workflow({
          supersedes: ["test.op1", "test.op2"],
          steps: [
            { operationId: "test.op1", description: "", optional: false, bindings: {} },
            {
              operationId: "test.op2",
              description: "",
              optional: false,
              bindings: { id: "$.steps.op1.id" },
            },
          ],
        }),
        undefined,
      ],
      [
        "a later step requiring the caller's idempotency key",
        workflow({ supersedes: ["test.op1", "test.op2"] }),
        [
          op("test.op1", "op1"),
          op("test.op2", "op2", {
            effect: {
              kind: "mutation",
              action: "create",
              resource: "thing",
              risk: "low",
              reversible: false,
            },
            idempotency: {
              mode: "required",
              mechanism: "header",
              key: "Idempotency-Key",
              keyDerivation: "client_supplied",
            },
          }),
        ],
      ],
    ];

    for (const [label, wf, operations] of ineligible) {
      it(`keeps every operation tool when the workflow is skipped: ${label}`, async () => {
        const air = documentWith(wf, operations);
        const onSkipWorkflow = vi.fn();
        const onSupersedeOperation = vi.fn();
        const names = await toolNames(air, { onSkipWorkflow, onSupersedeOperation });

        // The workflow registered nothing...
        expect(onSkipWorkflow).toHaveBeenCalledWith(wf.id, expect.any(String));
        expect(names).not.toContain("test_workflow_compose");
        // ...and therefore suppressed nothing.
        expect(onSupersedeOperation).not.toHaveBeenCalled();
        expect(names).toContain("op1");
        // op2 is only absent in the case where op2 itself was never approved.
        const op2Approved = (operations ?? []).every(
          (candidate) => candidate.id !== "test.op2" || candidate.state === "approved",
        );
        if (op2Approved) expect(names).toContain("op2");
      });
    }
  });

  it("refuses a supersession that would orphan a still-served async contract", async () => {
    // op1 submits a job and names op2 as its status operation. Superseding op2
    // alone would leave op1's `anvil/async_status_tool` pointing at a tool that
    // is not in tools/list — an agent handed half a contract. The suppression
    // yields; the tool stays.
    const submit = op("test.op1", "op1", {
      effect: {
        kind: "mutation",
        action: "create",
        resource: "job",
        risk: "low",
        reversible: false,
      },
      asyncContract: {
        statusOperationId: "test.op2",
        jobIdField: "job_id",
        statusJobIdParam: "job_id",
        stateField: "status",
        terminalStates: ["done"],
        pendingStates: ["running"],
      },
      output: { schema: { type: "object", properties: { job_id: { type: "string" } } } },
    });
    const status = op("test.op2", "op2", {
      output: { schema: { type: "object", properties: { status: { type: "string" } } } },
      input: {
        params: [
          {
            name: "job_id",
            in: "query",
            required: true,
            schema: { type: "string" },
            inferred: false,
          },
        ],
      },
    });
    const onRefuseSupersede = vi.fn();
    const names = await toolNames(
      documentWith(workflow({ supersedes: ["test.op2"] }), [submit, status]),
      { onRefuseSupersede },
    );
    expect(names).toContain("op2");
    expect(onRefuseSupersede).toHaveBeenCalledWith(
      "test.op2",
      "test.workflow.compose",
      expect.stringContaining("async status operation"),
    );
  });

  it("iterates refusals to a fixed point across an async chain (A→B→C)", async () => {
    // op1 submits and polls op2; op2 itself submits and polls op3. The workflow
    // proposes suppressing BOTH op2 and op3, listed in the order that defeats a
    // single refusal round: op3 is judged while op2 still looks suppressed.
    // Refusing op2 (op1 serves and names it) puts op2 back on the surface — and
    // op2 names op3, so that suppression must fall too. One round would serve
    // op2 whose `anvil/async_status_tool` points at the absent op3.
    const jobOutput = { schema: { type: "object", properties: { job_id: { type: "string" } } } };
    const jobParam = {
      params: [
        {
          name: "job_id",
          in: "query" as const,
          required: true,
          schema: { type: "string" },
          inferred: false,
        },
      ],
    };
    const submit = op("test.op1", "op1", {
      asyncContract: {
        statusOperationId: "test.op2",
        jobIdField: "job_id",
        statusJobIdParam: "job_id",
        terminalStates: ["done"],
        pendingStates: [],
      },
      output: jobOutput,
    });
    const middle = op("test.op2", "op2", {
      asyncContract: {
        statusOperationId: "test.op3",
        jobIdField: "job_id",
        statusJobIdParam: "job_id",
        terminalStates: ["done"],
        pendingStates: [],
      },
      output: jobOutput,
      input: jobParam,
    });
    const tail = op("test.op3", "op3", { input: jobParam });
    const onRefuseSupersede = vi.fn();
    const names = await toolNames(
      documentWith(
        workflow({
          steps: [
            { operationId: "test.op1", description: "", optional: false, bindings: {} },
            { operationId: "test.op2", description: "", optional: false, bindings: {} },
            { operationId: "test.op3", description: "", optional: false, bindings: {} },
          ],
          supersedes: ["test.op3", "test.op2"],
        }),
        [submit, middle, tail],
      ),
      { onRefuseSupersede },
    );
    // The final surface serves B AND C — the whole chain survives.
    expect(names).toContain("op2");
    expect(names).toContain("op3");
    expect(onRefuseSupersede).toHaveBeenCalledTimes(2);
    expect(onRefuseSupersede).toHaveBeenCalledWith(
      "test.op2",
      "test.workflow.compose",
      expect.stringContaining("async status operation"),
    );
    expect(onRefuseSupersede).toHaveBeenCalledWith(
      "test.op3",
      "test.workflow.compose",
      expect.stringContaining("async status operation"),
    );
  });

  it("still executes a superseded operation through the composite", async () => {
    const calls: string[] = [];
    const recording: Transport = {
      send: async (req: { url: string }) => {
        calls.push(req.url);
        return { status: 200, headers: {}, body: JSON.stringify({ id: "x" }) };
      },
    };
    const air = documentWith(workflow({ supersedes: ["test.op1", "test.op2"] }));
    const server = buildMcpServer(air, {
      contextFor: () => ({
        transport: recording,
        serviceId: "test",
        baseUrl: "http://test",
        allowedHosts: ["test"],
      }),
    });
    const client = new Client({ name: "t", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "test_workflow_compose", arguments: {} });
    await client.close();
    expect(result.isError ?? false).toBe(false);
    // Both superseded operations ran. Suppression removed the listings, not the
    // operations — the composite performs exactly what it replaced.
    expect(calls).toHaveLength(2);
  });
});
