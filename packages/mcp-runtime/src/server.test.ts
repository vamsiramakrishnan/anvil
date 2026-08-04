import {
  type AirDocument,
  loadAirDocument,
  Operation,
  type Workflow,
  type WorkflowStep,
} from "@anvil/air";
import type { Transport } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { buildMcpServer } from "./server.js";

const mockTransport: Transport = {
  send: async () => ({ status: 200, headers: {}, body: "{}" }),
};

function createBaseOperation(overrides?: Partial<Operation>): Operation {
  return Operation.parse({
    id: "test.operation.base",
    canonicalName: "test_base",
    displayName: "Test Base",
    sourceRef: { kind: "openapi", path: "/test", method: "get" },
    effect: {
      kind: "read",
      action: "list",
      resource: "test",
      risk: "low",
      reversible: false,
    },
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
    cli: { command: "test base" },
    mcp: { toolName: "test_base" },
    skill: { intentExamples: [] },
    state: "approved",
    output: {
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
      },
    },
    ...overrides,
  });
}

function createStep(operationId: string, bindings: Record<string, string> = {}): WorkflowStep {
  return {
    operationId,
    description: `Step for ${operationId}`,
    optional: false,
    bindings,
  };
}

function createWorkflow(overrides?: Partial<Workflow>): Workflow {
  return {
    id: "test.workflow.simple",
    capabilityId: "test.capability",
    displayName: "Test Workflow",
    description: "A test workflow",
    intentExamples: [],
    steps: [],
    humanApproval: false,
    state: "approved",
    evidence: { claims: [] },
    ...overrides,
  };
}

