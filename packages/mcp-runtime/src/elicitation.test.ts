import { type AirDocument, loadAirDocument, Operation, type Workflow } from "@anvil/air";
import { type HttpRequest, InMemoryObserver, type Transport } from "@anvil/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type ElicitRequest, ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { buildMcpServer } from "./server.js";

/**
 * Elicitation may only ADD a confirmation step. Every case below pins one
 * side of that: an accept is the only path that sets the safety key; every
 * other answer leaves the executor's own `confirmation_required` refusal in
 * place; a client that cannot elicit is never asked and sees the refusal it
 * always saw; and an operation the spec marks humanApproval is asked even when
 * the model already said `confirm: true`.
 */

function refund(over: Partial<Operation> = {}): Operation {
  return Operation.parse({
    id: "refunds.create",
    canonicalName: "create_refund",
    displayName: "Create refund",
    description: "Refunds a payment.",
    sourceRef: { kind: "openapi", path: "/refunds", method: "post" },
    effect: { kind: "mutation", action: "create", resource: "refund", risk: "financial" },
    input: { params: [{ name: "amount", in: "query", required: true, schema: { type: "integer" } }] },
    idempotency: { mode: "none", mechanism: "none" },
    retries: { mode: "none", maxAttempts: 1, backoff: "none", retryOn: [] },
    confirmation: { required: true, risk: "financial", reason: "Money leaves the account." },
    auth: { type: "none", scopes: [] },
    cli: { command: "refunds create" },
    mcp: { toolName: "create_refund" },
    skill: { intentExamples: [] },
    state: "approved",
    output: { schema: { type: "object", properties: { id: { type: "string" } } } },
    ...over,
  });
}

function lookup(): Operation {
  return Operation.parse({
    id: "payments.get",
    canonicalName: "get_payment",
    displayName: "Get payment",
    sourceRef: { kind: "openapi", path: "/payments/{id}", method: "get" },
    effect: { kind: "read", action: "get", resource: "payment", risk: "none" },
    input: { params: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] },
    idempotency: { mode: "natural", mechanism: "none" },
    retries: { mode: "safe", maxAttempts: 2, backoff: "none", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "payments get" },
    mcp: { toolName: "get_payment" },
    skill: { intentExamples: [] },
    state: "approved",
    output: { schema: { type: "object", properties: { id: { type: "string" } } } },
  });
}

function air(operations: Operation[], workflows: Workflow[] = []): AirDocument {
  return loadAirDocument({
    service: { id: "pay", version: "1.0.0", source: { kind: "openapi" } },
    operations,
    workflows,
  });
}

type Answer = ElicitResult | (() => Promise<ElicitResult>);

