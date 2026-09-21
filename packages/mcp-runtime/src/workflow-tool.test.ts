import { type AirDocument, loadAirDocument, Operation, type Workflow } from "@anvil/air";
import type { HttpRequest, Transport } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { buildMcpServer } from "./server.js";
import {
  bindStepInput,
  optionalStepFailure,
  STEP_FAILURE_KEY,
  stepTrace,
} from "./workflow-tool.js";

/**
 * `WorkflowStep.optional`: a failed optional step does not fail the run. Its
 * failure stands in for its output — visible in the trace, in the final
 * result's step outputs, and as `undefined` to any binding that reads it — and
 * a failed REQUIRED step still ends the run exactly where it always did.
 */

function read(id: string, over: Partial<z.input<typeof Operation>> = {}): Operation {
  const tool = id.replace(/\./g, "_");
  return Operation.parse({
    id,
    canonicalName: tool,
    displayName: id,
    sourceRef: { kind: "openapi", path: `/${tool}`, method: "get" },
    effect: { kind: "read", action: "get", resource: "thing", risk: "none" },
    input: { params: [] },
    idempotency: { mode: "natural", mechanism: "none" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: tool },
    mcp: { toolName: tool },
    skill: { intentExamples: [] },
    state: "approved",
    output: { schema: { type: "object", properties: { id: { type: "string" } } } },
    ...over,
  });
}

function workflow(steps: Workflow["steps"]): Workflow {
  return {
    id: "svc.flow",
    capabilityId: "svc.cap",
    displayName: "Flow",
    description: "",
    intentExamples: [],
    steps,
    humanApproval: false,
    state: "approved",
    evidence: { claims: [] },
  };
}

function air(operations: Operation[], workflows: Workflow[]): AirDocument {
  return loadAirDocument({
    service: { id: "svc", version: "1.0.0", source: { kind: "openapi" } },
    operations,
    workflows,
  });
}

/** Answers by path: `/enrich` fails upstream, everything else succeeds. */
function transportFailing(path: string): { transport: Transport; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const transport: Transport = {
    send: async (req) => {
      requests.push(req);
      if (new URL(req.url).pathname === path) {
        return { status: 500, headers: {}, body: JSON.stringify({ error: "down" }) };
      }
      return { status: 200, headers: {}, body: JSON.stringify({ id: "row-1", q: req.url }) };
    },
  };
  return { transport, requests };
}

async function connect(doc: AirDocument, transport: Transport): Promise<Client> {
  const server = buildMcpServer(doc, {
    contextFor: () => ({
      transport,
      serviceId: "svc",
      baseUrl: "https://api.example.com",
      allowedHosts: ["api.example.com"],
      env: "dev",
    }),
  });
  const client = new Client({ name: "t", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const steps = (enrichOptional: boolean): Workflow["steps"] => [
  { operationId: "svc.find", description: "", optional: false, bindings: {} },
  { operationId: "svc.enrich", description: "", optional: enrichOptional, bindings: {} },
  {
    operationId: "svc.finish",
    description: "",
    optional: false,
    bindings: { source: "$.output.id" },
  },
];

const ops = () => [
  read("svc.find"),
  read("svc.enrich"),
  read("svc.finish", {
    input: {
      params: [{ name: "source", in: "query", required: false, schema: { type: "string" } }],
    },
  }),
];

describe("optional workflow steps over MCP", () => {
  it("carries on past a failed optional step and reports the failure in the trace", async () => {
    const { transport, requests } = transportFailing("/svc_enrich");
    const client = await connect(air(ops(), [workflow(steps(true))]), transport);
    const result = await client.callTool({ name: "svc_flow", arguments: {} });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/svc_find",
      "/svc_enrich",
      "/svc_finish",
    ]);
    expect(result.structuredContent).toMatchObject({
      trace: "svc.find:ok, svc.enrich:failed, svc.finish:ok",
    });
    // A binding against the failed step resolves to nothing — never to a
    // stale value from the step before it.
    expect(requests[2]?.url).not.toContain("source=");
  });

  it("still fails the run at a failed REQUIRED step, with the prior outputs", async () => {
    const { transport, requests } = transportFailing("/svc_enrich");
    const client = await connect(air(ops(), [workflow(steps(false))]), transport);
    const result = await client.callTool({ name: "svc_flow", arguments: {} });
    await client.close();
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("workflow step failed");
    expect(text).toContain('\\"failedStep\\": \\"svc.enrich\\"');
    expect(requests).toHaveLength(2);
  });

  it("shows a failed optional LAST step's failure as the final result, marked as such", async () => {
    const { transport } = transportFailing("/svc_finish");
    const last = steps(true).map((s) =>
      s.operationId === "svc.finish" ? { ...s, optional: true } : s,
    );
    const client = await connect(air(ops(), [workflow(last)]), transport);
    const result = await client.callTool({ name: "svc_flow", arguments: {} });
    await client.close();
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.trace).toBe("svc.find:ok, svc.enrich:ok, svc.finish:failed");
    // Off the declared shape (the failure marker is not a response), so it is
    // served unvalidated — and the marker names the step's error envelope.
    const payload = JSON.stringify(structured);
    expect(payload).toContain(STEP_FAILURE_KEY);
    expect(payload).toContain("unknown_upstream_error");
  });
});

describe("workflow-tool helpers", () => {
  it("optionalStepFailure keeps the envelope where the output would have been", () => {
    const step = { operationId: "x", description: "", optional: true, bindings: {} };
    expect(optionalStepFailure(step, { error: { code: "not_found" } })).toEqual({
      operationId: "x",
      success: false,
      optional: true,
      data: { [STEP_FAILURE_KEY]: { error: { code: "not_found" } } },
    });
  });

  it("bindStepInput reads a successful previous output and nothing from a failed one", () => {
    const step = {
      operationId: "y",
      description: "",
      optional: false,
      bindings: { target: "$.output.id" },
    };
    const ok: Record<string, unknown> = {};
    bindStepInput(step, { operationId: "x", success: true, optional: false, data: { id: 7 } }, ok);
    expect(ok).toEqual({ target: 7 });
    const failed: Record<string, unknown> = {};
    bindStepInput(
      step,
      { operationId: "x", success: false, optional: true, data: { [STEP_FAILURE_KEY]: {} } },
      failed,
    );
    expect(failed).toEqual({ target: undefined });
  });

  it("stepTrace prints one entry per step", () => {
    expect(
      stepTrace([
        { operationId: "a", success: true, optional: false },
        { operationId: "b", success: false, optional: true },
      ]),
    ).toBe("a:ok, b:failed");
  });
});