describe("buildMcpServer - workflows", () => {
  describe("workflow registration eligibility", () => {
    it("registers a valid two-step workflow without error", () => {
      const op1 = createBaseOperation({
        id: "test.op1",
        canonicalName: "op1",
        displayName: "Operation 1",
        mcp: { toolName: "op1" },
        effect: {
          kind: "read",
          action: "get",
          resource: "resource1",
          risk: "low",
          reversible: false,
        },
        output: {
          schema: {
            type: "object",
            properties: { id: { type: "string" }, value: { type: "string" } },
          },
        },
      });

      const op2 = createBaseOperation({
        id: "test.op2",
        canonicalName: "op2",
        displayName: "Operation 2",
        mcp: { toolName: "op2" },
        input: {
          params: [
            {
              name: "id",
              in: "query",
              required: true,
              schema: { type: "string" },
              inferred: false,
            },
          ],
        },
      });

      const workflow = createWorkflow({
        id: "test.workflow.two-step",
        steps: [createStep("test.op1"), createStep("test.op2", { id: "$.output.id" })],
      });

      const air: AirDocument = loadAirDocument({
        service: { id: "test", version: "1.0.0", source: { kind: "openapi" } },
        operations: [op1, op2],
        workflows: [workflow],
      });

      const onSkipWorkflow = vi.fn();
      const buildResult = buildMcpServer(air, {
        contextFor: () => ({
          transport: mockTransport,
          serviceId: "test",
          baseUrl: "http://test",
        }),
        onSkipWorkflow,
      });

      // Should not skip the workflow
      expect(onSkipWorkflow).not.toHaveBeenCalledWith("test.workflow.two-step", expect.anything());
      // Should return a valid server object
      expect(buildResult).toBeDefined();
    });

    it("skips workflow with missing operation", () => {
      const op1 = createBaseOperation({
        id: "test.op1",
        canonicalName: "op1",
        mcp: { toolName: "op1" },
      });

      const workflow = createWorkflow({
        id: "test.workflow.bad",
        steps: [createStep("test.op1"), createStep("test.missing", { id: "$.output.id" })],
      });

      const onSkipWorkflow = vi.fn();
      const air: AirDocument = loadAirDocument({
        service: { id: "test", version: "1.0.0", source: { kind: "openapi" } },
        operations: [op1],
        workflows: [workflow],
      });

      buildMcpServer(air, {
        contextFor: () => ({
          transport: mockTransport,
          serviceId: "test",
          baseUrl: "http://test",
        }),
        onSkipWorkflow,
      });

      expect(onSkipWorkflow).toHaveBeenCalledWith(
        "test.workflow.bad",
        expect.stringContaining("not found"),
      );
    });

    it("skips workflow with unapproved operation", () => {
      const op1 = createBaseOperation({
        id: "test.op1",
        canonicalName: "op1",
        mcp: { toolName: "op1" },
      });

      const op2 = createBaseOperation({
        id: "test.op2",
        canonicalName: "op2",
        mcp: { toolName: "op2" },
        state: "generated", // Not approved
      });

      const workflow = createWorkflow({
        id: "test.workflow.bad",
        steps: [createStep("test.op1"), createStep("test.op2", { id: "$.output.id" })],
      });

      const onSkipWorkflow = vi.fn();
      const air: AirDocument = loadAirDocument({
        service: { id: "test", version: "1.0.0", source: { kind: "openapi" } },
        operations: [op1, op2],
        workflows: [workflow],
      });

      buildMcpServer(air, {
        contextFor: () => ({
          transport: mockTransport,
          serviceId: "test",
          baseUrl: "http://test",
        }),
        onSkipWorkflow,
      });

      expect(onSkipWorkflow).toHaveBeenCalledWith(
        "test.workflow.bad",
        expect.stringContaining("not found or not approved"),
      );
    });

    it("skips workflow with unapproved workflow state", () => {
      const op1 = createBaseOperation({
        id: "test.op1",
        canonicalName: "op1",
        mcp: { toolName: "op1" },
      });

      const workflow = createWorkflow({
        id: "test.workflow.bad-state",
        steps: [createStep("test.op1")],
        state: "generated", // Not approved
      });

      const onSkipWorkflow = vi.fn();
      const air: AirDocument = loadAirDocument({
        service: { id: "test", version: "1.0.0", source: { kind: "openapi" } },
        operations: [op1],
        workflows: [workflow],
      });

      buildMcpServer(air, {
        contextFor: () => ({
          transport: mockTransport,
          serviceId: "test",
          baseUrl: "http://test",
        }),
        onSkipWorkflow,
      });

      expect(onSkipWorkflow).toHaveBeenCalledWith(
        "test.workflow.bad-state",
        "workflow state is not approved",
      );
    });

    it("skips workflow with invalid binding format", () => {
      const op1 = createBaseOperation({
        id: "test.op1",
        canonicalName: "op1",
        mcp: { toolName: "op1" },
      });

      const op2 = createBaseOperation({
        id: "test.op2",
        canonicalName: "op2",
        mcp: { toolName: "op2" },
        input: {
          params: [
            {
              name: "id",
              in: "query",
              required: true,
              schema: { type: "string" },
              inferred: false,
            },
          ],
        },
      });

      const workflow = createWorkflow({
        id: "test.workflow.bad-binding",
        steps: [createStep("test.op1"), createStep("test.op2", { id: "$.steps.op1.id" })], // Invalid format
      });

      const onSkipWorkflow = vi.fn();
      const air: AirDocument = loadAirDocument({
        service: { id: "test", version: "1.0.0", source: { kind: "openapi" } },
        operations: [op1, op2],
        workflows: [workflow],
      });

      buildMcpServer(air, {
        contextFor: () => ({
          transport: mockTransport,
          serviceId: "test",
          baseUrl: "http://test",
        }),
        onSkipWorkflow,
      });

      expect(onSkipWorkflow).toHaveBeenCalledWith(
        "test.workflow.bad-binding",
        expect.stringContaining("invalid format"),
      );
    });

    it("skips workflow with no steps", () => {
      const workflow = createWorkflow({
        id: "test.workflow.empty",
        steps: [],
      });

      const onSkipWorkflow = vi.fn();
      const air: AirDocument = loadAirDocument({
        service: { id: "test", version: "1.0.0", source: { kind: "openapi" } },
        operations: [],
        workflows: [workflow],
      });

      buildMcpServer(air, {
        contextFor: () => ({
          transport: mockTransport,
          serviceId: "test",
          baseUrl: "http://test",
        }),
        onSkipWorkflow,
      });

      expect(onSkipWorkflow).toHaveBeenCalledWith("test.workflow.empty", "workflow has no steps");
    });
  });

  describe("workflow confirmation requirements", () => {
    it("workflow with confirmed step requires confirmation", () => {
      const op1 = createBaseOperation({
        id: "test.op1",
        canonicalName: "op1",
        mcp: { toolName: "op1" },
        confirmation: { required: false },
        output: {
          schema: {
            type: "object",
            properties: { id: { type: "string" } },
          },
        },
      });

      const op2 = createBaseOperation({
        id: "test.op2",
        canonicalName: "op2",
        mcp: { toolName: "op2" },
        confirmation: { required: true }, // This step requires confirmation
        input: {
          params: [
            {
              name: "id",
              in: "query",
              required: true,
              schema: { type: "string" },
              inferred: false,
            },
          ],
        },
      });

      const workflow = createWorkflow({
        id: "test.workflow.confirm",
        steps: [createStep("test.op1"), createStep("test.op2", { id: "$.output.id" })],
      });

      const air: AirDocument = loadAirDocument({
        service: { id: "test", version: "1.0.0", source: { kind: "openapi" } },
        operations: [op1, op2],
        workflows: [workflow],
      });

      const onSkipWorkflow = vi.fn();
      const server = buildMcpServer(air, {
        contextFor: () => ({
          transport: mockTransport,
          serviceId: "test",
          baseUrl: "http://test",
        }),
        onSkipWorkflow,
      });

      // Should not skip the workflow
      expect(onSkipWorkflow).not.toHaveBeenCalledWith("test.workflow.confirm", expect.anything());
      expect(server).toBeDefined();
    });

    it("forwards the caller's confirmation to a later confirming step, which the runtime still enforces", async () => {
      const calls: unknown[] = [];
      const recordingTransport: Transport = {
        send: async (req) => {
          calls.push(req);
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: "row-1" }),
          };
        },
      };
      const op1 = createBaseOperation({
        id: "test.op1",
        canonicalName: "op1",
        mcp: { toolName: "op1" },
      });
      const op2 = createBaseOperation({
        id: "test.op2",
        canonicalName: "op2",
        mcp: { toolName: "op2" },
        effect: {
          kind: "mutation",
          action: "update",
          resource: "test",
          risk: "low",
          reversible: false,
        },
        confirmation: { required: true, risk: "low" },
        input: {
          params: [
            {
              name: "id",
              in: "query",
              required: true,
              schema: { type: "string" },
              inferred: false,
            },
          ],
        },
      });
      const workflow = createWorkflow({
        id: "test.workflow.fwd",
        steps: [createStep("test.op1"), createStep("test.op2", { id: "$.output.id" })],
      });
      const air: AirDocument = loadAirDocument({
        service: { id: "test", version: "1.0.0", source: { kind: "openapi" } },
        operations: [op1, op2],
        workflows: [workflow],
      });

      const server = buildMcpServer(air, {
        contextFor: () => ({
          transport: recordingTransport,
          serviceId: "test",
          baseUrl: "http://test",
          allowedHosts: ["test"],
        }),
      });
      const client = new Client({ name: "t", version: "0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      // Without confirmation: step 2's own runtime gate refuses — the composite
      // never self-confirms on the caller's behalf.
      const refused = await client.callTool({ name: "test_workflow_fwd", arguments: {} });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain("confirmation_required");
      expect(calls.length).toBe(1); // step 1 ran; step 2 was refused before the wire

      // With the composite's one confirm: forwarded to step 2 under its own
      // safety key, so both steps reach the transport.
      calls.length = 0;
      const ok = await client.callTool({ name: "test_workflow_fwd", arguments: { confirm: true } });
      expect(ok.isError ?? false).toBe(false);
      expect(calls.length).toBe(2);
      await client.close();
    });

    it("skips a workflow whose non-first step requires a client idempotency key", () => {
      const op1 = createBaseOperation({ id: "test.op1", canonicalName: "op1" });
      const op2 = createBaseOperation({
        id: "test.op2",
        canonicalName: "op2",
        mcp: { toolName: "op2" },
        effect: {
          kind: "mutation",
          action: "create",
          resource: "test",
          risk: "low",
          reversible: false,
        },
        idempotency: {
          mode: "required",
          mechanism: "header",
          key: "Idempotency-Key",
          keyDerivation: "client_supplied",
        },
      });
      const workflow = createWorkflow({
        id: "test.workflow.keyed",
        steps: [createStep("test.op1"), createStep("test.op2")],
      });
      const air: AirDocument = loadAirDocument({
        service: { id: "test", version: "1.0.0", source: { kind: "openapi" } },
        operations: [op1, op2],
        workflows: [workflow],
      });

      const onSkipWorkflow = vi.fn();
      buildMcpServer(air, {
        contextFor: () => ({
          transport: mockTransport,
          serviceId: "test",
          baseUrl: "http://test",
        }),
        onSkipWorkflow,
      });
      // One caller key cannot safely dedup several distinct writes.
      expect(onSkipWorkflow).toHaveBeenCalledWith(
        "test.workflow.keyed",
        expect.stringContaining("idempotency key"),
      );
    });
  });

  describe("binding validation", () => {
    it("accepts valid field bindings like $.output.fieldName", () => {
      const op1 = createBaseOperation({
        id: "test.op1",
        mcp: { toolName: "op1" },
        output: {
          schema: {
            type: "object",
            properties: {
              id: { type: "string" },
              user_id: { type: "string" },
              transaction_ref: { type: "string" },
            },
          },
        },
      });

      const op2 = createBaseOperation({
        id: "test.op2",
        mcp: { toolName: "op2" },
        input: {
          params: [
            {
              name: "id",
              in: "query",
              required: true,
              schema: { type: "string" },
              inferred: false,
            },
            {
              name: "user_id",
              in: "query",
              required: true,
              schema: { type: "string" },
              inferred: false,
            },
            {
              name: "transaction_ref",
              in: "query",
              required: true,
              schema: { type: "string" },
              inferred: false,
            },
          ],
        },
      });

      const workflow = createWorkflow({
        id: "test.workflow.multi-binding",
        steps: [
          createStep("test.op1"),
          createStep("test.op2", {
            id: "$.output.id",
            user_id: "$.output.user_id",
            transaction_ref: "$.output.transaction_ref",
          }),
        ],
      });

      const onSkipWorkflow = vi.fn();
      const air: AirDocument = loadAirDocument({
        service: { id: "test", version: "1.0.0", source: { kind: "openapi" } },
        operations: [op1, op2],
        workflows: [workflow],
      });

      buildMcpServer(air, {
        contextFor: () => ({
          transport: mockTransport,
          serviceId: "test",
          baseUrl: "http://test",
        }),
        onSkipWorkflow,
      });

      expect(onSkipWorkflow).not.toHaveBeenCalledWith(
        "test.workflow.multi-binding",
        expect.anything(),
      );
    });

    it("rejects bindings with invalid formats", () => {
      const op1 = createBaseOperation({
        id: "test.op1",
        mcp: { toolName: "op1" },
      });

      const op2 = createBaseOperation({
        id: "test.op2",
        mcp: { toolName: "op2" },
        input: {
          params: [
            {
              name: "id",
              in: "query",
              required: true,
              schema: { type: "string" },
              inferred: false,
            },
          ],
        },
      });

      // Test various invalid formats
      const invalidFormats = [
        "$.steps.op1.id", // Wrong prefix
        "$output.id", // Missing dot
        "$.output.id.nested", // Too many dots
        "output.id", // Missing $
        "$.data.id", // Wrong path
      ];

      for (const invalidFormat of invalidFormats) {
        const workflow = createWorkflow({
          id: "test.workflow.invalid",
          steps: [createStep("test.op1"), createStep("test.op2", { id: invalidFormat })],
        });

        const onSkipWorkflow = vi.fn();
        const air: AirDocument = loadAirDocument({
          service: { id: "test", version: "1.0.0", source: { kind: "openapi" } },
          operations: [op1, op2],
          workflows: [workflow],
        });

        buildMcpServer(air, {
          contextFor: () => ({
            transport: mockTransport,
            serviceId: "test",
            baseUrl: "http://test",
          }),
          onSkipWorkflow,
        });

        expect(onSkipWorkflow).toHaveBeenCalledWith(
          "test.workflow.invalid",
          expect.stringContaining("invalid format"),
        );
      }
    });
  });
});