async function connect(
  doc: AirDocument,
  client: Client,
): Promise<{ requests: HttpRequest[]; observer: InMemoryObserver }> {
  const requests: HttpRequest[] = [];
  const observer = new InMemoryObserver();
  const transport: Transport = {
    send: async (req) => {
      requests.push(req);
      return { status: 200, headers: {}, body: JSON.stringify({ id: "rf_1", amount: 5 }) };
    },
  };
  const server = buildMcpServer(doc, {
    contextFor: () => ({
      transport,
      serviceId: "pay",
      baseUrl: "https://api.example.com",
      allowedHosts: ["api.example.com"],
      env: "dev",
      observer,
    }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { requests, observer };
}

/** A client that advertises elicitation and answers every ask the same way. */
function elicitingClient(answer: Answer): { client: Client; asks: ElicitRequest["params"][] } {
  const asks: ElicitRequest["params"][] = [];
  const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    asks.push(request.params);
    return typeof answer === "function" ? answer() : answer;
  });
  return { client, asks };
}

function plainClient(): Client {
  return new Client({ name: "t", version: "0" });
}

function text(result: unknown): string {
  return JSON.stringify((result as { content?: unknown }).content);
}

describe("confirmation over elicitation — single operation", () => {
  it("asks the human when confirm is missing and proceeds only on an explicit accept", async () => {
    const { client, asks } = elicitingClient({ action: "accept", content: { confirm: true } });
    const { requests, observer } = await connect(air([refund()]), client);

    const result = await client.callTool({ name: "create_refund", arguments: { amount: 5 } });
    await client.close();

    expect(asks).toHaveLength(1);
    expect(asks[0]?.message).toContain("Create refund");
    expect(asks[0]?.message).toContain("Money leaves the account.");
    const requested = asks[0] as { requestedSchema: { properties: Record<string, unknown> } };
    expect(Object.keys(requested.requestedSchema.properties)).toEqual(["confirm"]);
    expect(result.isError, text(result)).toBeFalsy();
    expect(result.structuredContent).toEqual({ id: "rf_1", amount: 5 });
    expect(requests).toHaveLength(1);
    // The confirmation the human gave never travels upstream as a field.
    expect(requests[0]?.url).not.toContain("confirm");
    expect(observer.records[0]?.policyDecisions).toContain("elicitation:accepted");
    expect(observer.records[0]?.confirmed).toBe(true);
  });

  it("returns the executor's own confirmation_required refusal when the human declines", async () => {
    const { client } = elicitingClient({ action: "decline" });
    const { requests, observer } = await connect(air([refund()]), client);

    const result = await client.callTool({ name: "create_refund", arguments: { amount: 5 } });
    await client.close();

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("confirmation_required");
    expect(requests).toHaveLength(0);
    expect(observer.records[0]?.errorCode).toBe("confirmation_required");
    expect(observer.records[0]?.policyDecisions).toContain("elicitation:declined");
  });

  it("treats cancel, an accept without confirm=true, and a failed ask as not confirmed", async () => {
    const answers: Array<[Answer, string]> = [
      [{ action: "cancel" }, "elicitation:cancelled"],
      [{ action: "accept", content: { confirm: false } }, "elicitation:declined"],
      [
        async () => {
          throw new Error("client exploded");
        },
        "elicitation:failed",
      ],
    ];
    for (const [answer, decision] of answers) {
      const { client } = elicitingClient(answer);
      const { requests, observer } = await connect(air([refund()]), client);
      const result = await client.callTool({ name: "create_refund", arguments: { amount: 5 } });
      await client.close();
      expect(result.isError, decision).toBe(true);
      expect(text(result)).toContain("confirmation_required");
      expect(requests).toHaveLength(0);
      expect(observer.records[0]?.policyDecisions).toContain(decision);
    }
  });

  it("is byte-identical to today for a client that cannot elicit: confirm stays required on the listed schema", async () => {
    const client = plainClient();
    const { requests, observer } = await connect(air([refund()]), client);

    const listed = await client.listTools();
    const schema = listed.tools[0]?.inputSchema as { required?: string[] };
    expect(schema.required).toContain("confirm");
    // The SDK refuses on the schema, before any handler runs — no ask, no
    // execution, no record: exactly the refusal such a client always got.
    const result = await client.callTool({ name: "create_refund", arguments: { amount: 5 } });
    await client.close();

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Input validation error");
    expect(requests).toHaveLength(0);
    expect(observer.records).toHaveLength(0);
  });

  it("lists confirm as optional only for a client that can be asked", async () => {
    const { client } = elicitingClient({ action: "decline" });
    await connect(air([refund()]), client);
    const listed = await client.listTools();
    await client.close();
    const schema = listed.tools[0]?.inputSchema as {
      required?: string[];
      properties: Record<string, { const?: unknown }>;
    };
    expect(schema.required ?? []).not.toContain("confirm");
    // Still the same key with the same meaning: only its presence is optional.
    expect(schema.properties.confirm?.const).toBe(true);
  });

  it("never asks when the caller already confirmed a model-confirmable operation", async () => {
    const { client, asks } = elicitingClient({ action: "decline" });
    const { requests } = await connect(air([refund()]), client);

    const result = await client.callTool({
      name: "create_refund",
      arguments: { amount: 5, confirm: true },
    });
    await client.close();

    expect(asks).toHaveLength(0);
    expect(result.isError).toBeFalsy();
    expect(requests).toHaveLength(1);
  });

  it("never asks for an operation that needs no confirmation", async () => {
    const { client, asks } = elicitingClient({ action: "decline" });
    await connect(air([lookup()]), client);
    const result = await client.callTool({ name: "get_payment", arguments: { id: "p_1" } });
    await client.close();
    expect(asks).toHaveLength(0);
    expect(result.isError).toBeFalsy();
  });

  it("asks a humanApproval operation even when the model passed confirm=true, and a decline revokes it", async () => {
    const human = refund({
      confirmation: { required: true, risk: "financial", humanApproval: true },
    });
    const { client, asks } = elicitingClient({ action: "decline" });
    const { requests, observer } = await connect(air([human]), client);

    const result = await client.callTool({
      name: "create_refund",
      arguments: { amount: 5, confirm: true },
    });
    await client.close();

    expect(asks).toHaveLength(1);
    expect(asks[0]?.message).toContain("human's sign-off");
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("confirmation_required");
    expect(requests).toHaveLength(0);
    expect(observer.records[0]?.confirmed).toBe(false);
  });

  it("lets a humanApproval operation through on a human accept, with the decision recorded", async () => {
    const human = refund({
      confirmation: { required: true, risk: "financial", humanApproval: true },
    });
    const { client } = elicitingClient({ action: "accept", content: { confirm: true } });
    const { requests, observer } = await connect(air([human]), client);
    const result = await client.callTool({ name: "create_refund", arguments: { amount: 5 } });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(requests).toHaveLength(1);
    expect(observer.records[0]?.policyDecisions).toEqual(["elicitation:accepted"]);
  });

  it("keeps an operator's own preValidate hook running after the decision is recorded", async () => {
    const { client } = elicitingClient({ action: "accept", content: { confirm: true } });
    const hook = vi.fn();
    const observer = new InMemoryObserver();
    const server = buildMcpServer(air([refund()]), {
      contextFor: () => ({
        transport: { send: async () => ({ status: 200, headers: {}, body: "{}" }) },
        serviceId: "pay",
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
        env: "dev",
        observer,
        policy: { preValidate: hook },
      }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.callTool({ name: "create_refund", arguments: { amount: 5 } });
    await client.close();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(observer.records[0]?.policyDecisions).toEqual(["elicitation:accepted"]);
  });
});

describe("confirmation over elicitation — workflows", () => {
  function workflow(over: Partial<Workflow> = {}): Workflow {
    return {
      id: "pay.refund_after_lookup",
      capabilityId: "pay.refunds",
      displayName: "Refund after lookup",
      description: "Look the payment up, then refund it.",
      intentExamples: [],
      steps: [
        { operationId: "payments.get", description: "", optional: false, bindings: {} },
        {
          operationId: "refunds.create",
          description: "",
          optional: false,
          bindings: { amount: "$.output.amount" },
        },
      ],
      humanApproval: false,
      state: "approved",
      evidence: { claims: [] },
      ...over,
    };
  }

  it("asks ONCE, before the first step, and forwards the accept to the confirming step", async () => {
    const { client, asks } = elicitingClient({ action: "accept", content: { confirm: true } });
    const { requests, observer } = await connect(air([lookup(), refund()], [workflow()]), client);

    const result = await client.callTool({
      name: "pay_refund_after_lookup",
      arguments: { id: "p_1" },
    });
    await client.close();

    expect(asks).toHaveLength(1);
    expect(asks[0]?.message).toContain("Refund after lookup");
    expect(asks[0]?.message).toContain("'Create refund'");
    expect(result.isError).toBeFalsy();
    expect(requests).toHaveLength(2);
    // Every step ran under the recorded decision, the confirming one confirmed.
    expect(observer.records.map((r) => r.policyDecisions)).toEqual([
      ["elicitation:accepted"],
      ["elicitation:accepted"],
    ]);
    expect(observer.records[1]?.confirmed).toBe(true);
  });

  it("refuses at the confirming step — after the read, before the write — when declined", async () => {
    const { client } = elicitingClient({ action: "decline" });
    const { requests } = await connect(air([lookup(), refund()], [workflow()]), client);
    const result = await client.callTool({
      name: "pay_refund_after_lookup",
      arguments: { id: "p_1" },
    });
    await client.close();
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("confirmation_required");
    expect(text(result)).toContain("refunds.create");
    // The read step ran; the write never left.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
  });

  it("asks a humanApproval workflow even when confirm=true was passed", async () => {
    const { client, asks } = elicitingClient({ action: "accept", content: { confirm: true } });
    await connect(air([lookup(), refund()], [workflow({ humanApproval: true })]), client);
    const result = await client.callTool({
      name: "pay_refund_after_lookup",
      arguments: { id: "p_1", confirm: true },
    });
    await client.close();
    expect(asks).toHaveLength(1);
    expect(result.isError).toBeFalsy();
  });

  it("changes nothing for a client that cannot elicit", async () => {
    const client = plainClient();
    const { requests, observer } = await connect(air([lookup(), refund()], [workflow()]), client);
    const result = await client.callTool({
      name: "pay_refund_after_lookup",
      arguments: { id: "p_1" },
    });
    await client.close();
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("confirmation_required");
    expect(requests).toHaveLength(1);
    expect(observer.records.every((r) => r.policyDecisions.length === 0)).toBe(true);
  });
});
