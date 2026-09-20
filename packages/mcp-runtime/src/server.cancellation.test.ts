import { type AirDocument, loadAirDocument, Operation, type Workflow } from "@anvil/air";
import { type HttpRequest, InMemoryObserver, type Transport, TransportError } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { buildMcpServer } from "./server.js";

/**
 * `notifications/cancelled` for an in-flight tool call reaches the upstream
 * request: the SDK trips the request's abort signal, the server threads it
 * into `ExecuteContext.signal`, the transport tears the connection down, and
 * the executor records a typed cancellation instead of retrying. The client
 * side has already given up on the response, so the proof lives in what the
 * transport saw and what the ExecutionRecord says.
 */

function read(over: Partial<Operation> = {}): Operation {
  return Operation.parse({
    id: "things.get",
    canonicalName: "get_thing",
    displayName: "Get thing",
    sourceRef: { kind: "openapi", path: "/things", method: "get" },
    effect: { kind: "read", action: "list", resource: "thing", risk: "none" },
    input: { params: [] },
    idempotency: { mode: "natural", mechanism: "none" },
    retries: { mode: "safe", maxAttempts: 3, backoff: "none", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "things get" },
    mcp: { toolName: "get_thing" },
    skill: { intentExamples: [] },
    state: "approved",
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

/** An upstream that never answers on its own: only an abort can end the request. */
function hangingTransport(): { transport: Transport; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const transport: Transport = {
    send: (req) =>
      new Promise((_resolve, reject) => {
        requests.push(req);
        req.signal?.addEventListener("abort", () =>
          reject(new TransportError("timeout", "aborted mid-flight")),
        );
      }),
  };
  return { transport, requests };
}

async function connect(doc: AirDocument, transport: Transport) {
  const observer = new InMemoryObserver();
  const server = buildMcpServer(doc, {
    contextFor: () => ({
      transport,
      serviceId: "svc",
      baseUrl: "https://api.example.com",
      allowedHosts: ["api.example.com"],
      env: "dev",
      observer,
      sleep: async () => {},
    }),
  });
  const client = new Client({ name: "t", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, observer };
}

describe("cancellation of an in-flight tool call", () => {
  it("aborts the upstream request, never retries, and records a typed cancellation", async () => {
    const { transport, requests } = hangingTransport();
    const { client, observer } = await connect(air([read()]), transport);
    const controller = new AbortController();

    const pending = client.callTool({ name: "get_thing", arguments: {} }, undefined, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toThrow();

    await vi.waitFor(() => expect(observer.records).toHaveLength(1));
    await client.close();
    const record = observer.records[0];
    expect(requests[0]?.signal?.aborted).toBe(true);
    // A retry-safe read on a retryable condition would ordinarily try again.
    expect(requests).toHaveLength(1);
    expect(record?.outcome).toBe("error");
    expect(record?.errorCode).toBe("policy_denied");
    expect(record?.retryCount).toBe(0);
  });

  it("stops a workflow at the step in flight; no later step starts", async () => {
    const { transport, requests } = hangingTransport();
    const ops = ["a", "b"].map((suffix) =>
      read({
        id: `things.get_${suffix}`,
        canonicalName: `get_thing_${suffix}`,
        mcp: { toolName: `get_thing_${suffix}` },
      }),
    );
    const workflow: Workflow = {
      id: "svc.pair",
      capabilityId: "svc.cap",
      displayName: "Pair",
      description: "",
      intentExamples: [],
      steps: ops.map((op) => ({
        operationId: op.id,
        description: "",
        optional: false,
        bindings: {},
      })),
      humanApproval: false,
      state: "approved",
      evidence: { claims: [] },
    };
    const { client, observer } = await connect(air(ops, [workflow]), transport);
    const controller = new AbortController();
    const pending = client.callTool({ name: "svc_pair", arguments: {} }, undefined, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    controller.abort();
    await pending.catch(() => {});
    await vi.waitFor(() => expect(observer.records).toHaveLength(1));
    // Give a second step every chance to start; it must not.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.close();
    expect(requests).toHaveLength(1);
    expect(observer.records[0]?.operationId).toBe("things.get_a");
    expect(observer.records[0]?.errorCode).toBe("policy_denied");
  });
});
